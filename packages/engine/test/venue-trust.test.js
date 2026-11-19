import test from 'node:test'
import assert from 'node:assert/strict'
import { Queries } from '../src/aggregate/queries.js'
import { MarketBook } from '../src/aggregate/book.js'
import { Registry } from '../src/registry/index.js'
import { migrations } from '../src/schema.js'
import { openStore } from './store-fixture.js'

const HOUR = 3_600_000
const ownKey = 'a'.repeat(64)
function fixture(t, symbols = ['A', 'B', 'C', 'Q']) {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const assets = symbols.map((symbol, i) => ({ id: symbol + ':native', symbol, name: symbol, rank: i + 1 }))
  const registry = new Registry(store, {
    assets, exchanges: [{ id: 'venue', name: 'Venue' }, { id: 'anchor' }],
    chains: [{ id: 'base', name: 'Base' }, { id: 'eth', name: 'Ethereum' }],
  })
  let now = 1_800_000_000_000
  const clock = () => now
  const book = new MarketBook({ registry, store, clock, ownKey })
  const queries = new Queries({ registry, store, clock, book })
  function observe(exchange, symbol, { price = 100, usd = 100, bid = null, ask = null, key = ownKey,
    quote = 'USD', at = now, baseVolume = 1 } = {}) {
    const market = registry.cex(exchange, symbol, quote)
    book.ingest(key, [[market.id, String(price), baseVolume, usd, bid, ask, at]], key === ownKey)
  }
  return { registry, store, clock, book, queries, observe, advance: ms => { now += ms },
    venue: () => queries.exchanges({ include: 'hidden' }).find(v => v.id === 'venue') }
}

for (const [price, halfSpread, agreement, quality] of [
  [100.1, 0.05, 5, 1], [101.05, 0.275, 2.5, 0.5], [102, 0.5, 0, 0],
]) {
  test('agreement and order-book components at price ' + price + ' and half-spread ' + halfSpread, t => {
    const f = fixture(t)
    f.registry.venues.get('venue').publishMarketData = false
    for (const s of ['A', 'B', 'C']) {
      f.observe('anchor', s, { usd: 500 })
      f.observe('venue', s, { price, bid: 100 - halfSpread, ask: 100 + halfSpread })
    }
    const row = f.venue()
    assert.deepEqual(row.trustWhy, { agreement, freshness: 2, confirmation: 0, book: quality, comparedMarkets: 3 })
    assert.equal(row.trustScore, Math.round(agreement + 2 + quality))
    assert.equal(row.reporters, 1)
  })
}

test('agreement weights deviations by turnover and converts the market quote to USD', t => {
  const f = fixture(t)
  f.observe('anchor', 'Q', { price: 2 })
  for (const s of ['A', 'B', 'C']) {
    f.observe('anchor', s, { usd: 10_000 })
    f.observe('venue', s, { quote: 'Q', price: s === 'C' ? 50 : 51, usd: s === 'C' ? 1000 : 10 })
  }
  assert.deepEqual(f.venue().trustWhy, { agreement: 5, freshness: 2, confirmation: 0, book: 0.5, comparedMarkets: 3 })
  f.advance(1000)
  f.observe('venue', 'A', { quote: 'Q', price: 51, usd: 3000 })
  assert.equal(f.venue().trustWhy.agreement, 0)
})

test('freshness includes stale turnover while agreement excludes stale markets, red assets and missing FX', t => {
  const f = fixture(t)
  f.observe('venue', 'A', { usd: 50, at: f.clock() - HOUR - 1 })
  f.observe('venue', 'B', { usd: 10 })
  f.observe('venue', 'C', { usd: 20, price: 120 })
  f.observe('anchor', 'C', { usd: 20, price: 100 })
  f.observe('venue', 'B', { usd: 20, quote: 'Q' })
  const row = f.venue()
  assert.equal(row.trustScore, null)
  assert.deepEqual(row.trustWhy, { agreement: 5, freshness: 1, confirmation: 0, book: 0.5, comparedMarkets: 1 })
  f.advance(4 * HOUR)
  assert.deepEqual(f.venue().trustWhy, { agreement: null, freshness: 0, confirmation: 0, book: 0.5, comparedMarkets: 0 })
})

test('zero USD turnover uses equal market weights, with fewer than three comparables unrated', t => {
  const f = fixture(t)
  f.observe('venue', 'A', { usd: 0 })
  f.observe('venue', 'B', { usd: 0 })
  f.registry.cex('venue', 'C', 'USD')
  const row = f.venue()
  assert.equal(row.trustScore, null)
  assert.equal(row.markets, 3)
  assert.deepEqual(row.trustWhy, { agreement: 5, freshness: 1.333333, confirmation: 0, book: 0.5, comparedMarkets: 2 })
})

test('only distinct proven eligible peers in the last hour contribute independent confirmation', t => {
  const f = fixture(t)
  const prove = f.store.writer.prepare('INSERT INTO engine_standing VALUES (?,3,?,1)')
  for (const s of ['A', 'B', 'C']) f.observe('venue', s, { bid: 100, ask: 100 })
  prove.run(ownKey, f.clock())
  assert.equal(f.venue().trustScore, 8)
  const peer = c => c.repeat(64)
  for (const c of ['b', 'c', 'd', 'e', 'f']) prove.run(peer(c), f.clock())
  f.observe('venue', 'A', { key: peer('e'), at: f.clock() - HOUR - 1 })
  f.observe('venue', 'A', { key: peer('f') })
  f.store.writer.prepare('INSERT INTO reporters(key,mutedUntil) VALUES (?,?)').run(peer('f'), f.clock() + HOUR)
  f.observe('venue', 'A', { key: peer('0') }) // provisional
  assert.equal(f.venue().trustWhy.confirmation, 0)
  f.observe('venue', 'A', { key: peer('b'), at: f.clock() - HOUR })
  f.observe('venue', 'B', { key: peer('b'), at: f.clock() - HOUR })
  assert.equal(f.venue().trustWhy.confirmation, 1)
  f.observe('venue', 'B', { key: peer('c') })
  assert.equal(f.venue().trustWhy.confirmation, 1.5)
  f.observe('venue', 'C', { key: peer('d') })
  assert.equal(f.venue().trustScore, 10)
  assert.equal(f.venue().reporters, 6)
})

test('book quality uses the ten highest-volume quoted markets and prefers a fresh own quote', t => {
  const symbols = Array.from({ length: 24 }, (_, i) => 'A' + i)
  const f = fixture(t, symbols)
  for (const [i, s] of symbols.entries()) {
    f.observe('venue', s, { usd: i, bid: i >= 14 ? 100 : 98, ask: 100 })
    f.observe('venue', s, { key: 'b'.repeat(64), usd: i, bid: 90, ask: 100, at: f.clock() + 1 })
  }
  assert.equal(f.venue().trustWhy.book, 1)
})

test('DEX rows display registry chain names and retain their venue ID across deployments', t => {
  const f = fixture(t)
  const add = chain => f.registry.register({ id: 'dex:' + chain + ':pool', kind: 'dex', chain,
    exchange: 'swap', base: 'A:native', quote: 'Q:native' })
  add('base')
  assert.deepEqual(f.queries.exchanges(), [])
  const row = f.queries.exchanges({ include: 'hidden' })[0]
  assert.equal(row.id, 'swap')
  assert.equal(row.kind, 'DEX')
  assert.equal(row.chain, 'Base')
  add('eth')
  assert.equal(f.queries.markets({ tab: 'exchanges', include: 'hidden' })[0].chain, 'Base, Ethereum')
})

test('volume history samples without exchange reads, keeps one row per UTC hour and compares the exact day-old hour', t => {
  const f = fixture(t)
  const sample = () => f.store.prune({ now: f.clock() })
  const history = () => f.store.reader.prepare('SELECT hour,volume FROM engine_venue_volume ORDER BY hour').all()
  f.observe('venue', 'A', { usd: null, baseVolume: 2 })
  sample()
  assert.equal(history()[0].volume, 200)
  f.advance(1000)
  f.observe('venue', 'A', { usd: 400 })
  sample()
  assert.deepEqual(history().map(r => r.volume), [400])
  f.advance(23 * HOUR)
  assert.equal(f.venue().change24h, null)
  f.advance(HOUR)
  f.observe('venue', 'A', { usd: 300 })
  assert.equal(f.venue().change24h, -25)
  f.advance(HOUR)
  assert.equal(f.venue().change24h, null)
  const original = history()[0].hour
  f.advance((8 * 24 - 25) * HOUR)
  sample()
  assert.equal(history()[0].hour, original)
  f.advance(HOUR)
  sample()
  assert.ok(history().every(r => r.hour > original))
})

test('zero baseline volume has no percentage change and an observed drop to zero is minus 100%', t => {
  const f = fixture(t)
  f.observe('venue', 'A', { usd: 0 })
  assert.equal(f.venue().change24h, null)
  f.advance(24 * HOUR)
  f.observe('venue', 'A', { usd: 100 })
  assert.equal(f.venue().change24h, null)
  f.advance(24 * HOUR)
  f.observe('venue', 'A', { usd: 0 })
  assert.equal(f.venue().change24h, -100)
})

test('a venue with no remaining volume observation has unknown volume change', t => {
  const f = fixture(t)
  f.observe('venue', 'A', { usd: 100 })
  assert.equal(f.venue().volume24h, 100)
  f.advance(24 * HOUR + 1000)
  f.store.prune({ now: f.clock() })
  assert.equal(f.venue().change24h, null)
})

test('turnover in unresolved bases is reported apart and does not rank the venue', t => {
  const f = fixture(t)
  f.observe('venue', 'A', { usd: 100 })
  // A tokenized share on one venue: no known asset, so its claimed turnover cannot be checked.
  const stock = f.registry.register({ id: 'cex:venue:RNVDA-USD', kind: 'cex', exchange: 'venue',
    base: 'unresolved:venue:RNVDA', quote: 'fiat:USD' })
  f.book.ingest(ownKey, [[stock.id, '154', 227_000_000, 34_000_000_000, null, null, f.clock()]], true)
  const row = f.venue()
  assert.equal(row.markets, 2)
  assert.equal(row.volume24h, 100)
  assert.equal(row.unresolvedVolume24h, 34_000_000_000)
  assert.equal(row.trustWhy.freshness, 2)
  f.store.prune({ now: f.clock() })
  assert.equal(f.store.reader.prepare("SELECT volume FROM engine_venue_volume WHERE venue='venue'").get().volume, 100)
})

test('legacy markets without a venue cannot prevent hourly maintenance', t => {
  const f = fixture(t)
  f.registry.register({ id: 'legacy-market', kind: 'cex', base: 'A:native', quote: 'fiat:USD' })
  f.observe('venue', 'B')
  f.store.prune({ now: f.clock() })
  assert.deepEqual(f.queries.exchanges().map(row => row.id), ['venue'])
})
