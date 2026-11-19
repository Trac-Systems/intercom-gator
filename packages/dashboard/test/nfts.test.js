// NFT collections, a collection page and Settings → Sources, from the shapes /api/v1 answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import markets from '../public/js/views/markets.js';
import nft from '../public/js/views/nft.js';
import { parse, href, navKey } from '../public/js/lib/router.js';
import { sourcesBody, sourcesPanel } from '../public/js/ui/sources.js';
import { ethTxt, collectingHTML } from '../public/js/ui/nfts.js';

const NOW = Date.now();
const status = { minSales: 3, sales24h: 12, flagged24h: 1, collectionsWithSales24h: 2,
  chains: [{ chain: 'ethereum', chainName: 'Ethereum', marketplaces: ['Seaport 1.6', 'Blur'], since: NOW - 600_000, salesSeen: 12, lagSeconds: 30 },
    { chain: 'base', chainName: 'Base', marketplaces: ['Seaport 1.6'], since: null, salesSeen: 0, lagSeconds: null }] };
const row = (i, extra = {}) => ({ id: 'ethereum:0x' + String(i).padStart(40, '0'), kind: 'nft', chain: 'ethereum', chainName: 'Ethereum',
  address: '0x' + String(i).padStart(40, '0'), name: 'Pics ' + i, symbol: 'PIC', seeded: true, floor: 1.25, floorUsd: 3750, floorCurrency: 'ETH',
  floorKind: 'sale', floorSales: 5, change24h: null, volume24h: 15000, volume24hEth: 5, sales24h: 4, washSales24h: 1,
  lastSale: { at: NOW - 60_000, priceEth: 1.3, priceUsd: 3900, marketplace: 'Seaport 1.6', tokenId: '7', tx: '0x' + 'a'.repeat(64) }, ...extra });
const API = {
  global: async () => ({}), fearGreed: async () => ({}), markets: async () => ({ items: [] }), feed: async () => ({ items: [] }),
  trending: async () => ({ items: [] }), extras: async () => ({ items: [] }), derivatives: async () => ({ items: [] }), exchanges: async () => ({ items: [] }),
  nfts: async () => ({ items: [row(1), row(2, { floor: null, floorUsd: null, sales24h: 0, volume24h: 0, volume24hEth: 0, lastSale: null, washSales24h: 0 })], total: 2, status }),
  nft: async (id) => ({ ...row(1), id, listed: true, firstSeen: NOW - 3600_000, sales: [
    { at: NOW - 60_000, tokenId: '7', qty: 1, priceEth: 1.3, priceUsd: 3900, currency: 'ETH', marketplace: 'Seaport 1.6', seller: '0x1', buyer: '0x2', tx: '0x' + 'a'.repeat(64), block: 1, flag: null, bundle: 1 },
    { at: NOW - 120_000, tokenId: '8', qty: 1, priceEth: 0.01, priceUsd: 30, currency: 'ETH', marketplace: 'Blur', seller: '0x2', buyer: '0x1', tx: '0x' + 'b'.repeat(64), block: 1, flag: 'loop', bundle: 1 }] }),
};
const ctxStub = () => ({ api: API, q: '', watch: new Set(), mentions: new Map(), people: new Map(), idx: { byId: new Map(), bySym: new Map() },
  promoUsed: false, takePromo() { return false; }, cached: (k, fn) => fn(), noteTokens() {}, noteMentions() {}, notePerson() {} });
const clean = (html) => assert.doesNotMatch(html.replace(/<[^>]+>/g, ' '), /\b(null|undefined|NaN)\b/);

test('the NFTs tab lists measured collections with a sale floor in ETH and USD and links to a collection page', { skip: 'the NFTs tab is hidden until the NFT release' }, async () => {
  const ctx = ctxStub(), route = { name: 'markets', params: { tab: 'nfts' }, query: {} };
  ctx.route = route;
  const out = markets.html(ctx, await markets.load(ctx, route), route);
  clean(out.main);
  assert.match(out.main, /Sale floor/);
  assert.doesNotMatch(out.main, />Floor</);
  assert.match(out.main, /1\.25 ETH/);
  assert.match(out.main, /\$3,750/);
  assert.match(out.main, /data-href="#\/nft\/ethereum%3A0x0+1"/);
  assert.match(out.main, /no sales seen yet/);
  assert.match(out.main, /not a listing floor/);
  assert.match(out.main, /What your node collects/);
  assert.match(out.main, /Seaport 1\.6, Blur/);
});

test('a collection page shows the sale floor, recent sales and flags wash-like trades', async () => {
  const ctx = ctxStub(), route = { name: 'nft', params: { id: 'ethereum:0x' + '1'.padStart(40, '0') }, query: {} };
  const out = nft.html(ctx, await nft.load(ctx, route), route);
  clean(out.main);
  assert.match(out.main, /<h1>Pics 1<\/h1>/);
  assert.match(out.main, /Sale floor/);
  assert.match(out.main, /wash-like/);
  assert.match(out.main, /Recent sales <small class="n">2</);
  assert.equal(parse('#/nft/ethereum%3A0xabc').name, 'nft');
  assert.equal(href('nft', { id: 'base:0x1' }), '#/nft/base%3A0x1');
  assert.equal(navKey(parse('#/nft/x')), 'markets');
  assert.equal(ethTxt(0.01234), '0.012 ETH');
  assert.match(collectingHTML({ chains: [] }), /no NFT marketplace contracts/);
});

test('the Sources panel shows state, last success, error share and requests per group, host names only', () => {
  const report = { at: NOW, budget: { limit: 240, used1m: 12 }, counts: { ok: 1, slow: 0, failing: 1, 'rate-limited': 0, off: 1 }, groups: [
    { id: 'cex', label: 'Exchange APIs', items: [{ id: 'cex:x', name: 'X', host: 'api.x.com', state: 'ok', lastSuccess: NOW - 5000, errorShare1h: 0, requests1h: 240 }] },
    { id: 'rpc', label: 'Chain RPC endpoints', items: [{ id: 'rpc:1', name: 'Ethereum', host: 'rpc.example.org', yours: true, state: 'failing', lastSuccess: null, errorShare1h: 0.75, requests1h: 8, latencyMs: 900 }] },
    { id: 'nft', label: 'NFT sales', items: [{ id: 'nft:ethereum', name: 'Ethereum NFT sales', state: 'off', lagSeconds: 30, lastGap: { from: 1, to: 10, at: NOW - 60_000 }, salesSeen: 3, requests1h: 0, errorShare1h: null }] }] };
  const html = sourcesBody(report, NOW);
  clean(html);
  assert.match(html, /api\.x\.com/);
  assert.match(html, /rpc\.example\.org · yours/);
  assert.match(html, /75%/);
  assert.match(html, /Failing/);
  assert.match(html, /gap 10 blocks/);
  // Every group starts folded, failing ones too: the lists open on request.
  assert.match(html, /<details class="src-g" data-src="rpc">/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(sourcesPanel(undefined), /Loading sources/);
  assert.match(sourcesBody(null), /Not available/);
});
