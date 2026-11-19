import { keccak256 } from './keccak.js';
import { addressWord, isAddress, readAddress, readUint, selector, word, ZERO } from './values.js';
import { runtime } from './sale-runtime.js';
import { decodeAggregate, encodeAggregate } from '../sources/evm-abi.js';

export const UNKNOWN = 'unknown';
// Read in this order, stopping at the first slot that holds an implementation (most proxies need one read).
const proxySlots = {
  implementation: '0x' + word(BigInt(keccak256('eip1967.proxy.implementation')) - 1n),
  // OpenZeppelin 2.x / ZeppelinOS AdminUpgradeabilityProxy (Circle's USDC FiatTokenProxy among others).
  zeppelinos: keccak256('org.zeppelinos.proxy.implementation'),
  beacon: '0x' + word(BigInt(keccak256('eip1967.proxy.beacon')) - 1n),
  proxiable: keccak256('PROXIABLE'),
};
/** Known entry points per capability. A `false` capability means: the token's dispatcher (its own code or its fixed or
 * slot-recorded implementation) was read completely and contains none of these selectors. */
export const privileges = {
  ownerMint: { signatures: ['mint(address,uint256)', 'mint(uint256)', 'issue(uint256)', 'mintTo(address,uint256)',
    'issue(address,uint256)', 'mint(address,uint256,bytes)'], role: 'MINTER_ROLE' },
  ownerPause: { signatures: ['pause()', 'setPaused(bool)', 'pause(bool)', 'setPause(bool)', 'togglePause()'], role: 'PAUSER_ROLE' },
  blacklist: { signatures: ['addBlackList(address)', 'blacklist(address)', 'setBlacklist(address,bool)',
    'setBlacklisted(address,bool)', 'blacklistAddress(address)', 'blacklist(address,bool)', 'addToBlacklist(address)',
    'freeze(address)', 'freezeAccount(address,bool)', 'setBots(address[],bool)', 'addBots(address[])', 'setBot(address,bool)'],
  role: 'BLACKLISTER_ROLE' },
};
// A dispatcher that exposes these is a recognised ERC-20 dispatcher; only then does a missing selector mean "absent".
const erc20Core = ['transfer(address,uint256)', 'balanceOf(address)', 'totalSupply()', 'approve(address,uint256)',
  'transferFrom(address,address,uint256)'];
const upgradeEntries = ['upgradeTo(address)', 'upgradeToAndCall(address,bytes)',
  'diamondCut((address,uint8,bytes4[])[],address,bytes)'];
const signatureCache = new Map();
function sig(signature) {
  if (!signatureCache.has(signature)) signatureCache.set(signature, selector(signature));
  return signatureCache.get(signature);
}

/** Per-check RPC limits. Reads wait for the shared endpoint buckets and profile budget (they never burst past them),
 * but a check stops reading after `maxCalls` dispatches or at its deadline; refused reads count as missing evidence.
 * Interactive checks (API/MCP, whose client gives up after 30 s) get 25 s; the scheduler's background job 90 s (its
 * job deadline is 180 s). Measured on idle default buckets (12 rpm per endpoint): 3–21 dispatches, 0.3–40 s. */
export const CHECK_LIMITS = Object.freeze({ maxCalls: 40, timeoutMs: 25_000 });
export const BACKGROUND_LIMITS = Object.freeze({ maxCalls: 40, timeoutMs: 90_000 });
const TIMEOUT = Symbol('timeout');
function refusalReason(error) {
  if (error?.name === 'RateLimited' || error?.retryAt !== undefined || /budget unavailable/i.test(error?.message ?? '')) {
    return 'rpc budget refused';
  }
  return 'rpc ' + (typeof error?.kind === 'string' ? error.kind : 'error');
}

/** Bind all observations in a check to the same chain and block. RPC failures carry no negative evidence; reverts
 * (a definite "this call fails here") are kept apart from refusals in `stats`. */
export function evmReader(rpc, chain, block, { maxCalls = Infinity, deadline = Infinity, now = Date.now, multicall } = {}) {
  const cache = new Map();
  const stats = { calls: 0, refused: 0, reverted: 0, reasons: [] };
  function refuse(reason) {
    stats.refused++;
    if (!stats.reasons.includes(reason) && stats.reasons.length < 8) stats.reasons.push(reason);
    return null;
  }
  function send(method, params) {
    if (stats.calls >= maxCalls) return refuse('per-check call cap (' + maxCalls + ')');
    const left = deadline - now();
    if (left <= 0) return refuse('check deadline');
    stats.calls++;
    // RpcClient.batch waits for a free endpoint slot inside the shared buckets; call() gives up after 2 s.
    const request = Promise.resolve().then(() => typeof rpc.batch === 'function'
      ? rpc.batch(chain, [{ method, params }]).then(rows => rows[0]) : rpc.call(chain, method, params));
    let timer;
    const limit = Number.isFinite(left) ? new Promise(resolve => {
      timer = setTimeout(resolve, left, TIMEOUT);
      timer.unref?.();
    }) : null;
    return (limit ? Promise.race([request, limit]) : request).then(
      value => value === TIMEOUT ? refuse('check deadline') : value,
      error => {
        if (error?.kind === 'reverted') { stats.reverted++; return null; }
        return refuse(refusalReason(error));
      }).finally(() => clearTimeout(timer));
  }
  function read(method, params) {
    const key = JSON.stringify([method, params]);
    if (!cache.has(key)) cache.set(key, send(method, params));
    return cache.get(key);
  }
  const reader = {
    read, block, stats, multicall: isAddress(multicall),
    code: address => read('eth_getCode', [address, reader.block]),
    storage: (address, slot) => read('eth_getStorageAt', [address, slot, reader.block]),
    call: (to, signature, args = '') => read('eth_call', [{ to, data: sig(signature) + args }, reader.block]),
    /** Many view calls in one Multicall3 aggregate3 read (one dispatch); individual reads without Multicall3.
     * Each entry is the return data, or null for a failed sub-call or a refused read. */
    async calls(list) {
      const encoded = list.map(([to, signature, args = '']) => ({ to, data: sig(signature) + args }));
      if (!encoded.length) return [];
      if (!isAddress(multicall)) return Promise.all(encoded.map(c => read('eth_call', [c, reader.block])));
      const data = await read('eth_call', [{ to: multicall, data: encodeAggregate(encoded) }, reader.block]);
      try { return decodeAggregate(data, encoded.length); } catch { return encoded.map(() => null); }
    },
  };
  return reader;
}

/** Solidity appends CBOR metadata (`a1..a5` map, big-endian length in the last two bytes). Its bytes are data, not
 * code: a stray 0xf4 inside an IPFS hash once marked plain tokens as delegating. */
function stripMetadata(bytes) {
  if (bytes.length < 4) return bytes;
  const length = bytes.readUInt16BE(bytes.length - 2), start = bytes.length - 2 - length;
  return length > 0 && length <= 128 && start >= 0 && bytes[start] >= 0xa1 && bytes[start] <= 0xa5
    ? bytes.subarray(0, start) : bytes;
}

export function inspectCode(code) {
  if (typeof code !== 'string' || code.length > 100_000 || !/^0x(?:[\da-f]{2})+$/i.test(code)) return null;
  const bytes = stripMetadata(Buffer.from(code.slice(2), 'hex')), selectors = new Set(), targets = [];
  let delegates = false, storage = false;
  for (let i = 0; i < bytes.length; i++) {
    const op = bytes[i];
    if (op === 0xf4) delegates = true;
    if (op === 0x54 || op === 0x55) storage = true;
    if (op < 0x60 || op > 0x7f) continue;
    const size = op - 0x5f, next = bytes[i + size + 1];
    // Selectors in dispatcher comparisons (`PUSH sel EQ`, viaIR `PUSH sel DUP2 EQ`), excluding bytes embedded in
    // other PUSH operands.
    if (size <= 4 && (next === 0x14 || (next === 0x81 && bytes[i + size + 2] === 0x14))) {
      selectors.add('0x' + bytes.subarray(i + 1, i + size + 1).toString('hex').padStart(8, '0'));
    }
    if (size === 20) targets.push('0x' + bytes.subarray(i + 1, i + 21).toString('hex'));
    i += size;
  }
  // An immutable forwarder (EIP-1167, its PUSH0 and Solady variants): tiny code, one hard-coded target, no storage.
  // Its implementation can never change.
  const forwarder = delegates && !storage && bytes.length <= 128 && targets.length === 1 ? targets[0] : null;
  return { selectors, delegates, forwarder, size: bytes.length };
}

async function roleEvidence(reader, token, roleName, selectors, candidates) {
  const role = await reader.call(token, roleName + '()');
  const roleId = readUint(role) === null ? keccak256(roleName) : role;
  if (selectors.has(sig('getRoleMember(bytes32,uint256)'))) {
    const member = readAddress(await reader.call(token, 'getRoleMember(bytes32,uint256)', roleId.slice(2) + word(0)));
    if (member && member !== ZERO) candidates.add(member);
  }
  for (const account of [...candidates].slice(0, 4)) {
    const result = await reader.call(token, 'hasRole(bytes32,address)', roleId.slice(2) + addressWord(account));
    if (readUint(result) === 1n) return { role: roleId, account };
  }
  if (selectors.has(sig('getRoleMemberCount(bytes32)'))) {
    const count = readUint(await reader.call(token, 'getRoleMemberCount(bytes32)', roleId.slice(2)));
    if (count === 0n) return { role: roleId, empty: true };
  }
  return null;
}

/** Interface (selectors) and upgradeability of the code that actually runs for `token`. */
async function resolveInterface(reader, token, evidence, why) {
  const raw = await reader.code(token);
  if (raw === '0x') return { error: 'no contract code at the pinned block' };
  const base = inspectCode(raw);
  if (!base) return { error: raw === null ? 'token code unavailable (' + (reader.stats.reasons.at(-1) ?? 'rpc') + ')' : 'token code unreadable' };
  evidence.codeBytes = base.size;
  let logic = base, upgradeable = UNKNOWN;
  if (base.forwarder) {
    evidence.proxy = 'immutable forwarder (minimal proxy)';
    evidence.implementation = base.forwarder;
    logic = inspectCode(await reader.code(base.forwarder));
    if (!logic) return { error: 'implementation code unavailable', upgradeable: false };
    upgradeable = false;
  }
  const selectors = new Set(logic.selectors);
  if (!logic.delegates) {
    if (upgradeable === UNKNOWN) evidence.upgrade = 'no DELEGATECALL in runtime code';
    return { selectors, complete: true, upgradeable: false };
  }
  let allSlots = true, found = false;
  for (const [type, slot] of Object.entries(proxySlots)) {
    const address = readAddress(await reader.storage(token, slot));
    evidence.slots[type] = address;
    if (address === null) { allSlots = false; continue; }
    if (address === ZERO) continue;
    const impl = type === 'beacon' ? readAddress(await reader.call(address, 'implementation()')) : address;
    found = true;
    evidence.proxy = type + ' slot';
    if (!impl || impl === ZERO) { allSlots = false; continue; }
    evidence.implementation = impl;
    const code = inspectCode(await reader.code(impl));
    if (!code) { allSlots = false; continue; }
    for (const s of code.selectors) selectors.add(s);
    break;
  }
  if (found) return { selectors, complete: allSlots, upgradeable: true,
    incomplete: allSlots ? undefined : 'implementation code unavailable' };
  if (upgradeEntries.some(s => selectors.has(sig(s)))) {
    evidence.upgrade = 'upgrade entry point in dispatcher';
    return { selectors, complete: false, upgradeable: true, incomplete: 'implementation not located' };
  }
  if (upgradeable === false) return { selectors, complete: false, upgradeable, incomplete: 'implementation delegates further' };
  const reason = allSlots ? 'DELEGATECALL without a known proxy slot' : 'proxy slots unavailable (' + (reader.stats.reasons.at(-1) ?? 'rpc') + ')';
  why.upgradeable = reason;
  return { selectors, complete: false, upgradeable, incomplete: reason };
}

/** Flags: upgradeable, ownerMint, ownerPause, blacklist. `why` explains every flag left unknown. */
export async function contractRisk(reader, token, roleAccounts = []) {
  const flags = { upgradeable: UNKNOWN, ownerMint: UNKNOWN, ownerPause: UNKNOWN, blacklist: UNKNOWN };
  const evidence = { slots: {}, capabilities: {}, owner: null }, why = {};
  const face = await resolveInterface(reader, token, evidence, why);
  if (face.upgradeable !== undefined) flags.upgradeable = face.upgradeable;
  if (face.error) {
    for (const flag of Object.keys(flags)) if (flags[flag] === UNKNOWN) why[flag] = face.error;
    return { flags, evidence, why };
  }
  const { selectors } = face;
  const core = erc20Core.filter(s => selectors.has(sig(s))).length;
  evidence.selectors = { count: selectors.size, erc20Core: core };
  const enumerable = face.complete && core >= 4;
  const matches = Object.entries(privileges).map(([flag, p]) => [flag, p, p.signatures.filter(s => selectors.has(sig(s)))]);
  let owner = null;
  if (matches.some(([, , matched]) => matched.length)) {
    const data = await reader.call(token, 'owner()');
    owner = readAddress(data);
    evidence.owner = owner;
  }
  const accessControl = selectors.has(sig('hasRole(bytes32,address)'));
  for (const [flag, { role }, matched] of matches) {
    if (!matched.length) {
      if (enumerable) {
        flags[flag] = false;
        evidence.capabilities[flag] = { signatures: [], method: 'no known entry point in the dispatcher' };
      } else why[flag] = face.complete ? 'dispatcher not recognised (' + core + ' of 5 ERC-20 core selectors)' : face.incomplete;
      continue;
    }
    const accounts = new Set(roleAccounts.filter(isAddress).slice(0, 8).map(a => a.toLowerCase()));
    if (owner && owner !== ZERO) accounts.add(owner);
    const grant = accessControl ? await roleEvidence(reader, token, role, selectors, accounts) : null;
    evidence.capabilities[flag] = { signatures: matched, owner, grant,
      method: accessControl ? 'selector and role membership' : 'selector and owner (heuristic)' };
    if (grant?.empty) flags[flag] = false;
    else if (grant || (!accessControl && owner && owner !== ZERO)) flags[flag] = true;
    else why[flag] = accessControl ? 'entry point present; no role holder found among candidates'
      : owner === ZERO ? 'entry point present; owner renounced, other controllers not checked'
        : 'entry point present; controller unknown (no owner())';
  }
  return { flags, evidence, why };
}

const probeAddress = '0x' + keccak256('intercom-gator/read-only-sale-probe/v1').slice(-40);
const kinds = new Map([['v2', 0], ['uniswap-v2', 0], ['v3', 1], ['uniswap-v3', 1], ['v3-router02', 2]]);

export async function simulateSale(reader, token, pool, block) {
  const unknown = reason => ({ flag: UNKNOWN, evidence: { reason } });
  const kind = kinds.get(pool?.routerKind ?? pool?.kind);
  if (!isAddress(pool?.address)) return unknown('no pool found');
  if (kind === undefined || !isAddress(pool?.router)) return unknown('no supported router for this pool');
  const amount = pool.probeAmountWei ?? '1000000000000000', fee = pool.bridgeFee ?? 3000;
  if (!/^\d{1,40}$/.test(String(amount)) || BigInt(amount) === 0n || !Number.isInteger(fee) || fee <= 0 || fee >= 1e6) {
    return unknown('invalid probe parameters');
  }
  const data = sig('probe(address,address,address,uint8,uint24,uint256)') +
    [pool.router, pool.address, token, kind, fee, amount].map(word).join('');
  const override = { [probeAddress]: { balance: '0x' + BigInt(amount).toString(16), code: runtime } };
  const result = await reader.read('eth_call', [{ to: probeAddress, data, gas: '0x5b8d80' }, block, override]);
  if (typeof result !== 'string' || !/^0x[\da-f]{192}$/i.test(result)) return unknown('override unavailable or probe inconclusive');
  const [stage, bought, proceeds] = result.slice(2).match(/.{64}/g).map(s => BigInt('0x' + s));
  const evidence = { method: 'atomic router round trip', router: pool.router, pool: pool.address,
    amountWei: String(amount), bought: String(bought), proceedsWei: String(proceeds), stage: Number(stage) };
  if (bought > 0n && stage === 5n) return { flag: proceeds === 0n, evidence };
  if (bought > 0n && stage === 4n && proceeds === 0n) return { flag: true, evidence };
  return { flag: UNKNOWN, evidence: { ...evidence, reason: ['', 'buy reverted', 'nothing bought or approve failed',
    'sell reverted without reason', 'sell reverted'][Number(stage)] ?? 'probe inconclusive' } };
}
