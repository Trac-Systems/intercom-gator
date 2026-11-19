import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { word } from '../src/sources/evm-abi.js'
import { EventEmitter } from 'node:events'
import { loadBundle } from '@gator/bundle'
import { openStore } from '@gator/store'
import { migrations as socialMigrations } from '@gator/social'
import { Engine, migrations } from '../src/index.js'
import { createRouter } from '../../api/src/routes.js'

const start = Date.UTC(2026, 10, 19, 6)
const btc = 'bitcoin:native', xrp = 'xrpl:native', uni = 'ethereum:0x1f9840a85d5af5bf1d1762f925bdaddc4201f984'
const ethUsdt = 'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7', tronUsdt = 'tron:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

class Transport extends EventEmitter {
  publicKey = 'a'.repeat(64)
  topics = new Map()
  sent = []
  channels() { return [...this.topics.keys()] }
  async join(channel, policy) { this.topics.set(channel, policy); return true }
  async leave(channel) { return this.topics.delete(channel) }
  send(channel, message) { this.sent.push({ channel, message }); return true }
}

async function fixture(t, ids, jobs, fetch) {
  const bundle = structuredClone(loadBundle())
  bundle.exchanges = bundle.exchanges.filter(s => s.id === 'bitstamp')
  bundle.tokens.tokens = bundle.tokens.tokens.filter(token => ids.includes(token.id))
  const transport = new Transport()
  const store = openStore({ file: ':memory:', profile: 'small', migrations: [...migrations, ...socialMigrations] })
  let now = start
  const engine = new Engine({ bundle, transport, store, clock: () => now, backgroundJobs: jobs, random: () => 0.5,
    rpcConfig: { bundleDigest: '0'.repeat(64), fetch, timeout: 500, retries: 0, requestsPerMinute: 60 } })
  await engine.start()
  clearTimeout(engine.timer)
  t.after(async () => { await engine.stop(); store.close() })
  return { engine, store, transport, clock: () => now, advance: ms => { now += ms } }
}
function ownPrice(e, symbol, price, volume) {
  const market = e.registry.cex('bitstamp', symbol, 'USD')
  e.publish([[market.id, String(price), volume, String(price * volume), null, null, e.clock()]])
}

test('issuer group prices untraded deployments and counts their combined circulation once', async t => {
  const jobs = ['supply:bitcoin', 'supply:issuer:tether-transparency']
  const f = await fixture(t, [btc, xrp, ethUsdt, tronUsdt], jobs, async url => {
    if (url.endsWith('/blocks/tip/height')) return Response.json(2)
    if (url === 'https://app.tether.to/transparency.json') return Response.json({ data: { usdt: { id: 1795044600,
      totaltokens_eth: '84296691994.493958', reserve_balance_eth: '4498804504.786249', quarantined_eth: 0,
      totaltokens_tron: '94207597532.05478', reserve_balance_tron: '2469202678.196809', quarantined_tron: 0 } } })
    assert.fail('Unexpected request ' + url)
  })
  const { engine: e, store, transport } = f
  ownPrice(e, 'BTC', 10, 1)
  ownPrice(e, 'XRP', 1, 5)
  store.writer.prepare('INSERT INTO engine_references VALUES (?,?,?,?)').run(ethUsdt, 'fixture', 1, f.clock())
  e.book.dirty = true
  // Both are top-100 work on a fresh node, so both run before any market polling.
  assert.deepEqual(new Set([await e.step(), await e.step()]), new Set(jobs))
  assert.equal(e.supply.display(tronUsdt).circulating.value, '91738394853.857971')
  assert.equal(e.supply.display(tronUsdt).total.value, '94207597532.05478')
  assert.equal(e.supply.display(ethUsdt).circulating.method, 'issuer-circulating')
  assert.equal(e.book.snapshots.has(tronUsdt), false)
  const usdt = 79797887489.707709 + 91738394853.857971
  const request = createRouter({ engine: e, store, transport, social: new EventEmitter(), release: { bundle: e.bundle } })
  const global = await request('GET', '/global')
  assert.equal(global.marketCap, 1000 + usdt)
  assert.equal(global.stablecoins, usdt)
  assert.equal(global.marketCapAssets, 2)
  const untraded = e.queries.detail(tronUsdt)
  assert.equal(untraded.coin, 'tether-usdt')
  assert.equal(untraded.price, null)
  assert.equal(untraded.coinMarketCap, usdt)
  assert.equal(e.queries.detail(ethUsdt).coinMarketCap, usdt)
  // BTC and XRP have volume; only BTC has a circulating supply.
  assert.equal(global.marketCapCoverage, 0.5)
  assert.equal(global.btcDominance, 100 * 1000 / global.marketCap)
  // The issuer's terms are unclear, so its figures stay local.
  assert.deepEqual(transport.sent.filter(m => m.channel === 'gator/meta').map(m => m.message.asset), [btc])
  // After reference and market expiry, the stored last-known prices stay out of the totals
  // (stale entries stay out of totals); nothing is guessed at $1.
  store.writer.prepare('DELETE FROM engine_references').run()
  f.advance(30 * 60_000)
  e.book.dirty = true
  const later = e.global()
  assert.equal(e.book.snapshots.get(ethUsdt).why.stale, true)
  assert.equal(later.marketCapAssets, 0)
  assert.equal(later.marketCap, null)
  assert.equal(later.stablecoins, null)
})

test('TRON USDT losing all quotes preserves its $92B contribution through Ethereum', async t => {
  const thirdParty = 'bsc:0x55d398326f99059ff775485246999027b3197955'
  const bridged = 'polygon:0xc2132d05d31c914a87c6611c10748aeb04b58e8f'
  const { engine, store, advance, clock } = await fixture(t, [ethUsdt, tronUsdt, bridged, thirdParty], [],
    () => assert.fail('Unexpected HTTP read'))
  const quote = store.writer.prepare('INSERT OR REPLACE INTO engine_references VALUES (?,?,?,?)')
  function mark(id, price) {
    quote.run(id, 'fixture', price, clock())
    engine.book.dirty = true
  }
  engine.setSupply(ethUsdt, { circulatingSupply: 77e9 })
  engine.setSupply(tronUsdt, { circulatingSupply: 92e9 })
  engine.setSupply(bridged, { circulatingSupply: 6e9 }) // already included in Ethereum issuance
  engine.setSupply(thirdParty, { circulatingSupply: 2e9 })
  mark(ethUsdt, 0.998)
  advance(1000)
  mark(tronUsdt, 1)
  assert.equal(engine.global().marketCap, 169e9)
  assert.equal(engine.queries.detail(ethUsdt).price, 0.998)
  assert.equal(engine.queries.detail(ethUsdt).coinMarketCap, 169e9)
  assert.equal(engine.queries.detail(bridged).coinMarketCap, 169e9)
  assert.equal(engine.queries.detail(thirdParty).coin, thirdParty)
  assert.equal(engine.queries.detail(thirdParty).coinMarketCap, null)

  advance(9 * 60_000)
  mark(ethUsdt, 1)
  assert.equal(engine.global().marketCap, 169e9)
  advance(2 * 60_000)
  engine.book.dirty = true
  const after = engine.global()
  assert.equal(engine.queries.detail(tronUsdt).visibility, 'stale')
  assert.equal(engine.queries.detail(tronUsdt).coinMarketCap, 169e9)
  assert.equal(after.marketCap, 169e9)
  assert.equal(after.marketCapAssets, 1)
  assert.equal(after.stablecoins, 169e9)
  mark(thirdParty, 1)
  assert.equal(engine.global().marketCap, 171e9)
  assert.equal(engine.global().marketCapAssets, 2)
  advance(1000)
  mark(bridged, 0.99)
  assert.equal(engine.queries.detail(bridged).price, 0.99)
  assert.equal(engine.global().marketCap, 169e9 * 0.99 + 2e9)
})

test('a signed untraded issuance member measures its reserves on public RPC using the native quote', async t => {
  const native = 'whitechain:native', eth = 'ethereum:0x925206b8a707096ed26ae47c84747fe0bb734f59'
  const { engine, store, clock } = await fixture(t, [native, eth], ['supply:tokens'],
    () => assert.fail('Unexpected fetch'))
  const mock = [8, 16522719100000000n, 0, 0, 2500000000000000n]
  let reads = 0
  engine.rpc.publicOnly.call = async (chain, method, [call]) => {
    assert.equal(chain, 'ethereum')
    assert.equal(method, 'eth_call')
    assert.ok(call.data.includes(eth.split(':')[1].slice(2)))
    const item = n => word(1) + word(64) + word(32) + word(n)
    reads++
    return '0x' + word(32) + word(mock.length) + mock.map((_, i) => word(mock.length * 32 + i * 128)).join('') +
      mock.map(item).join('')
  }
  engine.setSupply(native, { circulatingSupply: 73625000 })
  store.writer.prepare('INSERT INTO engine_references VALUES (?,?,?,?)').run(native, 'fixture', 60, clock())
  engine.book.dirty = true
  assert.equal(engine.global().marketCap, 73625000 * 60)
  await engine.scheduler.jobs.get('supply:tokens').run()
  assert.equal(reads, 1)
  assert.equal(engine.queries.detail(eth).price, null)
  assert.equal(engine.supply.display(eth).circulating.value, '140227191')
  assert.equal(engine.global().marketCap, (140227191 + 73625000) * 60)
  assert.equal(engine.global().marketCapAssets, 1)
})

test('a due top-100 token read outranks market polling until it is done', async t => {
  const f = await fixture(t, [btc, uni], ['supply:tokens', 'fixture:markets'], async () => assert.fail('No reads'))
  const { engine: e, store } = f
  // 200 under-covered tier-1 markets: a market job score far above any base supply relevance.
  e.registerJob({ id: 'fixture:markets', interval: 1000,
    markets: () => Array.from({ length: 200 }, (_, i) => ({ id: 'fixture:' + i, rank: 1 })), run: async () => {} })
  store.writer.prepare('INSERT INTO engine_references VALUES (?,?,?,?)').run(uni, 'fixture', 15, f.clock())
  e.book.dirty = true
  e.book.refresh()
  assert.ok(e.registry.assets.get(uni).rank <= 100)
  assert.equal(e.scheduler.choose().id, 'supply:tokens')
  e.registry.assets.get(uni).rank = 101
  f.advance(1001)
  assert.equal(e.scheduler.choose().id, 'fixture:markets')
})

test('missing deployment and high-turnover supplies precede a higher-ranked routine refresh', async t => {
  const nexo = 'ethereum:0xb62132e35a6c13ee1ee0f84dc5d40bad8d815206'
  const f = await fixture(t, [uni, nexo, ethUsdt], ['supply:tokens'], async () => assert.fail('Unexpected HTTP call'))
  const e = f.engine, job = e.scheduler.jobs.get('supply:tokens')
  const add = (id, rank, volume24h) => {
    e.registry.assets.get(id).rank = rank
    e.book.snapshots.set(id, { asset: id, price: 1, volume24h, visibility: 'live', why: {} })
  }
  add(uni, 1, 0)
  add(nexo, 150, 0)
  add(ethUsdt, 900, 1e6)
  const values = JSON.parse(readFileSync(new URL('fixtures/supply-reserves-mainnet.json', import.meta.url)))[nexo]
  const chosen = []
  e.rpc.publicOnly.call = async (_, method, [call]) => {
    const id = [nexo, uni, ethUsdt].find(id => call.data.includes(id.split(':')[1].slice(2)))
    chosen.push(id)
    const words = id === nexo ? values : values.slice(0, 4)
    const tuple = n => word(1) + word(64) + word(32) + n.slice(2)
    return '0x' + word(32) + word(words.length) + words.map((_, i) => word(words.length * 32 + 128 * i)).join('') +
      words.map(tuple).join('')
  }
  await job.run()
  await job.run()
  assert.deepEqual(chosen, [nexo, ethUsdt])
})
