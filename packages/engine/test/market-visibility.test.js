import assert from 'node:assert/strict'
import test from 'node:test'
import { openStore } from './store-fixture.js'
import { MarketBook } from '../src/aggregate/book.js'
import { Queries } from '../src/aggregate/queries.js'
import { Registry } from '../src/registry/index.js'
import { migrations } from '../src/schema.js'

const start = 1_800_000_000_000, hour = 3_600_000, day = 24 * hour

function fixture(t, definitions) {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const assets = definitions.map(([symbol, id, extra], index) => ({
    id: id ?? 'test:' + symbol, symbol, name: symbol, rank: 600 + index, category: 'Test', supply: 10, ...extra,
  }))
  const registry = new Registry(store, { assets, chains: [{ id: 'test' }, { id: 'bitcoin' }], exchanges: [{ id: 'spot' }] })
  let now = start
  const clock = () => now, book = new MarketBook({ store, registry, clock, ownKey: 'own' })
  const queries = new Queries({ store, registry, clock, book })
  function dex(symbol, pool, liquidity) {
    const id = 'dex:test:' + pool, base = 'test:' + symbol
    store.upsertPool({ chain: 'test', pool, token0: symbol, token1: 'USD', dex: 'swap', liquidity, firstSeen: now })
    return registry.register({ id, exchange: 'swap', kind: 'dex', chain: 'test', base, quote: 'fiat:USD' }).id
  }
  const cex = symbol => registry.cex('spot', symbol, 'USD').id
  const write = (market, key = 'own', at = now, volume = 100, price = '2') =>
    book.ingest(key, [[market, price, '0', volume, null, null, at]], key === 'own')
  return { store, registry, book, queries, dex, cex, write, advance(ms) { now += ms } }
}

test('rankings and totals use the same live, confirmed, non-dust assets before pagination', t => {
  const { store, queries, dex, cex, write } = fixture(t, [
    ['BTC', 'bitcoin:native'], ['STABLE', 'test:STABLE', { stable: true }], ['REMOTE', undefined, { stable: true }],
    ['THIN', undefined, { stable: true }], ['STALE'], ['EMPTY'],
  ])
  const prove = store.writer.prepare('INSERT INTO engine_standing VALUES (?,3,?,1)')
  prove.run('proven', start)
  write(cex('BTC'))
  write(cex('STABLE'), 'proven', start, 20, '1')
  write(cex('REMOTE'), 'remote', start, 1_000_000)
  write(dex('THIN', 'thin', 9999))
  write(cex('STALE'), 'own', start - hour - 1)
  const list = options => queries.markets(options).map(r => r.symbol)
  assert.deepEqual(list(), ['BTC', 'STABLE'])
  assert.deepEqual(list({ limit: 1, offset: 1 }), ['STABLE'])
  assert.deepEqual(list({ tab: 'trending' }).sort(), ['BTC', 'STABLE'])
  assert.deepEqual(store.marketCounts(), { total: 2, hidden: { stale: 1, unconfirmed: 2, dust: 1 } })
  const everything = queries.markets({ include: 'hidden' })
  assert.deepEqual(everything.map(r => r.visibility), ['live', 'live', 'unconfirmed', 'dust', 'stale', 'unconfirmed'])
  assert.equal(everything[4].staleSince, start - 1)
  assert.equal(queries.search('THIN')[0].visibility, 'dust')
  assert.equal(queries.detail('test:REMOTE').visibility, 'unconfirmed')
  assert.deepEqual(store.marketCounts({ chain: 'bitcoin' }).hidden, { stale: 0, unconfirmed: 0, dust: 0 })
  const global = queries.global()
  assert.equal(global.marketCap, 30)
  assert.equal(global.marketCapAssets, 2)
  assert.equal(global.volume24h, 120)
  assert.equal(global.btcDominance, 100 * 20 / 30)
  assert.equal(global.stablecoins, 10)
  assert.deepEqual(global.pegs.map(p => p.asset), ['test:STABLE'])
  assert.equal(queries.categories()[0].marketCap, 30)
  // Hidden REMOTE (unconfirmed) and THIN (dust) count; STALE has one CEX venue only, so it shows no cap.
  assert.equal(queries.categories({ include: 'hidden' })[0].marketCap, 70)
  const chain = queries.chains().find(c => c.chain === 'test')
  assert.deepEqual([chain.tokens, chain.pools, chain.dexVolume24h], [1, 0, 0])
  const full = queries.chains({ include: 'hidden' }).find(c => c.chain === 'test')
  assert.deepEqual([full.tokens, full.pools, full.dexVolume24h], [4, 1, 100])
})

test('dust uses the best known pool and positive turnover, including unknown depth and the exact floor', t => {
  const { queries, dex, cex, write } = fixture(t, [['FLOOR'], ['UNKNOWN'], ['QUIET'], ['MIXED']])
  write(dex('FLOOR', 'shallow', 50))
  write(dex('FLOOR', 'deep', 10_000))
  write(dex('UNKNOWN', 'unknown', null))
  write(dex('QUIET', 'deep-quiet', 10_001), 'own', start, 0)
  write(dex('MIXED', 'small', 0))
  write(cex('MIXED'), 'own', start, 0)
  assert.deepEqual(queries.markets().map(r => r.symbol), ['FLOOR', 'UNKNOWN', 'MIXED'])
  assert.equal(queries.detail('test:QUIET').visibility, 'dust')
})

test('the stale flag and one-hour ceiling expire independently, including a zero-turnover local CEX quote', t => {
  const { queries, cex, write, advance } = fixture(t, [['FAST', undefined, { rank: 1 }], ['SLOW']])
  write(cex('FAST'), 'own', start, 0)
  write(cex('SLOW'))
  advance(90_000)
  assert.equal(queries.detail('test:FAST').visibility, 'live')
  advance(100_000)
  const fast = queries.detail('test:FAST')
  assert.equal(fast.whyTrusted.stale, true)
  assert.equal(fast.visibility, 'stale')
  assert.equal(fast.staleSince, start + 180_000)
  advance(hour - 190_000)
  assert.equal(queries.detail('test:SLOW').visibility, 'live')
  advance(1)
  const slow = queries.detail('test:SLOW')
  assert.equal(slow.whyTrusted.stale, false)
  assert.equal(slow.visibility, 'stale')
  assert.equal(slow.staleSince, start + hour)
})

test('the hourly prune forgets idle membership, preserves local interests and restores a newly observed asset', t => {
  const { store, registry, queries, cex, write, advance } = fixture(t, [['IDLE'], ['WATCH'], ['HELD'], ['ALERT'], ['NEVER'], ['RAW']])
  for (const symbol of ['IDLE', 'WATCH', 'HELD', 'ALERT']) write(cex(symbol))
  store.watch('test:WATCH', start)
  store.setHolding({ asset: 'test:HELD', amount: '1' })
  store.addAlert({ asset: 'test:ALERT', direction: 'above', threshold: '1', createdAt: start })
  queries.markets()
  advance(6 * day)
  // An unconvertible observation still protects the asset after raw history rolls off.
  write(registry.cex('spot', 'RAW', 'EUR').id)
  advance(day)
  store.prune({ now: start + 7 * day })
  const all = () => queries.markets({ include: 'hidden' }).map(r => r.symbol)
  assert.deepEqual(all(), ['WATCH', 'HELD', 'ALERT', 'RAW'])
  assert.deepEqual(queries.markets({ tab: 'watch' }).map(r => r.visibility), ['stale'])
  assert.deepEqual(queries.search('IDLE'), [])
  assert.deepEqual(store.marketCounts().hidden, { stale: 3, unconfirmed: 1, dust: 0 })
  write(cex('IDLE'))
  assert.deepEqual(all(), ['IDLE', 'WATCH', 'HELD', 'ALERT', 'RAW'])
  assert.equal(queries.detail('test:IDLE').visibility, 'live')
})

test('confirmation follows the priced USD path and updates when reporter standing changes', t => {
  const { queries, registry, store, cex, write, advance } = fixture(t, [['COIN'], ['FX']])
  const quote = cex('FX'), cross = registry.cex('spot', 'COIN', 'FX').id
  write(quote, 'remote', start, 10, '1')
  write(cross, 'own')
  assert.equal(queries.detail('test:COIN').visibility, 'unconfirmed')
  store.writer.prepare('INSERT INTO engine_standing VALUES (?,3,?,1)').run('remote', start)
  advance(1000)
  assert.equal(queries.detail('test:COIN').visibility, 'live')
  assert.deepEqual(queries.markets().map(r => r.symbol), ['COIN', 'FX'])
  store.writer.prepare('UPDATE engine_standing SET agreements=0 WHERE reporter=?').run('remote')
  advance(1000)
  assert.equal(queries.detail('test:COIN').visibility, 'unconfirmed')
  assert.deepEqual(queries.markets(), [])
})

test('a supported market discarded for a disagreeing FX path cannot confirm a provisional USD price', t => {
  const { queries, registry, cex, write } = fixture(t, [['COIN'], ['FX']])
  write(cex('FX'), 'own', start, 100, '1')
  // Separate independent venues keep both measurements eligible for the FX spread.
  registry.venues.set('other', { id: 'other' })
  write(registry.cex('other', 'FX', 'USD').id, 'own', start, 100, '3')
  write(registry.cex('spot', 'COIN', 'FX').id, 'own', start, 100, '10')
  write(cex('COIN'), 'unproven', start, 100, '30')
  const result = queries.detail('test:COIN')
  assert.equal(result.price, 30)
  assert.equal(result.whyTrusted.provenSources, 0)
  assert.equal(result.visibility, 'unconfirmed')
})

test('a locally priced DEX quote asset uses turnover and liquidity from its side of the pool', t => {
  const { queries, registry, store, write, advance } = fixture(t, [['BASE'], ['QUOTE']])
  const id = 'dex:test:pool'
  registry.register({ id, exchange: 'swap', kind: 'dex', chain: 'test', base: 'test:BASE', quote: 'test:QUOTE' })
  const pool = { chain: 'test', pool: 'pool', token0: 'BASE', token1: 'QUOTE', dex: 'swap', firstSeen: start }
  store.upsertPool({ ...pool, liquidity: 15_000 })
  store.writer.prepare('INSERT INTO engine_references VALUES (?,?,?,?)').run('test:QUOTE', 'local-read', 1, start)
  write(id)
  assert.equal(queries.detail('test:QUOTE').visibility, 'live')
  store.upsertPool({ ...pool, liquidity: 9_999 })
  advance(1000)
  assert.equal(queries.detail('test:QUOTE').visibility, 'dust')
})

test('one CEX venue matched by symbol prices a token but shows no market cap', t => {
  const { queries, registry, cex, write } = fixture(t, [['RLB'], ['TWO']])
  write(cex('RLB'), 'own', start, 1000, '71.43')
  write(cex('TWO'), 'own', start, 1000, '2')
  write(registry.register({ id: 'cex:other:TWO-USD', exchange: 'other', kind: 'cex', base: 'test:TWO', quote: 'fiat:USD' }).id,
    'own', start, 1000, '2')
  const rows = new Map(queries.markets({ include: 'hidden' }).map(r => [r.symbol, r]))
  assert.equal(rows.get('RLB').price, 71.43)
  assert.equal(rows.get('RLB').marketCap, null)
  assert.ok(rows.get('TWO').marketCap > 0)
})

test('a local DEX state read with no sampled swaps keeps turnover measured by a fresh proven peer', t => {
  const { queries, store, dex, write } = fixture(t, [['TAIL'], ['UNPROVEN']])
  const market = dex('TAIL', 'funded', 30_000)
  store.writer.prepare('INSERT INTO engine_standing VALUES (?,3,?,1)').run('peer', start)
  write(market, 'peer', start, 150, '2.01')
  write(market, 'own', start, null, '2')
  const detail = queries.detail('test:TAIL')
  assert.equal(detail.price, 2)
  assert.equal(detail.visibility, 'live')
  assert.equal(detail.trust, 'yellow')
  assert.equal(detail.volume24h, 150)
  const other = dex('UNPROVEN', 'other', 30_000)
  write(other, 'stranger', start, 10000)
  write(other, 'own', start, null)
  assert.equal(queries.detail('test:UNPROVEN').visibility, 'dust')
})
