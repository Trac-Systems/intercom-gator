import assert from 'node:assert/strict';
import test from 'node:test';
import { fitBudget } from '../src/prune.js';
import { PROFILE_LIMITS } from '../src/profile.js';
import { fixture } from './fixture.js';

const minute = 60_000, day = 24 * 60 * minute;
const social = { id: 'social:fixture', up(db) { db.exec('CREATE TABLE posts(id INTEGER PRIMARY KEY, ts INTEGER, channel TEXT)'); } };

function register(s, id = 'test:one', rank = 1) {
  s.upsertAsset({ id, symbol: id, name: id, rank });
}
function market(s) {
  s.upsertMarket({ id: 'test-market', kind: 'cex', base: 'ONE', quote: 'USD' });
  s.linkAssetMarket('test:one', 'test-market');
}
function observation(srcTs) {
  return { market: 'test-market', reporter: 'r', srcTs, price: '5.0' };
}
function observe(s, times, assets = ['test:one']) {
  s.insertObservations(times.map(observation));
  s.recordPrices(assets.flatMap(asset => times.map(at => ({ asset, price: '5.0', at }))));
}

test('retention windows preserve boundary buckets, daily history and official posts', t => {
  const s = fixture(t, { migrations: [social] });
  assert.equal(s.reader.prepare("SELECT 1 FROM sqlite_schema WHERE name='candles_expiry'").get(), undefined);
  register(s);
  market(s);
  const now = 100 * day;
  const times = [0, 10 * day, 93 * day, 99 * day, now];
  observe(s, times);
  const post = s.writer.prepare('INSERT INTO posts(ts,channel) VALUES (?,?)');
  for (const [ts, channel] of [[0, 'soc/official'], [70 * day - 1, 'soc/u/key'], [70 * day, 'soc/u/key']]) post.run(ts, channel);
  const result = s.prune({ now });
  assert.equal(result.posts, 1);
  assert.equal(result.obs, 4);
  assert.equal(result.candles, 6);
  assert.deepEqual(s.reader.prepare('SELECT ts FROM posts ORDER BY ts').all().map(p => p.ts), [0, 70 * day]);
  const ts = tf => s.candles({ asset: 'test:one', tf }).map(bar => bar.ts);
  assert.deepEqual(ts('1m'), [99 * day, now]);
  assert.deepEqual(ts('5m'), [93 * day, 99 * day, now]);
  assert.deepEqual(ts('1h'), [10 * day, 93 * day, 99 * day, now]);
  assert.deepEqual(ts('1d'), times);
  assert.equal(s.insertObservations([observation(0)]), 0);
  assert.equal(s.candles({ asset: 'test:one', tf: '1d' })[0].samples, 1);
  assert.equal(s.prune({ now: now - 1 }).candles, 0);
  assert.equal(s.insertObservations([observation(99 * day - 1)]), 0);
});

test('small retains its top kept-asset histories by views plus watched and held assets; other snapshots survive', t => {
  const s = fixture(t);
  const K = PROFILE_LIMITS.small.keptAssets;
  s.transaction(() => {
    for (let rank = 1; rank <= K + 4; rank++) {
      const id = 'test:' + rank;
      register(s, id, rank);
      s.upsertPrice({ asset: id, price: '3', at: 1 });
      s.writer.prepare("INSERT INTO candles VALUES (?, '1d',0,'1','1','1','1',1,0,1,0,1)").run(id);
    }
    s.recordView('test:' + (K + 4));
    s.watch('test:' + (K + 3));
    s.setHolding({ asset: 'test:' + (K + 2), amount: '1' });
    s.setHolding({ asset: 'test:' + (K + 1), amount: '1' });
    s.setHolding({ asset: 'test:' + (K + 1), amount: '0' });
  });
  assert.equal(s.prune({ now: day, profile: 'normal' }).candles, 0);
  assert.equal(s.prune({ now: day, profile: 'small' }).candles, 2);
  const hasDaily = rank => s.candles({ asset: 'test:' + rank, tf: '1d' }).length;
  assert.deepEqual([K - 1, K, K + 1, K + 2, K + 3, K + 4].map(hasDaily), [1,0,0,1,1,1]);
  assert.equal(s.getPrice('test:' + K).price, '3');
  assert.equal(s.getAsset('test:' + (K + 1)).rank, K + 1);
  s.unwatch('test:' + (K + 3));
  assert.equal(s.prune({ now: day }).candles, 1);
});

test('a throwing package pruning hook rolls back every expiry, including the ingest floor', t => {
  const s = fixture(t, { migrations: [social] });
  register(s);
  market(s);
  s.insertObservations([observation(1)]);
  s.writer.exec("INSERT INTO posts(ts,channel) VALUES (0,'soc/u/test')");
  const unsubscribe = s.onPrune((writer, context) => {
    assert.equal(context.postsBefore, day);
    assert.equal(context.profile, 'small');
    assert.equal(writer.prepare('SELECT count(*) AS n FROM posts').get().n, 0);
    throw new Error('try later');
  });
  assert.throws(() => s.prune({ now: 31 * day }), /try later/);
  assert.equal(s.reader.prepare('SELECT count(*) AS n FROM posts').get().n, 1);
  assert.equal(s.insertObservations([observation(2)]), 1);
  unsubscribe();
  assert.equal(s.prune({ now: 31 * day }).obs, 1);
});

test('byte pressure expires raw data before unpinned history and reports protected usage', t => {
  const s = fixture(t);
  register(s);
  market(s);
  register(s, 'test:two', 2);
  s.linkAssetMarket('test:two', 'test-market');
  s.watch('test:two');
  observe(s, [1, 2], ['test:one', 'test:two']);
  const result = s.transaction(db => fitBudget(db, 1, 10));
  assert.equal(result.obs, 1);
  assert.equal(result.candles, 4);
  assert.ok(result.overBudgetBytes > 0);
  assert.equal(s.candles({ asset: 'test:two', tf: '1d' })[0].samples, 2);
  assert.equal(s.insertObservations([observation(2)]), 0);
  assert.equal(s.insertObservations([observation(3)]), 1);
});

test('package eviction hooks run inside the budget transaction and can be unregistered', t => {
  const s = fixture(t);
  s.writer.exec("CREATE TABLE package_data(id INTEGER PRIMARY KEY); INSERT INTO package_data VALUES(1),(2)");
  const unregister = s.onEvict((writer, { targetBytes, liveBytes }) => {
    assert.equal(targetBytes, 1);
    assert.ok(liveBytes > targetBytes);
    const result = writer.prepare('DELETE FROM package_data WHERE id=(SELECT min(id) FROM package_data)').run();
    if (!result.changes) throw new Error('rollback fixture');
    return result.changes;
  });
  assert.throws(() => s.transaction(db => fitBudget(db, 1, 100)), /rollback fixture/);
  assert.equal(s.reader.prepare('SELECT count(*) AS n FROM package_data').get().n, 2);
  unregister();
  assert.ok(s.transaction(db => fitBudget(db, 1, 100)).overBudgetBytes > 0);
  assert.equal(s.reader.prepare('SELECT count(*) AS n FROM package_data').get().n, 2);
});

test('eviction visits raw quotes, then package caches, then only unprotected candle history', t => {
  const s = fixture(t);
  register(s);
  market(s);
  const ids = ['test:one','test:live','test:watched','test:held'];
  for (const id of ids.slice(1)) register(s, id);
  s.watch(ids[2]);
  s.setHolding({ asset: ids[3], amount: '2' });
  s.upsertPrice({ asset: ids[1], price: '5', at: 10, visibility: 'live' });
  observe(s,[10],ids);
  let called = false;
  s.onEvict(db => {
    called = true;
    assert.equal(db.prepare('SELECT count(*) n FROM obs').get().n,0);
    assert.equal(db.prepare('SELECT count(DISTINCT asset) n FROM candles').get().n,4);
    return 0;
  });
  s.transaction(db => fitBudget(db,1,11));
  assert.ok(called);
  assert.deepEqual(ids.map(asset => s.candles({ asset }).length),[0,1,1,1]);
});

test('budget eviction recovers unused space in shared raw archives before calling package evictors', t => {
  const s = fixture(t, { migrations: [{ id: 'engine:test-latest', up(db) {
    db.exec('CREATE TABLE engine_latest(obsId INTEGER PRIMARY KEY REFERENCES obs(id))');
  } }] });
  register(s);
  market(s);
  for (let ts = 1; ts <= 128; ts++) {
    s.insertObservations(Array.from({ length: 32 }, (_, i) => ({
      ...observation(ts), reporter: String(i), price: String(ts),
    })));
  }
  const pinned = s.writer.prepare('SELECT obsId FROM store_obs_slice LIMIT 1').get().obsId;
  s.writer.prepare('INSERT INTO engine_latest VALUES (?)').run(pinned);
  let visited = false;
  s.onEvict(db => {
    visited = true;
    assert.equal(db.prepare('SELECT count(*) n FROM store_obs_archive WHERE live*2<total').get().n, 0);
    return 0;
  });
  s.transaction(db => fitBudget(db, 1, 129));
  assert.ok(visited);
  assert.equal(s.reader.prepare('SELECT id FROM obs').get().id, pinned);
});

test('a steady target below the profile ceiling shortens raw quotes only; caches and candles wait for the ceiling', t => {
  const s = fixture(t);
  register(s);
  market(s);
  observe(s, [10]);
  const calls = [];
  s.onEvict((db, { targetBytes }) => { calls.push(targetBytes); return 0; });
  // v0.1.0 ran every tier against 295 MB on a 1 GiB profile, which emptied small package caches on every pass.
  const steady = s.transaction(db => fitBudget(db, 1, 11, 256, Number.MAX_SAFE_INTEGER));
  assert.equal(steady.obs, 1);
  assert.equal(steady.candles, 0);
  assert.ok(steady.overBudgetBytes > 0, 'still measured against the steady target');
  assert.deepEqual(calls, []);
  assert.ok(s.candles({ asset: 'test:one' }).length > 0);
  // Above the ceiling every tier still relieves pressure, in the same order.
  s.transaction(db => fitBudget(db, 1, 11));
  assert.deepEqual(calls, [1]);
  assert.equal(s.candles({ asset: 'test:one' }).length, 0);
});
