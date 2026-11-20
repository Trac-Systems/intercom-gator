import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { bundleDigest, loadBundle } from '@gator/bundle'
import { openStore } from '@gator/store'
import { Engine, migrations } from '../src/index.js'
import { createIntel, migrations as intelMigrations } from '../src/intel/index.js'
import { RateLimited } from '../src/scheduler/index.js'
import { sourcesReport } from '../src/health/sources.js'
import {
  addressSlice, assetSlice, friendly, keyAddress, parseTon, poolKey, sliceBoc, stackAddress, stackAsset, tonAddress,
} from '../src/sources/ton/address.js'
import { DEDUST_FACTORY, PTON, STONFI_V1, USDT } from '../src/sources/ton/deployments.js'
import { jettonInfo } from '../src/sources/ton/source.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/tonnear/ton.json', import.meta.url)))
const bundle = loadBundle(), digest = bundleDigest(bundle)
const minute = 60_000
const DEDUST_POOL = 'EQA-X_yo3fzzbDbJ_0bzFWKqtRuZFIRa1sJsveZJ1YpViO3r'
const STON_V2_POOL = 'EQCGScrZe1xbyWqWDvdI6mzP-GAcAWFv6ZXuaJOuSqemxku4'
const STON_V1_POOL = 'EQD8TJ8xEWB1SpnRE4d89YO3jl0W0EiBnNS4IBaHaUmdfizE'
const call = (address, method) => fixture.calls.findLast(c => c.body.address === address && c.body.method === method).json
const key = body => JSON.stringify([body.address, body.method, body.stack ?? []])

class Transport extends EventEmitter {
  publicKey = 'a'.repeat(64)
  sent = []
  channels() { return [] }
  async join() { return true }
  async leave() { return true }
  send(ch, msg) { this.sent.push({ ch, msg }); return true }
}

async function node(t, store) {
  const transport = new Transport(), calls = []
  const answers = new Map(fixture.calls.map(c => [key(c.body), c.json]))
  const ctx = { now: fixture.at, calls, store, transport, refuse: null }
  const fetch = async (url, init) => {
    const { origin, pathname, searchParams } = new URL(url)
    calls.push({ origin, pathname, body: init?.body ? JSON.parse(init.body) : null })
    if (ctx.refuse) return new Response('{}', { status: ctx.refuse, headers: { 'retry-after': '300' } })
    if (origin === 'https://api.ston.fi') {
      const pair = pathname.replace('/v1/pools/by_market/', '')
      return Response.json(fixture.stonfi[pair] ?? { pool_list: [] })
    }
    assert.equal(origin, 'https://toncenter.com')
    if (pathname === '/api/v2/getTokenData') return Response.json(fixture.tokens[searchParams.get('address')] ?? { ok: false, code: 404 })
    if (pathname === '/api/v2/getTransactions') {
      assert.equal(searchParams.get('address'), DEDUST_FACTORY)
      return Response.json(fixture.dedustFactoryPage)
    }
    assert.equal(pathname, '/api/v2/runGetMethod')
    const body = JSON.parse(init.body)
    // Accounts that were never deployed answer exit code -13, exactly like the public endpoint.
    return Response.json(answers.get(key(body)) ?? { ok: true, result: { stack: [['num', '0x1cdac']], exit_code: -13 } })
  }
  const engine = new Engine({ bundle, store, transport, clock: () => ctx.now, random: 1, backgroundJobs: ['ton:dex'],
    rpcConfig: { fetch, bundleDigest: digest }, patches: { patchFeed: false, snapshot: false } })
  const intel = createIntel({ engine, dailyMarket: () => [], sampleGlobal() {} })
  await engine.start()
  clearTimeout(engine.timer)
  await intel.start()
  // Independently supplied USD conversion, just as the production reference job writes it.
  store.writer.prepare('INSERT OR REPLACE INTO engine_references VALUES (?,?,?,?)').run('ton:' + USDT, 'fixture', 1, ctx.now)
  engine.book.dirty = true
  engine.book.refresh()
  let stopped = false
  ctx.stop = async () => { if (!stopped) { stopped = true; await intel.stop(); await engine.stop() } }
  t.after(ctx.stop)
  // Each step waits for the reader's own request slot (6/12/20 per minute by profile).
  const step = async fn => { ctx.now += Math.ceil(minute / engine.ton.client.rpm) + 1; const r = await fn(); engine.book.refresh(); return r }
  return Object.assign(ctx, { engine, intel, source: engine.ton, step })
}

const database = () => openStore({ file: ':memory:', migrations: [...migrations, ...intelMigrations] })
const reserves = (stack, i, j) => [Number(BigInt(stack[i][1])), Number(BigInt(stack[j][1]))]

test('TON addresses, stack slices and the one-cell slice argument round-trip', () => {
  const a = parseTon(USDT)
  assert.equal(friendly(a), USDT)
  assert.equal(tonAddress('0:' + a.hash.toUpperCase()), USDT)
  assert.equal(keyAddress(poolKey(DEDUST_POOL)), DEDUST_POOL)
  assert.equal(parseTon(USDT.slice(0, -1) + (USDT.endsWith('s') ? 't' : 's')), null) // checksum
  assert.equal(tonAddress('-1:' + '0'.repeat(64)), null) // masterchain is not a DEX token
  // Wallet slices returned by STON.fi v1 get_pool_data (owner and master checked on-chain in the recorded reads).
  const v1 = call(STON_V1_POOL, 'get_pool_data').result.stack
  assert.deepEqual(v1.slice(2, 4).map(stackAddress), ['EQBO7JIbnU1WoNlGdgFtScJrObHXkBp-FT5mAz8UagiG9KQR',
    'EQARULUYsmJq1RiZ-YiH-IJLcAZUVkVff-KBPwEmmaQGH6aC'])
  assert.equal(stackAddress(v1[7]), 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c') // zero protocol fee address
  assert.deepEqual(call(DEDUST_POOL, 'get_assets').result.stack.map(stackAsset), ['native', USDT])
  // The exact argument cells the public endpoint accepted: factory and router recomputed the known pools.
  const lookup = fixture.calls.find(c => c.body.address === DEDUST_FACTORY)
  assert.deepEqual(lookup.body.stack.slice(1), [assetSlice('native'), assetSlice(USDT)])
  assert.equal(stackAddress(lookup.json.result.stack[0]), DEDUST_POOL)
  const member = fixture.calls.find(c => c.body.address === STONFI_V1 && c.body.method === 'get_pool_address')
  assert.deepEqual(member.body.stack, v1.slice(2, 4).map(stackAddress).map(addressSlice))
  assert.equal(stackAddress(member.json.result.stack[0]), STON_V1_POOL)
  assert.equal(sliceBoc([0, 0, 0, 0]), 'te6ccgEBAQEAAwAAAQg=') // native asset: 4 bits + completion tag
})

test('jetton identity comes only from on-chain content and is sanitized', () => {
  // USDT keeps its name and symbol off-chain (URI): decimals only, so the signed identity wins.
  assert.deepEqual(jettonInfo(fixture.tokens[USDT], USDT), { decimals: 6 })
  const json = structuredClone(fixture.tokens[USDT])
  json.result.jetton_content = { type: 'onchain', data: { name: 'Fake‮ Coin\u0000', symbol: ' FAKE​ ', decimals: '9' } }
  assert.deepEqual(jettonInfo(json, USDT), { name: 'Fake Coin', symbol: 'FAKE', decimals: 9 })
  json.result.jetton_content.data.decimals = '255'
  assert.equal(jettonInfo(json, USDT), null)
  assert.equal(jettonInfo(fixture.tokens[USDT], PTON[0]), null) // answer for another address
})

test('TON/USDT on DeDust and STON.fi v2 is verified on-chain, priced and shared only as prices', async t => {
  const store = database(), n = await node(t, store)
  try {
    assert.equal(await n.step(() => n.source.pairs()), true) // DeDust factory get_pool_address(TON, USDT)
    const dedust = n.source.candidate(poolKey(DEDUST_POOL))
    assert.equal(dedust.extra.factory, true)
    assert.equal(await n.step(() => n.source.verify()), true) // get_assets fixes the pool's token order
    assert.equal(n.source.candidate(poolKey(DEDUST_POOL)).stage, 1)
    assert.equal(await n.step(() => n.source.state()), true)
    const id = 'dex:ton:' + poolKey(DEDUST_POOL)
    const market = n.engine.registry.markets.get(id)
    assert.equal(market.base, 'ton:native')
    assert.equal(market.quote, 'ton:' + USDT)
    const [ton, usdt] = reserves(call(DEDUST_POOL, 'get_reserves').result.stack, 0, 1)
    const expected = (usdt / 1e6) / (ton / 1e9)
    const row = n.transport.sent.filter(m => m.ch.startsWith('gator/px/')).flatMap(m => m.msg.o).find(r => r[0] === id)
    assert.ok(Math.abs(Number(row[1]) / expected - 1) < 1e-9)
    assert.ok(expected > 0.5 && expected < 20)
    const price = Number(store.getPrice('ton:native')?.price)
    assert.ok(Math.abs(price / expected - 1) < 0.001, 'TON priced from the pool: ' + price)

    // STON.fi's directory lists the pair; only the funded pool on a known router is queued, then proven on-chain.
    assert.equal(await n.step(() => n.source.pairs()), true)
    const ston = n.source.candidate(poolKey(STON_V2_POOL))
    assert.equal(ston.dex, 'stonfi-v2')
    assert.equal(store.reader.prepare("SELECT count(*) n FROM engine_family_candidates WHERE dex='stonfi-v2'").get().n, 1)
    for (let i = 0; i < 4; i++) assert.equal(await n.step(() => n.source.verify()), true)
    const proven = n.source.candidate(poolKey(STON_V2_POOL))
    assert.equal(proven.stage, 1)
    assert.deepEqual([proven.token0, proven.token1], [USDT, 'native']) // pTON v2.1 resolves to native TON
    assert.equal(await n.step(() => n.source.state()), true)
    const stonId = 'dex:ton:' + poolKey(STON_V2_POOL)
    const [u2, t2] = reserves(call(STON_V2_POOL, 'get_pool_data').result.stack, 3, 4)
    const stonRow = n.transport.sent.filter(m => m.ch.startsWith('gator/px/')).flatMap(m => m.msg.o).find(r => r[0] === stonId)
    assert.ok(Math.abs(Number(stonRow[1]) / ((u2 / 1e6) / (t2 / 1e9)) - 1) < 1e-9)
    assert.ok(Math.abs(Number(stonRow[1]) / expected - 1) < 0.01, 'venues agree within 1%')
    assert.equal(n.transport.sent.some(m => m.ch === 'gator/new'), false)
    assert.equal(n.intel.newTokens.list().length, 0) // seeded old pools are not "new"
    const scanner = sourcesReport(n.engine).groups.find(g => g.id === 'scanners').items.find(i => i.id === 'ton:dex')
    assert.equal(scanner.host, 'toncenter.com')
  } finally { await n.stop(); store.close() }
})

test('a directory row naming a non-STON.fi contract is rejected on-chain', async t => {
  const store = database(), n = await node(t, store)
  try {
    n.source.remember({ pool: poolKey(DEDUST_POOL), ref: DEDUST_POOL, dex: 'stonfi-v2', kind: 'v2', firstSeen: n.now,
      extra: { router: 'EQCS4UEa5UaJLzOyyKieqQOQ2P9M-7kXpkO5HnP3Bv250cN3' } })
    await n.step(() => n.source.verify()) // DeDust pool has no STON.fi get_pool_data: rejected
    const row = n.source.candidate(poolKey(DEDUST_POOL))
    assert.equal(row.stage, 0)
    assert.ok(row.due > n.now + 60 * minute)
    assert.equal(n.engine.registry.markets.has('dex:ton:' + poolKey(DEDUST_POOL)), false)
  } finally { await n.stop(); store.close() }
})

test('DeDust factory transactions queue fresh creations, resume from the stored top and skip dead destinations', async t => {
  const store = database(), n = await node(t, store)
  try {
    assert.equal(await n.step(() => n.source.factory()), true)
    const page = fixture.dedustFactoryPage.result
    const expected = new Set(page.flatMap(tx => tx.out_msgs.map(m => m.destination).filter(d => d !== tx.in_msg.source)))
    const rows = store.reader.prepare("SELECT ref,isNew,firstSeen FROM engine_family_candidates WHERE chain='ton'").all()
    assert.deepEqual(new Set(rows.map(r => r.ref)), expected)
    assert.ok(rows.every(r => r.isNew === 1 && r.firstSeen <= n.now))
    const cursor = store.getSetting('engine-ton/factory')
    assert.equal(cursor.top, page[0].transaction_id.lt)
    assert.equal(cursor.bottom.lt, page.at(-1).transaction_id.lt)
    // The history backfill waits while the verification queue is long, then walks below the first page.
    store.writer.prepare("UPDATE engine_family_candidates SET due=? WHERE chain='ton'").run(n.now + 60 * minute)
    assert.equal(await n.step(() => n.source.history()), true)
    const walk = n.calls.at(-1)
    assert.equal(walk.pathname, '/api/v2/getTransactions')
    assert.equal(store.getSetting('engine-ton/factory-history').next > n.now + 6 * 86_400_000, true) // short page: done
    assert.equal(await n.step(() => n.source.history()), false)
    store.writer.prepare("UPDATE engine_family_candidates SET due=0 WHERE chain='ton'").run()
    assert.equal(await n.step(() => n.source.factory()), false) // polled again only after three minutes
    await n.stop()
    const again = await node(t, store)
    again.now = n.now + 3 * minute
    assert.equal(await again.step(() => again.source.factory()), true)
    assert.equal(store.reader.prepare("SELECT count(*) n FROM engine_family_candidates WHERE chain='ton'").get().n, expected.size)
    // A never-deployed destination answers exit code -13: rejected for a day, not retried every turn.
    await again.step(() => again.source.verify())
    assert.equal(store.reader.prepare("SELECT count(*) n FROM engine_family_candidates WHERE chain='ton' AND due>?").get(again.now).n, 1)
    await again.stop()
  } finally { store.close() }
})

test('fresh DeDust launches are measured on their TON side before any jetton metadata read', async t => {
  const store = database(), n = await node(t, store)
  try {
    // TON's USD price, as the engine derives it from the TON/USDT pools.
    await n.step(() => n.source.pairs())
    await n.step(() => n.source.verify())
    await n.step(() => n.source.state())
    assert.ok(n.source.usd('native') > 0)
    await n.step(() => n.source.factory())
    const launches = ['EQBZJAg9qUICohBRPEq2Y3spdT7pXIT2YOGvthnhsH44pAYa', 'EQB4fYtRJrQrjawVqsIM6mov-RtAi0lZuwB5d5JsXz6VVVX4']
    for (const ref of launches) {
      // Verify exactly this launch (other fresh destinations wait): get_assets, then the factory recomputes it.
      store.writer.prepare("UPDATE engine_family_candidates SET due=CASE WHEN ref=? THEN 0 ELSE ? END WHERE chain='ton' AND stage=0")
        .run(ref, n.now + 60 * minute)
      await n.step(() => n.source.verify())
      await n.step(() => n.source.verify())
      assert.equal(n.source.candidate(poolKey(ref)).stage, 1)
      await n.step(() => n.source.state())
      const row = n.source.candidate(poolKey(ref))
      assert.equal(row.funded, 0)
      assert.equal(row.extra.wantMeta, undefined)
      assert.ok(row.due > n.now)
    }
    // Recorded reserves: 1.93 TON and 1e-9 TON. Neither launch reached a metadata read or a market.
    assert.equal(n.calls.filter(c => c.pathname === '/api/v2/getTokenData').length, 0)
    assert.equal(await n.step(() => n.source.meta()), false)
    assert.equal([...n.engine.registry.markets.keys()].filter(id => id.startsWith('dex:ton:')).length, 1)
  } finally { await n.stop(); store.close() }
})

test('toncenter reads keep the reader share and back off on refusals', async t => {
  const store = database(), n = await node(t, store)
  try {
    const client = n.source.client
    assert.equal(client.rpm, { small: 6, normal: 12, large: 20 }[n.engine.profile])
    await client.run(DEDUST_POOL, 'get_reserves')
    await assert.rejects(client.run(DEDUST_POOL, 'get_reserves'), RateLimited)
    n.now += Math.ceil(minute / client.rpm) + 1
    n.refuse = 429
    await assert.rejects(client.run(DEDUST_POOL, 'get_reserves'), e => e.status === 429)
    const host = n.engine.http.hosts.get('https://toncenter.com')
    assert.ok(host.next >= n.now + 300_000, 'Retry-After honored on the shared host bucket')
    n.refuse = null
  } finally { await n.stop(); store.close() }
})
