import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { bundleDigest, loadBundle } from '@gator/bundle'
import { openStore } from '@gator/store'
import { Engine, migrations } from '../src/index.js'
import { createIntel, migrations as intelMigrations } from '../src/intel/index.js'
import { RateLimited, RequestBudget } from '../src/scheduler/index.js'
import { HttpSources } from '../src/sources/http.js'
import { word } from '../src/sources/evm-abi.js'
import { abiAddress } from '../src/sources/tron/address.js'
import { TronClient } from '../src/sources/tron/client.js'
import { FACTORIES, MULTICALL, USDT, WTRX } from '../src/sources/tron/deployments.js'
import { parsePage } from '../src/sources/tron/events.js'

const fixture = name => JSON.parse(readFileSync(new URL('./fixtures/tron/' + name + '.json', import.meta.url)))
const state = fixture('state'), funded = fixture('funded-event')
const bundle = loadBundle(), digest = bundleDigest(bundle)
const minute = 60_000, day = 86_400_000
const page = (data, fp) => ({ success: true, data, meta: { page_size: data.length, fingerprint: fp } })
const creation = parsePage(FACTORIES[1], page([funded.event]), { from: 0, until: funded.at }).pools[0]
const wire = ({ chain, pool, dex, kind, token0, token1, block, tx }) =>
  ({ t: 'pool', v: 1, chain, pool, dex, kind, token0, token1, block, tx })

class Transport extends EventEmitter {
  publicKey = 'a'.repeat(64)
  sent = []
  channels() { return [] }
  async join() { return true }
  async leave() { return true }
  send(ch, msg) { this.sent.push({ ch, msg }); return true }
}

// Decode the actual aggregate3 calldata and return recorded inner responses in request order.
function aggregate(input, answer) {
  const uint = (hex, offset) => Number(BigInt('0x' + hex.slice(offset, offset + 64)))
  const array = uint(input, 0) * 2, count = uint(input, array), table = array + 64
  const tuples = Array.from({ length: count }, (_, i) => {
    const pos = table + uint(input, table + i * 64) * 2, bytes = pos + uint(input, pos + 128) * 2
    const to = '0x' + input.slice(pos + 24, pos + 64)
    const data = '0x' + input.slice(bytes + 64, bytes + 64 + 2 * uint(input, bytes))
    const value = answer(to, data), payload = value?.slice(2) ?? ''
    return word(Number(value != null)) + word(64) + word(payload.length / 2) +
      payload.padEnd(Math.ceil(payload.length / 64) * 64, '0')
  })
  let offset = count * 32
  const offsets = tuples.map(tuple => { const pos = offset; offset += tuple.length / 2; return word(pos) })
  return word(32) + word(count) + offsets.join('') + tuples.join('')
}

async function node(t, store) {
  const transport = new Transport(), calls = [], pages = []
  const values = new Map([...state.calls, ...funded.calls].map(c => [c.to + c.data, c.result]))
  const ctx = { now: funded.at + 10_000, receipt: funded.receipt, calls, pages, store, transport, values }
  const fetch = async (url, init) => {
    const { origin, pathname, searchParams } = new URL(url)
    assert.equal(origin, 'https://api.trongrid.io')
    calls.push({ pathname, searchParams })
    let json
    if (pathname.endsWith('/events')) {
      assert.equal(searchParams.get('only_confirmed'), 'true')
      assert.equal(searchParams.get('order_by'), 'block_timestamp,asc')
      json = pages.shift() ?? page([])
    } else if (pathname.endsWith('/gettransactioninfobyid')) {
      assert.equal(JSON.parse(init.body).value, funded.receipt.id)
      json = ctx.receipt
    } else {
      assert.equal(pathname, '/walletsolidity/triggerconstantcontract')
      const body = JSON.parse(init.body)
      assert.equal(body.contract_address, MULTICALL)
      assert.equal(body.function_selector, 'aggregate3((address,bool,bytes)[])')
      const raw = aggregate(body.parameter, (to, data) => {
        if (to === abiAddress(MULTICALL) && data === '0x0f28c97d') return '0x' + word(Math.floor(ctx.now / 1000))
        if (values.has(to + data)) return values.get(to + data)
        if (FACTORIES.some(f => abiAddress(f.address) === to)) return '0x' + word(0)
        assert.fail('unexpected state query ' + to + ' ' + data)
      })
      json = { constant_result: [raw], result: { result: true } }
    }
    return Response.json(json)
  }
  const engine = new Engine({ bundle, store, transport, clock: () => ctx.now, random: 1, backgroundJobs: ['tron:sunswap'],
    rpcConfig: { fetch, bundleDigest: digest }, patches: { patchFeed: false, snapshot: false } })
  const intel = createIntel({ engine, dailyMarket: () => [], sampleGlobal() {} })
  await engine.start()
  clearTimeout(engine.timer)
  await intel.start()
  // Independently supplied USD conversion, just as the production reference job writes it.
  store.writer.prepare('INSERT OR REPLACE INTO engine_references VALUES (?,?,?,?)').run('tron:' + USDT, 'fixture', 1, ctx.now)
  engine.book.dirty = true
  engine.book.refresh()
  let stopped = false
  ctx.stop = async () => {
    if (!stopped) { stopped = true; await intel.stop(); await engine.stop() }
  }
  t.after(ctx.stop)
  return Object.assign(ctx, { engine, intel, source: engine.tron, advance: (ms = minute) => { ctx.now += ms } })
}

function database() {
  return openStore({ file: ':memory:', migrations: [...migrations, ...intelMigrations] })
}

test('scheduled signed-token seeding publishes TRX/USDT, and a complete negative pass survives restart', async t => {
  const store = database(), n = await node(t, store)
  try {
    assert.equal(await n.engine.step(), 'tron:sunswap')
    n.advance()
    assert.equal(await n.engine.step(), 'tron:sunswap')
    assert.ok(n.transport.sent.some(({ ch }) => ch.startsWith('gator/px/')))
    assert.equal(n.transport.sent.some(({ ch }) => ch === 'gator/new'), false)
    assert.ok(Math.abs(Number(store.getPrice('tron:native').price) - 0.3107) < 0.001)
    for (const p of state.pools) assert.ok(n.engine.registry.known('dex:tron:' + p.pool))
    for (const { address, chain } of n.engine.catalog.assets.filter(a => a.chain === 'tron' && a.address !== 'native')) {
      assert.equal(chain, 'tron')
      assert.ok(n.source.plan.some(p => p.token0 === address || p.token1 === address))
    }
    while (!store.getSetting('engine-tron/seed').next) { n.advance(); await n.source.seed() }
    await n.stop()
    const reopened = await node(t, store)
    try {
      assert.equal(await reopened.source.seed(), false)
      assert.equal(reopened.calls.length, 0)
      assert.ok(reopened.engine.registry.known('dex:tron:' + state.pools[0].pool))
    } finally { await reopened.stop() }
  } finally { await n.stop(); store.close() }
})

test('event pagination resumes the identical window after restart and commits a funded, priced new token', async t => {
  const store = database(), n = await node(t, store)
  const factory = FACTORIES[1], key = 'engine-tron/' + factory.dex
  const window = { from: creation.firstSeen - 1000, until: creation.firstSeen + 1000 }
  store.setSetting(key, window)
  n.pages.push(page([funded.event], 'cursor1'))
  try {
    await n.source.events(factory)
    assert.equal(n.source.candidate.get(creation.pool).tx, creation.tx)
    await n.stop()
    const next = await node(t, store)
    try {
      assert.ok(!next.engine.registry.assets.has('tron:' + creation.token1))
      // Inclusive boundary: the same event can appear on the next page or after a cursor replay.
      next.pages.push(page([funded.event]))
      await next.source.events(factory)
      const q = next.calls[0].searchParams
      assert.equal(q.get('fingerprint'), 'cursor1')
      assert.equal(Number(q.get('min_block_timestamp')), window.from)
      assert.equal(Number(q.get('max_block_timestamp')), window.until)
      assert.equal(store.reader.prepare('SELECT count(*) n FROM engine_tron_candidates').get().n, 1)
      assert.equal(store.getSetting(key).fingerprint, undefined)
      next.advance()
      await next.source.state()
      next.engine.book.refresh()
      const asset = next.engine.registry.assets.get('tron:' + creation.token1)
      assert.deepEqual([asset.name, asset.symbol, asset.decimals], ['TrueUSD', 'TUSD', 18])
      assert.ok(Math.abs(Number(store.getPrice(asset.id).price) - 1.0001147) < 0.000001)
      assert.ok(next.intel.newTokens.list().some(r => r.asset === asset.id && r.liquidityUsd > 1_800_000))
      assert.deepEqual(next.transport.sent.filter(x => x.ch === 'gator/new').map(x => x.msg), [wire(creation)])
      assert.ok(next.transport.sent.some(x => x.ch.startsWith('gator/px/') && x.msg.b === digest.slice(0, 16)))
      next.advance(3 * minute)
      await next.source.state()
      assert.equal(next.transport.sent.filter(x => x.ch === 'gator/new').length, 1)
    } finally { await next.stop() }
  } finally { await n.stop(); store.close() }
})

test('receiver registers a hinted TRON market only after the public receipt and an independent funded snapshot', async t => {
  const store = database(), n = await node(t, store), peer = 'b'.repeat(64)
  const submit = hint => n.transport.emit('message', 'gator/new', { channel: 'gator/new', from: peer, ts: n.now, message: wire(hint) })
  try {
    const before = n.engine.hints.rank(peer)
    submit({ ...creation, block: creation.block + 1 })
    assert.equal(n.intel.newTokens.list().length, 0)
    await n.engine.verifyHint()
    assert.ok(n.engine.hints.rank(peer) < before)
    assert.equal(n.source.pool.get(creation.pool), undefined)
    n.advance()
    submit(creation)
    await assert.rejects(n.engine.verifyHint(), RateLimited)
    assert.equal(n.source.pool.get(creation.pool), undefined)
    assert.equal(n.engine.hints.size, 1)
    n.advance(2 * minute)
    await n.engine.verifyHint()
    assert.ok(n.source.pool.get(creation.pool).liquidity > 1_800_000)
    assert.equal(n.engine.registry.known('dex:tron:' + creation.pool).fromHint, 1)
    assert.equal(n.intel.newTokens.list().find(r => r.asset === 'tron:' + creation.token1).reporters, 2)
    assert.equal(n.calls.filter(c => c.pathname.endsWith('/gettransactioninfobyid')).length, 2)
  } finally { await n.stop(); store.close() }
})

test('zero liquidity and a spoofed factory mapping cannot register an event or publish a price', async t => {
  const store = database(), n = await node(t, store)
  try {
    n.source.rememberPool(creation)
    const key = abiAddress(creation.pool) + '0x1a686502'
    const liquidity = n.values.get(key)
    n.values.set(key, '0x' + word(0))
    await n.source.state()
    assert.equal(n.source.pool.get(creation.pool), undefined)
    n.values.set(key, liquidity)
    const lookup = funded.calls.find(c => c.data.startsWith('0x1698ee82'))
    n.values.set(lookup.to + lookup.data, '0x' + word(abiAddress(WTRX)))
    n.advance(day)
    await n.source.state()
    assert.equal(n.source.pool.get(creation.pool), undefined)
    assert.equal(n.transport.sent.some(x => x.ch === 'gator/new' || x.ch.startsWith('gator/px/')), false)
  } finally { await n.stop(); store.close() }
})

for (const [profile, limit] of [['small', 2], ['normal', 4], ['large', 6]]) {
  test('TRON leaves other sources their budget on the ' + profile + ' profile', async () => {
    let now = 1, sent = 0
    const clock = () => now, budget = new RequestBudget(profile, undefined, clock)
    const http = new HttpSources({ clock, budget, fetch: async () => { sent++; return Response.json({}) } })
    const client = new TronClient({ http, budget, clock, profile, bundle })
    for (; now < minute; now += 1000) {
      try { await client.request('/v1/test') } catch (error) { assert.ok(error instanceof RateLimited) }
    }
    assert.equal(sent, limit)
    assert.equal(budget.dispatches, limit)
    while (budget.used < budget.limit) budget.take()
    await assert.rejects(client.request('/v1/test'), RateLimited)
    assert.equal(sent, limit)
  })
}

test('403 and 429 back off the whole public host, honor Retry-After and charge each failed dispatch', async () => {
  let now = 1000, status = 403
  const clock = () => now, budget = new RequestBudget('large', undefined, clock)
  const http = new HttpSources({ budget, clock, fetch: async () => new Response('{}', { status,
    headers: status === 429 ? { 'retry-after': '180' } : {} }) })
  const client = new TronClient({ bundle, http, budget, clock, profile: 'large' })
  await assert.rejects(client.request('/test'), { status: 403 })
  assert.equal(client.next, now + minute)
  now += 30_000
  await assert.rejects(http.getPublic('https://api.trongrid.io/test', 12), RateLimited)
  now = client.next
  status = 429
  await assert.rejects(client.request('/test'), { status: 429 })
  assert.equal(client.next, now + 180_000)
  assert.equal(budget.dispatches, 2)
})
