import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures.js';
import { httpClient } from '../src/client.js';

const hour = 3_600_000, day = 24 * hour;
const btc = 'bitcoin:native', eth = 'ethereum:native';

test('HTTP rankings count matching hidden rows before paging and expose their state on personal views', async t => {
  const f = fixture(t);
  let now = 1_800_000_000_000;
  const app = await f.start('visibility', { clock: () => now });
  const api = httpClient(app.dataDir);
  const { engine, store } = app;
  const id = symbol => engine.registry.cex('bitstamp', symbol, 'USD').id;
  // 100,000 units a day: above the movers' $50k floor at these prices.
  const observe = (market, price, key) => engine.book.ingest(key, [[market, price, 100000, null, null, null, now]], key === engine.book.ownKey);
  const peer = 'b'.repeat(64);
  store.recordPrices([{ asset: btc, price: '1', at: now - day }, { asset: eth, price: '5', at: now - day }]);
  observe(id('BTC'), '2', engine.book.ownKey);
  observe(id('ETH'), '3', peer);
  let result = await api('GET', '/markets', { limit: 1, offset: 1 });
  assert.deepEqual(result, { items: [], total: 1, hidden: { stale: 0, unconfirmed: 1, dust: 0 } });
  result = await api('GET', '/markets', { include: 'hidden', limit: 1, offset: 1 });
  assert.equal(result.total, 2);
  assert.equal(result.items[0].id, eth);
  assert.equal(result.items[0].visibility, 'unconfirmed');
  for (const tab of ['all', 'trending', 'gainers', 'losers']) {
    const result = await api('GET', '/markets', { tab, chain: 'ethereum' });
    assert.deepEqual(result.items, []);
    assert.equal(result.hidden.unconfirmed, tab === 'gainers' ? 0 : 1, tab);
  }
  const movers = await api('GET', '/movers');
  assert.deepEqual(movers.gainers.map(r => r.id), [btc]);
  assert.deepEqual(movers.losers, []);
  assert.equal(movers.hidden.unconfirmed, 1);
  assert.deepEqual((await api('GET', '/movers', { include: 'hidden' })).losers.map(r => r.id), [eth]);
  assert.equal((await api('GET', '/search', { q: 'ETH' })).tokens[0].visibility, 'unconfirmed');
  assert.equal((await api('GET', '/assets/ETH')).visibility, 'unconfirmed');
  assert.equal((await api('GET', '/assets/ETH/price')).visibility, 'unconfirmed');
  assert.equal((await api('POST', '/watchlist', {}, { asset: eth })).states[eth].visibility, 'unconfirmed');
  await api('POST', '/portfolio', {}, { op: 'add-holding', asset: eth, amount: 2 });
  await api('POST', '/alerts', {}, { asset: eth, op: 'above', value: 20 });
  now += hour + 1;
  assert.equal((await api('GET', '/global')).volume24h, null);
  assert.equal((await api('GET', '/markets')).hidden.stale, 2);
  assert.equal((await api('GET', '/markets', { tab: 'watch' })).items[0].visibility, 'stale');
  assert.equal((await api('GET', '/watchlist')).states[eth].staleSince, now - 1);
  assert.equal((await api('GET', '/portfolio')).holdings[0].visibility, 'stale');
  assert.equal((await api('GET', '/alerts')).items[0].visibility, 'stale');
  const ethMarket = id('ETH');
  const flooded = Array.from({ length: 125 }, (_, i) => [ethMarket, '3', 1, null, null, null, now - i]);
  engine.book.ingest(peer, flooded, false);
  assert.equal((await api('GET', '/network')).droppedUnproven1h, 5);
});

test('HTTP venue, derivative and New lists apply exact age boundaries, counters and the opt-in', async t => {
  let now = 1_800_000_000_000;
  const app = await fixture(t).start('age', { clock: () => now });
  const api = httpClient(app.dataDir);
  const { engine, intel } = app;
  const market = engine.registry.cex('bitstamp', 'BTC', 'USD').id;
  engine.book.ingest(engine.book.ownKey, [[market, '100', 1, null, null, null, now - hour]], true);
  engine.saveDerivative('bitstamp', 'btc-perp', 0.01, 10, now - hour);
  engine.saveDerivative('bitstamp', 'eth-perp', 0.01, 20, now - hour - 1);
  // The discovery tracker keeps both local sightings until graduation, even after the New window.
  const channel = 'gator/new';
  const discover = (n, at) => {
    const token0 = '0x' + n.repeat(40);
    const message = { v: 1, t: 'pool', chain: 'ethereum', dex: 'swap', kind: 'v2', pool: token0,
      token0, token1: 'native', block: 1, tx: '0x' + n.repeat(64) };
    assert.ok(intel.newTokens.consume(channel, { channel, from: engine.book.ownKey, ts: now, message }, at));
    return 'ethereum:' + token0;
  };
  const fresh = discover('2', now - day), old = discover('3', now - day - 1);
  for (const [route, field, expected] of [['exchanges', 'id', 'bitstamp'], ['derivatives', 'symbol', 'btc-perp'], ['new', 'id', fresh]]) {
    const list = await api('GET', '/' + route);
    assert.deepEqual(list.items.map(r => r[field]), [expected]);
    assert.deepEqual(list.hidden, { stale: route === 'exchanges' ? 0 : 1, unconfirmed: 0, dust: 0 });
    const all = await api('GET', '/' + route, { include: 'hidden' });
    assert.equal(all.items.length, 1 + list.hidden.stale);
  }
  assert.equal((await api('GET', '/assets/' + old)).id, old);
  now++;
  for (const [route, size] of [['exchanges', 1], ['derivatives', 2], ['new', 2]]) {
    const list = await api('GET', '/' + route, { limit: 1 });
    assert.deepEqual(list.items, []);
    assert.equal(list.hidden.stale, size);
    const all = await api('GET', '/' + route, { include: 'hidden', limit: 1, offset: size - 1 });
    assert.equal(all.items[0].visibility, 'stale');
    assert.equal(all.hidden.stale, size);
  }
  now += 7 * day;
  app.prune();
  assert.deepEqual((await api('GET', '/new', { include: 'hidden' })).items, []);
});

test('a move alert alone pins forgotten membership through hourly maintenance and reopening', async t => {
  const f = fixture(t);
  let now = 1_800_000_000_000;
  const start = () => f.start('pin', { clock: () => now });
  const app = await start();
  const api = httpClient(app.dataDir);
  await api('POST', '/alerts', {}, { asset: btc, op: 'move', value: 10 });
  now += 7 * day;
  app.prune();
  const list = await api('GET', '/markets', { include: 'hidden' });
  assert.deepEqual(list.items.map(r => r.id), [btc]);
  await app.close();
  const reopened = await start();
  const again = await httpClient(reopened.dataDir)('GET', '/markets', { include: 'hidden' });
  assert.deepEqual(again, list);
});
