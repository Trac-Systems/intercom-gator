// Feed lanes: Latest first and the default, the Latest lane in the demo backend, and the side column's post merge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LANES, laneOf } from '../public/js/views/feed.js';
import { mergePosts } from '../public/js/ui/side.js';
import { href, parse } from '../public/js/lib/router.js';
import { createApi } from '../public/js/api.js';

test('feed lanes: Latest first, then Following, Official, Mentions; no or unknown lane opens Latest', () => {
  assert.deepEqual(LANES.map((l) => l[0]), ['latest', 'following', 'official', 'mentions']);
  assert.equal(laneOf(undefined), 'latest');
  assert.equal(laneOf(''), 'latest');
  assert.equal(laneOf('nope'), 'latest');
  assert.equal(laneOf('following'), 'following');
  assert.equal(laneOf(parse('#/feed').params.lane), 'latest');
  assert.equal(laneOf(parse(href('feed', { lane: 'following' })).params.lane), 'following');
  assert.equal(href('feed', { lane: 'latest' }), '#/feed');
});

test('demo feed: Latest holds everyone, Following only the people you follow', async () => {
  const api = createApi({ demo: true });
  const [latest, following, dir] = await Promise.all([api.feed({ lane: 'latest' }), api.feed({ lane: 'following' }), api.directory()]);
  const followed = new Set(dir.items.filter((p) => p.followed || p.me).map((p) => p.key));
  const ids = new Set(latest.items.map((p) => p.id));
  assert.ok(following.items.every((p) => ids.has(p.id)), 'every Following post is in Latest');
  const others = new Set(latest.items.filter((p) => !followed.has(p.key)).map((p) => p.key));
  assert.ok(others.size >= 3, 'Latest shows posts from several people you do not follow');
  assert.ok(latest.items.every((p) => p.kind !== 'promoted'));
  assert.ok(latest.items.every((p, i, a) => i === 0 || a[i - 1].ts >= p.ts), 'newest first');
  // Same ?before= paging as Following.
  const mid = latest.items[3];
  const older = await api.feed({ lane: 'latest', before: mid.ts });
  assert.deepEqual(older.items.map((p) => p.id), latest.items.filter((p) => p.ts < mid.ts).map((p) => p.id));
  // Your own new post is in Latest at once.
  const mine = await api.publish('hello from the latest lane');
  assert.equal((await api.feed({ lane: 'latest' })).items[0].id, mine.id);
});

test('side column: posts merge without repeats, first list wins', () => {
  const a = [{ key: 'k1', id: '1', n: 'a' }, { key: 'k2', id: '1' }];
  const b = [{ key: 'k1', id: '1', n: 'b' }, { key: 'k1', id: '2' }];
  const m = mergePosts(a, b);
  assert.deepEqual(m.map((p) => p.key + '/' + p.id), ['k1/1', 'k2/1', 'k1/2']);
  assert.equal(m[0].n, 'a');
  assert.deepEqual(mergePosts([], []), []);
});
