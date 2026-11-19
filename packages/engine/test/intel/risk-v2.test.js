import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimited } from '../../src/scheduler/index.js';
import { contractRisk, evmReader, inspectCode, UNKNOWN } from '../../src/intel/evm.js';
import { createRiskService, FLAG_NAMES, METHOD } from '../../src/intel/risk.js';
import { poolRisk } from '../../src/intel/pool.js';
import { addressWord, selector, word, ZERO } from '../../src/intel/values.js';

const token = '0x' + 'a'.repeat(40), impl = '0x' + 'b'.repeat(40), owner = '0x' + 'c'.repeat(40);
const asset = 'ethereum:' + token;
const zero = '0x' + word(0);
// A dispatcher `PUSH4 sel EQ` per signature, like solc's legacy dispatcher.
const dispatcher = signatures => signatures.map(f => '63' + selector(f).slice(2) + '14').join('');
const erc20 = ['transfer(address,uint256)', 'balanceOf(address)', 'totalSupply()', 'approve(address,uint256)',
  'transferFrom(address,address,uint256)'];
const plain = '0x' + dispatcher(erc20);

function readerFor({ code = {}, calls = {}, storage = {} }) {
  return {
    stats: { calls: 0, refused: 0, reverted: 0, reasons: [] },
    code: a => code[a] ?? '0x',
    storage: (a, slot) => storage[slot] ?? zero,
    call: (to, sig) => calls[to + ':' + sig] ?? null,
  };
}

test('budget refusals leave every flag unknown and name the budget as the reason', async () => {
  const rpc = { call() { throw new Error('call() must not be used when batch() is available'); },
    batch() { return Promise.reject(new RateLimited(Date.now() + 60_000)); } };
  const result = await createRiskService({ rpc, bundle: {} }).checkRisk(asset);
  assert.ok(FLAG_NAMES.every(k => result.flags[k] === UNKNOWN));
  assert.equal(result.method, METHOD);
  assert.equal(result.evidence.reason, 'block unavailable (rpc budget refused)');
  assert.ok(FLAG_NAMES.every(k => /rpc budget refused/.test(result.evidence.why[k])));
  assert.deepEqual(result.evidence.rpc, { calls: 1, refused: 1, reverted: 0, reasons: ['rpc budget refused'] });
});

test('a refusal after the block pin leaves the dependent flags unknown with the reason attached', async () => {
  let n = 0;
  const rpc = { async batch(chain, [{ method }]) {
    n++;
    if (method === 'eth_blockNumber') return ['0x10'];
    throw new RateLimited(Date.now() + 30_000);
  } };
  const result = await createRiskService({ rpc, bundle: {} }).checkRisk(asset);
  assert.ok(FLAG_NAMES.every(k => result.flags[k] === UNKNOWN));
  assert.match(result.evidence.why.ownerMint, /token code unavailable \(rpc budget refused\)/);
  assert.match(result.evidence.why.unsellable, /no pool found/);
  assert.ok(result.evidence.rpc.refused >= 1 && result.evidence.rpc.calls === n);
});

test('the per-check call cap and deadline bound a check', async () => {
  const rpc = { batch: async () => ['0x1'] };
  const capped = evmReader(rpc, 'ethereum', '0x1', { maxCalls: 2 });
  assert.equal(await capped.read('eth_chainId', []), '0x1');
  assert.equal(await capped.read('eth_gasPrice', []), '0x1');
  assert.equal(await capped.read('eth_getBalance', [token, '0x1']), null);
  assert.deepEqual(capped.stats, { calls: 2, refused: 1, reverted: 0, reasons: ['per-check call cap (2)'] });
  const hung = evmReader({ batch: () => new Promise(() => {}) }, 'ethereum', '0x1', { deadline: Date.now() + 30 });
  const alive = setTimeout(() => {}, 1000); // the deadline timer is unref'd and must not hold a node process open
  assert.equal(await hung.read('eth_chainId', []), null);
  clearTimeout(alive);
  assert.deepEqual(hung.stats.reasons, ['check deadline']);
  const reverted = evmReader({ call: () => Promise.reject(Object.assign(new Error('x'), { kind: 'reverted' })) }, 'ethereum', '0x1');
  assert.equal(await reverted.call(token, 'owner()'), null);
  assert.deepEqual([reverted.stats.reverted, reverted.stats.refused], [1, 0]);
});

test('Multicall3 batches view calls into one dispatch and decodes failed sub-calls as null', async () => {
  const sent = [];
  const multicall = '0xca11bde05977b3631167028862be2a173976ca11';
  // aggregate3 result: [(true, word(7)), (false, 0x)]
  const tuple = (ok, data) => word(ok ? 1 : 0) + word(64) + word(data.length / 2) + data.padEnd(Math.ceil(data.length / 64) * 64, '0');
  const t0 = tuple(true, word(7)), t1 = tuple(false, '');
  const result = '0x' + word(32) + word(2) + word(64) + word(64 + t0.length / 2) + t0 + t1;
  const reader = evmReader({ call: async (chain, method, params) => { sent.push(params[0].to); return result; } },
    'ethereum', '0x1', { multicall });
  assert.deepEqual(await reader.calls([[token, 'decimals()'], [token, 'owner()']]), ['0x' + word(7), null]);
  assert.deepEqual(sent, [multicall]);
  assert.equal(reader.stats.calls, 1);
});

for (const [name, code] of [
  ['EIP-1167', '0x363d3d373d3d3d363d73' + impl.slice(2) + '5af43d82803e903d91602b57fd5bf3'],
  ['Solady/robinhood launchpad', '0x3d3d3d3d363d3d37363d73' + impl.slice(2) + '5af43d3d93803e602a57fd5bf3'],
]) {
  test(name + ' forwarder: fixed implementation, its dispatcher decides the capabilities', async () => {
    assert.equal(inspectCode(code).forwarder, impl);
    const reader = readerFor({ code: { [token]: code, [impl]: plain } });
    const r = await contractRisk(reader, token);
    assert.deepEqual(r.flags, { upgradeable: false, ownerMint: false, ownerPause: false, blacklist: false });
    assert.equal(r.evidence.implementation, impl);
    assert.deepEqual(r.why, {});
  });
}

test('CBOR metadata bytes are not code: a stray 0xf4 in the IPFS hash does not make a token a proxy', async () => {
  const metadata = 'a264697066735822' + 'f4'.repeat(34) + '64736f6c6343000818' + '0033';
  assert.equal(inspectCode(plain + metadata).delegates, false);
  const r = await contractRisk(readerFor({ code: { [token]: plain + metadata } }), token);
  assert.equal(r.flags.upgradeable, false);
  assert.equal(r.evidence.upgrade, 'no DELEGATECALL in runtime code');
});

test('ZeppelinOS slot proxy (USDC-style): upgradeable, implementation selectors with an owner are capabilities', async () => {
  const slot = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
  const reader = readerFor({ code: { [token]: '0x6000f4', [impl]: '0x' + dispatcher([...erc20, 'mint(address,uint256)', 'pause()', 'blacklist(address)']) },
    storage: { [slot]: '0x' + addressWord(impl) }, calls: { [token + ':owner()']: '0x' + addressWord(owner) } });
  const r = await contractRisk(reader, token);
  assert.deepEqual(r.flags, { upgradeable: true, ownerMint: true, ownerPause: true, blacklist: true });
  assert.equal(r.evidence.proxy, 'zeppelinos slot');
});

test('unknown stays unknown where the code cannot answer, with a reason per flag', async () => {
  // DELEGATECALL without a known slot: interface incomplete.
  let r = await contractRisk(readerFor({ code: { [token]: '0x' + dispatcher(erc20) + 'f4' } }), token);
  assert.equal(r.flags.upgradeable, UNKNOWN);
  assert.equal(r.why.upgradeable, 'DELEGATECALL without a known proxy slot');
  assert.equal(r.flags.ownerMint, UNKNOWN);
  // Unrecognised dispatcher (no ERC-20 core selectors): absence proves nothing.
  r = await contractRisk(readerFor({ code: { [token]: '0x6001' } }), token);
  assert.equal(r.flags.ownerMint, UNKNOWN);
  assert.match(r.why.ownerMint, /dispatcher not recognised/);
  // Renounced owner with the entry point present: the function may have another controller.
  r = await contractRisk(readerFor({ code: { [token]: '0x' + dispatcher([...erc20, 'blacklist(address,bool)']) },
    calls: { [token + ':owner()']: '0x' + addressWord(ZERO) } }), token);
  assert.equal(r.flags.blacklist, UNKNOWN);
  assert.equal(r.flags.ownerMint, false);
  assert.match(r.why.blacklist, /owner renounced/);
  // No code at the pinned block.
  r = await contractRisk(readerFor({}), token);
  assert.ok(Object.values(r.flags).every(v => v === UNKNOWN));
  assert.equal(r.why.ownerMint, 'no contract code at the pinned block');
});

test('an empty AccessControl role answers false; a held role answers true', async () => {
  const code = '0x' + dispatcher([...erc20, 'mint(address,uint256)', 'hasRole(bytes32,address)', 'getRoleMemberCount(bytes32)']);
  const reader = readerFor({ code: { [token]: code }, calls: { [token + ':getRoleMemberCount(bytes32)']: zero } });
  assert.equal((await contractRisk(reader, token)).flags.ownerMint, false);
});

test('liquidity: one priced side bounds a concentrated pool from below; engine depth is the fallback', async () => {
  const quote = '0x' + 'd'.repeat(40), pool = { address: '0x' + 'e'.repeat(40), kind: 'v3' };
  const reader = { block: null, stats: { reasons: [] }, code: () => '0x', read: () => null, call(to, sig, args) {
    if (sig === 'token0()') return '0x' + addressWord(token);
    if (sig === 'token1()') return '0x' + addressWord(quote);
    if (sig === 'decimals()') return '0x' + word(to === quote ? 6 : 18);
    if (sig === 'balanceOf(address)') return '0x' + word(to === quote ? 250_000n * 10n ** 6n : 10n ** 24n);
    return null;
  } };
  let r = await poolRisk(reader, token, pool, { at: 1, prices: { [quote]: 1 } });
  assert.equal(r.flags.lowLiquidity, false);
  assert.equal(r.evidence.liquidity.atLeastUsd, 250_000);
  r = await poolRisk(reader, token, pool, { at: 1, prices: { [quote]: 1 }, lowLiquidityUsd: 1e6 });
  assert.equal(r.flags.lowLiquidity, UNKNOWN);
  assert.match(r.why.lowLiquidity, /lower bound below the threshold/);
  r = await poolRisk(reader, token, pool, { at: 1, liquidityUsd: 1200 });
  assert.equal(r.flags.lowLiquidity, true);
  assert.equal(r.evidence.liquidity.method, 'engine-measured pool depth');
  assert.match(r.why.lpUnlocked, /not fungible LP tokens/);
});

// v0.1.0's acceptance rule for a gator/meta risk message (risk.js consume at ae1c336/2d5c18d), frozen here.
const v010Flags = new Set(['unsellable', 'ownerMint', 'ownerPause', 'blacklist', 'upgradeable', 'lpUnlocked', 'veryNew', 'lowLiquidity']);
function v010Accepts(m) {
  return m.v === 1 && m.t === 'risk' && typeof m.method === 'string' && m.method.length <= 256 && m.flags &&
    typeof m.flags === 'object' && !Array.isArray(m.flags) && Object.keys(m.flags).length > 0 &&
    Object.entries(m.flags).every(([k, v]) => v010Flags.has(k) && (typeof v === 'boolean' || v === 'unknown')) &&
    Buffer.byteLength(JSON.stringify(m)) <= 8192;
}

test('compat: a v2 result is a valid v0.1.0 message, and v1 hints are accepted quietly but never compared', async () => {
  let time = 1_000;
  const sent = [];
  const rpc = { batch: async (chain, [{ method }]) => [method === 'eth_blockNumber' ? '0x10' : plain] };
  const risk = createRiskService({ rpc, bundle: {}, now: () => time, transport: { send: (c, m) => sent.push([c, m]) } });
  const v1 = { from: 'f'.repeat(64), channel: 'gator/meta', ts: time, message: { v: 1, t: 'risk', asset, at: time,
    method: 'evm:selectors+roles+proxy-slots+router-roundtrip+reserves/v1',
    flags: { ownerMint: true, upgradeable: 'unknown', lpUnlocked: 'unknown' } } };
  assert.equal(risk.consume('gator/meta', v1), true);
  const { local, comparisons } = await risk.spotCheck(asset);
  assert.equal(local.flags.ownerMint, false);
  assert.deepEqual(comparisons[0].differs, []);
  assert.deepEqual(comparisons[0].unknown.sort(), ['lpUnlocked', 'ownerMint', 'upgradeable']);
  assert.equal(sent.length, 1);
  const [channel, message] = sent[0];
  assert.equal(channel, 'gator/meta');
  assert.deepEqual(Object.keys(message), ['t', 'v', 'asset', 'at', 'flags', 'method']);
  assert.ok(v010Accepts(message));
  assert.ok(Object.keys(message.flags).every(k => v010Flags.has(k)));
  // A v0.1.1 peer's v2 hint is accepted by v0.1.1 and compared.
  time += 1;
  assert.equal(risk.consume('gator/meta', { ...v1, from: 'e'.repeat(64), ts: time,
    message: { ...message, at: time, flags: { ...message.flags } } }), true);
  const again = await risk.spotCheck(asset);
  const v2 = again.comparisons.find(c => c.method === METHOD);
  assert.ok(v2.agrees.includes('ownerMint'));
});

test('a launchpad pair created before liquidity is an empty pool: $0, LP undecidable; a funded pool is preferred', async () => {
  const { findPool } = await import('../../src/intel/routes.js');
  const quote = '0x' + 'd'.repeat(40), empty = '0x' + '1'.repeat(40), funded = '0x' + '2'.repeat(40);
  const reader = { block: '0x10', stats: { reasons: [] }, code: () => '0x', read: () => null, call(to, sig) {
    if (sig === 'token0()') return '0x' + addressWord(token);
    if (sig === 'token1()') return '0x' + addressWord(quote);
    if (sig === 'getReserves()' || sig === 'totalSupply()') return '0x' + word(0).repeat(sig === 'getReserves()' ? 3 : 1);
    if (sig === 'decimals()') return '0x' + word(18);
    return null;
  } };
  const r = await poolRisk(reader, token, { address: empty, kind: 'v2' }, { at: 1 });
  assert.equal(r.flags.lowLiquidity, true);
  assert.equal(r.evidence.liquidity.method, 'empty pool (no reserves)');
  assert.equal(r.flags.lpUnlocked, UNKNOWN);
  assert.equal(r.why.lpUnlocked, 'no LP supply (empty pool)');
  const dex = { quoteTokens: [{ symbol: 'WETH', address: quote }], deployments: [
    { kind: 'v2', address: '0x' + '3'.repeat(40) }, { kind: 'v2', address: '0x' + '4'.repeat(40) }] };
  const lookup = { multicall: true, async calls(list) {
    return list.map(([to, sig]) => sig === 'getPair(address,address)' ? '0x' + addressWord(to === dex.deployments[0].address ? empty : funded)
      : '0x' + word(to === funded ? 5 : 0) + word(0) + word(0));
  } };
  assert.equal((await findPool(lookup, token, 'bsc', dex, 'ETH')).address, funded);
});
