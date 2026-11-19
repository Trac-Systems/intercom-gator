import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { openStore } from './store-fixture.js'
import { adaptBundle, rateLimit } from '../src/sources/bundle-adapter.js'
import { fetchTickers } from '../src/sources/cex.js'
import { fetchReferences } from '../src/sources/api.js'
import { derivativeJobs } from '../src/sources/derivatives.js'
import { solanaPools } from '../src/sources/solana.js'
import { providerBars } from '../src/candles/provider.js'
import { Registry } from '../src/registry/index.js'
import { migrations } from '../src/schema.js'

const catalog = adaptBundle(JSON.parse(readFileSync(new URL('./fixtures/source-bundle.json', import.meta.url))))
test('bundle fixture maps ticker, exchange catalog, pool topics, documented limits and candle routes', () => {
  const binance = catalog.exchanges.find((e) => e.id === 'binance')
  assert.match(binance.ticker.url, /api\/v3\/ticker\/24hr$/)
  assert.equal(binance.ticker.cost, 80)
  assert.equal(binance.candles.intervals['5m'], '5m')
  assert.ok(catalog.assets.some((a) => a.id === 'ethereum:native'))
  assert.ok(
    Object.values(catalog.chains.find((c) => c.id === 'ethereum').events).some((e) =>
      e.signature.startsWith('Initialize(bytes32')
    )
  )
  assert.equal(rateLimit('3 requests/s, 100 requests/hour without token'), 100 / 60)
  assert.equal(rateLimit('100 requests/10 s/IP, 40/10 s/IP per method'), 240)
  assert.equal(rateLimit('10,000 requests per 5 minutes per IP'), 2000)
})
test('recorded Kraken object-key tickers and catalog resolve XBT/USD to the Bitcoin native identity', async (t) => {
  const now = Date.now(),
    fixture = JSON.parse(readFileSync(new URL('./fixtures/kraken.json', import.meta.url)))
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const registry = new Registry(store, catalog),
    rows = []
  const venue = catalog.exchanges.find((e) => e.id === 'kraken')
  const http = { get: async (url) => (url.includes('AssetPairs') ? fixture.krakenPairs : fixture.krakenTicker) }
  await fetchTickers({
    venue,
    http,
    registry,
    clock: () => now,
    publish: (r) => rows.push(...r),
    discover: () => {},
  })
  const id = 'cex:kraken:BTC-USD',
    expected = fixture.krakenTicker.result.XXBTZUSD
  assert.deepEqual(rows, [[id, expected.c[0], expected.v[1], null, expected.b[0], expected.a[0], now]])
  assert.equal(registry.markets.get(id).base, 'bitcoin:native')
  assert.equal(registry.markets.get(id).symbol, 'XXBTZUSD')
})

test('derivative POST ticker joins by index and leaves spot registry untouched', async (t) => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const registry = new Registry(store, catalog),
    snapshots = []
  const venue = catalog.exchanges.find((e) => e.id === 'hyperliquid')
  const http = {
    get: async (_, rpm, cost, body) => {
      assert.deepEqual(body, { type: 'metaAndAssetCtxs' })
      return [
        { universe: [{ name: 'BTC' }, { name: 'ETH' }] },
        [
          { funding: '-0.001', openInterest: '530' },
          { funding: '0.002', openInterest: '10' },
        ],
      ]
    },
  }
  await fetchTickers({
    venue,
    http,
    registry,
    clock: () => 42,
    publish: (r) => assert.deepEqual(r, []),
    saveDerivative: (...r) => snapshots.push(r),
  })
  assert.deepEqual(snapshots, [
    ['hyperliquid', 'BTC', '-0.001', '530', 42],
    ['hyperliquid', 'ETH', '0.002', '10', 42],
  ])
  assert.equal(registry.markets.size, 0)
})

test('derivative route uses verified instrument notation and extracts nested funding and interest at most once', async () => {
  const venue = catalog.exchanges.find((e) => e.id === 'bybit'),
    saved = []
  const jobs = derivativeJobs(
    venue,
    {
      get: async (url) => {
        assert.ok(url.includes('symbol=BTCUSDT'))
        return { result: { list: [{ symbol: 'BTCUSDT', fundingRate: '0.0001', openInterest: '200' }] } }
      },
    },
    () => 100,
    (...r) => saved.push(r)
  )
  assert.equal(jobs.length, 1)
  await jobs[0].run()
  assert.deepEqual(saved, [['bybit', 'BTCUSDT', '0.0001', '200', 100]])
})

test('three Solana pool directories preserve mint case, units and venue-specific nesting', () => {
  const a = { address: 'Abc', symbol: 'M' },
    b = { address: 'xyz', symbol: 'N' }
  const cases = [
    ['raydium', { data: { data: [{ id: 'p', mintA: a, mintB: b, price: 2, day: { volume: 42 } }] } }],
    ['orca', { data: [{ address: 'p', tokenA: a, tokenB: b, price: '2', stats: { '24h': { volume: '42' } } }] }],
    ['meteora', { data: [{ address: 'p', token_x: a, token_y: b, current_price: 2, volume: { '24h': 42 } }] }],
  ]
  for (const [id, json] of cases) {
    const [pool] = solanaPools({ id }, json)
    assert.deepEqual([pool.a.address, pool.b.address, +pool.price, +pool.volume], ['Abc', 'xyz', 2, 42])
  }
})
test('reference prices require the requested identity, sufficient confidence and recent source time', async () => {
  const saved = [],
    now = 1740000000000
  await fetchReferences({
    source: { id: 'llama-prices', url: 'https://fixture.invalid/{coins}', rpm: 12 },
    assets: [{ id: 'eth:one' }],
    http: {
      get: async () => ({
        coins: {
          'eth:one': { price: 2, timestamp: now / 1000 },
          'eth:unknown': { price: 800, timestamp: now / 1000 },
        },
      }),
    },
    clock: () => now,
    save: (...r) => saved.push(r),
  })
  assert.deepEqual(saved, [['eth:one', 'llama-prices', 2, now]])
})
test('positional venue candles, named bars and TradingView columns preserve open/close order', () => {
  const at = 1740000000000
  const expected = { at, open: 1, high: 3, low: 0.5, close: 2 }
  assert.deepEqual(providerBars('gate', [[at / 1000, '40', 2, 3, 0.5, 1]]), [expected])
  assert.deepEqual(
    providerBars('coinbase', { candles: [{ start: at / 1000, open: 1, high: 3, low: 0.5, close: 2 }] }),
    [expected]
  )
  assert.deepEqual(providerBars('bitkub', { t: [at], o: [1], h: [3], l: [0.5], c: [2] }), [expected])
})

test('Jupiter uses slot age, preserves case-sensitive mint identity and ignores token creation time', async () => {
  const now = 1740000000000,
    saved = []
  await fetchReferences({
    source: { id: 'jupiter', url: 'https://fixture.invalid/{mints}', rpm: 12 },
    assets: [{ id: 'sol:Abc', address: 'Abc' }],
    http: {
      get: async () => ({
        Abc: { usdPrice: 2, blockId: 95, createdAt: '2020-01-01' },
        abc: { usdPrice: 50, blockId: 100 },
      }),
    },
    clock: () => now,
    slot: 100,
    slotMs: 400,
    save: (...r) => saved.push(r),
  })
  assert.deepEqual(saved, [['sol:Abc', 'jupiter', 2, now - 2000]])
})
