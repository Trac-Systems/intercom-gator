import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, storeOpener } from './fixture.js';

function seed(s) {
  s.trackMarketActivity(() => 5, s.onPrune);
  for (const [rank, symbol, name, price, change24h] of [
    [1, 'AC', 'Acorn', '100.09', -3], [2, 'ACX', 'Acer', '2.1000000000000000001', 4],
    [3, 'AX_X', 'A%Coin', '2.90', 0.1],
  ]) {
    const id = 'eth:' + symbol.toLowerCase();
    s.upsertAsset({ id, symbol, name, rank, category: rank === 1 ? 'Layer 1' : 'Meme' });
    s.upsertPrice({ asset: id, price, at: 5, visibility: 'live', change24h, trust: 'yellow', trending: rank, volume24h: 1e6 });
  }
}

test('market list has numeric sort, stable paging, tabs, filters and exact text prices', t => {
  const s = fixture(t);
  seed(s);
  const ids = rows => rows.map(row => row.id);
  assert.deepEqual(ids(s.listMarkets({ sort: 'price' })), ['eth:ac', 'eth:ax_x', 'eth:acx']);
  assert.deepEqual(ids(s.listMarkets({ sort: 'price', order: 'asc', limit: 1, offset: 1 })), ['eth:ax_x']);
  assert.deepEqual(ids(s.listMarkets({ chain: 'eth', category: 'Meme', trust: 'yellow' })), ['eth:acx', 'eth:ax_x']);
  assert.deepEqual(ids(s.listMarkets({ tab: 'trending' })), ['eth:ax_x', 'eth:acx', 'eth:ac']);
  assert.deepEqual(ids(s.movers()), ['eth:acx', 'eth:ax_x']);
  assert.deepEqual(ids(s.movers({ direction: 'losers' })), ['eth:ac']);
  // Movers need a price that is not red and $50k of 24 h volume (INDEX +4,587% on $3.5k was first).
  s.upsertAsset({ id: 'eth:thin', symbol: 'THIN', name: 'Thin', rank: 4 });
  s.upsertPrice({ asset: 'eth:thin', price: '1', at: 5, visibility: 'live', change24h: 4587, trust: 'yellow', volume24h: 3484 });
  s.upsertAsset({ id: 'eth:red', symbol: 'RED', name: 'Red', rank: 5 });
  s.upsertPrice({ asset: 'eth:red', price: '1', at: 5, visibility: 'live', change24h: -31, trust: 'red', volume24h: 1e6 });
  assert.deepEqual(ids(s.movers()), ['eth:acx', 'eth:ax_x']);
  assert.deepEqual(ids(s.movers({ direction: 'losers' })), ['eth:ac']);
  assert.deepEqual(ids(s.listMarkets({ tab: 'trending' })).slice(0, 3), ['eth:ax_x', 'eth:acx', 'eth:ac']);
  assert.equal(s.upsertPrice({ asset: 'eth:acx', price: '9', at: 4 }), 0);
  assert.equal(s.getPrice('eth:acx').price, '2.1000000000000000001');
  assert.throws(() => s.listMarkets({ sort: 'invalid' }), RangeError);
  assert.throws(() => s.listMarkets({ limit: -1 }), RangeError);
  assert.equal(s.watch('eth:ac'), 1);
  assert.equal(s.watch('eth:ac'), 0);
  assert.deepEqual(ids(s.listMarkets({ tab: 'watch' })), ['eth:ac']);
  assert.equal(s.listWatchlist()[0].asset, 'eth:ac');
  assert.equal(s.unwatch('eth:ac'), 1);
  assert.deepEqual(s.listMarkets({ tab: 'watch' }), []);
});

test('prefix search treats SQL wildcards literally and finds symbol, name and address', t => {
  const s = fixture(t);
  seed(s);
  s.upsertAsset({ id: 'sol:1zB3', symbol: 'PIX', name: 'Pixel' });
  for (const prefix of ['AX_', 'A%']) assert.equal(s.searchAssets(prefix)[0].id, 'eth:ax_x');
  assert.deepEqual(s.searchAssets('AX_').map(r => r.id), ['eth:ax_x']);
  assert.deepEqual(s.searchAssets('A%').map(r => r.id), ['eth:ax_x']);
  assert.equal(s.searchAssets('piXel')[0].id, 'sol:1zB3');
  assert.equal(s.searchAssets('1zB')[0].symbol, 'PIX');
  assert.equal(s.searchAssets('pix')[0].address, '1zB3');
  assert.deepEqual(s.searchAssets('zB'), []);
  assert.deepEqual(s.searchAssets('1Zb'), []);
  s.upsertAsset({ id: 'eth:0xaabb', symbol: 'EVM', name: 'Hex' });
  assert.equal(s.searchAssets('0xAA')[0].id, 'eth:0xaabb');
  assert.equal(s.searchAssets('eth:0xAA')[0].id, 'eth:0xaabb');
  for (const prefix of ['?', '*', '[']) assert.deepEqual(s.searchAssets(prefix), []);
});

test('market membership, views and foreign keys survive registry refresh', t => {
  const s = fixture(t);
  seed(s);
  const market = { id: 'cex:test:AC-USD', kind: 'cex', exchange: 'test', base: 'AC', quote: 'USD' };
  s.upsertMarket(market);
  assert.equal(s.getMarket(market.id).quote, 'USD');
  assert.equal(s.linkAssetMarket('eth:ac', market.id), 1);
  assert.equal(s.linkAssetMarket('eth:ac', market.id), 0);
  assert.throws(() => s.linkAssetMarket('eth:missing', market.id), /FOREIGN KEY/);
  assert.deepEqual(s.marketsForAsset('eth:ac').map(m => m.id), [market.id]);
  s.recordView('eth:ac');
  s.upsertAsset({ id: 'eth:ac', symbol: 'AC', name: 'Oak' });
  assert.equal(s.getAsset('eth:ac').views, 1);
});

test('discovery queries keep earliest times and page new pools in stable order', t => {
  const s = fixture(t);
  const pool = { chain: 'eth', pool: 'a', dex: 'test', token0: 'AA', token1: 'BB', firstSeen: 100 };
  s.upsertPool(pool);
  s.upsertPool({ ...pool, firstSeen: 200, liquidity: 50, block: 123 });
  s.upsertPool({ ...pool, chain: 'sol', firstSeen: 101 });
  s.upsertPool({ ...pool, pool: 'b', firstSeen: 102 });
  assert.deepEqual(s.newPools({ from: 100, to: 102 }).map(p => p.chain), ['sol', 'eth']);
  assert.equal(s.newPools({ chain: 'eth', limit: 1, offset: 1 })[0].liquidity, 50);
  assert.equal(s.newPools({ chain: 'eth', to: 101 })[0].block, 123);
  s.upsertListing({ exchange: 'test', symbol: 'A', firstSeen: 7 });
  s.upsertListing({ exchange: 'test', symbol: 'A', firstSeen: 9 });
  assert.equal(s.newListings({ to: 8 })[0].firstSeen, 7);
});

test('trust, local state and engine snapshots round-trip through the reader', t => {
  const s = fixture(t);
  seed(s);
  const asset = 'eth:ac';
  s.upsertRisk({ asset, at: 10, flags: { ownerMint: true }, method: 'local' });
  s.upsertRisk({ asset, at: 8, flags: {}, method: 'local' });
  assert.deepEqual(s.getRisk(asset).flags, { ownerMint: true });
  const claim = { asset, at: 8, kind: 'website', value: 'example.test', reporter: 'test', proof: { dns: true } };
  s.upsertClaim(claim);
  s.upsertClaim({ ...claim, at: 7, value: 'old' });
  assert.deepEqual({ ...s.claimsForAsset(asset)[0] }, claim);
  s.upsertReporter({ key: 'test', strikes: 1, weight: 0.8 });
  assert.equal(s.getReporter('test').weight, 0.8);
  s.setHolding({ asset, amount: '0.000001' });
  assert.equal(s.listPortfolio()[0].amount, '0.000001');
  s.setHolding({ asset, amount: '0.00' });
  assert.deepEqual(s.listPortfolio(), []);
  const id = s.addAlert({ asset, direction: 'above', threshold: '1.10', createdAt: 1 });
  assert.equal(s.hitAlert(id, 2), 1);
  assert.equal(s.hitAlert(id, 3), 0);
  assert.equal(s.listAlerts()[0].hitAt, 2);
  s.removeAlert(id);
  assert.deepEqual(s.listAlerts(), []);
  s.upsertFearGreed({ at: 20, value: 24, label: 'Fear', inputs: [{ name: 'Volume', value: 17 }] });
  assert.equal(s.fearGreedHistory()[0].inputs[0].value, 17);
  s.upsertExtra({ slotType: 'spotlight', slot: 1, contentHash: 'sample', expiresAt: 100 });
  assert.equal(s.activeExtras(99).length, 1);
  assert.equal(s.activeExtras(100).length, 0);
  assert.equal(s.removeExtra('spotlight', 1), 1);
  s.setEndpointHealth({ id: 'one', failures: 2, retryAt: 8 });
  assert.equal(s.getEndpointHealth('one').retryAt, 8);
  s.setSetting('prefs', { mode: 'small' });
  assert.deepEqual(s.getSetting('prefs'), { mode: 'small' });
  s.setSetting('prefs', null);
  assert.equal(s.getSetting('prefs'), null);
  assert.equal(s.getSetting('missing'), undefined);
});

test('dashboard tabs page real pool, category, chain, venue, derivative and NFT records', t => {
  const s = fixture(t);
  seed(s);
  const dex = { id: 'dex:eth:pool', kind: 'dex', exchange: 'Swap', chain: 'eth', base: 'AC', quote: 'USD', volume24h: 500 };
  s.upsertMarket(dex);
  s.linkAssetMarket('eth:ac', dex.id);
  s.upsertPool({ chain: 'eth', pool: 'pool', dex: 'Swap', token0: 'eth:ac', token1: 'USD', firstSeen: 12 });
  s.upsertRisk({ asset: 'eth:ac', at: 12, method: 'local', flags: { ownerMint: true } });
  const perp = { id: 'cex:example:AC-PERP', kind: 'cex', exchange: 'example', base: 'AC', quote: 'USD',
    instrument: 'perpetual', openInterest: 400, funding: 0.08, oiChange24h: 2, volume24h: 200 };
  s.upsertMarket(perp);
  s.upsertAsset({ id: 'eth:collection', kind: 'nft', symbol: 'PIC', name: 'Pictures' });
  s.upsertPrice({ asset: 'eth:collection', at: 13, price: '750', floor: '0.25', floorCurrency: 'ETH' });
  assert.equal(s.listMarkets().length, 3);
  assert.equal(s.listMarkets({ tab: 'nfts', sort: 'floor', chain: 'eth' })[0].floorCurrency, 'ETH');
  const fresh = s.listMarkets({ tab: 'new', sort: 'price', now: 75_000, chain: 'eth' })[0];
  assert.equal(fresh.ageMin, 1);
  assert.equal(fresh.price, '100.09');
  assert.deepEqual(fresh.flags, { ownerMint: true });
  const meme = s.listMarkets({ tab: 'categories', name: 'Meme' })[0];
  assert.equal(meme.assets, 2);
  assert.deepEqual(meme.top, ['ACX','AX_X']);
  assert.deepEqual({ ...s.listMarkets({ tab: 'chains', now: 100 })[0] }, {
    name: 'eth', chain: 'eth', dexVolume24h: 500, pools: 1, newPools24h: 1,
  });
  assert.deepEqual(s.listMarkets({ tab: 'exchanges' }), []);
  assert.equal(s.listMarkets({ tab: 'exchanges', include: 'hidden', limit: 1, offset: 1 })[0].volume24h, 200);
  assert.deepEqual(s.listMarkets({ tab: 'derivatives', exchange: 'Swap' }), []);
  assert.equal(s.listMarkets({ tab: 'derivatives', include: 'hidden', sort: 'funding' })[0].openInterest, 400);
  s.insertObservations([{ market: perp.id, reporter: 'self', at: 5, srcTs: 5, price: '1' }]);
  assert.equal(s.listMarkets({ tab: 'derivatives' })[0].id, perp.id);
  assert.equal(s.listMarkets({ tab: 'exchanges' })[0].name, 'example');
  assert.throws(() => s.listMarkets({ tab: 'derivatives', sort: 'unknown' }), RangeError);
});

test('ranked filters run before paging and stale prices cannot overwrite newer visibility', t => {
  const store = fixture(t);
  let now = 1_800_000_000_000;
  store.trackMarketActivity(() => now, store.onPrune);
  for (const [rank, visibility] of ['unconfirmed', 'dust', 'live', 'live'].entries()) {
    const id = 'test:' + rank;
    store.upsertAsset({ id, symbol: 'T' + rank, name: 'Token ' + rank, rank: rank + 1, category: rank ? 'B' : 'A' });
    store.upsertPrice({ asset: id, at: now, price: '2', visibility, change24h: 1, volume24h: 1e6 });
  }
  assert.equal(store.upsertPrice({ asset: 'test:1', at: now - 1, price: '1', visibility: 'live' }), 0);
  assert.deepEqual(store.listMarkets({ limit: 1, offset: 1 }).map(r => r.id), ['test:3']);
  assert.deepEqual(store.marketCounts({ tab: 'gainers', category: 'B' }), { total: 2, hidden: { stale: 0, unconfirmed: 0, dust: 1 } });
  assert.deepEqual(store.marketCounts({ include: 'hidden' }), { total: 4, hidden: { stale: 0, unconfirmed: 1, dust: 1 } });
  assert.equal(store.searchAssets('T1')[0].visibility, 'dust');
  assert.deepEqual(store.listMarkets({ tab: 'categories' }).map(r => [r.name, r.assets]), [['B', 2]]);
  now += 3_600_000;
  assert.equal(store.marketCounts().total, 2);
  now++;
  assert.equal(store.marketCounts().hidden.stale, 4);
  assert.equal(store.getAsset('test:2').staleSince, now - 1);
  store.upsertPrice({ asset: 'test:2', at: now, price: '3', visibility: 'live' });
  assert.equal(store.getAsset('test:2').staleSince, null);
});

test('retention seeds existing databases from price and raw source times without assuming a legacy price is confirmed', t => {
  const open = storeOpener(t), old = open(), now = 1_800_000_000_000, week = 7 * 86_400_000;
  for (const id of ['priced', 'raw', 'quote', 'fresh', 'never']) old.upsertAsset({ id: 'test:' + id, symbol: id, name: id });
  old.upsertPrice({ asset: 'test:priced', at: now - week, price: '1' });
  old.upsertPrice({ asset: 'test:fresh', at: now, price: '2', trust: 'green' });
  const id = 'cex:test:RAW-QUOTE';
  old.upsertMarket({ id, kind: 'cex', base: 'test:raw', quote: 'test:quote' });
  old.insertObservations([{ market: id, reporter: 'self', at: now - week, srcTs: now - week, price: '1' }]);
  // Reproduce the previous on-disk schema with existing snapshots and raw evidence.
  old.writer.exec('DROP TABLE store_market_list');
  old.close();
  const store = open();
  store.trackMarketActivity(() => now, store.onPrune);
  assert.equal(store.getAsset('test:fresh').visibility, 'unconfirmed');
  store.prune({ now });
  assert.deepEqual(store.listMarkets({ include: 'hidden' }).map(r => r.id), ['test:fresh', 'test:never']);
  assert.equal(store.getAsset('test:priced').price, '1');
});
