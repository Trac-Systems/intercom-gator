// Regression coverage for price and scheduler trust decisions.
import test from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from '../store-fixture.js'
import { Registry } from '../../src/registry/index.js'
import { MarketBook } from '../../src/aggregate/book.js'
import { migrations } from '../../src/schema.js'

const sybils = (n) => Array.from({ length: n }, (_, i) => (i + 1).toString(16).padStart(64, 'f'))

function fixture(t) {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const now = 1740000000000
  const registry = new Registry(store, {
    assets: [{ id: 'eth:native', symbol: 'ETH', name: 'Ether', rank: 2 }],
    chains: [],
    exchanges: [{ id: 'x1' }, { id: 'x2' }],
  })
  const a = registry.cex('x1', 'ETH', 'USD').id
  const b = registry.cex('x2', 'ETH', 'USD').id
  const ownKey = 'a'.repeat(64)
  const book = new MarketBook({ store, registry, ownKey, clock: () => now })
  const row = (market, price) => [market, String(price), 10, null, null, null, now]
  return { store, book, a, b, ownKey, row, now }
}

test('R-APP-01a: a fresh local market price dominates five unproven reporters', (t) => {
  const { book, a, ownKey, row } = fixture(t)
  book.ingest(ownKey, [row(a, 3000)], true) // our own fresh local observation
  book.ingest('b'.repeat(64), [row(a, 3001)], false) // one honest peer
  for (const key of sybils(5)) book.ingest(key, [row(a, 1)], false)
  const p = book.refresh().get('eth:native')
  assert.equal(p.price, 3000)
  // Unproven keys can neither move the price nor force red (which would suppress green-only alerts); the one own
  // venue keeps it yellow. Their disagreement still costs them standing via spot checks.
  assert.equal(p.trust, 'yellow')
  assert.equal(book.coverage(a, 60_000), 1)
  assert.equal(book.muted(sybils(5)[0]), false)
})

test('R-APP-01b: provisional prices across two venues stay yellow and leave a coverage gap', (t) => {
  const { book, a, b, row } = fixture(t)
  for (const key of sybils(5)) book.ingest(key, [row(a, 1), row(b, 1)], false)
  const p = book.refresh().get('eth:native')
  assert.equal(p.price, 1)
  assert.equal(p.trust, 'yellow')
  assert.equal(p.why.agents, 5)
  assert.equal(p.why.provenAgents, 0)
  assert.equal(book.coverage(a, 60_000), 0)
})
