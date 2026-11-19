import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFearGreed, createFearGreed, fearGreedLabel } from '../../src/intel/fear-greed.js';
import { DAY } from '../../src/intel/values.js';

const at = DAY * 20000, key = '1'.repeat(64);
const baseline = () => Array.from({ length: 91 }, (_, i) => ({
  at: at + (i - 91) * DAY, btcClose: 100, ethClose: '100', volumeUsd: 100, btcDominance: 50,
}));
const post = (text, i, timestamp) => ({ t: 'post', key, id: String(i), text, ts: timestamp });
test('flat complete calendar produces the neutral midpoint with equal components', () => {
  const daily = baseline();
  const r = computeFearGreed({ at: at + DAY - 1, daily: daily.reverse(), posts: [] });
  assert.equal(r.at, at);
  assert.deepEqual(r.inputs.map(i => i.value), [50, 50, 50, 50, 50]);
  assert.equal(r.value, 50);
  assert.equal(r.label, 'Neutral');
  assert.equal(r.partial, false);
  assert.deepEqual(r.missing, []);
  assert.ok(r.inputs.every(i => i.status === 'ok' && !('days' in i)));
});

test('each market factor responds to its own window, the composite uses equal weights', () => {
  const daily = baseline();
  daily.forEach((d, i) => {
    if (i >= 61) d.btcClose = d.ethClose = i % 2 ? 120 : 80;
  });
  daily.at(-1).btcClose = daily.at(-1).ethClose = 150;
  daily.at(-1).volumeUsd = 250;
  daily.at(-1).btcDominance = 54;
  const posts = [post('$ETH bullish', 1, at - 1)];
  const r = computeFearGreed({ at, daily, posts, isFollowed: k => k === key });
  const values = r.inputs.map(i => i.value);
  assert.ok(values[0] < 50 && values[1] > 50 && values[2] > 50 && values[3] > 50 && values[4] < 50);
  assert.equal(r.value, Math.round(values.reduce((a,b) => a+b) / 5));
});

test('missing days, missing social, or a zero price cannot manufacture a complete snapshot', () => {
  const daily = baseline();
  daily[0].ethClose = 0;
  const r = computeFearGreed({ at, daily });
  assert.equal(r.value, 50);
  assert.equal(r.partial, true);
  assert.deepEqual(r.missing, ['Volatility', 'Social']);
  assert.deepEqual(r.inputs[0].days, { have: 90, need: 91 });
  assert.deepEqual(r.inputs[3].days, { have: 0, need: 8 });
  assert.deepEqual(r.inputs.map(i => i.value), [null, 50, 50, null, 50]);
  daily.pop();
  daily.push({ ...daily.at(-1), at: at + DAY }); // future candle cannot replace a gap
  assert.deepEqual(computeFearGreed({ at, daily, posts: [] }).inputs.map(i => i.value), [null, null, null, 50, null]);
});

test('a value needs two available inputs and at least one price factor', () => {
  const daily = baseline();
  delete daily.at(-1).btcClose;
  const noPrice = computeFearGreed({ at, daily, posts: [] });
  assert.equal(noPrice.value, null);
  assert.equal(noPrice.label, null);
  assert.deepEqual(noPrice.missing, ['Volatility', 'Momentum']);
  const onlyMomentum = daily.slice(1).map(d => ({ at: d.at, btcClose: 10, ethClose: 2 }));
  const one = computeFearGreed({ at, daily: onlyMomentum });
  assert.equal(one.value, null);
  assert.deepEqual(one.inputs.filter(i => i.status === 'ok').map(i => i.name), ['Momentum']);
});

test('Fear & Greed bands at exact boundaries', () => {
  assert.deepEqual([0,24,25,44,45,55,56,75,76,100].map(fearGreedLabel),
    ['Extreme fear','Extreme fear','Fear','Fear','Neutral','Neutral','Greed','Greed','Extreme greed','Extreme greed']);
});

test('daily snapshot coalesces concurrent requests, survives service recreation, and exposes sparse calendar history', async () => {
  const saved = new Map(), queries = [];
  const store = { upsertFearGreed(row) { saved.set(row.at, structuredClone(row)); },
    fearGreedHistory({ from, to, limit }) { return [...saved.values()].filter(r => r.at >= from && r.at < to).reverse().slice(0, limit); } };
  for (const days of [30, 7, 1]) saved.set(at - DAY * days, { at: at - DAY * days, value: days });
  let daily = [];
  const opts = { store, now: () => at + 42, dailyMarket(q) { queries.push(q); return daily; },
    postsSince(q) { assert.deepEqual(q, { from: at - 8 * DAY, to: at }); return []; } };
  const index = createFearGreed(opts);
  assert.equal((await index.snapshot()).value, null);
  assert.equal(saved.size, 3);
  daily = baseline();
  const [a, b] = await Promise.all([index.snapshot(), index.snapshot()]);
  assert.deepEqual(a, b);
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0], { from: at - 91 * DAY, to: at });
  assert.deepEqual([a.yesterday, a.lastWeek, a.lastMonth], [1, 7, 30]);
  assert.equal(a.history30d.length, 30);
  assert.equal(a.history30d.at(-1), 50);
  assert.equal(a.history30d.at(-3), null);
  assert.deepEqual(await createFearGreed(opts).snapshot(), a);
  assert.equal(queries.length, 2);
});

test('R-APP-18: unknown authors cannot change either social window or the daily index', async () => {
  const proven = 'b'.repeat(64);
  const posts = [post('$ETH bullish', 1, at - 1), { ...post('$ETH bearish', 2, at - 2 * DAY), key: proven }];
  const options = { dailyMarket: baseline, postsSince: () => posts, now: () => at,
    isFollowed: id => id === key, isProven: id => id === proven };
  const before = await createFearGreed(options).snapshot();
  assert.ok(before.inputs.find(i => i.name === 'Social').value > 50);
  for (let i = 1; i <= 40; i++) {
    const author = i.toString(16).padStart(64, '0');
    posts.push({ ...post('$ETH bearish', i, at - 1), key: author },
      { ...post('$ETH bullish', i + 100, at - 3 * DAY), key: author });
  }
  assert.deepEqual(await createFearGreed(options).snapshot(), before);
  const unknown = computeFearGreed({ daily: baseline(), at, posts });
  assert.equal(unknown.value, 50);
});

test('a saved partial comparison upgrades when the missing local data becomes available', async () => {
  let daily = baseline().map(({ at, btcClose, ethClose }) => ({ at, btcClose, ethClose }));
  let posts;
  const isFollowed = author => author === key;
  const index = createFearGreed({ dailyMarket: () => daily, postsSince: () => posts, now: () => at, isFollowed });
  assert.equal((await index.snapshot()).partial, true);
  daily = baseline();
  posts = [post('$BTC bullish', 1, at - 1), post('$BTC bearish', 2, at + DAY - 1)];
  const next = await index.snapshot(at + DAY);
  assert.deepEqual(next.historyPoints.yesterday, computeFearGreed({ at, daily, posts, isFollowed }));
  assert.ok(next.historyPoints.yesterday.inputs[3].value > 50);
  assert.ok(next.inputs[3].value < 50);
  assert.equal(index.history().find(p => p.at === at).partial, false);
});

test('an upgrade rebuilds the current daily score using eligible authors and preserves historical scores', async () => {
  const legacy = { at, value: 75, label: 'Greed', inputs: [{ name: 'Social', value: 100 }] };
  const rows = new Map([[at, legacy], [at - DAY, { ...legacy, at: at - DAY }]]);
  const store = { upsertFearGreed: r => rows.set(r.at, r),
    fearGreedHistory: ({ from, to, limit }) => [...rows.values()].filter(r => r.at >= from && r.at < to)
      .sort((a, b) => b.at - a.at).slice(0, limit) };
  let daily = [];
  const reads = [];
  const index = createFearGreed({ store, dailyMarket: q => { reads.push(q); return daily; }, now: () => at,
    postsSince: () => [post('$ETH bullish', 1, at - 1)] });
  const incomplete = await index.snapshot();
  assert.equal(incomplete.value, null);
  assert.equal(incomplete.history30d.at(-1), null);
  daily = baseline();
  const rebuilt = await index.snapshot();
  assert.equal(rebuilt.value, 50);
  assert.equal(rebuilt.yesterday, 75);
  assert.equal((await index.snapshot()).value, 50);
  assert.deepEqual(reads.map(q => q.to), [at, at, at - 7 * DAY]); // final read only fills missing comparisons
});
