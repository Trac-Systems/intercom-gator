// The screens on a young node: the shapes /api/v1 answers in its first minutes (no history,
// no supply, no social, unmapped derivatives). Nothing may print null/NaN/undefined, link to
// #/token/null, or render a column of dashes where one quiet note says what is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import markets from '../public/js/views/markets.js';
import newView from '../public/js/views/new.js';
import exchanges from '../public/js/views/exchanges.js';
import token from '../public/js/views/token.js';

const tok = (i) => ({
  id: i === 3 ? null : `ethereum:0x${String(i).padStart(40, '0')}`, symbol: 'T' + i, name: 'Token ' + i, rank: i + 1, price: 1 + i,
  change1h: null, change24h: null, change7d: null, volume24h: 1e6 * (50 - i), marketCap: null, fdv: null, trust: i % 2 ? 'green' : null,
  spark7d: [1 + i], chains: ['ethereum'], sources: { agents: 1, exchanges: 2 },
});
const empty = { items: [] };
const API = {
  global: async () => ({ marketCap: null, marketCapChange24h: null, volume24h: 5.9e9, stablecoins: null, btcDominance: null, ethDominance: null, gas: [{ chain: 'Base', value: '0.005 gwei' }], pegs: [] }),
  fearGreed: async () => ({ at: 0, value: null, label: null, inputs: [{ name: 'Volatility', value: null, status: 'collecting', days: { have: 2, need: 91 } }, { name: 'Social', value: 50, status: 'ok' }], yesterday: null, lastWeek: null, lastMonth: null, history30d: Array(30).fill(null), partial: false, missing: ['Volatility'] }),
  markets: async (q) => ({ items: q.tab === 'gainers' ? [] : Array.from({ length: q.limit ?? 100 }, (_, i) => tok(i + (q.offset || 0))), total: 1435 }), // no 24 h change → no gainers
  categories: async () => ({ items: [{ name: 'Stablecoin', marketCap: 0, change24h: null, top: ['USDE'] }] }),
  chains: async () => empty,
  derivatives: async () => ({ items: [{ id: 'd1', exchange: 'bybit', symbol: 'BTCUSDT', funding: '0.0001', openInterest: 72000, openInterestUnit: 'provider units', oiChange24h: null, asset: null }] }),
  nfts: async () => empty,
  exchanges: async () => ({ items: [{ id: 'weex', name: 'WEEX', kind: 'CEX', volume24h: 2.4e9, markets: 1761, trustScore: null, reporters: 2, change24h: null }, { id: 'uni', name: 'Uniswap', kind: 'DEX', chain: 'Base', volume24h: 1e6, markets: 3, trustScore: 6, trustWhy: { agreement: 3, freshness: 2, confirmation: 0, book: 0.5, comparedMarkets: 4 }, reporters: 0, change24h: null }] }),
  newTokens: async () => ({ items: [{ id: 'base:0xabc0000000000000000000000000000000000001', name: 'base:0xabc0000000000000000000000000000000000001', symbol: null, chain: 'base', price: null, change: null, ageMin: 7, age: '7m', liquidity: 18.7e6, holders: null, flags: ['upgradeable unknown', 'ownerMint unknown', 'risk unchecked'], riskFlags: {} }] }),
  trending: async () => empty,
  feed: async () => empty,
  extras: async () => empty,
  asset: async () => ({ ...tok(1), why: { state: 'green', reporters: null, window: null, spreadPct: null, sources: [{ venue: 'Upbit', pair: 'T1/KRW', price: 2900, deltaPct: null }, { venue: 'Gate', pair: 'T1/unresolved:gate:USD1', price: 2.01, deltaPct: 0.5 }] }, risk: { at: 1, method: 'evm', flags: ['risk unchecked'], checks: [] }, links: [] }),
  assetMarkets: async () => ({ items: [{ id: 'm', venue: 'Gate', kind: 'CEX', pair: 'T1/unresolved:gate:USD1', price: 2, volume24h: null, trust: null, updated: null }] }),
};

function ctxStub() {
  const idx = { byId: new Map(), bySym: new Map() };
  return {
    api: API, q: '', watch: new Set(), mentions: new Map(), people: new Map(), idx, route: { name: 'markets', params: {}, query: {} },
    promoUsed: false, takePromo() { return false; },
    cached: (k, fn) => fn(),
    noteTokens(list) { for (const t of list) if (t && t.id) { idx.byId.set(t.id, t); idx.bySym.set(t.symbol, t); } },
    noteMentions() {}, notePerson() {},
  };
}

function clean(name, html) {
  const text = html.replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(text, /\b(null|undefined|NaN)\b/, name + ': printed a missing value');
  assert.doesNotMatch(html, /token\/(null|undefined)\b|href="#\/token\/"|data-href=""/, name + ': link to a missing token');
}

test('markets tabs on a young node', async () => {
  // NFTs are hidden until the on-chain sales source ships.
  for (const tab of ['all', 'gainers', 'categories', 'chains', 'derivatives', 'exchanges']) {
    const ctx = ctxStub();
    const route = { name: 'markets', params: { tab }, query: {} };
    ctx.route = route;
    const d = await markets.load(ctx, route);
    const out = markets.html(ctx, d, route);
    clean('markets/' + tab, out.main + out.side);
    if (tab === 'all') {
      assert.match(out.main, /24 h and 7 d change: collecting history/);
      assert.match(out.main, /Market cap: needs supply data/);
      assert.doesNotMatch(out.main, />24 h<\/button>/); // no column of dashes
      assert.match(out.main, /100 of 1,435/);
      assert.match(out.main, /data-more="all"/);
      assert.match(out.main, /Top 30 · volume · 24 h change: collecting history/);
      assert.match(out.main, /needs supply data/);
      assert.doesNotMatch(out.main, /data-star=""/); // no watch star on a row without an asset
    }
    if (tab === 'derivatives') {
      assert.match(out.main, /\+0\.0100%/); // raw venue fraction shown as percent
      assert.doesNotMatch(out.main, /data-href/); // unmapped perp is not a link
      assert.doesNotMatch(out.main, /PERP-PERP/);
    }
    if (tab === 'chains') assert.match(out.main, /No chain activity yet/);
    if (tab === 'gainers') assert.match(out.main, /Gainers need 24 h of prices/);
  }
});

test('new tokens: one chip per row, short name for an unnamed discovery, no holders column of dashes', async () => {
  const ctx = ctxStub();
  const d = await newView.load(ctx, { name: 'new', params: {}, query: {} });
  const out = newView.html(ctx, d, { name: 'new', params: {}, query: {} });
  clean('new', out.main);
  assert.equal((out.main.match(/class="fchip/g) || []).length, 2); // the column + the phone copy, one row
  assert.match(out.main, />Unchecked</);
  assert.match(out.main, />0xabc0…0001</);
  assert.doesNotMatch(out.main, /Holders/);
});

test('exchanges: unscored venue is a quiet dash, scored one shows bars with its reasons', async () => {
  const ctx = ctxStub();
  const route = { name: 'exchanges', params: {}, query: {} };
  const d = await exchanges.load(ctx, route);
  const out = exchanges.html(ctx, d, route);
  clean('exchanges', out.main);
  assert.match(out.main, /Trust 6 of 10/);
  assert.match(out.main, /DEX · Base/);
  assert.match(out.main, /24 h volume change: collecting history/);
});

test('token page with missing history, supply, trust and risk', async () => {
  const ctx = ctxStub();
  const route = { name: 'token', params: { id: 'ethereum:0x01' }, query: {} };
  const d = await token.load(ctx, route);
  const out = token.html(ctx, d, route);
  clean('token', out.main + out.side);
  assert.match(out.main, /24 h: collecting/);
  assert.match(out.main, /Market cap and FDV: need supply data/);
  assert.match(out.side, /Not checked yet/);
  assert.match(out.side, /T1\/USD1/); // unresolved quote id tidied
  assert.match(out.side, />2,900\.00</); // KRW price without a dollar sign
  assert.doesNotMatch(out.side, /\$2,900/);
  assert.match(out.main, /1 agent</);
});
