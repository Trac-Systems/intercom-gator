import test from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from './store-fixture.js'
import { Registry } from '../src/registry/index.js'
import { MarketBook } from '../src/aggregate/book.js'
import { Queries } from '../src/aggregate/queries.js'
import { migrations } from '../src/schema.js'

test('chains lists every bundle chain, busiest first, with its native price and gas', (t) => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const now = 1740000000000
  const registry = new Registry(store, {
    assets: [{ id: 'quiet:native', symbol: 'Q', name: 'Quiet', rank: 1 }],
    chains: [
      { id: 'quiet', name: 'Quiet', family: 'evm', quotes: [] },
      { id: 'busy', name: 'Busy', family: 'evm', quotes: [] },
      { id: 'empty', name: 'Empty', family: 'cosmos', quotes: [] },
    ],
    exchanges: [{ id: 'x' }],
  })
  const ownKey = 'a'.repeat(64)
  const book = new MarketBook({ store, registry, ownKey, clock: () => now })
  const market = registry.cex('x', 'Q', 'USD').id
  book.ingest(ownKey, [[market, '3', '1', null, null, null, now]], true)
  store.upsertPool({ chain: 'busy', pool: '0x' + '1'.repeat(40), dex: 'd', token0: '0x' + '2'.repeat(40), token1: '0x' + '3'.repeat(40), firstSeen: now })
  store.setSetting('engine-fee/quiet', { chain: 'Quiet', at: now, kind: 'baseFee', value: '0.1 gwei' })
  const queries = new Queries({ book, registry, store, clock: () => now })
  assert.equal(queries.chains().find(r => r.chain === 'busy').pools, 0)
  const rows = queries.chains({ include: 'hidden' })
  assert.deepEqual(rows.map((r) => r.chain), ['busy', 'quiet', 'empty'])
  const quiet = rows.find((r) => r.chain === 'quiet')
  assert.equal(quiet.nativePrice, 3)
  assert.equal(quiet.tokens, 1)
  assert.equal(quiet.gas, '0.1 gwei')
  assert.deepEqual(rows[0], { chain: 'busy', name: 'Busy', family: 'evm', pools: 1, newPools24h: 1, dexVolume24h: 0, tokens: 0, nativePrice: null, gas: null })
})
