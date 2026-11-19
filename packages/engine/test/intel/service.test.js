import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createIntel, createNewTokens, migrations } from '../../src/intel/index.js';
import { DAY } from '../../src/intel/values.js';
import { engineData } from '../../src/intel/market-data.js';

const at = 100 * DAY, key = 'a'.repeat(64), other = 'b'.repeat(64);
const a = '0x' + 'a'.repeat(40), b = '0x' + 'b'.repeat(40), p = '0x' + 'c'.repeat(40);
const asset = 'base:' + a, poolMessage = { t: 'pool', v: 1, chain: 'base', token0: a, token1: b,
  pool: p, kind: 'v2', dex: 'Uniswap V2', block: 1, tx: '0x' + '1'.repeat(64) };
function transport(channels = []) {
  return Object.assign(new EventEmitter(), { publicKey: key, joined: new Set(channels), policies: [], sent: [],
    channels() { return [...this.joined]; },
    async join(c, policy) { this.joined.add(c); this.policies.push(policy); return true; },
    async leave(c) { return this.joined.delete(c); },
    send(...args) { this.sent.push(args); return true; },
  });
}
function database(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const migration of migrations) migration.up(db);
  return { reader: db, writer: db, transaction: fn => fn() };
}
const env = (channel, message, from = other) => ({ channel, message, from, ts: at });

test('subscription lifecycle, mute filter, deferred spot check and own publication', async () => {
  const net = transport(['gator/new']);
  const intel = createIntel({ rpc: { call() { assert.fail('unexpected local RPC'); } },
    publicRpc: { call() { throw Error('offline'); } }, bundle: {}, transport: net,
    now: () => at, isMuted: k => k === 'c'.repeat(64) });
  await Promise.all([intel.start(), intel.start()]);
  assert.deepEqual(net.channels(), ['gator/new', 'gator/meta']);
  assert.deepEqual(net.policies, [{ verifySignature: true, powDifficulty: 10, maxReceiveBytes: 8192 }]);
  assert.equal(net.listenerCount('message'), 1);
  const msg = { t: 'risk', v: 1, asset, at, flags: { ownerMint: true }, method: 'peer' };
  assert.equal(await intel.consume('gator/meta', env('gator/meta', msg, 'c'.repeat(64))), false);
  net.emit('message', 'gator/meta', env('gator/meta', msg));
  assert.equal(intel.risk.get(asset), null);
  const result = await intel.checkNext();
  assert.equal(result.local.flags.ownerMint, 'unknown');
  assert.deepEqual(result.comparisons[0], { reporter: other, at, agrees: [], differs: [], unknown: ['ownerMint'] });
  assert.equal(net.sent[0][0], 'gator/meta');
  assert.equal(await intel.checkNext(), undefined);
  await intel.stop();
  assert.equal(net.listenerCount('message'), 0);
  assert.deepEqual(net.channels(), ['gator/new']);
});

test('failed join rolls back earlier subscriptions and allows a clean retry', async () => {
  const net = transport();
  const join = net.join.bind(net);
  net.join = async (...args) => args[0] === 'gator/meta' ? false : join(...args);
  const intel = createIntel({ rpc: {}, bundle: {}, transport: net });
  await assert.rejects(intel.start(), /join/);
  assert.deepEqual(net.channels(), []);
  assert.equal(net.listenerCount('message'), 0);
  net.join = join;
  await intel.start();
  assert.equal(net.channels().length, 2);
  await intel.stop();
});

test('authenticated discovery votes and graduation survive recreation without mutating market registry', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const m of migrations) m.up(db);
    const store = { reader: db, writer: db, transaction: fn => fn() };
    let metrics = {};
    const options = { store, now: () => at, isKnownAsset: id => id.endsWith(b), metricsFor: () => metrics, thresholds: { reporters: 2 } };
    let tracker = createNewTokens(options);
    tracker.consume('gator/new', env('gator/new', { ...poolMessage, liquidity: 1e10 }));
    tracker = createNewTokens(options);
    assert.equal(tracker.list()[0].reporters, 1);
    assert.equal(tracker.list()[0].liquidityUsd, null);
    tracker.consume('gator/new', env('gator/new', poolMessage, key));
    metrics = { liquidityUsd: 100_000, trades: 100, createdAt: at - DAY };
    assert.deepEqual(tracker.list(), []);
    metrics = {};
    assert.deepEqual(createNewTokens(options).list(), []);
  } finally { db.close(); }
});

test('Solana directory discoveries retain case-sensitive mints without an on-chain transaction ID', () => {
  const tracker = createNewTokens({ now: () => at });
  const m = { ...poolMessage, chain: 'solana', pool: 'Z'.repeat(44), token0: 'A'.repeat(43),
    token1: 'a'.repeat(43), kind: 'whirlpool', block: null, tx: null };
  assert.ok(tracker.consume('gator/new', env('gator/new', m)));
  assert.deepEqual(tracker.list().map(t => t.asset).sort(), ['solana:' + m.token0, 'solana:' + m.token1]);
  assert.equal(tracker.consume('gator/new', env('gator/new', { ...m, token1: m.token0 }, key)), false);
});

test('engine adapter uses local pools, registered base asset, recent trades and calendar-day global inputs', async t => {
  const store = database(t), db = store.writer;
  db.exec(`CREATE TABLE pools (chain,pool,dex,kind,liquidity,firstSeen,token0,token1,tx);
    CREATE TABLE markets (id,kind,chain,base,quote);
    CREATE TABLE asset_markets (asset,market);
    CREATE TABLE engine_trades (market,at);`);
  const market = 'dex:base:' + p;
  db.prepare('INSERT INTO pools VALUES(?,?,?,?,?,?,?,?,?)').run('base', p, 'fixture', 'v2', 40, at, a, b, poolMessage.tx);
  db.prepare('INSERT INTO markets VALUES(?,?,?,?,?)').run(market, 'dex', 'base', asset, 'base:' + b);
  db.prepare('INSERT INTO asset_markets VALUES(?,?)').run(asset, market);
  db.prepare('INSERT INTO engine_trades VALUES(?,?)').run(market, at - 1);
  store.getPrice = id => ({ price: id === asset ? '2' : '1' });
  store.candles = ({ asset, tf }) => {
    assert.equal(tf, '1d');
    return [{ ts: at, close: asset === 'bitcoin:native' ? '10' : '4' }];
  };
  const registry = { markets: new Map([[market, { base: asset }]]), symbols: new Map([['ABC', new Set([asset])]]) };
  const opts = engineData({ store, bundle: { dex: { evm: [{ chain: 'base', quoteTokens: [{ address: b }],
    deployments: [{ name: 'fixture', kind: 'v2', router: a, address: b }] }] } }, registry, clock: () => at,
    global: () => ({ volume24h: 123, btcDominance: 55 }) });
  assert.ok(opts.isKnownAsset('base:' + b));
  assert.deepEqual(opts.resolveAssets(poolMessage), [asset]);
  assert.equal(opts.resolveSymbol('ABC'), asset);
  assert.equal(opts.resolveContext(asset).pool.router, a);
  assert.deepEqual(opts.metricsFor(asset), { trades: 1, liquidityUsd: 40 });
  opts.sampleGlobal(at);
  const [day] = await opts.dailyMarket({ from: at, to: at + DAY });
  assert.deepEqual([day.volumeUsd, day.btcDominance, day.btcClose, day.ethClose], [123, 55, '10', '4']);
});

test('five-minute verifier interval actually polls and stop cancels it', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  const rpc = { async call() { calls++; return '0x' + '20'.padStart(64, '0') + '0'.repeat(64); } };
  const intel = createIntel({ rpc, bundle: { paidExtras: { base: a } } });
  await intel.start();
  await intel.settled();
  assert.equal(calls, 3);
  t.mock.timers.tick(299999);
  assert.equal(calls, 3);
  t.mock.timers.tick(1);
  await intel.extras.refresh();
  assert.equal(calls, 6);
  await intel.stop();
  t.mock.timers.tick(600000);
  assert.equal(calls, 6);
});

test('remote risk checks share one cooldown across authors and require a public RPC adapter', async () => {
  let time = at, paid = 0;
  const publicCalls = [];
  const opts = { now: () => time, rpc: { call() { paid++; return null; } } };
  const intel = createIntel({ ...opts, publicRpc: { call(chain, method) { publicCalls.push([chain, method]); return null; } } });
  const hint = (target, reporter) => env('gator/meta', { t: 'risk', v: 1, asset: target, at: time,
    flags: { ownerMint: false }, method: 'fixture' }, reporter);
  const second = 'base:' + b;
  await intel.consume('gator/meta', hint(asset, other));
  await intel.consume('gator/meta', hint(second, key));
  assert.equal((await intel.checkNext()).local.asset, asset);
  assert.equal(await intel.checkNext(), undefined);
  time += 59_999;
  await intel.consume('gator/meta', hint(second, key));
  assert.equal(await intel.checkNext(), undefined);
  time++;
  await intel.consume('gator/meta', hint(second, other));
  assert.equal((await intel.checkNext()).local.asset, second);
  assert.deepEqual(publicCalls, [['base', 'eth_blockNumber'], ['base', 'eth_blockNumber']]);
  const localOnly = createIntel(opts);
  await localOnly.consume('gator/meta', hint(asset, other));
  assert.equal(await localOnly.checkNext(), undefined);
  assert.equal(paid, 0);
});
