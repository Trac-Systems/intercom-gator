import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBundle } from '@gator/bundle'
import { Queries } from '../src/aggregate/queries.js'
import { MarketBook } from '../src/aggregate/book.js'
import { Registry } from '../src/registry/index.js'
import { migrations } from '../src/schema.js'
import { adaptBundle } from '../src/sources/bundle-adapter.js'
import { openStore } from './store-fixture.js'

const btc = 'bitcoin:native'
const now = 1_780_000_000_000
const catalog = adaptBundle(loadBundle())
const ownKey = 'a'.repeat(64)

function fixture(t, assets, exchanges) {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const registry = new Registry(store, { assets, exchanges, chains: [] })
  const clock = () => now
  const book = new MarketBook({ registry, store, clock, ownKey })
  const queries = new Queries({ registry, book, store, clock })
  const save = store.writer.prepare('INSERT INTO engine_derivatives VALUES (?,?,0.01,123,?)')
  return { registry, book, queries, add: (exchange, symbol) => save.run(exchange, symbol, now) }
}

// One case per distinct spelling in the shipped derivative probes, including all-instrument feeds.
const styles = [
  ['binance', 'BTCUSDT'], ['bingx', 'BTC-USDT'], ['xt', 'btc_usdt'],
  ['backpack', 'BTC_USDC_PERP'], ['bitfinex', 'tBTCF0:USTF0'], ['bitmex', 'XBTUSD'],
  ['bitrue', 'E-BTC-USDT'], ['bitstamp', 'btcusd-perp'], ['btse', 'BTCPFC'],
  ['coinbase', 'BTC-PERPETUAL'], ['crypto-com', 'BTCUSD-PERP'], ['deepcoin', 'BTC-USDT-SWAP'],
  ['digifinex', 'BTCUSDTPERP'], ['gemini', 'btcgusdperp'], ['hitbtc', 'BTCUSDT_PERP'],
  ['hyperliquid', 'BTC'], ['kraken', 'PF_XBTUSD'], ['kraken-futures', 'PI_XBTUSD'],
  ['kucoin', 'XBTUSDTM'], ['paradex', 'BTC-USD-PERP'], ['toobit', 'BTC-SWAP-USDT'],
  ['whitebit', 'BTC_PERP'], ['okx', 'BTC-USD-261225'], ['binance', 'BTCUSDT_20261225'],
  ['deribit', 'BTC-25DEC26'], ['bitmex', 'XBTZ26'], ['kraken-futures', 'FI_XBTUSD_261225'],
  ['gate', 'BTC/USD'], ['gate', 'BTC:USDT'], ['gate', 'BTC/USDT:USDT'],
]

test('derivatives resolve the shipped exchange symbol styles using a locally priced asset', async t => {
  const f = fixture(t, [catalog.assets.find(a => a.id === btc)], catalog.exchanges)
  const spot = f.registry.cex('binance', 'BTC', 'USD')
  f.book.ingest(ownKey, [[spot.id, '100', 1, null, null, null, now]], true)
  for (const [exchange, symbol] of styles) f.add(exchange, symbol)
  const rows = f.queries.derivatives()
  for (const [exchange, symbol] of styles) {
    await t.test(exchange + ' ' + symbol, () => {
      const row = rows.find(d => d.exchange === exchange && d.symbol === symbol)
      assert.equal(row.asset, btc)
      assert.equal(row.openInterest, 123)
      assert.equal(row.openInterestUnit, 'provider units')
    })
  }
})

test('same-exchange spot identity wins, then the unique best priced rank, with ambiguous or missing evidence null', t => {
  const assets = [
    { id: 'a:native', symbol: 'A1', rank: 9 },
    { id: 'b:native', symbol: 'A1', rank: 2 },
    { id: 'c:native', symbol: 'A1', rank: 1 }, // no price
    { id: 'd:native', symbol: 'TIE', rank: 7 },
    { id: 'e:native', symbol: 'TIE', rank: 7 },
    { id: 'f:native', symbol: 'UNPRICED' },
  ].map(a => ({ ...a, name: a.symbol }))
  const f = fixture(t, assets, [
    { id: 'one', symbolMap: { A1: 'a:native', TIE: 'd:native', ALIAS: 'a:native' } },
    { id: 'two', symbolMap: { A1: 'b:native', TIE: 'e:native' } }, { id: 'other' },
  ])
  for (const venue of ['one', 'two']) {
    for (const symbol of ['A1', 'TIE']) {
      const market = f.registry.cex(venue, symbol, 'USD')
      f.book.ingest(ownKey, [[market.id, '10', 10, null, null, null, now]], true)
    }
  }
  f.registry.cex('one', 'ALIAS', 'USD')
  for (const [exchange, symbol] of [
    ['one', 'A1USDT'], ['one', 'ALIASUSDT'], ['other', 'A1USDT'],
    ['other', 'TIEUSDT'], ['other', 'UNPRICEDUSDT'], ['other', 'UNKNOWNUSDT'],
  ]) f.add(exchange, symbol)
  const result = f.queries.markets({ tab: 'derivatives' }).map(d => [d.symbol, d.asset])
  assert.deepEqual(result, [
    ['A1USDT', 'a:native'], ['ALIASUSDT', 'a:native'], ['A1USDT', 'b:native'],
    ['TIEUSDT', null], ['UNKNOWNUSDT', null], ['UNPRICEDUSDT', null],
  ])
})

test('conflicting spot identities, non-spot instruments and unranked provisional prices cannot decide the link', t => {
  const assets = [
    { id: 'x:native', symbol: 'X', name: 'X' }, { id: 'y:native', symbol: 'Y', name: 'Y' },
  ]
  const f = fixture(t, assets, [{ id: 'one' }, { id: 'two' }])
  f.registry.register({ id: 'cex:one:DUP-USD', base: 'x:native', quote: 'fiat:USD', kind: 'cex', exchange: 'one' })
  f.registry.register({ id: 'cex:one:DUP-EUR', base: 'y:native', quote: 'fiat:EUR', kind: 'cex', exchange: 'one' })
  f.registry.register({ id: 'cex:one:FUT-USD', base: 'x:native', quote: 'fiat:USD',
    kind: 'cex', exchange: 'one', instrument: 'future' })
  const market = f.registry.cex('one', 'X', 'USD')
  f.book.ingest('b'.repeat(64), [[market.id, '10', 1, null, null, null, now]], false)
  for (const s of ['DUPUSDT', 'FUTUSDT', 'XUSDT']) f.add('one', s)
  f.add('two', 'XUSDT')
  assert.deepEqual(f.queries.derivatives().map(d => d.asset), [null, null, 'x:native', null])
})
