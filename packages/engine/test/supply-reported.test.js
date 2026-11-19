import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { loadBundle } from '@gator/bundle'
import { openStore } from '@gator/store'
import { migrations as socialMigrations } from '@gator/social'
import { Engine, migrations } from '../src/index.js'
import { RateLimited } from '../src/scheduler/index.js'

const start = Date.UTC(2026, 10, 19, 6)
const ctx = 'ethereum:0x321c2fe4446c7c963dc41dd58879af648838f98d'
const index = 'ethereum:0x0954906da0bf32d5479e25f46056d22f08464cab'
const tusd = 'ethereum:0x0000000000085d4780b73119b644ae5ecd22b376'
const ausd = 'ethereum:0x00000000efe302beaa2b3e6e1b18d08d69a9012a'
const bundle = structuredClone(loadBundle())
bundle.exchanges = bundle.exchanges.filter(s => ['binance', 'coinbase'].includes(s.id))
bundle.tokens.tokens = bundle.tokens.tokens.filter(t => [ctx, index, tusd, ausd].includes(t.id))

class Transport extends EventEmitter {
  publicKey = 'a'.repeat(64)
  topics = new Map()
  sent = []
  channels() { return [...this.topics.keys()] }
  async join(channel, policy) { this.topics.set(channel, policy); return true }
  async leave(channel) { return this.topics.delete(channel) }
  send(channel, message) { this.sent.push({ channel, message }); return true }
}

const binance = { data: [
  { b: 'CTX', q: 'USDT', cs: 9700000 },
  { b: 'TUSD', q: 'USDT', cs: 200 },
  { b: 'AUSD', q: 'USDT', cs: 0 },
  { b: 'NOPE', q: 'USDT', cs: 5 },
] }
const coinbase = [
  { data: [{ symbol: 'CTX', circulating_supply: '9654694.61045688' }, { symbol: 'INDEX', circulating_supply: '7105559.38' }],
    pagination: { next_starting_after: 'page-2' } },
  { data: [{ symbol: 'TUSD', circulating_supply: '100' }, { symbol: 'AUSD', circulating_supply: '5000' }], pagination: {} },
]

test('exchange-reported circulating supply fills gaps through bound markets, checked against totals and each other', async t => {
  const transport = new Transport(),
    store = openStore({ file: ':memory:', profile: 'small', migrations: [...migrations, ...socialMigrations] })
  let now = start
  const urls = []
  const engine = new Engine({ bundle, transport, store, clock: () => now, backgroundJobs: ['supply:reported'], random: () => 0.5,
    rpcConfig: { bundleDigest: '0'.repeat(64), timeout: 500, retries: 0, requestsPerMinute: 60,
      fetch: async url => {
        urls.push(url)
        if (url.includes('binance.com/bapi/')) return Response.json(binance)
        if (url.includes('coinbase.com/api/v2/assets/search'))
          return Response.json(coinbase[new URL(url).searchParams.get('starting_after') === 'page-2' ? 1 : 0])
        assert.fail('Unexpected request ' + url)
      } } })
  t.after(async () => { await engine.stop(); store.close() })
  await engine.start()
  clearTimeout(engine.timer)
  const { registry } = engine
  // Only markets the registry binds map a ticker to an asset.
  for (const [venue, symbol, quote] of [['binance', 'CTX', 'USDT'], ['coinbase', 'CTX', 'USD'], ['coinbase', 'INDEX', 'USD'],
    ['binance', 'TUSD', 'USDT'], ['coinbase', 'TUSD', 'USD'], ['coinbase', 'AUSD', 'USD']]) assert.ok(registry.cex(venue, symbol, quote))
  for (const id of [ctx, index, tusd]) registry.setSupply(id, { totalSupply: 10_000_000 })
  registry.setSupply(ausd, { totalSupply: 1000 })
  now += 4 * 60_000
  // The reader paces its pages through the request budget and resumes after a deferral.
  for (let i = 0; i < 20 && registry.assets.get(ctx).supply == null; i++) {
    try { await engine.step() } catch (error) { if (!(error instanceof RateLimited)) throw error }
    now += 25_000
  }
  // Both venues within 2%: the lower figure, labelled with both sources.
  assert.equal(registry.assets.get(ctx).supply, 9654694.61045688)
  const evidence = engine.supply.display(ctx).circulating
  assert.equal(evidence.method, 'exchange-reported')
  assert.equal(evidence.source, 'binance+coinbase')
  assert.equal(evidence.estimate, true)
  // One venue is enough when it fits inside the contract total.
  assert.equal(registry.assets.get(index).supply, 7105559.38)
  assert.equal(engine.supply.display(index).circulating.source, 'coinbase')
  // 100 against 200: the venues disagree, so no figure. 5,000 above a 1,000 total is rejected.
  assert.equal(registry.assets.get(tusd).supply, null)
  assert.equal(registry.assets.get(ausd).supply, null)
  // Website figures stay on this node.
  assert.equal(transport.sent.some(s => s.message?.kind === 'supply'), false)
  // Coinbase paging follows the cursor and stops when it is missing, once per listing (default and by rank).
  const coinbaseUrls = urls.filter(u => u.includes('coinbase.com'))
  assert.equal(coinbaseUrls.length, 4)
  assert.equal(coinbaseUrls.filter(u => new URL(u).searchParams.get('sort') === 'rank').length, 2)
  const status = engine.supply.reportedStatus()
  assert.equal(status.filled, 2)
  assert.equal(status.disagreements, 1)
  assert.equal(status.rejectedAboveTotal, 1)
  assert.ok(status.unmapped >= 1)
})
