import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { bundleDigest, loadBundle } from '@gator/bundle'
import { openStore } from '@gator/store'
import { Engine, migrations } from '../src/index.js'
import { createIntel, migrations as intelMigrations } from '../src/intel/index.js'
import { RateLimited } from '../src/scheduler/index.js'
import { ftInfo, nearToken, refKey, refState, REF } from '../src/sources/near/source.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/tonnear/near.json', import.meta.url)))
const bundle = loadBundle(), digest = bundleDigest(bundle)
const minute = 60_000
const HOSTS = ['https://rpc.mainnet.near.org', 'https://rpc.mainnet.fastnear.com', 'https://free.rpc.fastnear.com']
const page = from => fixture.calls.find(c => c.method_name === 'get_pools' && c.args.from_index === from).value
const STNEAR = fixture.calls.find(c => c.method_name === 'get_pool_by_ids').value[0] // Ref pool 535, meta-pool.near/wNEAR
const META = fixture.calls.find(c => c.method_name === 'ft_metadata').value
const NEAR_USD = 3.21 // independent reference sample (Binance NEARUSDT, same hour)

class Transport extends EventEmitter {
  publicKey = 'a'.repeat(64)
  sent = []
  channels() { return [] }
  async join() { return true }
  async leave() { return true }
  send(ch, msg) { this.sent.push({ ch, msg }); return true }
}

function answer(value) {
  return Response.json({ jsonrpc: '2.0', id: 'gator', result: { block_height: 225336355, logs: [],
    result: [...Buffer.from(JSON.stringify(value))] } })
}

async function node(t, store, pools) {
  const transport = new Transport(), calls = []
  const ctx = { now: fixture.calls[0].at, calls, store, transport, pools }
  const fetch = async (url, init) => {
    const { origin } = new URL(url)
    assert.ok(HOSTS.includes(origin), origin)
    const { method, params } = JSON.parse(init.body)
    assert.equal(method, 'query')
    assert.equal(params.finality, 'final')
    const args = JSON.parse(Buffer.from(params.args_base64, 'base64'))
    calls.push({ origin, account: params.account_id, method: params.method_name, args })
    if (params.method_name === 'ft_metadata') {
      if (params.account_id === 'meta-pool.near') return answer(META)
      return Response.json({ jsonrpc: '2.0', id: 'gator', result: { error: 'wasm execution failed', logs: [] } })
    }
    assert.equal(params.account_id, REF)
    if (params.method_name === 'get_pools') {
      const out = []
      for (let i = args.from_index; i < args.from_index + args.limit && ctx.pools.has(i); i++) out.push(ctx.pools.get(i))
      return answer(out)
    }
    assert.equal(params.method_name, 'get_pool_by_ids')
    return answer(args.pool_ids.map(id => ctx.pools.get(id)))
  }
  const engine = new Engine({ bundle, store, transport, clock: () => ctx.now, random: 1, backgroundJobs: ['near:ref'],
    rpcConfig: { fetch, bundleDigest: digest }, patches: { patchFeed: false, snapshot: false } })
  const intel = createIntel({ engine, dailyMarket: () => [], sampleGlobal() {} })
  await engine.start()
  clearTimeout(engine.timer)
  await intel.start()
  // Independently supplied USD conversions, just as the production reference job writes them.
  const ref = store.writer.prepare('INSERT OR REPLACE INTO engine_references VALUES (?,?,?,?)')
  ref.run('near:native', 'fixture', NEAR_USD, ctx.now)
  ref.run('near:usdt.tether-token.near', 'fixture', 1, ctx.now)
  engine.book.dirty = true
  engine.book.refresh()
  let stopped = false
  ctx.stop = async () => { if (!stopped) { stopped = true; await intel.stop(); await engine.stop() } }
  t.after(ctx.stop)
  const step = async fn => {
    ctx.now += Math.ceil(minute / engine.near.client.rpm) + 1
    for (const asset of ['near:native', 'near:usdt.tether-token.near']) ref.run(asset, 'fixture', asset === 'near:native' ? NEAR_USD : 1, ctx.now)
    const r = await fn()
    engine.book.dirty = true
    engine.book.refresh()
    return r
  }
  return Object.assign(ctx, { engine, intel, source: engine.near, step })
}

const database = () => openStore({ file: ':memory:', migrations: [...migrations, ...intelMigrations] })
const directory = () => new Map([...page(0), ...page(250)].map((p, i) => [i, p]))

test('Ref pool state, NEP-141 metadata and market keys', () => {
  assert.equal(nearToken('wrap.near'), 'native')
  assert.equal(nearToken('Bad.Near'), null)
  assert.equal(nearToken('a'.repeat(65)), null)
  assert.match(refKey(535), /^0x[0-9a-f]{64}$/)
  assert.notEqual(refKey(535), refKey(535, 'other.near'))
  const s = refState(STNEAR, [24, 24])
  assert.ok(s.price > 1.2 && s.price < 2, 'wNEAR per stNEAR: ' + s.price) // liquid staking ratio
  assert.equal(refState({ ...STNEAR, pool_kind: 'RATED_SWAP' }, [24, 24]), null)
  assert.equal(refState({ ...STNEAR, amounts: ['1e5', '1'] }, [24, 24]), null)
  assert.deepEqual(ftInfo(META, 'meta-pool.near'), { name: 'Staked NEAR', symbol: 'STNEAR', decimals: 24 })
  assert.deepEqual(ftInfo({ name: 'x‮Y', symbol: '\u0007', decimals: 6 }, 'a.near'), { decimals: 6 })
  assert.equal(ftInfo({ name: 'A', symbol: 'A', decimals: 300 }, 'a.near'), null)
})

test('directory paging resumes after restart and queues only pools with $10k of priced depth', async t => {
  const store = database(), n = await node(t, store, directory())
  try {
    assert.equal(await n.step(() => n.source.pages()), true)
    assert.deepEqual(store.getSetting('engine-near/pages'), { index: 250, tail: null, native: true })
    await n.stop()
    const again = await node(t, store, directory())
    again.now = n.now
    assert.equal(await again.step(() => again.source.pages()), true)
    assert.equal(again.calls[0].args.from_index, 250) // the stored index, not a fresh pass
    assert.equal(await again.step(() => again.source.pages()), true) // empty tail page completes the pass
    const cursor = store.getSetting('engine-near/pages')
    assert.equal(cursor.tail, 500)
    assert.ok(cursor.next >= again.now + 6 * 60 * minute - 1, 'pass with a NEAR price repeats after six hours')
    // Depth from the priced side only; every queued pool shows ≥ $10k, and none is reported as new.
    const queued = store.reader.prepare("SELECT ref,token0,token1,isNew FROM engine_family_candidates WHERE chain='near'").all()
    const all = directory()
    for (const q of queued) {
      const p = all.get(Number(q.ref))
      const side = p.token_account_ids.indexOf('wrap.near')
      assert.ok(side >= 0 || p.token_account_ids.includes('usdt.tether-token.near'))
      if (side >= 0) assert.ok(2 * Number(BigInt(p.amounts[side])) / 1e24 * NEAR_USD >= 10_000)
      assert.equal(q.isNew, 0)
    }
    assert.ok(queued.length >= 1)
    // Batched state for the queued set: one view call, priced markets, no gator/new.
    assert.equal(await again.step(() => again.source.state()), queued.some(q => again.source.decimals(q.token0) != null &&
      again.source.decimals(q.token1) != null))
    assert.equal(again.transport.sent.some(m => m.ch === 'gator/new'), false)
    await again.stop()
  } finally { store.close() }
})

test('a pool appended after the pass registers its new token, prices it and enters the local New list', async t => {
  const pools = new Map(), store = database(), n = await node(t, store, pools)
  try {
    assert.equal(await n.step(() => n.source.pages()), true) // empty directory: pass complete, tail at 0
    assert.equal(store.getSetting('engine-near/pages').tail, 0)
    pools.set(0, STNEAR) // a creation appended after the pass (real pool state of Ref pool 535)
    n.now += 2 * minute
    assert.equal(await n.step(() => n.source.pages()), true)
    const key = refKey(0), c = n.source.candidate(key)
    assert.equal(c.isNew, 1)
    assert.deepEqual([c.token0, c.token1], ['meta-pool.near', 'native'])
    assert.equal(await n.step(() => n.source.state()), false) // waits for decimals
    assert.equal(await n.step(() => n.source.meta()), true)
    assert.equal(await n.step(() => n.source.state()), true)
    const asset = n.engine.registry.assets.get('near:meta-pool.near')
    assert.equal(asset.symbol, 'STNEAR')
    assert.equal(asset.decimals, 24)
    const id = 'dex:near:' + key, market = n.engine.registry.markets.get(id)
    assert.equal(market.base, 'near:meta-pool.near')
    assert.equal(market.quote, 'near:native')
    const ratio = Number(BigInt(STNEAR.amounts[1])) / Number(BigInt(STNEAR.amounts[0]))
    const row = n.transport.sent.filter(m => m.ch.startsWith('gator/px/')).flatMap(m => m.msg.o).find(r => r[0] === id)
    assert.ok(Math.abs(Number(row[1]) / ratio - 1) < 1e-9)
    const usd = Number(n.store.getPrice('near:meta-pool.near')?.price)
    assert.ok(Math.abs(usd / (ratio * NEAR_USD) - 1) < 0.01, 'stNEAR in USD: ' + usd)
    const entry = n.intel.newTokens.list().find(e => e.asset === 'near:meta-pool.near')
    assert.ok(entry?.markets.includes(id))
    assert.ok(entry.liquidityUsd > 10_000)
    assert.equal(n.transport.sent.some(m => m.ch === 'gator/new'), false)
  } finally { await n.stop(); store.close() }
})

test('reads rotate over the three signed NEAR hosts inside the reader share', async t => {
  const store = database(), n = await node(t, store, directory())
  try {
    for (let i = 0; i < 3; i++) await n.step(() => n.source.client.view(REF, 'get_pools', { from_index: 0, limit: 1 }))
    assert.deepEqual(n.calls.map(c => c.origin), HOSTS)
    assert.equal(n.source.client.rpm, { small: 4, normal: 10, large: 15 }[n.engine.profile])
    await assert.rejects(n.source.client.view(REF, 'get_pools', { from_index: 0, limit: 1 }), RateLimited)
  } finally { await n.stop(); store.close() }
})
