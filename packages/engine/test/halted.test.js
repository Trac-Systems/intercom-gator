import assert from 'node:assert/strict'
import test from 'node:test'
import { loadBundle } from '@gator/bundle'
import { adaptBundle } from '../src/sources/bundle-adapter.js'
import { fetchTickers } from '../src/sources/cex.js'
import { MarketBook } from '../src/aggregate/book.js'
import { CandleHistory } from '../src/candles/index.js'
import { Registry } from '../src/registry/index.js'
import { migrations } from '../src/schema.js'
import { openStore } from './store-fixture.js'

const bundle = loadBundle(), DAY = 86_400_000
function fixture(t, id) {
  const catalog = adaptBundle({ ...bundle, exchanges: bundle.exchanges.filter(e => e.id === id) })
  catalog.assets = [{ id: 'test:native', symbol: 'TEST', name: 'Test' }]
  const venue = catalog.exchanges[0], store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const registry = new Registry(store, catalog)
  let now = 1_800_000_000_000
  const clock = () => now
  const book = new MarketBook({ registry, store, clock, ownKey: 'own' })
  const marketId = 'cex:' + venue.id + ':TEST-USD'
  async function poll(ticker, status = 'TRADING') {
    now += 15000
    venue.catalogAt = null
    const http = { get: async url => url === venue.format.catalog?.url
      ? { symbols: [{ symbol: 'TESTUSD', baseAsset: 'TEST', quoteAsset: 'USD', status }] } : ticker }
    return fetchTickers({ venue, http, registry, clock, discover() {}, publish: rows => book.ingest('own', rows, true) })
  }
  return { book, registry, marketId, clock, store, poll }
}
const binance = { symbol: 'TESTUSD', lastPrice: '2', bidPrice: '1.9', askPrice: '2.1', volume: '0.00001', count: 1 }

test('a frozen Binance.US price goes stale immediately, survives restart and recovers on trading resumption', async t => {
  const { book, registry, clock, store, poll, marketId } = fixture(t, 'binance-us')
  await poll([binance])
  book.refresh()
  assert.equal(store.listMarkets()[0].visibility, 'live')
  book.ingest('legacy-peer', [[marketId, '999', '100', null, '0', '0', clock()]], false)
  assert.equal(store.observations({ market: marketId }).length, 1)
  // The last price, count, volume and closeTime all look usable despite the empty book.
  assert.equal(await poll([{ ...binance, bidPrice: '0', askPrice: '0.000', closeTime: clock(), count: 4000 }]), 0)
  assert.equal(book.refresh().get('test:native').visibility, 'stale')
  assert.equal(book.coverage(marketId, DAY), 0)
  book.ingest('peer', [[marketId, '999', '1', null, null, null, clock()]], false)
  assert.equal(store.observations({ market: marketId }).length, 1)
  const restored = new Registry(store, registry.catalog)
  assert.equal(new MarketBook({ registry: restored, store, clock, ownKey: 'own' }).refresh().get('test:native').visibility, 'stale')
  assert.deepEqual(store.listMarkets(), [])
  // exchangeInfo can still veto an apparently two-sided ticker.
  assert.equal(await poll([binance], 'BREAK'), 0)
  assert.equal(await poll([{ ...binance, bidPrice: undefined, askPrice: undefined }]), 0)
  assert.equal(await poll([{ ...binance, bidPrice: '10', askPrice: '1' }]), 0)
  assert.equal(await poll([binance]), 1)
  assert.equal(book.refresh().get('test:native').visibility, 'live')
  assert.equal(store.listMarkets()[0].symbol, 'TEST')
})

test('one same-price trade in 24h stays live even with rounded volume, while an explicit zero trade count halts', async t => {
  const { book, poll } = fixture(t, 'binance-us')
  const quiet = { ...binance, volume: '0', count: 1 }
  await poll([quiet])
  assert.equal(await poll([quiet]), 1)
  assert.equal(book.refresh().get('test:native').visibility, 'live')
  assert.equal(await poll([{ ...quiet, count: 0 }]), 0)
  assert.equal(book.refresh().get('test:native').visibility, 'stale')
})

test('a bookless ticker uses last trade time and corroborated zero rolling turnover', async t => {
  const { poll, clock } = fixture(t, 'upbit')
  const tick = { market: 'KRW-TEST', trade_price: 1400, acc_trade_volume_24h: 0 }
  assert.equal(await poll([{ ...tick, trade_timestamp: clock() - DAY - 1, timestamp: clock() }]), 0)
  assert.equal(await poll([{ ...tick, trade_timestamp: clock() }]), 1)
  assert.equal(await poll([{ ...tick, trade_timestamp: clock() }]), 1)
  assert.equal(await poll([{ ...tick, acc_trade_volume_24h: 10 }]), 1)
  assert.equal(await poll([tick]), 1)
  assert.equal(await poll([tick]), 0)
  assert.equal(await poll([{ ...tick, acc_trade_volume_24h: 0.03 }]), 1)
})

test('only a complete request through the present can use dated klines to stale a fresh ticker', async t => {
  const { book, clock, marketId, poll, registry, store } = fixture(t, 'binance-us')
  await poll([binance])
  book.refresh()
  const hour = 3_600_000, end = Math.floor(clock() / hour) * hour
  let response = [[end - 2 * DAY, '2', '2.1', '1.9', '2']]
  const history = new CandleHistory({ store, registry, clock, http: { get: async () => response },
    scheduler: { demand: (_id, _url, read) => read() } })
  const read = (from, to, limit) => history.market(registry.markets.get(marketId), '1h', from, to, limit)
  await read(end - 8 * DAY, end - 2 * DAY, 144)
  await read(end - 8 * DAY, end, 12)
  assert.equal(book.refresh().get('test:native').visibility, 'live')
  response.push([end, '2', '2.1', '1.9', '2'])
  assert.deepEqual(await read(end - DAY, end, 24), [])
  assert.equal(book.refresh().get('test:native').visibility, 'live')
  response.pop()
  await read(end - DAY, end, 24)
  assert.equal(book.refresh().get('test:native').visibility, 'stale')
  assert.equal(await poll([binance]), 0)
  assert.equal(await poll([{ ...binance, count: binance.count + 1 }]), 1)
  assert.equal(book.refresh().get('test:native').visibility, 'live')
  response = []
  await read(end - DAY, end, 24)
  assert.equal(book.refresh().get('test:native').visibility, 'live')
})

test('a dated ticker drops only its own market when another venue still trades the asset', async t => {
  const { book, clock, poll, marketId, registry } = fixture(t, 'binance-us')
  await poll([binance])
  registry.venues.set('other', { id: 'other' })
  const other = registry.cex('other', 'TEST', 'USD').id
  book.ingest('own', [[other, '2.02', '10', null, null, null, clock()]], true)
  assert.equal(await poll([{ ...binance, closeTime: clock() - DAY - 1 }]), 0)
  const price = book.refresh().get('test:native')
  assert.equal(price.visibility, 'live')
  assert.equal(price.price, 2.02)
  assert.equal(book.marketPrices.has(marketId), false)
})

test('a surviving trading pair without a USD conversion preserves the last known USD price as stale', async t => {
  const { book, clock, poll, registry, store } = fixture(t, 'binance-us')
  await poll([binance])
  registry.venues.set('fiatvenue', { id: 'fiatvenue' })
  const fiat = registry.cex('fiatvenue', 'TEST', 'THB').id
  book.ingest('own', [[fiat, '68', '10', null, null, null, clock()]], true)
  assert.equal(book.refresh().get('test:native').visibility, 'live')
  await poll([binance], 'BREAK')
  assert.equal(book.refresh().get('test:native').visibility, 'stale')
  assert.deepEqual(store.listMarkets(), [])
})

test('DigiFinex rejects a delisted symbol even while repeating a positive volume and a two-sided book', async t => {
  const { book, clock, marketId, poll, registry, store } = fixture(t, 'digifinex')
  const row = { symbol: 'test_usd', last: 2, buy: 1.9, sell: 2.1, vol: 12, base_vol: 24 }
  assert.equal(await poll({ ticker: [row] }), 1)
  book.refresh()
  const hour = 3_600_000, to = Math.floor(clock() / hour) * hour
  let response = { code: 10005 } // Request throttled.
  const history = new CandleHistory({ store, registry, clock, http: { get: async () => response },
    scheduler: { demand: (_id, _url, read) => read() } })
  const check = () => history.market(registry.markets.get(marketId), '1h', to - DAY, to, 24)
  await check()
  assert.equal(book.refresh().get('test:native').visibility, 'live')
  response = { code: 20019 } // The exact native symbol copied from all-tickers is invalid at the venue.
  await check()
  assert.equal(book.refresh().get('test:native').visibility, 'stale')
  assert.equal(await poll({ ticker: [row] }), 0)
  assert.equal(await poll({ ticker: [{ ...row, last: 2.01 }] }), 1)
  assert.equal(book.refresh().get('test:native').visibility, 'live')
})
