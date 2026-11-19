import { keccak256 } from './keccak.js';
import { addressWord, isAddress, readAddress, readUint, selector, word, ZERO } from './values.js';
import { runtime } from './sale-runtime.js';

export const UNKNOWN = 'unknown';
const proxySlots = {
  implementation: '0x' + word(BigInt(keccak256('eip1967.proxy.implementation')) - 1n),
  beacon: '0x' + word(BigInt(keccak256('eip1967.proxy.beacon')) - 1n),
  proxiable: keccak256('PROXIABLE'),
};
const privileges = {
  ownerMint: { signatures: ['mint(address,uint256)', 'mint(uint256)', 'issue(uint256)'], role: 'MINTER_ROLE' },
  ownerPause: { signatures: ['pause()', 'setPaused(bool)'], role: 'PAUSER_ROLE' },
  blacklist: { signatures: ['addBlackList(address)', 'blacklist(address)', 'setBlacklist(address,bool)',
    'setBlacklisted(address,bool)', 'blacklistAddress(address)'], role: 'BLACKLISTER_ROLE' },
};
const signatureCache = new Map();
function sig(signature) {
  if (!signatureCache.has(signature)) signatureCache.set(signature, selector(signature));
  return signatureCache.get(signature);
}

/** Bind all observations in a check to the same chain and block. RPC failures carry no negative evidence. */
export function evmReader(rpc, chain, block) {
  const cache = new Map();
  function read(method, params) {
    const key = JSON.stringify([method, params]);
    if (!cache.has(key)) cache.set(key, Promise.resolve().then(() => rpc.call(chain, method, params)).catch(() => null));
    return cache.get(key);
  }
  return {
    read, block,
    code: address => read('eth_getCode', [address, block]),
    storage: (address, slot) => read('eth_getStorageAt', [address, slot, block]),
    call: (to, signature, args = '') => read('eth_call', [{ to, data: sig(signature) + args }, block]),
  };
}

function inspectCode(code) {
  if (typeof code !== 'string' || code.length > 100_000 || !/^0x(?:[\da-f]{2})+$/i.test(code)) return null;
  const bytes = Buffer.from(code.slice(2), 'hex'), selectors = new Set();
  let delegates = false;
  for (let i = 0; i < bytes.length; i++) {
    const op = bytes[i];
    if (op === 0xf4) delegates = true;
    if (op < 0x60 || op > 0x7f) continue;
    const size = op - 0x5f;
    // Selectors in dispatcher comparisons, excluding bytes embedded in other PUSH operands.
    if (size <= 4 && bytes[i + size + 1] === 0x14) {
      selectors.add('0x' + bytes.subarray(i + 1, i + size + 1).toString('hex').padStart(8, '0'));
    }
    i += size;
  }
  return { selectors, delegates };
}

async function roleEvidence(reader, token, roleName, selectors, candidates) {
  const role = await reader.call(token, roleName + '()');
  const roleId = readUint(role) === null ? keccak256(roleName) : role;
  if (selectors.has(sig('getRoleMember(bytes32,uint256)'))) {
    const member = readAddress(await reader.call(token, 'getRoleMember(bytes32,uint256)', roleId.slice(2) + word(0)));
    if (member && member !== ZERO) candidates.add(member);
  }
  for (const account of candidates) {
    const result = await reader.call(token, 'hasRole(bytes32,address)', roleId.slice(2) + addressWord(account));
    if (readUint(result) === 1n) return { role: roleId, account };
  }
  return null;
}

export async function contractRisk(reader, token, roleAccounts = []) {
  const base = inspectCode(await reader.code(token));
  const flags = { upgradeable: UNKNOWN, ownerMint: UNKNOWN, ownerPause: UNKNOWN, blacklist: UNKNOWN };
  const evidence = { slots: {}, capabilities: {} };
  if (!base) return { flags, evidence };
  const selectors = new Set(base.selectors);
  let allSlots = true;
  for (const [type, slot] of Object.entries(proxySlots)) {
    const address = readAddress(await reader.storage(token, slot));
    evidence.slots[type] = address;
    if (address === null) allSlots = false;
    if (!address || address === ZERO) continue;
    const impl = type === 'beacon' ? readAddress(await reader.call(address, 'implementation()')) : address;
    if (!impl || impl === ZERO) continue;
    const code = inspectCode(await reader.code(impl));
    if (code && base.delegates) {
      flags.upgradeable = true;
      evidence.implementation = impl;
      for (const s of code.selectors) selectors.add(s);
    }
  }
  if (allSlots && !base.delegates && Object.values(evidence.slots).every(a => a === ZERO)) flags.upgradeable = false;
  const owner = readAddress(await reader.call(token, 'owner()'));
  evidence.owner = owner;
  for (const [flag, { signatures, role }] of Object.entries(privileges)) {
    const matched = signatures.filter(s => selectors.has(sig(s)));
    if (!matched.length) continue;
    const accounts = new Set(roleAccounts.filter(isAddress).slice(0, 8).map(a => a.toLowerCase()));
    if (owner && owner !== ZERO) accounts.add(owner);
    const accessControl = selectors.has(sig('hasRole(bytes32,address)'));
    const grant = accessControl ? await roleEvidence(reader, token, role, selectors, accounts) : null;
    evidence.capabilities[flag] = { signatures: matched, owner, grant,
      method: accessControl ? 'selector and role membership' : 'selector and owner (heuristic)' };
    if (grant || (!accessControl && owner && owner !== ZERO)) flags[flag] = true;
  }
  return { flags, evidence };
}

const probeAddress = '0x' + keccak256('intercom-gator/read-only-sale-probe/v1').slice(-40);
const kinds = new Map([['v2', 0], ['uniswap-v2', 0], ['v3', 1], ['uniswap-v3', 1], ['v3-router02', 2]]);

export async function simulateSale(reader, token, pool, block) {
  const unknown = reason => ({ flag: UNKNOWN, evidence: { reason } });
  const kind = kinds.get(pool?.routerKind ?? pool?.kind);
  if (kind === undefined || !isAddress(pool?.router) || !isAddress(pool?.address)) return unknown('unsupported route');
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
  return { flag: UNKNOWN, evidence };
}
