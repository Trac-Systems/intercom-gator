import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadBundle } from '@gator/bundle';
import { openStore } from '@gator/store';
import { Engine, migrations as engineMigrations } from '../../src/index.js';
import { computeFearGreed, createIntel, migrations } from '../../src/intel/index.js';
import { engineData } from '../../src/intel/market-data.js';
import { DAY } from '../../src/intel/values.js';

const at = 20_000 * DAY, btc = 'bitcoin:native', eth = 'ethereum:native';
const venueDays = Array.from({ length: 123 }, (_, i) => ({
  at: at + (i - 121) * DAY, btcClose: 100 + (i % 37) * 2, ethClose: 200 + (i % 23),
}));

function fixture(t) {
  const store = openStore({ file: ':memory:', profile: 'small', migrations: [...engineMigrations, ...migrations] });
  t.after(() => store.close());
  const start = Date.now(), state = { offset: 0, offline: false, requests: [] };
  const clock = () => at + 60_000 + state.offset + Date.now() - start;
  const engine = new Engine({ bundle: loadBundle(), store, transport: { publicKey: '1'.repeat(64) }, clock,
    rpcConfig: { async fetch(url) {
      state.requests.push(url);
      if (state.offline) throw new Error('Venue unavailable');
      const field = url.includes('/btcusd/') ? 'btcClose' : 'ethClose';
      const ohlc = venueDays.filter(d => d.at <= clock()).slice(-Number(new URL(url).searchParams.get('limit'))).map(d => ({
        // A traded market's day has a range (a flat series reads as a market nobody trades).
        timestamp: String(d.at / 1000), open: d[field], high: d[field] + 1, low: d[field] - 1, close: d[field], volume: 999,
      }));
      return Response.json({ data: { ohlc } });
    } } });
  const calls = t.mock.method(engine, 'candles');
  function discover() {
    for (const sym of ['BTC', 'ETH']) engine.registry.cex('bitstamp', sym, 'USD', sym + '/USD');
  }
  // Local history is the node's own aggregated price (raw quotes no longer draw candles).
  function observe(sym, ts, close) {
    store.insertObservations([{ market: 'cex:bitstamp:' + sym + '-USD', reporter: engine.transport.publicKey,
      srcTs: ts, at: ts, price: String(close), priceUsd: String(close) }]);
    store.recordPrices([{ asset: sym === 'BTC' ? 'bitcoin:native' : 'ethereum:native', price: String(close), at: ts }]);
  }
  return { engine, store, state, calls: calls.mock, discover, observe };
}

test('fresh node shares budgeted daily bars with comparison points and caches them across restarts and midnight', async t => {
  const { engine, calls, store, state, discover } = fixture(t);
  const index = createIntel({ engine }).fearGreed;
  assert.equal((await index.snapshot()).value, null);
  assert.equal(calls.callCount(), 0); // startup before any usable venue is discovered
  discover();
  const [s, concurrent] = await Promise.all([index.snapshot(), index.snapshot()]);
  assert.deepEqual(concurrent, s);
  assert.equal(s.value, computeFearGreed({ at, daily: venueDays }).value);
  assert.ok(Number.isInteger(s.value));
  assert.equal(s.partial, true);
  assert.deepEqual(s.missing, ['Volume', 'Social', 'BTC dominance']);
  assert.deepEqual(s.inputs.map(i => i.days), [undefined, undefined,
    { have: 0, need: 31 }, { have: 0, need: 8 }, { have: 0, need: 31 }]);
  for (const [name, days] of Object.entries({ yesterday: 1, lastWeek: 7, lastMonth: 30 })) {
    const expected = computeFearGreed({ at: at - days * DAY, daily: venueDays });
    assert.deepEqual(s.historyPoints[name], expected);
    assert.equal(s[name], expected.value);
    assert.ok(Number.isInteger(s[name]));
  }
  assert.deepEqual([s.history30d.at(-2), s.history30d.at(-8)], [s.yesterday, s.lastWeek]);
  assert.deepEqual(calls.calls.map(c => c.arguments[0]), [btc, eth]);
  assert.deepEqual(state.requests.map(url => new URL(url).pathname), ['/api/v2/ohlc/btcusd/', '/api/v2/ohlc/ethusd/']);
  assert.equal(engine.budget.used, 2);
  assert.equal(store.fearGreedHistory()[0].partial, 1);
  assert.deepEqual(await createIntel({ engine }).fearGreed.snapshot(), s);
  await index.snapshot(at - DAY);
  assert.equal(calls.callCount(), 2);
  state.offset += DAY;
  const next = await index.snapshot();
  assert.equal(next.at, at + DAY);
  assert.deepEqual(next.historyPoints.yesterday, index.history({ from: at, to: at + DAY })[0]);
  assert.equal(calls.callCount(), 4);
  assert.equal(state.requests.length, 4);
});

test('fresh local closes override cached venue days and a complete result replaces the SQLite partial', async t => {
  const { engine, store, calls, discover, observe } = fixture(t);
  discover();
  const index = createIntel({ engine, postsSince: () => [] }).fearGreed;
  const original = await index.snapshot();
  assert.deepEqual(original.missing, ['Volume', 'BTC dominance']);
  const market = engineData(engine);
  const daily = venueDays.filter(d => d.at < at).map(d => ({ ...d, volumeUsd: 100, btcDominance: 50 }));
  daily.at(-1).btcClose = 900;
  observe('BTC', at - DAY, 900);
  const filled = await market.dailyMarket({ from: at - 91 * DAY, to: at });
  const last = filled.find(d => d.at === at - DAY);
  assert.equal(last.btcClose, '900');
  assert.equal(+last.ethClose, daily.at(-1).ethClose);
  for (const d of daily.slice(-31)) {
    engine.global = () => ({ volume24h: 100, btcDominance: null });
    market.sampleGlobal(d.at);
    engine.global = () => ({ volume24h: null, btcDominance: 50 });
    market.sampleGlobal(d.at + 1);
  }
  const complete = await index.snapshot(), expected = computeFearGreed({ at, daily, posts: [] });
  assert.equal(complete.value, expected.value);
  assert.deepEqual(complete.inputs, expected.inputs);
  assert.equal(complete.partial, false);
  assert.deepEqual(complete.missing, []);
  assert.equal(calls.callCount(), 2);
  assert.equal(store.fearGreedHistory()[0].partial, 0);
  assert.deepEqual(createIntel({ engine }).fearGreed.history()[0], expected);
});

test('a full local calendar reproduces the complete score without a venue request', async t => {
  const { engine, calls, discover, observe } = fixture(t);
  discover();
  const market = engineData(engine);
  const daily = venueDays.filter(d => d.at < at).map(d => ({ ...d, volumeUsd: d.btcClose * 10, btcDominance: 50 }));
  for (const d of daily) {
    observe('BTC', d.at, d.btcClose);
    observe('ETH', d.at, d.ethClose);
    engine.global = () => ({ volume24h: d.volumeUsd, btcDominance: d.btcDominance });
    market.sampleGlobal(d.at);
  }
  const s = await createIntel({ engine, postsSince: () => [] }).fearGreed.snapshot();
  // Recorded from 9ca3002 for this non-flat fixture.
  assert.equal(s.value, 46);
  assert.deepEqual(s.inputs.map(i => i.value), [45, 41, 42, 50, 50]);
  assert.deepEqual([s.partial, s.missing], [false, []]);
  assert.equal(s.historyPoints.lastMonth.partial, false);
  assert.equal(calls.callCount(), 0);
});

test('missing comparison days alone never spend a backfill request', async t => {
  const { engine, calls, discover, observe } = fixture(t);
  discover();
  for (const d of venueDays.filter(d => at - 91 * DAY <= d.at && d.at < at)) {
    observe('BTC', d.at, d.btcClose);
    observe('ETH', d.at, d.ethClose);
  }
  const s = await createIntel({ engine }).fearGreed.snapshot();
  assert.ok(Number.isInteger(s.value));
  assert.equal(s.lastWeek, null);
  assert.deepEqual(s.historyPoints.lastWeek.inputs[0].days, { have: 84, need: 91 });
  assert.equal(calls.callCount(), 0);
});

test('existing market days and complete scores survive the SQLite upgrade', t => {
  const dir = mkdtempSync(join(import.meta.dirname, 'runtime-')), file = join(dir, 'gator.db');
  let store = openStore({ file, migrations: migrations.slice(0, 1) });
  t.after(() => { store.close(); rmSync(dir, { recursive: true }); });
  store.writer.prepare('INSERT INTO intel_market_days VALUES (?,?,?,?)').run(at, at + 42, 700, 55);
  const inputs = ['Volatility', 'Momentum', 'Volume', 'Social', 'BTC dominance'].map(name =>
    ({ name, value: 50, ...(name === 'Social' && { authors: 'followed-or-proven' }) }));
  store.upsertFearGreed({ at, value: 50, label: 'Neutral', inputs });
  store.close();
  store = openStore({ file, migrations });
  const day = store.reader.prepare('SELECT * FROM intel_market_days').get();
  assert.deepEqual({ ...day }, { at, observedAt: at + 42, volumeUsd: 700, btcDominance: 55 });
  const row = store.fearGreedHistory()[0];
  assert.equal(row.partial, 0);
  assert.deepEqual(row.inputs, inputs);
});

test('a venue failure is bounded for the day and local volume collects without supply', async t => {
  const { engine, state, calls, discover } = fixture(t);
  discover();
  state.offline = true;
  const market = engineData(engine);
  engine.global = () => ({ volume24h: 0, btcDominance: null });
  for (let i = 1; i <= 31; i++) market.sampleGlobal(at - i * DAY);
  const index = createIntel({ engine, postsSince: () => [] }).fearGreed;
  const s = await index.snapshot();
  assert.equal(s.value, null);
  assert.deepEqual(s.inputs.map(i => i.value), [null, null, 50, 50, null]);
  assert.deepEqual(s.inputs.at(-1).days, { have: 0, need: 31 });
  state.offline = false;
  await createIntel({ engine }).fearGreed.snapshot();
  assert.equal(calls.callCount(), 2);
  state.offset += DAY;
  assert.ok(Number.isInteger((await index.snapshot()).value));
  assert.equal(calls.callCount(), 4);
});
