// One page per coin: any member of a coin opens the coin (name, group price and cap) with a Contracts control
// that lists every member, and the markets of all members labelled with their chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import token, { coinView, contractsHTML, contractsPop, marketChain } from '../public/js/views/token.js';
import { buildSample, sampleContracts } from '../public/js/sample.js';
import { createDemoServer } from '../public/js/demo-server.js';

const usdt = buildSample(0).tokens.find((t) => t.symbol === 'USDT');
const TRON = 'tron:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

function ctxStub(api, id) {
  const idx = { byId: new Map(), bySym: new Map() };
  return {
    api, q: '', watch: new Set(), mentions: new Map(), people: new Map(), idx, route: { name: 'token', params: { id }, query: {} },
    cached: (k, fn) => fn(), noteTokens(list) { for (const t of list) if (t && t.id) idx.byId.set(t.id, t); }, notePerson() {},
  };
}

test('the TRON member page shows the USDT coin with all 15 contracts and the Ethereum CEX markets', async () => {
  const demo = createDemoServer({ now: () => 0 });
  const api = {
    asset: (id) => demo.route('GET', '/assets/' + encodeURIComponent(id), {}),
    assetMarkets: (id) => demo.route('GET', '/assets/' + encodeURIComponent(id) + '/markets', {}),
    feed: async () => ({ items: [] }),
  };
  const ctx = ctxStub(api, TRON);
  const d = await token.load(ctx, ctx.route);
  assert.equal(d.t.id, TRON);
  assert.equal(d.t.contracts.length, 15);
  const out = token.html(ctx, d);
  // Headline: the coin, not the deployment.
  assert.match(out.main, /<h1>Tether <small>USDT<\/small>/);
  assert.match(out.main, /<span class="rk n">#3<\/span>/);
  // The control names the open member: TRON, its short address, copy, explorer, and "14 more chains".
  assert.match(out.main, /class="ct-ch">TRON</);
  assert.match(out.main, /data-copy="TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"/);
  assert.match(out.main, /href="https:\/\/tronscan\.org\/#\/token20\/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"/);
  assert.match(out.main, /id="ct-more" aria-haspopup="dialog" aria-expanded="false">14 more chains/);
  // Markets carry their chain: CEX pairs bind to Ethereum, the SunSwap pool is on TRON.
  assert.match(out.main, /Binance · Ethereum/);
  assert.match(out.main, /SunSwap v2 · TRON/);
  // The member's own figures are secondary.
  assert.match(out.side, /This contract/);
  assert.doesNotMatch(out.main + out.side, /undefined|NaN|>null</);
});

test('the dropdown lists every member once with role, copy and explorer, the open one marked', () => {
  const t = { ...usdt, id: TRON, ...sampleContracts(usdt, TRON) };
  const html = contractsPop(t);
  const items = html.match(/<li/g) || [];
  assert.equal(items.length, 15);
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  assert.match(html, /<li class="cur"><a class="ct-go" href="#\/token\/tron%3ATR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" aria-current="page"/);
  assert.match(html, /<b>Arbitrum One<\/b><span class="ct-role">bridged \(USDT0\)<\/span>/);
  assert.equal((html.match(/data-copy=/g) || []).length, 15);
  assert.equal((html.match(/target="_blank" rel="noopener noreferrer"/g) || []).length, 15);
  assert.match(html, /Contracts <span class="n">15<\/span>/);
  // Selecting the Ethereum member navigates to it (the sample names it with its short id).
  assert.match(html, /href="#\/token\/eth%3A0xdac17f958d2ee523a2206206994597c13d831ec7"/);
});

test('standalone tokens get the same control without a dropdown; native coins and old answers keep the plain line', () => {
  const one = contractsHTML({ id: 'base:0x1', contracts: [{ id: 'base:0x1', chain: 'base', chainName: 'Base', address: '0x1234567890abcdef1234', explorer: 'https://basescan.org/token/0x1234567890abcdef1234', role: null, current: true }] });
  assert.match(one, /class="ct-ch">Base</);
  assert.doesNotMatch(one, /ct-more/);
  assert.equal(contractsHTML({ id: 'bitcoin:native', contracts: [] }), '');
  assert.equal(contractsHTML({ id: 'x:1' }), '');
  assert.equal(marketChain({ contracts: [] }, { kind: 'DEX', chain: 'base' }), ' · Base');
  assert.equal(marketChain({ contracts: [] }, { kind: 'CEX' }), '');
  assert.equal(marketChain({ contracts: [{}, {}] }, { kind: 'CEX', chainName: 'Ethereum' }), ' · Ethereum');
});

test('a coin headline uses the group figures and leaves standalone tokens untouched', () => {
  const plain = { id: 'a', price: 2, marketCap: 5 };
  assert.equal(coinView(plain), plain);
  const v = coinView({ id: TRON, name: 'Tether USDT', symbol: 'USDT', price: null, marketCap: 92e9, fdv: 92e9, rank: 3,
    coinGroup: { name: 'Tether USD', symbol: 'USDT', price: 1.0002, marketCap: 171e9, volume24h: 6e10, change24h: 0.01, rank: 3 } });
  assert.equal(v.price, 1.0002);
  assert.equal(v.marketCap, 171e9);
  assert.equal(v.fdv, null);
  assert.equal(v.name, 'Tether USD');
});
