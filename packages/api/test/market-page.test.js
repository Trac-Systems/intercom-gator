import test from 'node:test';
import assert from 'node:assert/strict';
import { marketViews } from '../src/markets.js';

const USDT = 'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7', BTC = 'bitcoin:native';
const note = 'The venue lists this pair as a tokenized stock and reports the underlying stock market\'s volume.';

/** A USDT page: 230 X/USDT pairs, one USDT/USD pair, a RANT-like stock pair and an unconfirmed giant. */
function app() {
  const rows = [];
  rows.push({ id: 'cex:bitget:RANT-USDT', kind: 'cex', exchange: 'bitget', base: 'unresolved:bitget:RANT', quote: USDT,
    member: USDT, volume24h: 102.5e9, price: 91.4, at: 0, volumeSuspect: { reason: 'underlying-stock', note } });
  rows.push({ id: 'cex:x:GIANT-USDT', kind: 'cex', exchange: 'x', base: 'base:0xgiant', quote: USDT, member: USDT,
    volume24h: 9e9, price: 1, at: 0, volumeSuspect: { reason: 'unconfirmed', note: 'not confirmed' } });
  rows.push({ id: 'cex:binance:BTC-USDT', kind: 'cex', exchange: 'binance', base: BTC, quote: USDT, member: USDT,
    volume24h: 1.29e9, price: 61398, at: 0 });
  rows.push({ id: 'cex:kraken:USDT-USD', kind: 'cex', exchange: 'kraken', base: USDT, quote: 'fiat:USD', member: USDT,
    volume24h: 2e8, price: 1, at: 0 });
  for (let i = 0; i < 230; i++)
    rows.push({ id: `cex:gate:T${i}-USDT`, kind: 'cex', exchange: 'gate', base: `t:${i}`, quote: USDT, member: USDT,
      volume24h: 1000 + i, price: 1, at: 0 });
  const engine = {
    assetMarkets: () => rows,
    book: { marketPrices: new Map(), snapshots: new Map() },
    registry: { assets: new Map([[USDT, { symbol: 'USDT' }], [BTC, { symbol: 'BTC' }]]), venues: new Map() },
    queries: { chainName: id => id },
    whyTrusted: () => null,
  };
  const store = { reader: { prepare: () => ({ get: () => null, all: () => [] }) }, getPrice: () => null };
  return { engine, store, intel: {}, clock: () => 1000, transport: { publicKey: 'k' } };
}

test('flagged volumes sort last, stay listed with their number and leave the total', () => {
  const views = marketViews(app(), {});
  const first = views.marketPage(USDT, { limit: 3 });
  assert.equal(first.total, 234);
  assert.deepEqual(first.items.map(m => m.id), ['cex:binance:BTC-USDT', 'cex:kraken:USDT-USD', 'cex:gate:T229-USDT']);
  const counted = 1.29e9 + 2e8 + Array.from({ length: 230 }, (_, i) => 1000 + i).reduce((a, b) => a + b, 0);
  assert.equal(first.volumeTotal, counted);
  assert.deepEqual(first.suspect, { count: 2, volume24h: 102.5e9 + 9e9 });
  // BTC/USDT's share is of counted volume only: ~86%, not ~1% of a junk-inflated total.
  assert.ok(first.items[0].volume24h / first.volumeTotal > 0.85);
  const last = views.marketPage(USDT, { limit: 3, offset: 231 });
  assert.deepEqual(last.items.map(m => [m.id, m.volumeSuspect]),
    [['cex:gate:T0-USDT', undefined], ['cex:bitget:RANT-USDT', 'underlying-stock'], ['cex:x:GIANT-USDT', 'unconfirmed']]);
  assert.equal(last.items[1].volume24h, 102.5e9);
  assert.match(last.items[1].volumeNote, /underlying stock market's volume/);
});

test('pages cover every market exactly once', () => {
  const views = marketViews(app(), {});
  const seen = [];
  for (let offset = 0; ; offset += 100) {
    const page = views.marketPage(USDT, { limit: 100, offset });
    seen.push(...page.items.map(m => m.id));
    if (page.items.length < 100) break;
  }
  assert.equal(seen.length, 234);
  assert.equal(new Set(seen).size, 234);
});

test('side keeps the pairs with the asset as base or as quote, counting both first', () => {
  const views = marketViews(app(), {});
  const base = views.marketPage(USDT, { side: 'base' });
  assert.deepEqual(base.items.map(m => m.id), ['cex:kraken:USDT-USD']);
  assert.deepEqual(base.counts, { base: 1, quote: 233 });
  const quote = views.marketPage(USDT, { side: 'quote', limit: 1 });
  assert.equal(quote.total, 233);
  assert.equal(quote.items[0].id, 'cex:binance:BTC-USDT');
  assert.equal(quote.items[0].pair, 'BTC/USDT');
});
