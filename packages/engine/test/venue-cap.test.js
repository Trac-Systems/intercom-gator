import test from 'node:test'
import assert from 'node:assert/strict'
import { MarketBook } from '../src/aggregate/book.js'
import { Registry } from '../src/registry/index.js'
import { migrations } from '../src/schema.js'
import { openStore } from './store-fixture.js'

test('one venue with outsized turnover cannot outvote nine agreeing venues (FUN on HTX)', t => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const venues = ['htx', 'poloniex', 'bitget', 'bitrue', 'gate', 'kraken', 'kucoin', 'ourbit', 'xt', 'bitvavo', 'mexc']
  const registry = new Registry(store, {
    assets: [{ id: 'ethereum:0x419d0d8bdd9af5e606ae2232ed285aff190e711b', symbol: 'FUN', name: 'FUNToken', rank: 300 }],
    exchanges: venues.map(id => ({ id })), chains: [{ id: 'ethereum', name: 'Ethereum' }],
  })
  const now = 1_800_000_000_000
  const book = new MarketBook({ registry, store, clock: () => now, ownKey: 'own' })
  const rows = venues.map(v => {
    const [price, usd] = v === 'htx' ? ['0.001902', 2_000_000] : v === 'poloniex' ? ['0.00163', 5_000] : ['0.0121', 20_000]
    return [registry.cex(v, 'FUN', 'USD').id, price, '0', usd, null, null, now]
  })
  book.ingest('own', rows, true)
  const fun = book.refresh().get('ethereum:0x419d0d8bdd9af5e606ae2232ed285aff190e711b')
  assert.ok(Math.abs(fun.price / 0.0121 - 1) < 0.01, 'priced at ' + fun.price)
  // The two outliers still disagree with the rest, so the price is not trusted.
  assert.equal(fun.trust, 'red')
})
