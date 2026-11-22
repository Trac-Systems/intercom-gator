import assert from 'node:assert/strict';
import test from 'node:test';
import { createNewTokens, NEW_THRESHOLDS } from '../../src/intel/discoveries.js';
import { DAY } from '../../src/intel/values.js';

const channel = 'gator/new';
const a = '0x' + 'a'.repeat(40), b = '0x' + 'b'.repeat(40);
const asset = 'base:' + a, quote = 'base:' + b;
const pool = { t: 'pool', v: 1, pool: '0x' + '1'.repeat(40), token0: a, token1: b,
  block: 1, tx: '0x' + 'f'.repeat(64), chain: 'base', kind: 'v2', dex: 'dex' };
const envelope = (message, key = 'a', ts = 1) => ({ channel, from: key.repeat(64), ts, message });

test('all four locally evaluated gates must pass, graduation is permanent during the session', () => {
  let time = DAY, metrics = {};
  const tracker = createNewTokens({ now: () => time, metricsFor: () => metrics, isKnownAsset: id => id === quote,
    getRisk: () => ({ flags: { unsellable: 'unknown', veryNew: true } }) });
  for (const key of ['a', 'a', 'b', 'c']) tracker.consume(channel, envelope(pool, key));
  assert.equal(tracker.list().length, 1);
  assert.deepEqual(tracker.list()[0].flags, { unsellable: 'unknown', veryNew: true });
  assert.equal(tracker.list()[0].reporters, 3);
  metrics = { liquidityUsd: NEW_THRESHOLDS.liquidityUsd, trades: 100 };
  assert.equal(tracker.list()[0].ageMs, 0);
  time += DAY;
  metrics.trades--;
  assert.equal(tracker.list().length, 1);
  metrics.trades++; metrics.liquidityUsd--;
  assert.equal(tracker.list().length, 1);
  metrics.liquidityUsd++;
  assert.deepEqual(tracker.list(), []);
  metrics = {};
  assert.deepEqual(tracker.list(), []);
});

test('listings await local identity and peer metrics do not influence graduation', () => {
  let resolved = [];
  const tracker = createNewTokens({ resolveAssets: () => resolved, now: () => 10 });
  const listing = { v: 1, t: 'listing', exchange: 'spot', symbol: 'ABC/USD', firstSeen: 0, trades: 10000, liquidityUsd: 10e6 };
  assert.ok(tracker.consume(channel, envelope(listing)));
  assert.deepEqual(tracker.list(), []);
  resolved = [asset]; tracker.reconcile();
  const [r] = tracker.list();
  assert.equal(r.asset, asset);
  assert.equal(r.liquidityUsd, null);
  assert.equal(r.trades, null);
});

test('conflicting pool identity, wrong channel, invalid block or future listing is rejected', () => {
  const tracker = createNewTokens();
  assert.ok(tracker.consume(channel, envelope(pool)));
  assert.equal(tracker.consume(channel, envelope({ ...pool, token1: a })), false);
  assert.equal(tracker.consume(channel, envelope({ ...pool, tx: '0x' + '1'.repeat(64) }, 'b')), false);
  assert.equal(tracker.consume(channel, envelope({ ...pool, block: -1 })), false);
  assert.equal(tracker.consume('gator/meta', envelope(pool)), false);
  assert.equal(tracker.consume(channel, envelope({ t: 'listing', v: 1, symbol: 'ABC', exchange: 'dex', firstSeen: 2 })), false);
  assert.equal(tracker.list()[0].reporters, 1);
});

test('a pool learned late takes its age from the creation-block estimate, a checked creation time wins', () => {
  // A young node hears of a two-day-old pool now (another peer's history scan): it is not "0m" old.
  const time = 10 * DAY;
  let metrics = { createdEstimate: time - 2 * DAY };
  const tracker = createNewTokens({ now: () => time, metricsFor: () => metrics, isKnownAsset: id => id === quote });
  tracker.consume(channel, envelope(pool));
  assert.equal(tracker.list()[0].ageMs, 2 * DAY);
  // An estimate after first sight never makes the token younger than the node has known it.
  metrics = { createdEstimate: time + DAY };
  assert.equal(tracker.list()[0].ageMs, 0);
  metrics = { createdEstimate: time - 2 * DAY, createdAt: time - 3 * DAY };
  assert.equal(tracker.list()[0].ageMs, 3 * DAY);
});

test('a peer repeating a pool this node already knows is dated by the local sighting, not by its arrival', () => {
  // 11-22: peers repeat their records; after the capped table evicted a pool its repeat came back dated now and
  // long-established Solana tokens showed as "0m".
  const time = 10 * DAY, market = 'dex:base:' + pool.pool;
  let seen = { [market]: time - 2 * DAY };
  const tracker = createNewTokens({ now: () => time, poolSeen: m => seen[m], isKnownAsset: id => id === quote });
  assert.equal(tracker.consume(channel, envelope(pool)), false, 'known for longer than the New window: not new');
  assert.deepEqual(tracker.list(), []);
  seen = { [market]: time - 2 * 3600_000 };
  assert.ok(tracker.consume(channel, envelope(pool)));
  assert.equal(tracker.list()[0].firstSeen, time - 2 * 3600_000);
  assert.equal(tracker.list()[0].ageMs, 2 * 3600_000);
});

test('a stored row is never younger than the first sighting of any of its pools', () => {
  const time = 10 * DAY;
  let metrics = {};
  const tracker = createNewTokens({ now: () => time, metricsFor: () => metrics, isKnownAsset: id => id === quote });
  tracker.consume(channel, envelope(pool));
  assert.equal(tracker.list()[0].ageMs, 0);
  metrics = { poolSeen: time - 45 * 3600_000 };
  assert.equal(tracker.list()[0].ageMs, 45 * 3600_000);
  metrics = { poolSeen: time - 45 * 3600_000, createdEstimate: time - 50 * 3600_000 };
  assert.equal(tracker.list()[0].ageMs, 50 * 3600_000);
});
