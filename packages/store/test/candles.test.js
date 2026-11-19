import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './fixture.js';

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

function markets(s) {
  s.upsertAsset({ id: 'eth:native', symbol: 'ETH', name: 'Ethereum' });
  const market = 'cex:test:ETH-USD';
  s.upsertMarket({ id: market, base: 'ETH', quote: 'USD', kind: 'cex', exchange: 'test' });
  s.linkAssetMarket('eth:native', market);
}

const price = (at, value) => ({ asset: 'eth:native', price: value, at });
const obs = (srcTs, value, fields = {}) => ({ market: 'cex:test:ETH-USD', reporter: 'one', srcTs, price: value, ...fields });
const bars = (s, tf, opts = {}) => s.candles({ asset: 'eth:native', tf, ...opts }).map(r =>
  [r.ts, r.open, r.high, r.low, r.close, r.samples]);

test('late aggregate samples yield exact, chronological OHLC at every resolution', t => {
  const s = fixture(t);
  markets(s);
  const high = '21.000000000000000002', low = '21.000000000000000001';
  assert.equal(s.recordPrices([price(day + 1, '90'), price(hour, '50'), price(5 * minute, '40'), price(59_999, high)]), 4);
  assert.equal(s.recordPrices([price(1, low), price(minute, '020.0')]), 2);
  assert.deepEqual(bars(s, '1m', { from: 0, to: minute }), [[0, low, high, low, high, 2]]);
  assert.deepEqual(bars(s, '5m'), [
    [0, low, high, '020.0', '020.0', 3],
    [5 * minute, '40', '40', '40', '40', 1],
    [hour, '50', '50', '50', '50', 1],
    [day, '90', '90', '90', '90', 1],
  ]);
  assert.deepEqual(bars(s, '1h', { to: hour }), [[0, low, '40', '020.0', '40', 4]]);
  assert.deepEqual(bars(s, '1d'), [[0, low, '50', '020.0', '50', 5], [day, '90', '90', '90', '90', 1]]);
});

test('raw quotes never draw asset candles, however far off they are', t => {
  const s = fixture(t);
  markets(s);
  assert.equal(s.insertObservations([obs(1, '1800'), obs(2, '2690', { reporter: 'two' }), obs(3, '9', { priceUsd: '9' })]), 3);
  assert.deepEqual(bars(s, '1d'), []);
  assert.equal(s.observations({ market: 'cex:test:ETH-USD' }).length, 3);
  s.recordPrices([price(4, '1805')]);
  assert.deepEqual(bars(s, '1d'), [[0, '1805', '1805', '1805', '1805', 1]]);
});

test('batch error rolls back all raw rows and bars', t => {
  const s = fixture(t);
  markets(s);
  assert.throws(() => s.insertObservations([obs(1, '1'), obs(2, 'invalid')]), /decimal string/);
  assert.deepEqual(s.observations({ market: 'cex:test:ETH-USD' }), []);
  assert.throws(() => s.recordPrices([price(1, '1'), price(2, 'invalid')]), /decimal string/);
  assert.deepEqual(bars(s, '1d'), []);
  assert.throws(() => s.candles({ asset: 'eth:native', tf: '3d' }), /timeframe/);
});
