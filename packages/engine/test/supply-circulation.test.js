import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { Engine, migrations } from '../src/index.js'
import { openStore } from '@gator/store'
import { loadBundle } from '@gator/bundle'
import { CIRCULATION_FEEDS, readCirculation } from '../src/sources/supply-circulation.js'
import { DAY } from '../src/sources/supply-api.js'
import { RateLimited } from '../src/scheduler/index.js'

const now = Date.parse('2026-11-19T12:00:00Z')
const samples = JSON.parse(readFileSync(new URL('fixtures/circulation-mainnet.json', import.meta.url)))
const expected = {
  'bnb-burn': '131510353.6', 'tronscan-funds': '95046366117.16151',
  'avax-supply': '444217168.06601430042185150349', 'tontech-circulation': '2870322095.771816961',
  'sui-circulation': '4139043544.1303763', 'ripple-distribution': '63516606953',
  'near-circulation': '1312113465.497752560650862705794036', 'aptos-circulation': '889222706.3731208',
  'aptos-usd1': '19121853.520449', 'kamino-circulation': '6021918190.75', 'jup-circulation': '3319369204.37',
}
const read = (api, data, at = now) => readCirculation(CIRCULATION_FEEDS.find(f => f.api === api), data, at)

test('mainnet circulating values retain dates, units and provenance for the exact asset', () => {
  for (const f of CIRCULATION_FEEDS) {
    const record = read(f.api, samples[f.api])
    assert.equal(record.value, expected[f.api])
    assert.equal(record.source, f.api)
    assert.equal(record.method, f.method)
    assert.ok(record.expiresAt > now)
    assert.throws(() => read(f.api, {}))
  }
  assert.equal(read('ripple-distribution', samples['ripple-distribution']).at, Date.UTC(2026, 9, 25))
  assert.equal(read('aptos-circulation', samples['aptos-circulation']).block, 8122643326)
  assert.equal(read('near-circulation', samples['near-circulation']).at, Date.UTC(2026, 10, 19))
  const avax = samples['avax-supply']
  assert.equal(read('avax-supply', { ...avax, circulatingSupply: expected['avax-supply'] }).value, expected['avax-supply'])
  assert.equal(read('sui-circulation', samples['sui-circulation'], Date.UTC(2026, 10, 30, 23)).expiresAt, Date.UTC(2026, 11))
})

test('inconsistent, stale, future and wrong-period reports cannot set circulation', () => {
  for (const [id, changes] of [
    ['bnb-burn', { bcSupply: 12 }], ['tronscan-funds', { circulationSupply: 1e12 }],
    ['avax-supply', { totalLocked: '9999999999' }], ['avax-supply', { circulatingSupply: '1' }],
    ['avax-supply', { lastUpdated: 'yesterday' }], ['tontech-circulation', { result: '0' }],
    ['sui-circulation', { year: 2025 }], ['sui-circulation', { circulatingSupplyPercentage: 0.999 }],
    ['ripple-distribution', { rows: [{ ...samples['ripple-distribution'].rows[0], distributed: '1' }] }],
    ['near-circulation', { timestamp: '1' }], ['aptos-circulation', { blockchain_time_microseconds: (now + 10) * 1000 }],
    ['jup-circulation', { total: 1 }],
  ]) assert.throws(() => read(id, { ...samples[id], ...changes }), undefined, id)
  assert.throws(() => read('ripple-distribution', samples['ripple-distribution'], Date.UTC(2026, 10, 29)))
  assert.throws(() => read('kamino-circulation', '1e10'))
})

test('refresh failure, expiry and restart withdraw a previously priced float from display, ranks and storage', async t => {
  const feed = CIRCULATION_FEEDS.find(f => f.api === 'bnb-burn')
  const bundle = structuredClone(loadBundle())
  bundle.tokens.tokens = bundle.tokens.tokens.filter(t => t.id === feed.asset)
  const store = openStore({ file: ':memory:', migrations })
  let time = now, bad = false
  const make = () => new Engine({ bundle, store, clock: () => time, transport: Object.assign(new EventEmitter(),
    { publicKey: '1'.repeat(64) }), backgroundJobs: ['supply:circulating:bnb-burn'], rpcConfig: { fetch: async url => {
      assert.equal(url, 'https://www.bnbburn.info/api/getBnbSupply')
      return Response.json(bad ? { bscSupply: 0 } : samples[feed.api])
    } } })
  t.after(() => store.close())
  const e = make(), job = e.scheduler.jobs.get('supply:circulating:bnb-burn')
  const price = () => {
    store.writer.prepare('INSERT OR REPLACE INTO engine_references VALUES (?,?,?,?)').run(feed.asset, 'fixture', 2, time)
    e.book.dirty = true
  }
  price()
  await job.run()
  assert.equal(e.supply.display(feed.asset).circulating.value, expected[feed.api])
  assert.equal(e.global().marketCap, Number(expected[feed.api]) * 2)
  assert.equal(job.ready(), false)
  // Local profile/host deferrals do not represent a failed upstream read.
  await assert.rejects(job.run(), RateLimited)
  assert.ok(e.global().marketCap)
  time += 60_000
  bad = true
  await assert.rejects(job.run())
  assert.equal(e.supply.display(feed.asset).circulating, null)
  assert.equal(e.global().marketCap, null)
  assert.equal(store.getAsset(feed.asset).marketCap, null)
  assert.equal(make().registry.assets.get(feed.asset).supply, null)
  time += 60_000
  bad = false
  await job.run()
  time += 2 * DAY
  price()
  // The first global read after a clock jump runs before timers or another scheduler step.
  assert.equal(e.global().marketCap, null)
  assert.equal(store.getAsset(feed.asset).marketCap, null)
  await job.run()
  time += 2 * DAY
  price()
  // A restarted process clears stale facts before reading its first persisted price.
  const restarted = make()
  assert.equal(restarted.global().marketCap, null)
  assert.equal(restarted.supply.display(feed.asset).circulating, null)
  assert.equal(store.getAsset(feed.asset).marketCap, null)
})

test('a missing bridge-adjusted GHO row and a disabled Jupiter feed cannot fall back to gross mint supply', async t => {
  const gho = 'arbitrum:0x7dff72693f6a4149b17e7c6314655f6a9f7c8b33'
  const jup = CIRCULATION_FEEDS.find(feed => feed.api === 'jup-circulation').asset
  const bundle = structuredClone(loadBundle())
  bundle.tokens.tokens = bundle.tokens.tokens.filter(a => [gho, jup].includes(a.id))
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const data = { table: { columns: ['date', 'origin_key', 'address', 'decimals', 'method', 'value'],
    rows: [['2026-11-18', 'arbitrum', gho.split(':')[1], 18, 'rpc', 30052945.05]] } }
  let time = now, requests = 0
  const make = () => new Engine({ bundle, store, clock: () => time, transport: Object.assign(new EventEmitter(),
    { publicKey: '1'.repeat(64) }), backgroundJobs: ['supply:tokens', 'supply:stablecoins:arbitrum'],
    rpcConfig: { fetch: async url => {
      assert.ok(url.endsWith('/table_arbitrum.json'))
      requests++
      return Response.json({ data })
    } } })
  const old = make()
  old.setSupply(jup, { circulatingSupply: 6862295090.11, totalSupply: 6862295090.11 })
  store.upsertClaim({ asset: jup, kind: 'supply', value: '6862295090.11', reporter: 'local-supply', at: time,
    proof: { at: time, source: 'solana/spl-token', method: 'total-minus-burn' } })
  const e = make(), table = e.scheduler.jobs.get('supply:stablecoins:arbitrum')
  assert.equal(e.registry.assets.get(jup).supply, null)
  assert.equal(e.registry.assets.get(jup).totalSupply, 6862295090.11)
  for (const id of [gho, jup]) store.writer.prepare('INSERT INTO engine_references VALUES (?,?,?,?)').run(id, 'fixture', 1, time)
  e.book.refresh()
  await table.run()
  assert.equal(e.supply.display(gho).circulating.value, '30052945.05')
  time += 60000
  data.table.rows = []
  await table.run()
  await e.scheduler.jobs.get('supply:tokens').run()
  assert.equal(requests, 2)
  assert.equal(e.supply.display(gho).circulating, null)
  assert.equal(e.supply.display(jup).circulating, null)
  assert.equal(e.global().marketCap, null)
})
