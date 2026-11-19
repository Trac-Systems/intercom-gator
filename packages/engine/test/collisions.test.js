import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregateAssets, marketMedian } from '../src/aggregate/index.js'
import { collisionReport, marketUsdVolume, splitCollisions, SPLIT_REVIEW_MS } from '../src/aggregate/collisions.js'
import { Queries } from '../src/aggregate/queries.js'
import { MarketBook } from '../src/aggregate/book.js'
import { Registry } from '../src/registry/index.js'
import { migrations } from '../src/schema.js'
import { openStore } from './store-fixture.js'

// Live numbers measured 2026-11-19: RAIN is one project on Bitget and another on HTX/Gate/Bitrue/KuCoin/MEXC/WEEX;
// RBC is another project on Bitget than Rubic (Gate). Base volumes are the venues' own 24 h figures.
const RAIN = 'arbitrum:0x25118290e6a5f4139381d072181157035864099d'
const RBC = 'ethereum:0xa4eed63db85311e22df4473f87ccfc3dadcfa3e3'
const USDT = 'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7'
const ETH = 'ethereum:native'
const RAIN_TICKS = [
  ['bitget', '65.4', 204281.5367],
  ['htx', '0.004407', 1256559909.3683],
  ['gate', '0.004404', 436768079],
  ['bitrue', '0.004407', 232881681.52],
  ['kucoin', '0.004412', 32546466],
  ['mexc', '0.004434', 12420582.93],
  ['weex', '0.0044076', 219265556.15],
]
const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual / expected - 1) <= tolerance, actual + ' ≉ ' + expected)

// ---- pure aggregation -------------------------------------------------------------------------------------------
const now = 1_795_084_430_000
const pureAssets = new Map([
  [RAIN, { id: RAIN, symbol: 'RAIN' }], [RBC, { id: RBC, symbol: 'RBC' }], [ETH, { id: ETH, symbol: 'ETH' }],
  ['coin', { id: 'coin' }],
])
function market(id, base, quote, price, { volume = 0, usd = null, kind = 'cex', proven = true, reporters = ['me'] } = {}) {
  const [, exchange] = id.split(':')
  return marketMedian({ id, kind, rank: 200, exchange, base, quote },
    reporters.map(reporter => ({ reporter, own: proven && reporter === 'me', proven, price: String(price), weight: 1,
      srcTs: now, baseVol24h: volume, quoteVol24hUsd: usd })), now)
}
const rainMarkets = () => RAIN_TICKS.map(([venue, price, volume]) =>
  market('cex:' + venue + ':RAIN-USDT', RAIN, 'fiat:USD', price, { volume }))
const anchor = price => ({ asset: RAIN, at: now, price, why: { stale: false, depegs: [], referenceProviders: ['llama-prices'] } })

test('RAIN without an own price: six venues at $0.0044 outvote Bitget at $65.40, which is detached', () => {
  const collisions = new Map()
  const result = aggregateAssets(pureAssets, rainMarkets(), now, new Map(), { collisions }).get(RAIN)
  close(result.price, 0.004407)
  assert.equal(result.exchanges, 6)
  // Volume of the kept markets only, each valued at its own price (never 1.26 B RAIN × $65).
  const expected = RAIN_TICKS.slice(1).reduce((sum, [, price, volume]) => sum + volume * Number(price), 0)
  close(result.volume24h, expected)
  assert.ok(result.volume24h < 20e6)
  const record = collisions.get(RAIN)
  assert.equal(record.kept.reason, 'venues')
  assert.deepEqual(record.detached.map(d => [d.market, d.key, d.current, d.proven]),
    [['cex:bitget:RAIN-USDT', 'bitget:RAIN', true, true]])
  assert.ok(record.detached[0].ratio > 14_000 && record.detached[0].ratio < 15_000)
  assert.equal(record.kept.supported, true)
})

test('RAIN with its own price: a DEX pool or reference read decides the kept cluster before venue counts', () => {
  // A proven pool of the token at $65.40 keeps Bitget; the six $0.0044 venues are the other project.
  const pool = market('dex:arbitrum:0x' + '1'.repeat(40), RAIN, 'fiat:USD', '65.38', { kind: 'dex', volume: 1000 })
  let collisions = new Map()
  let result = aggregateAssets(pureAssets, [...rainMarkets(), pool], now, new Map(), { collisions }).get(RAIN)
  close(result.price, 65.4, 1e-3)
  assert.equal(collisions.get(RAIN).kept.reason, 'dex')
  assert.deepEqual(collisions.get(RAIN).detached.map(d => d.venue).sort(),
    ['bitrue', 'gate', 'htx', 'kucoin', 'mexc', 'weex'])
  // A reference read for the token's address at $0.0044 (DefiLlama measured 0.0044036) keeps the six venues.
  collisions = new Map()
  result = aggregateAssets(pureAssets, rainMarkets(), now, new Map([[RAIN, anchor(0.004403620247636708)]]),
    { collisions }).get(RAIN)
  close(result.price, 0.004407)
  assert.equal(collisions.get(RAIN).kept.reason, 'reference')
  assert.deepEqual(collisions.get(RAIN).detached.map(d => d.venue), ['bitget'])
})

test('RBC: Gate quotes Rubic in USDT and ETH; both Gate markets cluster together against Bitget', () => {
  const eth = market('cex:kraken:ETH-USD', ETH, 'fiat:USD', '1803.1', { volume: 1000 })
  const markets = [
    eth,
    market('cex:bitget:RBC-USDT', RBC, 'fiat:USD', '74.94', { volume: 868864.1219 }),
    market('cex:gate:RBC-USDT', RBC, 'fiat:USD', '0.0016956', { volume: 13440783 }),
    market('cex:gate:RBC-ETH', RBC, ETH, '0.0000009404', { volume: 6991553 }),
  ]
  // Without an own price the venues tie (1 : 1) and turnover decides: Bitget's $65 M beats Gate's $34 k.
  let collisions = new Map()
  let result = aggregateAssets(pureAssets, markets, now, new Map(), { collisions }).get(RBC)
  assert.equal(result.price, 74.94)
  assert.equal(collisions.get(RBC).kept.reason, 'volume')
  assert.deepEqual(collisions.get(RBC).detached.map(d => d.market).sort(), ['cex:gate:RBC-ETH', 'cex:gate:RBC-USDT'])
  // With Rubic's own price (a reference read) Gate's two markets are kept and Bitget's label is detached.
  collisions = new Map()
  const reference = new Map([[RBC, { ...anchor(0.0017), asset: RBC }]])
  result = aggregateAssets(pureAssets, markets, now, reference, { collisions }).get(RBC)
  assert.ok(result.price > 0.0016 && result.price < 0.0018)
  assert.equal(result.exchanges, 1)
  close(result.volume24h, 13440783 * 0.0016956 + 6991553 * 0.0000009404 * 1803.1)
  assert.deepEqual(collisions.get(RBC).detached.map(d => d.market), ['cex:bitget:RBC-USDT'])
})

test('peer-only venues break a tie between proven clusters before turnover; they cannot outvote proven ones', () => {
  // Proven: a dead Binance.US pair at $4.86 with stale turnover, Kraken at $0.1157 (1 : 1). Peers report two more
  // venues at $0.10.
  const markets = [
    market('cex:binance-us:BAL-USD', 'coin', 'fiat:USD', '4.859', { volume: 1e6 }),
    market('cex:kraken:BAL-USD', 'coin', 'fiat:USD', '0.1157', { volume: 1e4 }),
    market('cex:htx:BAL-USDT', 'coin', 'fiat:USD', '0.09998', { proven: false, reporters: ['p1'], volume: 1e5 }),
    market('cex:poloniex:BAL-USDT', 'coin', 'fiat:USD', '0.09489', { proven: false, reporters: ['p2'], volume: 1e5 }),
  ]
  const collisions = new Map()
  const result = aggregateAssets(pureAssets, markets, now, new Map(), { collisions }).get('coin')
  assert.ok(result.price < 0.12)
  assert.equal(collisions.get('coin').kept.reason, 'venues')
  assert.deepEqual(collisions.get('coin').detached.map(d => d.market), ['cex:binance-us:BAL-USD'])
  // Peers alone cannot outvote a proven cluster with more proven venues.
  const proven = [markets[0], market('cex:okx:BAL-USD', 'coin', 'fiat:USD', '4.86', { volume: 1 }), markets[1],
    ...markets.slice(2)]
  assert.equal(aggregateAssets(pureAssets, proven, now).get('coin').price, 4.859)
})

test('a real 3× move with lagging venues is not split', () => {
  const venues = [['a', 1], ['b', 1.4], ['c', 2.2], ['d', 3], ['e', 3.05]]
  const markets = venues.map(([v, p]) => market('cex:' + v + ':COIN-USD', 'coin', 'fiat:USD', p, { volume: 1000 }))
  const collisions = new Map()
  const result = aggregateAssets(pureAssets, markets, now, new Map(), { collisions }).get('coin')
  assert.equal(result.exchanges, 5)
  assert.equal(result.trust, 'red')
  assert.equal(collisions.size, 0)
  // Two groups 3× apart (half the venues not yet moved) are still one project.
  const halves = [['a', 1], ['b', 1.01], ['c', 3], ['d', 3.02]]
    .map(([v, p]) => market('cex:' + v + ':COIN-USD', 'coin', 'fiat:USD', p, { volume: 1000 }))
  assert.equal(splitCollisions(halves.map(m => ({ market: m, price: m.price, volume: 1000, proven: true }))), null)
  const kept = aggregateAssets(pureAssets, halves, now, new Map(), { collisions }).get('coin')
  assert.equal(kept.exchanges, 4)
  assert.equal(collisions.size, 0)
})

test('a bundle symbolMap market is never detached and anchors its cluster', () => {
  const pinned = m => m.id === 'cex:bitget:RAIN-USDT'
  const collisions = new Map()
  const result = aggregateAssets(pureAssets, rainMarkets(), now, new Map(), { pinned, collisions }).get(RAIN)
  assert.equal(result.price, 65.4)
  assert.equal(collisions.get(RAIN).kept.reason, 'symbolMap')
  assert.equal(collisions.get(RAIN).detached.length, 6)
})

test('pools or pinned markets still more than 10× apart publish no USD price; unproven keys cannot force that', () => {
  const pool = (n, price, volume = 1000) => market('dex:arbitrum:0x' + String(n).repeat(40), 'coin', 'fiat:USD',
    price, { kind: 'dex', volume })
  const collisions = new Map()
  // Comparable turnover on both sides (about $1,000 each), so core trimming keeps them all.
  const resolved = aggregateAssets(pureAssets, [pool(1, 1), pool(2, 1.01), pool(3, 50, 20)], now, new Map(),
    { collisions })
  assert.equal(resolved.has('coin'), false)
  // The median would be 1.01; the 50 pool is 49.5× away from it.
  close(collisions.get('coin').guard.ratio, 50 / 1.01)
  // A thin pool far away (4% of turnover) is trimmed from the core as before: price published, no guard.
  const thin = new Map()
  assert.equal(aggregateAssets(pureAssets, [pool(1, 1), pool(2, 1.01), pool(3, 50, 1)], now, new Map(),
    { collisions: thin }).get('coin').price, 1.01)
  assert.equal(thin.get('coin')?.guard, undefined)
  // An unproven report 300× away is a stray: dropped, the supported price stays published.
  const strays = new Map()
  const fake = market('cex:fake:COIN-USD', 'coin', 'fiat:USD', 300, { proven: false, reporters: ['x'], volume: 1e12 })
  const kept = aggregateAssets(pureAssets, [pool(1, 1), fake], now, new Map(), { collisions: strays }).get('coin')
  assert.equal(kept.price, 1)
  assert.equal(kept.exchanges, 0)
  assert.equal(strays.get('coin').kept.supported, true)
  assert.deepEqual(strays.get('coin').detached.map(d => [d.market, d.proven]), [['cex:fake:COIN-USD', false]])
  // Unproven markets cannot bridge two proven clusters into one.
  const bridge = [0.04, 0.4, 4, 40].map((p, i) =>
    market('cex:u' + i + ':RAIN-USDT', RAIN, 'fiat:USD', p, { proven: false, reporters: ['x' + i] }))
  const bridged = new Map()
  close(aggregateAssets(pureAssets, [...rainMarkets(), ...bridge], now, new Map(), { collisions: bridged })
    .get(RAIN).price, 0.004407)
  assert.ok(bridged.get(RAIN).detached.some(d => d.market === 'cex:bitget:RAIN-USDT'))
})

test('market USD volume uses the market price and quote rate, else the venue USD figure, else null', () => {
  const snapshots = new Map([
    ['q', { price: 2, why: { stale: false } }],
    ['old', { price: 2, why: { stale: true } }],
  ])
  assert.equal(marketUsdVolume({ usdVolume: 7, baseVolume: 1, price: 1, quote: 'none' }, snapshots), 7)
  assert.equal(marketUsdVolume({ baseVolume: 10, price: 3, quote: 'fiat:USD' }, snapshots), 30)
  assert.equal(marketUsdVolume({ baseVolume: 10, price: 3, quote: 'q' }, snapshots), 60)
  assert.equal(marketUsdVolume({ baseVolume: 10, price: 3, quote: 'none' }, snapshots), null)
  assert.equal(marketUsdVolume({ baseVolume: 10, price: 3, quote: 'old' }, snapshots), null)
  assert.equal(marketUsdVolume({ baseVolume: 0, price: 3, quote: 'none' }, snapshots), 0)
  assert.equal(marketUsdVolume({ baseVolume: null, price: 3, quote: 'q' }, snapshots), null)
  assert.equal(marketUsdVolume(undefined, snapshots), null)
})

// ---- registry + book + store ------------------------------------------------------------------------------------
const ownKey = 'a'.repeat(64)
const venues = ['bitget', 'htx', 'gate', 'bitrue', 'kucoin', 'mexc', 'weex', 'kraken', 'coinbase']
function catalog(symbolMaps = {}) {
  return {
    assets: [
      { id: USDT, symbol: 'USDT', name: 'Tether', stable: true },
      { id: RAIN, symbol: 'RAIN', name: 'RAIN' },
      { id: RBC, symbol: 'RBC', name: 'Rubic' },
      { id: 'fixture:xyz', symbol: 'XYZ', name: 'Unpriced quote' },
      { id: ETH, symbol: 'ETH', name: 'Ether' },
    ],
    exchanges: venues.map(id => ({ id, name: id, symbolMap: symbolMaps[id] })),
    chains: [],
  }
}
function node(t, { store, symbolMaps, at = now } = {}) {
  store ??= openStore({ file: ':memory:', migrations })
  const registry = new Registry(store, catalog(symbolMaps))
  const state = { now: at }
  const clock = () => state.now
  const book = new MarketBook({ registry, store, clock, ownKey })
  const queries = new Queries({ registry, store, clock, book })
  const observe = (venue, base, quote, price, baseVolume, usd = null) => {
    const m = registry.cex(venue, base, quote)
    book.ingest(ownKey, [[m.id, String(price), String(baseVolume), usd, null, null, state.now]], true)
    return m
  }
  const tick = () => {
    observe('kraken', 'USDT', 'USD', '1.0002', 5e6)
    observe('coinbase', 'USDT', 'USD', '0.9998', 5e6)
    for (const [venue, price, volume] of RAIN_TICKS) observe(venue, 'RAIN', 'USDT', price, volume)
  }
  return { store, registry, book, queries, observe, tick, state, clock,
    advance: ms => { state.now += ms }, close: () => store.close() }
}

test('the live RAIN case: Bitget is split off durably and every venue volume uses its own price', t => {
  const n = node(t)
  t.after(n.close)
  n.tick()
  const p = n.book.refresh().get(RAIN)
  close(p.price, 0.004407 * 1.0002, 1e-3)
  assert.equal(p.exchanges, 6)
  const bitget = n.registry.markets.get('cex:bitget:RAIN-USDT')
  assert.equal(bitget.base, 'unresolved:bitget:RAIN')
  assert.deepEqual(n.store.marketsForAsset(RAIN).map(m => m.id).includes('cex:bitget:RAIN-USDT'), false)
  assert.equal(n.store.getMarket('cex:bitget:RAIN-USDT').base, 'unresolved:bitget:RAIN')
  assert.equal(n.queries.assetMarkets(RAIN).some(m => m.id === 'cex:bitget:RAIN-USDT'), false)
  // The detached market keeps its observations and its own price.
  assert.equal(n.book.marketPrices.get('cex:bitget:RAIN-USDT').price, 65.4)
  const usdt = n.book.snapshots.get(USDT).price
  const rows = new Map(n.queries.exchanges().map(r => [r.id, r]))
  close(rows.get('htx').volume24h, 1256559909.3683 * 0.004407 * usdt)
  close(rows.get('gate').volume24h, 436768079 * 0.004404 * usdt)
  // The detached market is unresolved: its turnover is reported apart and does not rank Bitget.
  assert.equal(rows.get('bitget').volume24h, 0)
  close(rows.get('bitget').unresolvedVolume24h, 204281.5367 * 65.4 * usdt)
  assert.ok(rows.get('htx').volume24h < 6e6, 'HTX shows $' + rows.get('htx').volume24h)
  // Asset markets value each market at its own price.
  const htx = n.queries.assetMarkets(RAIN).find(m => m.id === 'cex:htx:RAIN-USDT')
  close(htx.volume24h, 1256559909.3683 * 0.004407 * usdt)
  // Global volume: USDT's two $5 M markets plus RAIN's kept markets (it was $83 B on HTX alone before).
  close(n.queries.global().volume24h, n.book.snapshots.get(USDT).volume24h + p.volume24h)
  assert.ok(p.volume24h < 10e6)
  // Diagnostics for the owner.
  const [report] = collisionReport(n)
  assert.equal(report.asset, RAIN)
  assert.equal(report.symbol, 'RAIN')
  assert.equal(report.venues, 6)
  assert.equal(report.reason, 'venues')
  assert.equal(report.guard, null)
  assert.deepEqual(report.detached.map(d => [d.venue, d.label, d.markets, d.since]),
    [['bitget', 'RAIN', ['cex:bitget:RAIN-USDT'], now]])
  assert.ok(report.detached[0].ratio > 14_000 && report.detached[0].ratio < 15_000)
})

test('a split survives a restart, keeps new tickers of that label unresolved and is re-checked daily', t => {
  const first = node(t)
  first.tick()
  first.book.refresh()
  const store = first.store
  t.after(() => store.close())
  // Restart on the same database.
  const n = node(t, { store, at: now + 60_000 })
  assert.equal(n.registry.markets.get('cex:bitget:RAIN-USDT').base, 'unresolved:bitget:RAIN')
  assert.equal(n.registry.splits.get('bitget:RAIN').at, now)
  n.tick()
  assert.equal(n.registry.cex('bitget', 'RAIN', 'XYZ').base, 'unresolved:bitget:RAIN')
  close(n.book.refresh().get(RAIN).price, 0.004407 * 1.0002, 1e-3)
  assert.equal(n.book.refresh().get(RAIN).exchanges, 6)
  // A day later the label is reviewed: still another project, so it stays split with its first time kept.
  n.advance(SPLIT_REVIEW_MS)
  n.tick()
  n.book.refresh()
  assert.equal(n.registry.markets.get('cex:bitget:RAIN-USDT').base, 'unresolved:bitget:RAIN')
  assert.deepEqual([n.registry.splits.get('bitget:RAIN').at, n.registry.splits.get('bitget:RAIN').checkedAt],
    [now, n.clock()])
  assert.equal(n.book.snapshots.get(RAIN).exchanges, 6)
  // Another day later Bitget trades with the others (e.g. it relisted the same project): the split is dropped.
  n.advance(SPLIT_REVIEW_MS)
  n.tick()
  n.advance(1000)
  n.observe('bitget', 'RAIN', 'USDT', '0.00441', 1e6)
  n.book.refresh()
  assert.equal(n.registry.splits.has('bitget:RAIN'), false)
  assert.equal(n.registry.markets.get('cex:bitget:RAIN-USDT').base, RAIN)
  assert.equal(n.store.getSetting('engine-split/bitget/RAIN'), undefined)
  assert.equal(n.book.snapshots.get(RAIN).exchanges, 7)
  assert.ok(n.store.marketsForAsset(RAIN).some(m => m.id === 'cex:bitget:RAIN-USDT'))
})

test('a bundle symbolMap entry wins: Bitget stays RAIN and the other six venues are split off', t => {
  const n = node(t, { symbolMaps: { bitget: { RAIN } } })
  t.after(n.close)
  n.tick()
  const p = n.book.refresh().get(RAIN)
  close(p.price, 65.4 * 1.0002, 1e-3)
  assert.equal(n.registry.markets.get('cex:bitget:RAIN-USDT').base, RAIN)
  assert.equal(n.registry.markets.get('cex:htx:RAIN-USDT').base, 'unresolved:htx:RAIN')
  assert.equal(collisionReport(n)[0].reason, 'symbolMap')
  assert.equal(collisionReport(n)[0].detached.length, 6)
})

test('a market quoted in an asset without a USD rate contributes no volume rather than a guess', t => {
  const n = node(t)
  t.after(n.close)
  n.tick()
  n.observe('kraken', 'RAIN', 'XYZ', '3', 1e9)
  n.observe('coinbase', 'RBC', 'USDT', '0.0017', 1e6, '1650')
  n.book.refresh()
  const markets = new Map(n.queries.assetMarkets(RAIN).map(m => [m.id, m]))
  assert.equal(markets.get('cex:kraken:RAIN-XYZ').volume24h, null)
  // The venue's own USD figure wins over any derivation.
  assert.equal(n.queries.assetMarkets(RBC).find(m => m.id === 'cex:coinbase:RBC-USDT').volume24h, 1650)
  const kraken = n.queries.exchanges().find(r => r.id === 'kraken')
  close(kraken.volume24h, 5e6 * 1.0002)
})

test('RBC on the node: turnover keeps Bitget first; a later reference read for Rubic corrects the split at once', t => {
  const n = node(t)
  t.after(n.close)
  const rbc = () => {
    n.observe('kraken', 'USDT', 'USD', '1', 5e6)
    n.observe('coinbase', 'USDT', 'USD', '1', 5e6)
    n.observe('kraken', 'ETH', 'USD', '1803.1', 1e4)
    n.observe('bitget', 'RBC', 'USDT', '74.94', 868864.1219)
    n.observe('gate', 'RBC', 'USDT', '0.0016956', 13440783)
    n.observe('gate', 'RBC', 'ETH', '0.0000009404', 6991553)
  }
  rbc()
  assert.equal(n.book.refresh().get(RBC).price, 74.94)
  assert.equal(n.registry.markets.get('cex:gate:RBC-ETH').base, 'unresolved:gate:RBC')
  assert.equal(n.registry.splits.get('gate:RBC').reason, 'volume')
  // DefiLlama reads Rubic's address at $0.0017 (a reference row, as the llama-prices job saves it).
  n.advance(10 * 60_000)
  n.store.writer.prepare('INSERT INTO engine_references VALUES (?,?,?,?)').run(RBC, 'llama-prices', 0.0017, n.clock())
  n.advance(1000)
  rbc()
  const p = n.book.refresh().get(RBC)
  assert.ok(p.price > 0.0016 && p.price < 0.0018, 'RBC $' + p.price)
  assert.equal(n.registry.splits.has('gate:RBC'), false)
  assert.equal(n.registry.markets.get('cex:gate:RBC-ETH').base, RBC)
  assert.equal(n.registry.markets.get('cex:bitget:RBC-USDT').base, 'unresolved:bitget:RBC')
  assert.equal(n.registry.splits.get('bitget:RBC').reason, 'reference')
  // Gate's two pairs: USDT turnover at its own price plus ETH turnover at its own price × the ETH rate.
  close(p.volume24h, 13440783 * 0.0016956 + 6991553 * 0.0000009404 * 1803.1)
  // Eleven minutes later the reference is too old for the USD price but still anchors the split for a day.
  n.advance(11 * 60_000)
  rbc()
  assert.ok(n.book.refresh().get(RBC).price < 0.0018)
  assert.equal(n.registry.markets.get('cex:bitget:RBC-USDT').base, 'unresolved:bitget:RBC')
})

test('a native coin keeps its exchanges when its wrapped-token pools disagree', () => {
  const cex = (venue, price) => ({ market: { id: `cex:${venue}:SOL-USDT`, kind: 'cex', exchange: venue }, price, proven: true, volume: 1e6 })
  const pool = (id, price) => ({ market: { id: 'dex:solana:' + id, kind: 'dex', exchange: 'orca' }, price, proven: true, volume: 1e5 })
  const entries = [cex('okx', 74.6), cex('kraken', 74.7), cex('coinbase', 74.5), pool('a', 0.0134), pool('b', 0.0135)]
  const asToken = splitCollisions(entries)
  assert.equal(asToken.kept.reason, 'dex')
  const asNative = splitCollisions(entries, { dexAnchor: false })
  assert.equal(asNative.kept.reason, 'venues')
  assert.ok([...asNative.excluded].every(e => e.market.kind === 'dex'))
})
