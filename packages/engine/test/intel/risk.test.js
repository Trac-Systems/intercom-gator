import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkRisk, createRiskService } from '../../src/intel/risk.js';
import { contractRisk, evmReader, simulateSale } from '../../src/intel/evm.js';
import { keccak256 } from '../../src/intel/keccak.js';
import { poolRisk } from '../../src/intel/pool.js';
import { addressWord, DAY, selector, word, ZERO } from '../../src/intel/values.js';

const fixture = name => JSON.parse(readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8'));
const usdt = fixture('usdt'), weth = fixture('weth'), route = fixture('router-v2');
const asset = 'ethereum:' + usdt.address, block = usdt.block, zero = '0x' + word(0);
const account = '0x' + '1'.repeat(40), impl = '0x' + '2'.repeat(40);
function fixtureRpc(f) {
  return { async call(chain, method, params) {
    assert.equal(chain, 'ethereum');
    if (method === 'eth_blockNumber') return f.block;
    const hit = f.calls.find(c => c.method === method && JSON.stringify(params) === JSON.stringify(c.params));
    if (hit) return hit.response.result;
    if (method === 'eth_getStorageAt') return zero;
    throw Error('no fixture');
  } };
}

test('USDT runtime and owner RPC capture identify three privileged entry points', async () => {
  const result = await checkRisk(asset, { rpc: fixtureRpc(usdt), bundle: {} });
  assert.equal(result.flags.ownerMint, true);
  assert.equal(result.flags.ownerPause, true);
  assert.equal(result.flags.blacklist, true);
  assert.deepEqual(result.evidence.capabilities.ownerMint.signatures, ['issue(uint256)']);
  assert.equal(result.evidence.owner, '0x' + usdt.calls[1].response.result.slice(-40));
  assert.equal(result.flags.unsellable, 'unknown');
});

test('WETH: a recognised dispatcher without mint, pause or blacklist entry points answers false', async () => {
  const result = await checkRisk('ethereum:' + weth.address, { rpc: fixtureRpc(weth), bundle: {} });
  assert.equal(result.flags.ownerMint, false);
  assert.equal(result.flags.ownerPause, false);
  assert.equal(result.flags.blacklist, false);
  assert.equal(result.flags.upgradeable, false);
  assert.equal(result.evidence.owner, null);
  assert.equal(result.evidence.capabilities.ownerMint.method, 'no known entry point in the dispatcher');
});

for (const kind of ['v2', 'v3', 'v3-router02']) {
  test('round trip matches recorded Ethereum ' + kind + ' call and proceeds', async () => {
    const f = fixture('router-' + kind);
    let matched = false;
    const reader = { async read(method, [call, tag, override]) {
      assert.equal(method, f.method);
      assert.deepEqual(call, f.call);
      assert.equal(tag, f.block);
      assert.deepEqual(Object.keys(override), [f.account]);
      assert.equal(override[f.account].balance, f.balance);
      assert.equal(keccak256(Buffer.from(override[f.account].code.slice(2), 'hex')), f.runtimeHash);
      matched = true;
      return f.response.result;
    } };
    const result = await simulateSale(reader, f.assetAddress, f.pool, f.block);
    assert.ok(matched);
    assert.equal(result.flag, false);
    assert.ok(BigInt(result.evidence.proceedsWei) > 0n);
  });
}

test('sell-stage reverts and zero proceeds are scoped to a completed buy', async () => {
  for (const [stage, bought, proceeds, expected] of [
    [1, 0, 0, 'unknown'], [2, 3, 0, 'unknown'], [3, 3, 0, 'unknown'],
    [4, 3, 0, true], [5, 3, 0, true], [5, 0, 1, 'unknown'], [5, 3, 1, false],
  ]) {
    const reader = { read: () => '0x' + [stage, bought, proceeds].map(word).join('') };
    assert.equal((await simulateSale(reader, route.assetAddress, route.pool, route.block)).flag, expected);
  }
  const rpc = { call() { throw Error('state overrides unsupported'); } };
  assert.equal((await simulateSale(evmReader(rpc, 'ethereum', block), route.assetAddress, route.pool, block)).flag, 'unknown');
});

for (const [slot, beacon] of [
  ['0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', false],
  [keccak256('PROXIABLE'), false],
  ['0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50', true],
]) {
  test('reads implementation selectors and checks roles through proxy slot ' + slot.slice(0, 10), async () => {
    const code = ['mint(address,uint256)', 'hasRole(bytes32,address)'].map(f => '63' + selector(f).slice(2) + '14').join('');
    const reader = {
      code: a => a === usdt.address ? '0x6000f4' : '0x' + code,
      storage: (_, s) => s === slot ? '0x' + addressWord(beacon ? account : impl) : zero,
      call: (to, s, args) => {
        if (beacon && to === account && s === 'implementation()') return '0x' + addressWord(impl);
        assert.equal(to, usdt.address);
        if (s === 'owner()') return zero;
        if (s === 'hasRole(bytes32,address)') {
          assert.equal(args, keccak256('MINTER_ROLE').slice(2) + addressWord(account));
          return '0x' + word(1);
        }
        return '0x';
      },
    };
    const r = await contractRisk(reader, usdt.address, [account]);
    assert.equal(r.flags.upgradeable, true);
    assert.equal(r.flags.ownerMint, true);
    assert.equal(r.evidence.capabilities.ownerMint.grant.account, account);
  });
}

test('V2 lock and liquidity checks retain incomplete LP ownership as unknown', async () => {
  let eoaBalance = 0, locked = 4;
  const pool = { ...route.pool, holders: [account, account], createdAt: DAY };
  const reader = {
    code: a => a === account ? '0x' : '0x01',
    call(to, sig, args) {
      if (sig === 'token0()') return '0x' + addressWord(usdt.address);
      if (sig === 'token1()') return '0x' + addressWord(weth.address);
      if (sig === 'totalSupply()') return '0x' + word(10);
      if (sig === 'balanceOf(address)') return '0x' + word(args === addressWord(ZERO) ? locked : args === addressWord(account) ? eoaBalance : 0);
      if (sig === 'getReserves()') return '0x' + [2500_000000, 10n ** 18n, 9].map(word).join('');
      if (sig === 'decimals()') return '0x' + word(to === usdt.address ? 6 : 18);
    },
  };
  const opts = { at: DAY + 10, prices: { [usdt.address]: 1 }, lowLiquidityUsd: 5001 };
  const first = await poolRisk(reader, usdt.address, pool, opts);
  assert.deepEqual(first.flags, { veryNew: true, lowLiquidity: true, lpUnlocked: 'unknown' });
  assert.equal(first.evidence.liquidity.usd, 5000);
  eoaBalance = 6;
  assert.equal((await poolRisk(reader, usdt.address, pool, opts)).flags.lpUnlocked, true);
  locked = 10; eoaBalance = 0;
  assert.equal((await poolRisk(reader, usdt.address, pool, opts)).flags.lpUnlocked, false);
  const both = await poolRisk(reader, usdt.address, pool, { ...opts, at: DAY * 2,
    prices: { [usdt.address]: 1, [weth.address]: 3100 } });
  assert.deepEqual(both.flags, { lpUnlocked: false, veryNew: false, lowLiquidity: false });
  assert.equal(both.evidence.liquidity.usd, 5600);
});

test('hints stay isolated and a coalesced local check publishes once per TTL', async () => {
  let time = 100, heads = 0;
  const published = [], source = fixtureRpc(usdt);
  const risk = createRiskService({ rpc: { call(...args) { if (args[1] === 'eth_blockNumber') heads++; return source.call(...args); } },
    bundle: {}, now: () => time, ttlMs: 20, transport: { send(...args) { published.push(args); } } });
  const channel = 'gator/meta';
  const hint = { from: 'a'.repeat(64), channel, ts: time, message: { v: 1, t: 'risk', asset, at: time,
    method: 'peer', flags: { ownerMint: false } } };
  assert.equal(risk.consume(channel, hint), true);
  assert.equal(risk.get(asset), null);
  assert.equal(risk.hints(asset)[0].flags.ownerMint, false);
  const [a, b] = await Promise.all([risk.checkRisk(asset), risk.checkRisk(asset)]);
  assert.deepEqual(a, b);
  assert.equal(a.flags.ownerMint, true);
  a.flags.ownerMint = false;
  assert.equal((await risk.checkRisk(asset)).flags.ownerMint, true);
  assert.equal(heads, 1);
  assert.equal(published.length, 1);
  assert.equal(published[0][1].t, 'risk');
  time += 20;
  assert.equal(risk.hints(asset).length, 0);
  await risk.checkRisk(asset);
  assert.equal(heads, 2);
});

test('unavailable block and malformed peer input cannot establish a negative risk result', async () => {
  const risk = createRiskService({ rpc: { call() { throw Error('offline'); } }, bundle: {} });
  assert.ok(Object.values((await risk.checkRisk(asset)).flags).every(x => x === 'unknown'));
  await assert.rejects(risk.checkRisk('ethereum:native'));
  assert.equal(risk.consume('gator/new', {}), false);
});


test('factory receipt establishes pool birth and bounded LP Transfer logs nominate a measurable EOA', async () => {
  const factory = '0x' + '5'.repeat(40), observed = [];
  const pair = route.pool.address, tx = '0x' + '6'.repeat(64);
  const pool = { ...route.pool, factory, discoveryTx: tx };
  const reader = {
    block: '0x100',
    read(method, params) {
      observed.push([method, params]);
      if (method === 'eth_getTransactionReceipt') return { blockNumber: '0x4', logs: [{ address: factory,
        topics: [keccak256('PairCreated(address,address,address,uint256)')], data: '0x' + addressWord(pair) + word(1) }] };
      if (method === 'eth_getBlockByNumber') return { timestamp: '0x64' };
      if (method === 'eth_getLogs') return [{ address: pair, topics: [keccak256('Transfer(address,address,uint256)'),
        zero, '0x' + addressWord(account)] }];
    },
    call(_, sig, args) {
      if (sig === 'token0()') return '0x' + addressWord(usdt.address);
      if (sig === 'token1()') return '0x' + addressWord(weth.address);
      if (sig === 'totalSupply()') return '0x' + word(10);
      if (sig === 'balanceOf(address)') return '0x' + word(args === addressWord(account) ? 9 : 0);
    },
    code: () => '0x',
  };
  const r = await poolRisk(reader, usdt.address, pool, { at: 110_000 });
  assert.equal(r.flags.veryNew, true);
  assert.equal(r.evidence.ageMs, 10_000);
  assert.equal(r.flags.lpUnlocked, true);
  assert.deepEqual(observed.filter(([m]) => m === 'eth_getLogs').map(([, [q]]) => [q.fromBlock, q.toBlock]),
    [['0x4', '0x4'], ['0xa1', '0x100']]);
  const unknown = await poolRisk({ ...reader, read: () => null }, usdt.address, pool, { at: 110_000 });
  assert.equal(unknown.flags.veryNew, 'unknown');
  assert.equal(unknown.flags.lpUnlocked, 'unknown');
});


test('standalone checkRisk finds a bundled factory pool, prefers wrapped native and reuses the local result', async () => {
  const f = route;
  const factory = '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f';
  const bundle = {
    chains: [{ id: f.chain, native: { symbol: 'ETH' } }],
    dex: { evm: [{ chain: f.chain, quoteTokens: [{ symbol: 'ALT', address: account }, { symbol: 'WETH', address: weth.address }],
      deployments: [{ kind: 'v2', address: impl }, { kind: 'v2', address: factory }] }] },
  };
  let heads = 0, lookups = 0, simulated = false;
  const rpc = { call(chain, method, params) {
    assert.equal(chain, f.chain);
    if (method === 'eth_blockNumber') { heads++; return f.block; }
    if (method === 'eth_call' && params[0].to === factory) {
      assert.equal(params[0].data, selector('getPair(address,address)') + addressWord(f.assetAddress) + addressWord(weth.address));
      lookups++; return '0x' + addressWord(f.pool.address);
    }
    if (method === 'eth_call' && params[2]) {
      assert.deepEqual(params[0], f.call);
      simulated = true; return f.response.result;
    }
    return null;
  } };
  const result = await checkRisk(asset, { rpc, bundle });
  assert.equal(result.flags.unsellable, false);
  assert.equal(simulated, true);
  assert.equal(lookups, 1);
  await checkRisk(asset, { rpc, bundle });
  assert.equal(heads, 1);
});


test('standalone pool age uses the timestamp of historical code and leaves unavailable archive state unknown', async () => {
  const head = 20_000, at = head * 12_000;
  let pastCode = '0x6000';
  const reader = {
    block: '0x' + head.toString(16),
    read(method, params) {
      if (method === 'eth_getBlockByNumber') return { timestamp: '0x' + (Number(BigInt(params[0])) * 12).toString(16) };
      if (method === 'eth_getCode') return pastCode;
      return [];
    },
    call(_, sig) {
      if (sig === 'token0()') return '0x' + addressWord(usdt.address);
      if (sig === 'token1()') return '0x' + addressWord(weth.address);
      return null;
    },
  };
  const check = () => poolRisk(reader, usdt.address, route.pool, { at, blockTimeSeconds: 12 });
  assert.equal((await check()).evidence.ageBound.minAgeMs, DAY);
  pastCode = '0x';
  assert.equal((await check()).flags.veryNew, true);
  pastCode = null;
  assert.equal((await check()).flags.veryNew, 'unknown');
});

test('standalone pool age reaches a day back when the signed block time is stale', async () => {
  // Base on 11-22: 0.2 s a block, signed 2 s. The first guess lands 2.4 hours back; the second steps at the pace
  // observed between the head and that block.
  const head = 1_000_000, at = head / 5 * 1000;
  const reader = {
    block: '0x' + head.toString(16),
    read(method, params) {
      if (method === 'eth_getBlockByNumber') return { timestamp: '0x' + Math.floor(Number(BigInt(params[0])) / 5).toString(16) };
      if (method === 'eth_getCode') return '0x6000';
      return [];
    },
    call(_, sig) {
      if (sig === 'token0()') return '0x' + addressWord(usdt.address);
      if (sig === 'token1()') return '0x' + addressWord(weth.address);
      return null;
    },
  };
  const result = await poolRisk(reader, usdt.address, route.pool, { at, blockTimeSeconds: 2 });
  assert.ok(result.evidence.ageBound.minAgeMs >= DAY && result.evidence.ageBound.minAgeMs < DAY + 2000);
  assert.equal(result.flags.veryNew, false);
});
