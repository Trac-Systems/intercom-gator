// EVM coverage (11-20: Polygon showed 1 of 196 known tokens): seed order and pacing, page batching, public
// endpoint rate defaults, waiting reads vs scanners, scanner turns, prioritised refresh and restart resume.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Registry } from '../src/registry/index.js'
import { EvmSource, seedPlan, seedValue } from '../src/sources/evm.js'
import { word } from '../src/sources/evm-abi.js'
import { endpointRate, rateLimit } from '../src/sources/bundle-adapter.js'
import { EndpointBucket, RateLimited, RequestBudget, Scheduler } from '../src/scheduler/index.js'
import { RpcClient } from '../src/rpc/index.js'
import { migrations } from '../src/schema.js'
import { openStore } from './store-fixture.js'

const addr = n => '0x' + word(n).slice(-40)
const data = (...words) => '0x' + words.map(n => word(BigInt.asUintN(256, BigInt(n)))).join('')
const initial = Date.UTC(2026, 10, 20)

/** Answer every aggregate3 call with `answer(to, input)`; count the multicalls. */
function aggregate(input, answer) {
  const args = input.slice(10)
  const number = (hex, offset) => Number(BigInt('0x' + hex.slice(offset, offset + 64)))
  const start = number(args, 0) * 2, count = number(args, start), table = start + 64
  const tuples = Array.from({ length: count }, (_, i) => {
    const pos = table + number(args, table + 64 * i) * 2
    const to = '0x' + args.slice(pos + 24, pos + 64)
    const bytes = pos + number(args, pos + 128) * 2
    const size = number(args, bytes)
    const result = answer(to, '0x' + args.slice(bytes + 64, bytes + 64 + 2 * size))
    const payload = result?.slice(2) ?? ''
    return word(Number(result != null)) + word(64) + word(payload.length / 2) +
      payload.padEnd(Math.ceil(payload.length / 64) * 64, '0')
  })
  let offset = 32 * count
  return data(32, count) + tuples.map(t => { const start = offset; offset += t.length / 2; return word(start) }).join('') + tuples.join('')
}

const QUOTE = addr(12), WBTC = addr(0xfff), EARLY = addr(0x20), V2 = addr(1)
/** A chain with one quote, an early-address unranked token and a late-address WBTC deployment whose coin (BTC on
 * another chain) carries rank 1. */
function fixture(t, { profile = 'normal', extra = 0, tiers = null } = {}) {
  const store = openStore({ file: ':memory:', migrations, profile })
  t.after(() => store.close())
  const chain = { id: 'poly', family: 'evm', range: 20, quotes: [QUOTE], events: {}, multicall: addr(90),
    deployments: [{ address: V2, name: 'v2', kind: 'v2', topics: [] },
      ...(tiers ? [{ address: addr(2), name: 'v3', kind: 'v3', feeTiersPpm: tiers, topics: [] }] : [])] }
  const assets = [
    { id: 'poly:' + QUOTE, chain: 'poly', address: QUOTE, decimals: 6, name: 'USD Coin', symbol: 'USDC', stable: true },
    { id: 'poly:' + EARLY, chain: 'poly', address: EARLY, decimals: 18, name: 'Early', symbol: 'EARLY' },
    { id: 'poly:' + WBTC, chain: 'poly', address: WBTC, decimals: 8, name: 'Wrapped BTC', symbol: 'WBTC' },
    { id: 'btc:native', chain: 'btc', address: 'native', decimals: 8, name: 'Bitcoin', symbol: 'BTC' },
    ...Array.from({ length: extra }, (_, i) => ({ id: 'poly:' + addr(0x100 + i), chain: 'poly', address: addr(0x100 + i),
      decimals: 18, name: 'T' + i, symbol: 'T' + i })),
  ]
  const registry = new Registry(store, { assets, chains: [chain], exchanges: [] })
  const requests = []
  let now = initial
  const rpc = {
    budget: new RequestBudget(profile, undefined, () => now),
    call: async (_, method, [arg]) => {
      requests.push({ method, arg })
      if (method === 'eth_getBlockByNumber') return { number: '0x64', timestamp: '0x' + Math.floor(now / 1000).toString(16) }
      assert.equal(method, 'eth_call')
      return aggregate(arg.data, rpc.answer ?? (() => data(0)))
    },
  }
  const open = () => new EvmSource({ store, registry, chain, rpc, clock: () => now, publish: () => {}, discover: () => {} })
  return { store, registry, rpc, open, requests, advance: ms => { now += ms }, now: () => now }
}

test('seed value takes the coin ticker rank; the plan probes WBTC before an address-earlier unranked token', t => {
  const f = fixture(t)
  f.registry.assets.get('btc:native').rank = 1
  const value = seedValue(f.registry)
  assert.equal(value(f.registry.assets.get('poly:' + WBTC)), 1)
  assert.equal(value(f.registry.assets.get('poly:' + EARLY)), Infinity)
  const source = f.open()
  const plan = seedPlan(source)
  const index = token => plan.pairs.findIndex(pair => pair.includes(token))
  assert.ok(index(WBTC) < index(EARLY), 'WBTC first')
  assert.equal(plan.ranked, 1)
  // Quote pairs and the top tokens (normal: 40) form the priority prefix: here every pair.
  assert.equal(plan.hot, plan.pairs.length * plan.methods.length)
})

test('a seed page batches up to 256 probes into two 128-call lookups and paces the priority prefix', async t => {
  const f = fixture(t, { extra: 300 })
  const source = f.open()
  assert.equal(source.seedDelay(), 10_000)
  await source.seed()
  const calls = f.requests.filter(r => r.method === 'eth_call')
  assert.equal(calls.length, 2, 'two lookup multicalls, nothing found')
  assert.equal(f.store.getSetting('engine-seed/poly').next, 256)
  // The prefix (USDC and the top 40 tokens, one method each) fit in that page: back to one page per period.
  assert.equal(source.plan.hot, 40)
  assert.equal(source.seedHot, false)
  assert.equal(source.seedDelay(), 90_000)
})

test('hot pacing yields once seed pages spent a quarter of the profile minute budget', async t => {
  // 40 hot tokens x 200 fee tiers: a prefix of ~31 pages.
  const f = fixture(t, { extra: 60, tiers: Array.from({ length: 199 }, (_, i) => 100 + i) })
  const source = f.open()
  // Other jobs' use of the budget does not stop the seeder's share.
  for (let i = 0; i < 200; i++) f.rpc.budget.take()
  assert.equal(source.seedDelay(), 10_000)
  // normal: 240/min -> 60 seed lookups (two per 256-probe page, nothing found) per minute.
  for (let i = 0; i < 29; i++) await source.seed()
  assert.equal(source.seedDelay(), 10_000)
  await source.seed()
  assert.equal(source.seedHot, true)
  assert.equal(source.seedDelay(), 90_000)
  f.advance(60_000)
  assert.equal(source.seedDelay(), 10_000)
})

test('a fresh plan is rebuilt by value once ranks arrive; answered probes are not requested again', async t => {
  const f = fixture(t, { profile: 'small' })
  const source = f.open()
  await source.seed()
  const first = f.requests.filter(r => r.method === 'eth_call').length
  assert.equal(first, 1, 'all four probes in one page')
  f.registry.assets.get('btc:native').rank = 1
  f.advance(61_000)
  await source.seed()
  assert.ok(source.plan.ranked === 1)
  assert.equal(f.requests.filter(r => r.method === 'eth_call').length, first, 'memoized probes cost nothing')
  // A restart keeps the cursor and the memo: no lookup repeats inside the 6 h retry window.
  const restarted = f.open()
  await restarted.seed()
  assert.equal(f.requests.filter(r => r.method === 'eth_call').length, first)
})

test('public RPC gateways get provider defaults; documented limits win; unknown hosts keep 12/min', () => {
  assert.equal(endpointRate('https://polygon-bor-rpc.publicnode.com', undefined), 120)
  assert.equal(endpointRate('https://polygon.drpc.org', undefined), 120)
  assert.equal(endpointRate('https://poly.api.pocket.network', undefined), 120)
  assert.equal(endpointRate('https://polygon.gateway.tenderly.co', undefined), 60)
  assert.equal(endpointRate('https://rpc.example.org', undefined), 12)
  assert.equal(endpointRate('https://evil.publicnode.com.example.org', undefined), 12)
  assert.equal(endpointRate('https://arbitrum.api.onfinality.io/public', '10 requests per minute (OnFinality)'), 10)
  assert.equal(endpointRate('https://polygon.drpc.org', '30 requests per minute'), 30)
  assert.equal(rateLimit(undefined), 12)
  // The bucket keeps half of the assumed rate, spaced evenly (no burst): one request per second at 120/min.
  let now = 0
  const bucket = new EndpointBucket(endpointRate('https://x.publicnode.com'), () => now)
  const budget = new RequestBudget('large', undefined, () => now)
  bucket.take(budget)
  now += 999
  assert.throws(() => bucket.take(budget), RateLimited)
  now += 1
  bucket.take(budget)
})

test('waiting reads hold at most half an endpoint bucket; scanner reads still get the rest', () => {
  let now = 0
  const budget = new RequestBudget('large', undefined, () => now)
  const bucket = new EndpointBucket(24, () => now) // 12 per minute, one per 5 s
  let waiting = 0, scanner = 0
  for (; now < 60_000; now += 5_000) {
    try { bucket.take(budget, 1, true); waiting++; continue } catch (error) { assert.ok(error instanceof RateLimited) }
    bucket.take(budget, 1, false)
    scanner++
  }
  assert.equal(waiting, 6)
  assert.equal(scanner, 6)
})

test('the RPC client charges risk-style waiting batches to the waiting share, plain calls not', async () => {
  let now = 0
  const sent = []
  const rpc = new RpcClient({
    endpoints: { poly: [{ url: 'https://a.example', rpm: 8 }] }, clock: () => now,
    budget: new RequestBudget('large', undefined, () => now),
    sleep: async ms => { now += ms },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body)
      sent.push(now)
      return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x1' })
    },
  })
  // 4 per minute: a waiting reader gets two slots per minute, then sleeps past the minute for the third.
  for (let i = 0; i < 3; i++) await rpc.batch('poly', [{ method: 'eth_blockNumber', params: [] }])
  assert.deepEqual(sent, [0, 15_000, 60_000])
  const bucket = rpc.buckets.get('https://a.example')
  assert.equal(bucket.waitingCost, 2)
  now = 75_000
  await rpc.call('poly', 'eth_blockNumber', [])
  // The charge from 15 s expired; the plain call counts toward the bucket, not the waiting share.
  assert.equal(bucket.waitingCost, 1)
  assert.equal(bucket.cost, 2)
})

test('one turn in eight goes to the longest-waiting price scanner despite many older maintenance jobs', async () => {
  let now = 1_000_000
  const scheduler = new Scheduler({ clock: () => now, random: () => 0.99, coverage: () => 0 })
  const ran = []
  for (let i = 0; i < 50; i++) scheduler.add({ id: 'supply:' + i, interval: 1, run() { ran.push('supply') } })
  let seededAt = null
  scheduler.add({ id: 'evm:poly:seed', lane: 'scanner', interval: () => 10_000, run() { ran.push('seed'); seededAt = now } })
  // Make every maintenance job older than the scanner.
  for (const job of scheduler.jobs.values()) job.last = job.id.startsWith('supply:') ? 0 : now - 1
  for (let i = 0; i < 8; i++) { await scheduler.runOne(); now += 1 }
  assert.deepEqual(ran.filter(r => r === 'seed'), ['seed'])
  // The job paces itself through its interval function.
  assert.equal(scheduler.jobs.get('evm:poly:seed').next, seededAt + 10_000)
})

test('state refresh reads the deepest pools first and also runs while the decode queue is busy', async t => {
  const f = fixture(t, { profile: 'small' })
  const pools = Array.from({ length: 40 }, (_, i) => addr(0x500 + i))
  for (const [i, pool] of pools.entries())
    f.registry.pool({ chain: 'poly', pool, token0: EARLY, token1: QUOTE, dex: 'v2', kind: 'v2', firstSeen: f.now() },
      { token0: { decimals: 18 }, token1: { decimals: 6 } })
  const deep = pools.at(-1)
  f.store.writer.prepare('UPDATE pools SET liquidity=? WHERE pool=?').run(5_000_000, deep)
  const source = f.open()
  // A busy chain: a queued log that never decodes successfully.
  f.store.writer.prepare("INSERT INTO engine_logs VALUES ('poly',99,0,?,1)").run(JSON.stringify({ topics: ['0x00'] }))
  const read = []
  f.rpc.answer = (to, input) => { if (input === '0x0902f1ac') read.push(to); return data(0) }
  await source.scheduledState().catch(() => {})
  assert.equal(read.length, 32, 'one multicall of 32 pools')
  assert.equal(read[0], deep, 'deepest pool first although its address sorts last')
  read.length = 0
  await source.scheduledState().catch(() => {})
  assert.equal(read.length, 0, 'next refresh waits a period')
})

test('a refused price scanner reserves a quarter of the profile budget for a minute', async () => {
  let now = 0
  const budget = new RequestBudget('normal', undefined, () => now)
  for (let i = 0; i < 240; i++) { budget.take(); now += 100 } // other jobs spend the whole minute
  // A scanner is refused while the minute is full, which starts the reserve.
  await assert.rejects(budget.scanner(async () => budget.take()), RateLimited)
  now = 60_000 + 100 * 60 // 60 requests expired
  assert.throws(() => budget.take(), RateLimited, 'others capped at 180 while the reserve holds')
  for (let i = 0; i < 60; i++) await budget.scanner(async () => budget.take())
  assert.equal(budget.used, 240)
  now += 120_000
  for (let i = 0; i < 240; i++) budget.take() // reserve expired with no refused scanner
  assert.equal(budget.used, 240)
})
