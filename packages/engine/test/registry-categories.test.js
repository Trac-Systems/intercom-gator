import assert from 'node:assert/strict'
import test from 'node:test'
import { Registry } from '../src/registry/index.js'
import { migrations } from '../src/schema.js'
import { openStore } from './store-fixture.js'

test('registry seeds primary categories, derives legacy defaults and clears withdrawn classifications', t => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const tokens = [
    { id: 'ethereum:native', symbol: 'ETH' }, { id: 'base:native', symbol: 'ETH' },
    { id: 'newchain:native', symbol: 'ETH' }, { id: 'gnosis:native', symbol: 'XDAI' },
    { id: 'other:stable', symbol: 'DOLLAR', stable: true },
    { id: 'other:curated', symbol: 'ETH', category: 'Oracle / data' },
  ]
  const catalog = { assets: tokens.map(a => ({ ...a, name: a.symbol })), exchanges: [], chains: [] }
  const registry = new Registry(store, catalog)
  const expected = ['Layer 1', 'Layer 2', null, 'Stablecoin', 'Stablecoin', 'Oracle / data']
  assert.deepEqual(tokens.map(t => registry.assets.get(t.id).category), expected)
  delete catalog.assets.at(-1).category
  const next = new Registry(store, catalog)
  assert.equal(next.assets.get('other:curated').category, null)
  assert.equal(next.token('other', 'clone', { symbol: 'ETH', name: 'Ether' }).category ?? null, null)
})

test('category-only identities annotate discovered tokens, survive restart and withdraw without aliasing tickers', t => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const catalog = { assets: [], exchanges: [{ id: 'venue' }], chains: [{ id: 'solana' }] }
  const id = 'solana:wrapped', older = 'solana:existing'
  const before = new Registry(store, catalog)
  before.token('solana', 'existing', { symbol: 'WRAP' })
  const sources = [{ assetCategories: [id, older].map(id => ({ id, category: 'wrapped-bridged' })) }]
  const current = new Registry(store, catalog, sources)
  assert.equal(current.assets.has(id), false)
  assert.equal(current.assets.get(older).category, 'Wrapped / bridged')
  assert.equal(current.token('solana', 'wrapped', { symbol: 'WRAP' }).category, 'Wrapped / bridged')
  assert.equal(current.token('solana', 'impostor', { symbol: 'WRAP' }).category ?? null, null)
  assert.equal(current.resolve(catalog.exchanges[0], 'WRAP'), 'unresolved:venue:WRAP')
  const withdrawn = new Registry(store, catalog)
  assert.equal(withdrawn.assets.get(id).category, null)
  assert.equal(withdrawn.assets.get(older).category, null)
})

test('signed display categories preserve every historical USD-peg flag and distinguish ticker collisions', async t => {
  const { loadBundle } = await import('@gator/bundle')
  const { adaptBundle } = await import('../src/sources/bundle-adapter.js')
  const bundle = structuredClone(loadBundle())
  const token = bundle.tokens.tokens.find(t => t.symbol === 'EURC')
  const extra = { ...token, id: 'ethereum:0x' + '1'.repeat(40), name: 'Unverified', symbol: 'USDC', links: [] }
  delete extra.category
  delete extra.categorySource
  bundle.tokens.tokens.push(extra)
  const catalog = adaptBundle(bundle)
  const prior = structuredClone(bundle)
  for (const token of prior.tokens.tokens) delete token.category
  assert.deepEqual(catalog.assets.map(a => a.stable), adaptBundle(prior).assets.map(a => a.stable))
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const registry = new Registry(store, catalog, bundle.tokens.sources)
  assert.equal(registry.assets.get(token.id).category, 'Stablecoin')
  assert.equal(registry.assets.get(token.id).stable, 0)
  assert.equal(registry.assets.get(extra.id).category, null)
  const jup = [...registry.assets.values()].filter(a => a.symbol === 'JUP')
  assert.equal(jup.find(a => a.chain === 'solana').category, 'DeFi')
  assert.equal(jup.find(a => a.chain === 'ethereum').category, 'Infrastructure')
})

test('new signed native identities rebind persisted CEX bases and quotes before the first poll', async t => {
  const { loadBundle } = await import('@gator/bundle')
  const { adaptBundle } = await import('../src/sources/bundle-adapter.js')
  const catalog = adaptBundle(loadBundle()), store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const old = new Registry(store, { ...catalog, assets: catalog.assets.filter(a => a.id !== 'zcash:native') })
  const peg = 'bsc:0x1ba42e5193dfa8b03d15dd1b86a3113bbbef8eeb'
  const base = old.cex('bitstamp', 'ZEC', 'USD'), quote = old.cex('bitstamp', 'BTC', 'ZEC')
  assert.equal(base.base, peg)
  assert.equal(quote.quote, peg)
  const registry = new Registry(store, catalog)
  assert.equal(registry.known(base.id).base, 'zcash:native')
  assert.equal(registry.known(quote.id).quote, 'zcash:native')
  assert.equal(store.reader.prepare('SELECT base FROM markets WHERE id=?').get(base.id).base, 'zcash:native')
  const nativeCoins = ['XLM', 'BCH', 'ZEC', 'ETC', 'HBAR', 'XMR', 'LTC', 'DOGE', 'HYPE', 'PEARL', 'PI',
    'TAO', 'ICP', 'DOT', 'KAS', 'ALGO', 'FIL', 'LUNC', 'ZIL', 'WBT']
  for (const symbol of nativeCoins) {
    const coin = catalog.assets.find(a => a.address === 'native' && a.symbol === symbol)
    assert.ok(coin, symbol)
    for (const venue of catalog.exchanges.filter(v => !v.derivativeOnly))
      assert.equal(registry.resolve(venue, symbol), coin.id, venue.id + ' ' + symbol)
  }
  for (const [symbol, chain] of [['RENDER', 'solana'], ['JST', 'tron'], ['HTX', 'tron'], ['HUMA', 'solana'],
    ['PUFFER', 'ethereum'], ['EVAA', 'ton'], ['WSTAR', 'ethereum'], ['NAORIS', 'ethereum'], ['PIEVERSE', 'bsc'],
    ['BTW', 'ethereum']]) {
    const deployment = registry.cex('bitstamp', symbol, 'USD').base
    assert.ok(registry.seedIds.has(deployment))
    assert.equal(registry.assets.get(deployment).chain, chain)
  }
})
