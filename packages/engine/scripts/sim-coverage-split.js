// Offline hour of price reads. Run from the checkout root: node packages/engine/scripts/sim-coverage-split.js [profile] [nodes...] [--rpm=N] [--legacy]
import assert from 'node:assert/strict'
import { hash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { loadBundle } from '@gator/bundle'
import { openStore } from '@gator/store'
import { Engine, migrations } from '../src/index.js'
import { BUDGETS, RateLimited } from '../src/scheduler/index.js'
import { fetchSolana } from '../src/sources/solana.js'
import { word } from '../src/sources/evm-abi.js'
import { ownerCounts } from '../test/fixtures/coverage-pools.js'

const [profile = 'normal', ...args] = process.argv.slice(2)
assert.ok(Object.hasOwn(BUDGETS, profile))
const legacy = args.includes('--legacy')
const rpm = Number(args.find(a => a.startsWith('--rpm='))?.slice(6) ?? BUDGETS[profile])
assert.ok(Number.isInteger(rpm) && rpm > 0 && rpm <= BUDGETS[profile])
const runs = args.filter(a => !a.startsWith('--'))
const sizes = runs.length ? runs.map(Number) : [1, 3, 7, 20, 100]
assert.ok(sizes.every(n => Number.isInteger(n) && n >= 1 && n <= 100))
const stamp = Date.UTC(2026, 10, 19), minute = 60_000, duration = 60 * minute
const reporter = i => hash('sha256', 'coverage-fixture/node/' + i)
const bundle = loadBundle(), inventory = new Map(), directories = new Map()
const venues = ['raydium', 'orca', 'meteora']
mkdirSync('.tmp', { recursive: true })
const dir = mkdtempSync('.tmp/coverage-sim-'), template = join(dir, 'template.db')

function makeEngine(file, index, clock, fetch) {
  const store = openStore({ file, profile, migrations })
  // These disposable replicas measure requests and prices, not disk durability or wall-clock throughput.
  store.writer.exec('PRAGMA synchronous=OFF')
  return new Engine({ bundle, store, clock, profile, transport: Object.assign(new EventEmitter(), { publicKey: reporter(index), send: () => true }),
    patches: { patchFeed: false }, rpcConfig: { requestsPerMinute: rpm, retries: 0, fetch } })
}

function buildFixture() {
  const engine = makeEngine(template, 0, () => stamp, () => assert.fail('unexpected request'))
  const { registry, store } = engine
  try {
    store.transaction(() => {
      // Model only the four EVM inventories for which the owner supplied counts. Signed factories, quotes and
      // token decimals are real. All other identities, depths, transactions and prices in the workload are synthetic.
      for (const [chain, { known }] of Object.entries(ownerCounts)) {
        const source = engine.evm.get(chain)
        const d = source.chain.deployments.find(d => d.kind === 'v2')
        const q = [...source.quotes.values()].find(q => ['USDC', 'USDG'].includes(q.symbol))
        const signed = engine.catalog.assets.filter(a => a.chain === chain && /^0x/.test(a.address) && a.address !== q.address)
        for (let i = 0; i < known; i++) {
          const pool = '0x' + hash('sha256', 'pool/' + chain + '/' + i).slice(0, 40)
          const token0 = signed[i]?.address ?? '0x' + hash('sha256', 'token/' + chain + '/' + i).slice(0, 40)
          const decimals = signed[i]?.decimals ?? 18, depth = 20_000 + 2 * (known - i)
          const p = { chain, pool, dex: d.name, kind: d.kind, token0, token1: q.address, liquidity: depth, firstSeen: stamp }
          const market = registry.pool(p, { token0: { decimals }, token1: q })
          // Each funded pool traded in the preceding day. Routine state reads carry its existing measured turnover.
          source.addTrade.run(market.id, 1, 0, stamp - minute, 100)
          inventory.set(pool, { reserves: word(BigInt(depth / 2) * 10n ** BigInt(decimals)) +
            word(BigInt(depth / 2) * 10n ** BigInt(q.decimals)) + word(0) })
        }
      }
      const assets = engine.catalog.assets.filter(a => a.chain === 'solana' && a.address !== 'native')
      const quotes = ['USDC','USDT'].map(symbol => assets.find(a => a.symbol === symbol))
      quotes.push({ address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9 })
      const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
      for (const [v, dex] of venues.entries()) {
        const list = []
        for (const a of assets) for (const b of quotes) {
          if (a.address === b.address) continue
          const i = list.length, pool = alphabet[v] + 'p'.repeat(31) + alphabet[Math.floor(i / 58)] + alphabet[i % 58]
          const p = { chain: 'solana', pool, dex, kind: 'pool', token0: a.address, token1: b.address,
            liquidity: 100_000 - i, firstSeen: stamp }
          registry.pool(p, { token0: a, token1: b })
          const raw = dex === 'raydium' ? { id: pool, mintA: a, mintB: b, price: 1, tvl: p.liquidity, day: { volume: 100 } } :
            dex === 'orca' ? { address: pool, tokenA: a, tokenB: b, price: 1, tvlUsdc: p.liquidity, stats: { '24h': { volume: 100 } } } :
            { address: pool, token_x: a, token_y: b, current_price: 1, tvl: p.liquidity, volume: { '24h': 100 } }
          list.push({ pool, raw })
        }
        directories.set(new URL(engine.catalog.apis.find(s => s.id === dex).url).origin, { dex, list,
          byId: new Map(list.map(p => [p.pool, p.raw])) })
      }
    })
  } finally { store.close() }
}

function directoryResponse(url) {
  const { dex, list, byId } = directories.get(url.origin)
  const ids = url.searchParams.get('ids')
  if (ids) return { data: ids.split(',').map(id => byId.get(id)) }
  const exact = byId.get(url.pathname.split('/').at(-1))
  if (exact) return dex === 'orca' ? { data: exact } : exact
  const page = Number(url.searchParams.get('page') ?? url.searchParams.get('next') ?? 1)
  const data = list.slice((page - 1) * 100, page * 100).map(p => p.raw)
  return dex === 'raydium' ? { data: { data } } : { data, meta: { cursor: { next: data.length === 100 ? String(page + 1) : null } } }
}

// Decode aggregate3's inner targets and return the fixture reserves. Count only published decoded prices.
function multicall(input) {
  assert.equal(input.slice(0, 10), '0x82ad56cb')
  const args = input.slice(10), num = pos => Number(BigInt('0x' + args.slice(pos, pos + 64)))
  const start = num(0) * 2, count = num(start), table = start + 64
  let offset = count * 32
  const offsets = [], bodies = []
  for (let i = 0; i < count; i++) {
    const tuple = table + num(table + 64 * i) * 2
    const pool = inventory.get('0x' + args.slice(tuple + 24, tuple + 64))
    const payload = pool.reserves
    offsets.push(word(offset))
    const body = word(1) + word(64) + word(payload.length / 2) + payload
    bodies.push(body)
    offset += body.length / 2
  }
  return '0x' + word(32) + word(count) + offsets.join('') + bodies.join('')
}

async function runNode(n, index, totals) {
  const file = join(dir, 'replica.db')
  copyFileSync(template, file)
  let now = stamp, rpc = 0, http = 0, peak = 0
  const fetch = (url, init) => {
    if (!init.body) { http++; return Response.json(directoryResponse(new URL(url))) }
    rpc++
    const { id, method, params } = JSON.parse(init.body)
    let result
    if (method === 'eth_call') result = multicall(params[0].data)
    else if (method === 'eth_getLogs') result = []
    else if (method === 'eth_getBlockByNumber') result = { number: '0x' + (100 + Math.floor((now - stamp) / 1000)).toString(16),
      timestamp: '0x' + Math.floor(now / 1000).toString(16) }
    else assert.fail(method)
    return Response.json({ jsonrpc: '2.0', id, result })
  }
  const engine = makeEngine(file, index, () => now, fetch)
  try {
    const seen = new Set(), jobs = [], db = engine.store.writer
    const observe = rows => {
      for (const [market, price, baseVol, usdVol] of rows) {
        assert.ok(Number(price) > 0 && (Number(baseVol) > 0 || Number(usdVol) > 0))
        seen.add(market)
      }
    }
    const active = db.prepare('INSERT OR REPLACE INTO store_reporters_seen VALUES (?,?)')
    function sightings() {
      for (let j = 0; j < n; j++) if (j !== index) active.run(reporter(j), now)
    }
    const standing = db.prepare('INSERT INTO engine_standing VALUES (?,3,?,1)')
    for (let j = 0; j < n; j++) if (j !== index) standing.run(reporter(j), now)
    sightings()
    for (const chain of Object.keys(ownerCounts)) {
      const source = engine.evm.get(chain)
      if (legacy) source.coverage = null
      source.publish = observe
      jobs.push({ run: () => source.refreshState(), period: source.limits.period, due: stamp },
        { run: () => source.trades(), period: source.limits.period, due: stamp })
    }
    for (const reader of engine.solanaReaders.values()) {
      reader.options.publish = observe
      jobs.push({ run: () => legacy ? fetchSolana(reader.options) : reader.run(), period: 30_000, due: stamp })
    }
    for (let elapsed = 0; elapsed < duration; elapsed += 1000) {
      now = stamp + elapsed
      if (elapsed % (15 * minute) === 0) sightings()
      for (const job of jobs) if (now >= job.due) {
        try { await job.run(); job.due = now + job.period }
        catch (e) {
          if (!(e instanceof RateLimited)) throw e
          job.due = Math.max(now + 1000, e.retryAt)
        }
        peak = Math.max(peak, engine.budget.used)
      }
    }
    for (const id of seen) totals.set(id, (totals.get(id) ?? 0) + 1)
    assert.equal(engine.budget.dispatches, rpc + http)
    assert.ok(peak <= engine.budget.limit)
    return { rpc, http, peak }
  } finally { engine.store.close() }
}

try {
  buildFixture()
  const universe = inventory.size + [...directories.values()].reduce((n, d) => n + d.list.length, 0)
  for (const n of sizes) {
    const totals = new Map(), costs = []
    for (let i = 0; i < n; i++) costs.push(await runNode(n, i, totals))
    const evm = [...totals.keys()].filter(id => !id.startsWith('dex:solana:')).length
    const histogram = { 0: universe - totals.size }
    for (const v of totals.values()) histogram[v] = (histogram[v] ?? 0) + 1
    const mean = field => +(costs.reduce((sum, node) => sum + node[field], 0) / n / 60).toFixed(2)
    console.log(JSON.stringify({ n, profile, rpm, legacy, universe, evm, solana: totals.size - evm, distinct: totals.size,
      reportersPerCoveredPool: +([...totals.values()].reduce((sum, v) => sum + v, 0) / totals.size).toFixed(2),
      histogram, rpcPerMinute: mean('rpc'), httpPerMinute: mean('http'), peakRollingMinute: Math.max(...costs.map(c => c.peak)) }))
  }
} finally { rmSync(dir, { force: true, recursive: true }) }
