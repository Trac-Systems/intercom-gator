import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { loadBundle } from '@gator/bundle'
import { openStore } from '@gator/store'
import { migrations as socialMigrations } from '@gator/social'
import { Engine, migrations } from '../src/index.js'
import { RateLimited } from '../src/scheduler/index.js'
import { createRouter } from '../../api/src/routes.js'
import { word } from '../src/sources/evm-abi.js'

const HOUR = 3_600_000, DAY = 24 * HOUR, start = Date.UTC(2026, 10, 19, 6)
const btc = 'bitcoin:native', xrp = 'xrpl:native'
const usdc = 'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const baseUsdc = 'base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const bundle = structuredClone(loadBundle())
bundle.exchanges = bundle.exchanges.filter(s => s.id === 'bitstamp')
bundle.tokens.tokens = bundle.tokens.tokens.filter(t => [btc, xrp, 'ethereum:native', 'aptos:native', usdc, baseUsdc].includes(t.id))

class Transport extends EventEmitter {
  publicKey = 'a'.repeat(64)
  topics = new Map()
  sent = []
  channels() { return [...this.topics.keys()] }
  async join(channel, policy) { this.topics.set(channel, policy); return true }
  async leave(channel) { return this.topics.delete(channel) }
  send(channel, message) { this.sent.push({ channel, message }); return true }
}

async function fixture(t, jobs, fetch, options = {}) {
  const transport = new Transport(), store = openStore({ file: ':memory:', profile: 'small', migrations: [...migrations, ...socialMigrations] })
  let now = start
  const clock = () => now, engines = []
  const open = async () => {
    const engine = new Engine({ bundle: options.bundle ?? bundle, transport, store, clock, backgroundJobs: jobs, random: () => 0.5,
      rpcConfig: { bundleDigest: '0'.repeat(64), fetch, timeout: 500, retries: 0, requestsPerMinute: options.limit ?? 60,
        endpoints: options.endpoints } })
    engines.push(engine)
    await engine.start()
    clearTimeout(engine.timer)
    return engine
  }
  t.after(async () => { for (const e of engines) await e.stop(); store.close() })
  const engine = await open()
  return { engine, store, clock, transport, open, advance: ms => { now += ms } }
}
function ownPrice(e, symbol, price, volume) {
  const market = e.registry.cex('bitstamp', symbol, 'USD')
  assert.ok(market)
  e.publish([[market.id, String(price), volume, String(price * volume), null, null, e.clock()]])
}
function table(chain, id, quantity) {
  return { data: { table: { columns: ['method', 'value', 'date', 'origin_key', 'decimals', 'address'],
    rows: [['rpc', quantity, '2026-11-18', chain, 6, id.slice(id.indexOf(':') + 1)]] } } }
}
test('scheduled supply feeds /global, ranks by cap then proven volume and persists evidence across restart', async t => {
  const jobs = ['supply:bitcoin', 'supply:stablecoins:ethereum', 'supply:stablecoins:base']
  const { engine: e, transport, store, clock, open, advance } = await fixture(t, jobs, async url => {
    if (url.endsWith('/blocks/tip/height')) return Response.json(2)
    if (url.endsWith('table_ethereum.json')) return Response.json(table('ethereum', usdc, 55))
    if (url.endsWith('table_base.json')) return Response.json(table('base', baseUsdc, 45))
    assert.fail('Unexpected supply request')
  })
  ownPrice(e, 'BTC', 10, 1)
  ownPrice(e, 'ETH', 20, 200)
  ownPrice(e, 'XRP', 1, 200)
  const ref = store.writer.prepare('INSERT INTO engine_references VALUES (?,?,?,?)')
  for (const id of [usdc, baseUsdc]) ref.run(id, 'fixture', 1, clock())
  assert.equal(e.global().marketCap, null)
  const chosen = []
  for (let i = 0; i < 3; i++) {
    chosen.push(await e.step())
    advance(11_000) // Smooth shared growthepie host bucket.
  }
  assert.deepEqual(new Set(chosen), new Set(jobs))
  const request = createRouter({ engine: e, store, transport, social: new EventEmitter(), release: { bundle } })
  const global = await request('GET', '/global')
  assert.equal(global.marketCap, 1100)
  assert.equal(global.stablecoins, 100)
  assert.equal(global.btcDominance, 100 * 1000 / 1100)
  // Ethereum and Base USDC are one coin: one row, ranked by the group cap, linked to the Ethereum member.
  assert.deepEqual(e.markets().filter(m => m.price != null).map(m => m.id), [btc, usdc, 'ethereum:native', xrp])
  const messages = transport.sent.filter(m => m.channel === 'gator/meta').map(m => m.message)
  assert.equal(messages.length, 3)
  assert.equal(messages[0].kind, 'supply')
  assert.deepEqual(messages.find(m => m.asset === btc), { t: 'claim', v: 1, asset: btc, kind: 'supply', value: '100',
    quantity: 'circulating', method: 'scheduled-emission', source: 'bitcoin/esplora/mempool.space',
    at: start, estimate: true, block: 2 })
  const own = e.supply.display(usdc)
  assert.equal(own.circulating.at, Date.UTC(2026, 10, 18))
  assert.equal(own.circulating.source, 'growthepie-stablecoins')
  await e.stop()
  assert.equal(transport.listenerCount('message'), 0)
  const reopened = await open()
  assert.deepEqual(reopened.supply.display(usdc), own)
  assert.equal(reopened.registry.assets.get(btc).supply, 100)
  // Top-100 assets refresh once after a start, then follow the hourly cadence.
  const refreshed = []
  for (let id; (id = await reopened.step()) && refreshed.length < 10; advance(11_000)) refreshed.push(id)
  assert.deepEqual(new Set(refreshed), new Set(jobs))
  assert.equal(refreshed.length, jobs.length)
  assert.equal(await reopened.step(), null)
  reopened.registry.assets.get(btc).rank = 1 // The fixture's price evidence has aged out of its window.
  advance(HOUR)
  assert.equal(reopened.scheduler.jobs.get(jobs[0]).ready(), true)
  reopened.registry.assets.get(btc).rank = 101
  assert.equal(reopened.scheduler.jobs.get(jobs[0]).ready(), false)
  advance(DAY)
  assert.equal(reopened.scheduler.jobs.get(jobs[0]).ready(), true)
})
test('native jobs spend the shared profile budget and honor repeated calls to the same endpoint', async t => {
  let calls = 0
  const { engine: e, advance } = await fixture(t, ['supply:bitcoin'], async () => { calls++; return Response.json(2) }, { limit: 1 })
  await e.step()
  const job = e.scheduler.jobs.get('supply:bitcoin')
  assert.equal(e.budget.used, 1)
  await assert.rejects(job.run(), RateLimited)
  advance(15_000)
  await assert.rejects(job.run(), RateLimited)
  assert.equal(calls, 1)
  advance(45_001)
  await job.run()
  assert.equal(calls, 2)
})
const keys = ['1', '2', '3', '4'].map(s => s.repeat(64))
function standing(store, key, agreements = 3) {
  store.writer.prepare('INSERT OR REPLACE INTO engine_standing VALUES (?,?,?,?)').run(key, agreements, start, 1)
}
function hint(f, key, id, value, fields = {}) {
  f.transport.emit('message', 'gator/meta', { from: key, channel: 'gator/meta', ts: f.clock(),
    message: { v: 1, t: 'claim', asset: id, kind: 'supply', method: 'issuer-circulating', value, at: f.clock(), ...fields } })
}
test('two current proven reporters can fill display only when local circulation is unavailable', async t => {
  let failed = true
  const f = await fixture(t, ['supply:listen', 'supply:bitcoin'], async () => {
    if (failed) throw new Error('offline')
    return Response.json(2)
  })
  const { engine: e, store } = f
  await e.scheduler.jobs.get('supply:listen').run()
  ownPrice(e, 'BTC', 10, 1)
  standing(store, keys[0])
  hint(f, keys[0], btc, '100')
  hint(f, keys[0], btc, '100.5')
  hint(f, keys[1], btc, '100.5') // Provisional at receipt time.
  assert.equal(e.supply.display(btc).circulating, null)
  standing(store, keys[1])
  f.advance(1)
  hint(f, keys[1], btc, '100.5')
  assert.equal(e.supply.display(btc).circulating, null) // Independent read has not run yet.
  await assert.rejects(e.scheduler.jobs.get('supply:bitcoin').run())
  let display = e.supply.display(btc).circulating
  assert.equal(display.method, 'peer-agreement')
  assert.deepEqual(display.reporters.map(r => r.reporter), keys.slice(0, 2))
  assert.equal(e.global().marketCap, null)
  assert.equal(e.registry.assets.get(btc).supply, null)
  assert.equal(f.transport.sent.filter(m => m.channel === 'gator/meta').length, 0)
  store.upsertReporter({ key: keys[1], mutedUntil: f.clock() + 60000 })
  assert.equal(e.supply.display(btc).circulating, null)
  store.upsertReporter({ key: keys[1] })
  f.advance(1)
  hint(f, keys[1], btc, '100.501')
  assert.equal(e.supply.display(btc).circulating, null)
  f.advance(1)
  hint(f, keys[1], btc, '100.49')
  failed = false
  await e.scheduler.jobs.get('supply:bitcoin').run()
  display = e.supply.display(btc).circulating
  assert.equal(display.method, 'scheduled-emission')
  assert.equal(e.global().marketCap, 1000)
})
test('stale, ambiguous, legacy total and same-reporter claims cannot create display supply', async t => {
  const f = await fixture(t, ['supply:listen'], () => assert.fail('Hints must be network-free'))
  const { engine: e, store } = f
  for (const key of keys) standing(store, key)
  await e.step()
  for (const key of keys) {
    hint(f, key, xrp, '80', { method: undefined })
    hint(f, key, xrp, '80', { quantity: 'total', method: 'xrpl-ledger-total' })
    hint(f, key, xrp, '80', { at: f.clock() + 1 })
  }
  assert.equal(e.supply.display(xrp).circulating, null)
  e.setSupply(xrp, { totalSupply: 90 })
  for (const key of keys.slice(0, 2)) hint(f, key, xrp, '100')
  assert.equal(e.supply.display(xrp).circulating, null)
  f.advance(1)
  for (const [i, key] of keys.entries()) hint(f, key, xrp, i < 2 ? '85' : '80')
  assert.equal(e.supply.display(xrp).circulating, null)
  standing(store, keys[3], 0)
  assert.equal(e.supply.display(xrp).circulating.value, '85')
  f.advance(DAY + 1)
  assert.equal(e.supply.display(xrp).circulating, null)
  assert.equal(e.supply.display(xrp).total.value, '90')
})
test('priced tokens resume rate-limited pinned reads and leave unpriced tokens idle', async t => {
  const custom = structuredClone(bundle)
  const chain = custom.chains.find(c => c.id === 'ethereum')
  chain.multicall3 = null
  const url = 'https://public.invalid/'
  chain.endpoints = [{ url, protocol: 'evm-jsonrpc', limits: '12 requests per minute' }]
  let attempt = 0
  const f = await fixture(t, ['supply:tokens'], async (endpoint, init) => {
    assert.equal(endpoint, url)
    const { method, params, id } = JSON.parse(init.body)
    let result
    if (method === 'eth_blockNumber') result = '0x9'
    else {
      assert.equal(params[0].to, usdc.split(':')[1])
      assert.equal(params[1], '0x9')
      result = '0x' + word([6, 10000001, 1, 0][attempt - 1])
    }
    attempt++
    return Response.json({ jsonrpc: '2.0', id, result })
  }, { bundle: custom })
  const { engine: e, store } = f
  assert.equal(await e.step(), null)
  assert.equal(attempt, 0)
  store.writer.prepare('INSERT INTO engine_references VALUES (?,?,?,?)').run(usdc, 'fixture', 1, f.clock())
  e.book.dirty = true
  e.book.refresh()
  for (let i = 0; i < 4; i++) {
    await assert.rejects(e.step(), RateLimited)
    f.advance(10_001)
  }
  assert.equal(await e.step(), 'supply:tokens')
  assert.equal(attempt, 5)
  assert.equal(e.supply.display(usdc).circulating.estimate, true)
  assert.equal(e.asset(usdc).marketCap, 10)
  assert.equal(e.supply.display(baseUsdc).circulating, null)
})
test('an unavailable meta channel leaves local supply jobs operational', async t => {
  const { engine: e, transport } = await fixture(t, ['supply:bitcoin'], async () => Response.json(1))
  transport.join = async () => false
  await e.step()
  assert.equal(e.supply.display(btc).circulating.value, '50')
  assert.equal(transport.sent.filter(m => m.channel === 'gator/meta').length, 0)
})
test('peer agreement compares fixed-point quantities at the exact 0.5% boundary', async t => {
  const f = await fixture(t, ['supply:listen'], () => assert.fail('Unexpected request'))
  await f.engine.step()
  for (const key of keys.slice(0, 2)) standing(f.store, key)
  hint(f, keys[0], xrp, '100')
  hint(f, keys[1], xrp, '100.5000000000000000001')
  assert.equal(f.engine.supply.display(xrp).circulating, null)
  f.advance(1)
  hint(f, keys[1], xrp, '100.5000000000000000000')
  assert.equal(f.engine.supply.display(xrp).circulating.method, 'peer-agreement')
})
test('a fresh stablecoin table supersedes local estimates and suppresses lower-quality token reads', async t => {
  let available = false
  const f = await fixture(t, ['supply:tokens', 'supply:stablecoins:ethereum'], async (url, init) => {
    if (url.endsWith('table_ethereum.json')) {
      if (!available) return new Response(null, { status: 503 })
      return Response.json(table('ethereum', usdc, 25))
    }
    const { method, id } = JSON.parse(init.body)
    assert.equal(method, 'eth_call')
    return Response.json({ jsonrpc: '2.0', id, result: aggregate([6, 40000000, 0, 0]) })
  })
  f.store.writer.prepare('INSERT INTO engine_references VALUES (?,?,?,?)').run(usdc, 'fixture', 1, f.clock())
  f.engine.book.dirty = true
  f.engine.book.refresh()
  const tokens = f.engine.scheduler.jobs.get('supply:tokens')
  await tokens.run()
  assert.equal(f.engine.budget.used, 0) // Give the circulating source the first attempt.
  const batch = f.engine.scheduler.jobs.get('supply:stablecoins:ethereum')
  await assert.rejects(batch.run())
  await tokens.run()
  assert.equal(f.engine.supply.display(usdc).circulating.value, '40')
  available = true
  f.advance(11000)
  await batch.run()
  await tokens.run()
  assert.equal(f.engine.budget.used, 3)
  assert.equal(f.engine.supply.display(usdc).circulating.value, '25')
})
function aggregate(values) {
  // ABI fixture for Multicall3 aggregate3 returning (success, bytes)[].
  const tuple = n => word(1) + word(64) + word(32) + word(n)
  return '0x' + word(32) + word(values.length) +
    values.map((_, i) => word(values.length * 32 + 128 * i)).join('') + values.map(tuple).join('')
}
test('a token price supported only by peers uses a public RPC even for a seed asset', async t => {
  const custom = structuredClone(bundle)
  const chain = custom.chains.find(c => c.id === 'ethereum')
  const pub = 'https://public.invalid', configured = 'https://private.invalid'
  chain.endpoints = [{ url: pub, protocol: 'evm-jsonrpc', limits: 6000 }]
  const visited = []
  const f = await fixture(t, ['supply:tokens'], async (url, init) => {
    visited.push(url)
    const { id } = JSON.parse(init.body)
    const result = aggregate([6, 1000000, 1, 0])
    return Response.json({ jsonrpc: '2.0', id, result })
  }, { bundle: custom, endpoints: { ethereum: [configured] } })
  const e = f.engine
  const m = e.registry.cex('bitstamp', 'USDC', 'USD')
  e.book.ingest(keys[0], [[m.id, '1', '4', '4', null, null, f.clock()]], false)
  e.book.refresh()
  await e.scheduler.jobs.get('supply:tokens').run()
  assert.deepEqual(visited, [pub])
  assert.equal(e.supply.display(usdc).circulating.value, '0.999999')
})
test('lagging native height preserves the evidence and still observes refresh cadence', async t => {
  let height = 7
  const f = await fixture(t, ['supply:bitcoin'], async () => Response.json(height))
  await f.engine.step()
  const original = f.engine.supply.display(btc)
  height = 1
  f.advance(DAY)
  await f.engine.step()
  const { circulating } = f.engine.supply.display(btc)
  assert.equal(circulating.block, 7)
  assert.equal(circulating.at, original.circulating.at)
  assert.equal(circulating.checkedAt, f.clock())
  assert.equal(f.engine.scheduler.jobs.get('supply:bitcoin').ready(), false)
  assert.equal(f.transport.sent.filter(m => m.channel === 'gator/meta').length, 1)
})
