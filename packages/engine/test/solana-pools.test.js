import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchSolana } from '../src/sources/solana.js'
import { Registry } from '../src/registry/index.js'
import { migrations } from '../src/schema.js'
import { openStore } from './store-fixture.js'

const WSOL = 'So11111111111111111111111111111111111111112' // gitleaks:allow (public wrapped-SOL mint)
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // gitleaks:allow (public USDC mint)

test('a wrapped-SOL pool prices native SOL in USDC, whichever side the directory lists first', async t => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const registry = new Registry(store, {
    assets: [{ id: 'solana:native', symbol: 'SOL', name: 'Solana', rank: 5 },
      { id: 'solana:' + USDC, symbol: 'USDC', name: 'USD Coin', rank: 6, stable: true }],
    chains: [{ id: 'solana', family: 'solana', quotes: [WSOL, USDC] }], exchanges: [],
  })
  const rows = []
  const pool = (id, a, b, price) => ({ id, mintA: { address: a, symbol: '' }, mintB: { address: b, symbol: '' }, price })
  const json = { data: { data: [pool('P1' + 'a'.repeat(40), WSOL, USDC, 74.47), pool('P2' + 'b'.repeat(40), USDC, WSOL, 1 / 74.47)] } }
  await fetchSolana({ source: { id: 'raydium', url: 'https://pools.invalid', rpm: 60 }, http: { get: async () => json },
    registry, publish: r => rows.push(...r), discover: () => {}, clock: () => 1, chain: 'solana' })
  assert.equal(rows.length, 2)
  for (const [id, price] of rows) {
    assert.equal(registry.markets.get(id).base, 'solana:native')
    assert.ok(Math.abs(Number(price) - 74.47) < 1e-6, id + ' priced ' + price)
  }
})
