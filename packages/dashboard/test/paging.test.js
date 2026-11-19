// Paging: the pager itself, the demo server's limit/offset/sort, and the markets list pagers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPager, pagerCache, countText } from '../public/js/lib/pager.js';
import { createApi } from '../public/js/api.js';
import { listPager, PAGE, PAGE_SUMMARY, bandBasis, gasNum } from '../public/js/views/markets.js';
import { withOlder, hasOlder, FEED_PAGE } from '../public/js/views/feed.js';

const rows = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: 'a' + (from + i) }));

test('pager loads pages in order and stops on a short page', async () => {
  const calls = [];
  const p = createPager(async (offset, limit) => { calls.push([offset, limit]); return { items: rows(Math.min(limit, 250 - offset), offset) }; }, { limit: 100 });
  await p.more();
  assert.equal(p.state.items.length, 100);
  assert.equal(p.state.done, false);
  await p.more(); await p.more();
  assert.equal(p.state.items.length, 250);
  assert.equal(p.state.done, true);
  await p.more(); // no-op when done
  assert.deepEqual(calls, [[0, 100], [100, 100], [200, 100]]);
});

test('pager uses total when given, and stops exactly at it', async () => {
  const p = createPager(async (offset, limit) => ({ items: rows(limit, offset), total: 200 }), { limit: 100 });
  await p.more();
  assert.equal(p.state.total, 200);
  assert.equal(countText(p.state, String), '100 of 200');
  await p.more();
  assert.equal(p.state.done, true);
  assert.equal(countText(p.state, String), 'All 200');
});

test('pager drops rows repeated across pages (live data shifts) but keeps the offset moving', async () => {
  const pages = [[{ id: 'x' }, { id: 'y' }], [{ id: 'y' }, { id: 'z' }], []];
  const offsets = [];
  const p = createPager(async (offset) => { offsets.push(offset); return { items: pages.shift() }; }, { limit: 2 });
  await p.more(); await p.more(); await p.more();
  assert.deepEqual(p.state.items.map((x) => x.id), ['x', 'y', 'z']);
  assert.deepEqual(offsets, [0, 2, 4]);
  assert.equal(p.state.done, true);
});

test('concurrent more() calls share one request; an error can be retried', async () => {
  let n = 0, fail = true;
  const p = createPager(async (offset, limit) => { n++; if (fail) { fail = false; throw new Error('down'); } return { items: rows(limit, offset) }; }, { limit: 3 });
  await assert.rejects(p.more(), /down/);
  assert.equal(p.state.error?.message, 'down');
  assert.equal(p.state.loading, false);
  await Promise.all([p.more(), p.more()]);
  assert.equal(n, 2);
  assert.equal(p.state.items.length, 3);
  assert.equal(p.state.error, null);
});

test('the items array is mutated in place (views hold a reference)', async () => {
  const p = createPager(async (offset, limit) => ({ items: rows(limit, offset) }), { limit: 2 });
  const ref = p.state.items;
  await p.more(); await p.more();
  assert.equal(ref.length, 4);
});

test('countText: unknown total says "shown"; empty done list says nothing', () => {
  assert.equal(countText({ items: rows(100), total: null, done: false }, String), '100 shown');
  assert.equal(countText({ items: [], total: null, done: true }, String), '');
});

test('pagerCache keeps a pager for its ttl, then replaces it; errors are not kept', () => {
  let t = 0;
  const c = pagerCache(1000, () => t);
  const a = c.get('k', () => createPager(async () => ({ items: [] })));
  assert.equal(c.get('k', () => assert.fail('should reuse')), a);
  t = 2000;
  const b = c.get('k', () => createPager(async () => ({ items: [] })));
  assert.notEqual(b, a);
  b.state.error = new Error('x');
  assert.notEqual(c.get('k', () => createPager(async () => ({ items: [] }))), b);
});

test('demo API pages with limit/offset like the real one and rejects bad ranges', async () => {
  const api = createApi({ demo: true, now: () => 1_790_000_000_000 });
  const a = await api.markets({ tab: 'all', limit: 5, offset: 0 });
  const b = await api.markets({ tab: 'all', limit: 5, offset: 5 });
  assert.equal(a.items.length, 5);
  assert.ok(a.total > 10);
  assert.equal(new Set(a.items.concat(b.items).map((t) => t.id)).size, 10);
  await assert.rejects(api.markets({ limit: 501 }), /bad range/);
  await assert.rejects(api.categories({ offset: -1 }), /bad range/);
  const ex = await api.exchanges({ limit: 2 });
  assert.equal(ex.items.length, 2);
});

test('demo API sorts on the server across pages (nulls last)', async () => {
  const api = createApi({ demo: true, now: () => 1_790_000_000_000 });
  const p1 = await api.markets({ sort: 'volume24h', order: 'desc', limit: 4, offset: 0 });
  const p2 = await api.markets({ sort: 'volume24h', order: 'desc', limit: 4, offset: 4 });
  const v = p1.items.concat(p2.items).map((t) => t.volume24h);
  assert.deepEqual(v, v.slice().sort((x, y) => y - x));
  const asc = await api.markets({ sort: 'name', order: 'asc', limit: 3 });
  const names = asc.items.map((t) => t.name.toLowerCase());
  assert.deepEqual(names, names.slice().sort());
  await assert.rejects(api.markets({ sort: 'evil; drop' }), /Unknown markets sort/);
});

test('markets token pagers send sort/order, page by 100, and only trust total on the plain All list', async () => {
  const seen = [];
  const fake = { markets: async (q) => { seen.push(q); return { items: rows(q.limit, q.offset), total: 1435 }; } };
  const all = listPager(fake, 'all', { so: { tab: 'all', k: 'marketCap', dir: -1 } });
  await all.more();
  assert.equal(seen[0].limit, PAGE);
  assert.equal(seen[0].offset, 0);
  assert.equal(seen[0].sort, 'marketCap');
  assert.equal(seen[0].order, 'desc');
  assert.equal(all.state.total, 1435);
  await all.more();
  assert.equal(seen[1].offset, PAGE);
  assert.equal(seen[1].sort, 'marketCap'); // same order on every page
  const g = listPager(fake, 'gainers', { cat: 'Meme' });
  await g.more();
  assert.equal(g.state.total, null); // the API total counts every token, not gainers in Meme
  assert.equal(seen[2].category, 'Meme');
  assert.equal(seen[2].sort, undefined);
  // A different sort is a different list (page 1 again).
  const other = listPager(fake, 'all', { so: { tab: 'all', k: 'name', dir: 1 } });
  assert.notEqual(other, all);
  assert.equal(other.state.pages, 0);
});

test('summary tabs page by the API maximum and dedupe by name', async () => {
  const seen = [];
  const fake = { categories: async (q) => { seen.push(q); return { items: [{ name: 'A' }, { name: 'B' }] }; } };
  const p = listPager(fake, 'categories');
  await p.more();
  assert.equal(seen[0].limit, PAGE_SUMMARY);
  assert.equal(p.state.done, true);
});

test('feed: older pages join the first without repeats; a short first page has no older', () => {
  const first = Array.from({ length: FEED_PAGE }, (_, i) => ({ key: 'k', id: String(i), ts: 1000 - i }));
  const o = { items: [{ key: 'k', id: '99', ts: 901 }, { key: 'k', id: 'x', ts: 1 }], done: false, loading: false };
  const all = withOlder(first, o);
  assert.equal(all.length, FEED_PAGE + 1);
  assert.equal(all[all.length - 1].id, 'x');
  assert.equal(hasOlder(first, o), true);
  assert.equal(hasOlder(first.slice(0, 10), o), false);
  assert.equal(hasOlder(first, { ...o, done: true }), false);
});

test('pulse band: market cap when enough tokens have one, else volume; never rows without an id', () => {
  const young = rows(40).map((t, i) => ({ ...t, symbol: 'T' + i, marketCap: null, volume24h: 1000 - i, change24h: null }));
  young.push({ id: null, symbol: 'NOID', volume24h: 1e9 });
  const b = bandBasis(young);
  assert.equal(b.k, 'volume24h');
  assert.equal(b.list.length, 30);
  assert.equal(b.changes, false);
  assert.ok(!b.list.some((t) => t.symbol === 'NOID'));
  const grown = young.map((t, i) => ({ ...t, marketCap: 1e6 * (50 - i), change24h: 1 }));
  assert.equal(bandBasis(grown).k, 'marketCap');
  assert.equal(bandBasis(grown).changes, true);
  // Partial supply: the biggest token by volume has no cap yet → stay on volume, so it is not dropped.
  const partial = grown.map((t, i) => (i === 0 ? { ...t, marketCap: null } : t));
  assert.equal(bandBasis(partial).k, 'volume24h');
  assert.equal(bandBasis(partial).list[0].symbol, 'T0');
});

test('gas stat stays short', () => {
  assert.equal(gasNum('0.000000007 gwei'), '<0.001');
  assert.equal(gasNum('7.512 gwei'), '7.51');
  assert.equal(gasNum('0.005 gwei'), '0.005');
});
