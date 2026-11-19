import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, urlOptions, ApiError } from '../public/js/api.js';
import { buildSample, sampleCandles } from '../public/js/sample.js';

const refused = async () => { throw new TypeError('fetch failed'); };
/** A fake fetch answering JSON. */
function jsonFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init });
    const { status = 200, body, type = 'application/json' } = await handler(url, init);
    return { ok: status >= 200 && status < 300, status, statusText: String(status), headers: { get: (h) => (h === 'content-type' ? type : null) }, json: async () => body };
  };
  f.calls = calls;
  return f;
}

test('falls back to sample data when the API is unreachable', async () => {
  const api = createApi({ fetch: refused });
  const g = await api.global();
  assert.equal(api.mode, 'demo');
  assert.equal(api.reason, 'unreachable');
  assert.equal(g.marketCap, 3.284e12);
});

test('falls back on 404 / non-JSON (dashboard served without the API)', async () => {
  const api = createApi({ fetch: jsonFetch(() => ({ status: 404, body: null, type: 'text/plain' })) });
  await api.probe();
  assert.equal(api.mode, 'demo');
  const api2 = createApi({ fetch: jsonFetch(() => ({ status: 200, body: '<html>', type: 'text/html' })) });
  await api2.probe();
  assert.equal(api2.mode, 'demo');
});

test('401 means "not signed in": demo with reason signin', async () => {
  const api = createApi({ fetch: jsonFetch(() => ({ status: 401, body: { error: 'auth' } })) });
  await api.probe();
  assert.equal(api.mode, 'demo');
  assert.equal(api.reason, 'signin');
});

test('a hanging API times out into demo', async () => {
  const api = createApi({ fetch: () => new Promise(() => {}), timeoutMs: 30 });
  await api.probe();
  assert.equal(api.mode, 'demo');
});

test('?demo=1 never touches the network', async () => {
  let n = 0;
  const api = createApi({ demo: true, fetch: async () => { n++; throw new Error('no'); } });
  await api.markets();
  assert.equal(n, 0);
  assert.equal(api.reason, 'asked');
  assert.deepEqual(urlOptions('?demo=1&still=1'), { demo: true, still: true });
});

test('live mode: paths, query, bodies, errors', async () => {
  const f = jsonFetch((url, init) => {
    if (url === '/api/v1/me') return { body: { key: 'k' } };
    if (url.startsWith('/api/v1/assets/')) return { body: { url } };
    if (url === '/api/v1/posts') return { status: 400, body: { error: 'too long' } };
    return { body: { url, method: init.method, sent: init.body ? JSON.parse(init.body) : null } };
  });
  const api = createApi({ fetch: f });
  await api.probe();
  assert.equal(api.mode, 'live');
  assert.equal((await api.asset('eth:0xabc')).url, '/api/v1/assets/eth%3A0xabc');
  assert.equal((await api.candles('btc:native', '5m', 288)).url, '/api/v1/assets/btc%3Anative/candles?tf=5m&limit=288');
  assert.equal((await api.markets({ tab: 'gainers', category: '' })).url, '/api/v1/markets?tab=gainers');
  const like = await api.like({ key: 'a', id: 'b' }, false);
  assert.deepEqual(like.sent, { target: { key: 'a', id: 'b' }, undo: true });
  assert.equal((await api.follow('k', false)).url, '/api/v1/unfollow');
  assert.equal((await api.putSettings({ theme: 'dark' })).method, 'PUT');
  await assert.rejects(api.publish('x'), (e) => e instanceof ApiError && e.status === 400 && e.message === 'too long');
  assert.ok(f.calls.every((c) => c.init.credentials === 'same-origin'));
});

test('demo answers carry the sample shapes', async () => {
  const api = createApi({ demo: true });
  const m = await api.markets();
  assert.equal(m.items.length, 30);
  for (const k of ['id', 'rank', 'symbol', 'name', 'price', 'change1h', 'change24h', 'change7d', 'volume24h', 'marketCap', 'trust', 'sources', 'spark7d']) assert.ok(k in m.items[0], k);
  const g = await api.markets({ tab: 'gainers' });
  assert.ok(g.items.every((t, i, a) => t.change24h > 0 && (i === 0 || a[i - 1].change24h >= t.change24h)));
  const n = await api.newTokens();
  assert.ok(n.items.every((t) => Array.isArray(t.flags) && typeof t.ageMin === 'number'));
  const a = await api.asset('btc:native');
  assert.ok(a.why && a.risk && Array.isArray(a.links));
  const s = await api.search('$sol');
  assert.equal(s.tokens[0].symbol, 'SOL');
  const addr = await api.search('0x6982508145454ce325ddbe47a25d4ec3d2311933');
  assert.equal(addr.address.kind, 'evm');
});

test('demo feed: lanes, threads, mutes, the promoted post never in a lane', async () => {
  const api = createApi({ demo: true });
  const f = await api.feed({ lane: 'following' });
  assert.ok(f.items.length > 3);
  assert.ok(f.items.every((p) => p.kind !== 'promoted'));
  const o = await api.feed({ lane: 'official' });
  assert.ok(o.items.every((p) => p.official || p.product));
  const men = await api.feed({ lane: 'mentions' });
  assert.ok(men.items.length >= 1);
  const top = f.items.find((p) => p.replies > 0);
  const th = await api.thread(top.key, top.id);
  assert.ok(th.replies.length > 0 && th.replies.every((r) => r.parent.id === top.id));
  await api.mute(top.key, true);
  const f2 = await api.feed({ lane: 'following' });
  assert.ok(f2.items.every((p) => p.key !== top.key));
  const ex = await api.extras();
  assert.ok(ex.items.every((x) => x.label === 'Promoted'));
});

test('demo writes: post, like toggle, watch, alerts, settings rules', async () => {
  const api = createApi({ demo: true });
  const p = await api.publish('hello $ETH');
  assert.deepEqual(p.tickers, [{ sym: 'ETH', asset: 'eth:native' }]);
  await assert.rejects(api.publish('x'.repeat(501)), /too long/);
  await assert.rejects(api.publish('   '), /empty/);
  const liked = await api.like({ key: p.key, id: p.id });
  assert.equal(liked.likes, 1); assert.equal(liked.liked, true);
  const un = await api.like({ key: p.key, id: p.id }, false);
  assert.equal(un.likes, 0);
  const r = await api.reply('hi', { key: p.key, id: p.id });
  assert.equal(r.kind, 'reply');
  const w = await api.setWatch('eth:native', true);
  assert.ok(w.items.includes('eth:native'));
  const al = await api.addAlert({ asset: 'eth:native', op: 'above', value: 4000 });
  assert.ok(al.items.some((x) => x.asset === 'eth:native'));
  await assert.rejects(api.addAlert({ asset: 'eth:native', op: 'above', value: -1 }));
  const s0 = await api.settings();
  assert.equal(s0.agent.agentPosting, false, 'agent posting is off by default');
  await assert.rejects(api.putSettings({ profile: 'large' }), /lowered/);
  const s1 = await api.putSettings({ profile: 'small' });
  assert.equal(s1.budgetPerMin, 60);
  await assert.rejects(api.putSettings({ budgetPerMin: 0 }), /range/);
  await assert.rejects(api.putSettings({ endpoint: { url: 'javascript:alert(1)' } }), /url/);
  await assert.rejects(api.putSettings({ card: { handle: 'Bad Handle' } }), /handle/);
  await assert.rejects(api.follow((await api.feed({ lane: 'official' })).items[0].key, false), /cannot be unfollowed/);
});

test('demo copies answers so callers cannot mutate the sample world', async () => {
  const api = createApi({ demo: true });
  const a = await api.markets();
  a.items[0].price = 1;
  const b = await api.markets();
  assert.notEqual(b.items[0].price, 1);
});

test('sample candles end at the price and match the 24 h change', () => {
  const now = Date.UTC(2026, 10, 19, 12);
  const W = buildSample(now);
  const btc = W.tokens[0];
  const c = sampleCandles(btc, '5m', 288, now);
  assert.equal(c.length, 288);
  assert.equal(c.at(-1).c, btc.price);
  assert.ok(Math.abs((c.at(-1).c / c[0].c - 1) * 100 - btc.change24h) < 1.5);
  assert.ok(c.every((k) => k.h >= Math.max(k.o, k.c) && k.l <= Math.min(k.o, k.c) && k.v > 0));
  assert.deepEqual(sampleCandles(btc, '5m', 288, now), c, 'deterministic');
  const kite = W.newTokens.find((t) => t.symbol === 'KITE');
  assert.ok(sampleCandles(kite, '1m', 60, now).length <= 13, 'no history before first seen');
});

test('a timed-out read is retried once; a timed-out write is reported, not repeated', async () => {
  const calls = { GET: 0, POST: 0, PUT: 0 };
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    if (String(url).endsWith('/me')) return new Response('{}', { headers: { 'content-type': 'application/json' } });
    calls[method]++;
    if (calls[method] === 1) return new Promise(() => {});
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  };
  const api = createApi({ fetch, timeoutMs: 30 });
  assert.deepEqual(await api.global(), { ok: true });
  assert.equal(calls.GET, 2);
  await assert.rejects(api.putSettings({ theme: 'dark' }), /timeout/);
  assert.equal(calls.POST + calls.PUT, 1);
});
