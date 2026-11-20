// Found pools must show (11-20, WP-evmcov2): a funded pool's token leaves dust once one swap is decoded, so a tracked
// pool looks back for its newest swap once; plus the related visibility fixes below.
import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { loadBundle } from '@gator/bundle'
import { openStore } from '@gator/store'
import { Engine, migrations } from '../src/index.js'
import { word } from '../src/sources/evm-abi.js'
import { RateLimited } from '../src/scheduler/index.js'

const DAY = 86400_000
const address = n => '0x' + word(n).slice(-40)
const start = Date.UTC(2026, 10, 20)

function node(t, profile = 'small') {
  const bundle = loadBundle(), store = openStore({ file: ':memory:', migrations, profile })
  const transport = Object.assign(new EventEmitter(), { publicKey: word(1), channels: () => [], join: async () => true,
    leave: async () => true, send: () => true, peerCount: () => 0 })
  let now = start
  const engine = new Engine({ store, bundle, transport, profile, clock: () => now, backgroundJobs: [],
    patches: { patchFeed: false }, rpcConfig: { fetch: () => assert.fail('unexpected upstream request') } })
  t.after(async () => { await engine.stop(); store.close() })
  return { engine, store, advance: ms => { now += ms }, now: () => now }
}

function v2Pools(engine, count, liquidity = 100_000) {
  const source = engine.evm.get('bsc')
  const deploy = source.chain.deployments.find(d => d.kind === 'v2')
  const [token0, token1] = source.quotes.keys()
  return Array.from({ length: count }, (_, i) => engine.registry.pool({
    chain: 'bsc', pool: address(100 + i), dex: deploy.name, kind: deploy.kind,
    token0, token1, firstSeen: start, liquidity: liquidity - i,
  }, {}, false).id.split(':')[2])
}

function swapLog(source, pool, block, idx) {
  const topic = Object.values(source.chain.events)
    .find(e => e.signature === 'Swap(address,uint256,uint256,uint256,uint256,address)').topic
  const hash = '0x' + word(block * 100 + idx)
  return { address: pool, blockHash: hash, blockNumber: '0x' + block.toString(16), transactionHash: hash,
    logIndex: '0x' + idx.toString(16), topics: [topic, hash, hash],
    data: '0x' + [10n ** 19n, 0, 0, 2n * 10n ** 19n].map(word).join('') }
}

const tracked = (source, now) => source.tracked.all(now - DAY, now - 3600_000, 'bsc', source.limits.tracked)

test('a funded tracked pool without a swap looks back once, newest chunk first, and enqueues only its newest swap', async t => {
  const { engine, store, advance, now } = node(t), source = engine.evm.get('bsc')
  const [pool, empty] = v2Pools(engine, 2)
  const { dex, kind, token0, token1 } = source.poolInfo.get('bsc', pool)
  const thin = address(200), fresh = address(201)
  for (const [p, liquidity] of [[thin, 5_000], [fresh, 900_000]])
    engine.registry.pool({ chain: 'bsc', pool: p, dex, kind, token0, token1, firstSeen: start, liquidity }, {}, false)
  const head = 1_000_000
  // The thin pool is below the $10k floor; the fresh one was never scanned (its first scan starts at the head).
  for (const p of [pool, empty, thin]) source.trackCursor.run('bsc', p, head, now())
  const calls = []
  source.rpc.call = async (_, method, [filter]) => {
    assert.equal(method, 'eth_getLogs')
    calls.push({ from: +filter.fromBlock, to: +filter.toBlock, address: filter.address })
    if (calls.length === 1) return []
    return [swapLog(source, pool, head - 1000, 1), swapLog(source, pool, head - 600, 3), swapLog(source, pool, head - 600, 2)]
  }
  await source.lookback(tracked(source, now()))
  const first = 4 * source.chain.range
  assert.deepEqual(calls.map(c => [c.from, c.to]), [[head - first + 1, head]])
  assert.deepEqual([...calls[0].address].sort(), [pool, empty].sort(), 'funded pools only, deepest first')
  await source.lookback(tracked(source, now()))
  assert.equal(calls.length, 1, 'one call per max(15 s, hot interval)')
  advance(source.limits.hotInterval)
  await source.lookback(tracked(source, now()))
  assert.deepEqual([calls[1].from, calls[1].to], [head - 3 * first + 1, head - first], 'walks back, doubling, no overlap')
  assert.deepEqual(store.reader.prepare('SELECT block,idx FROM engine_logs WHERE chain=?').all('bsc').map(r => ({ ...r })),
    [{ block: head - 600, idx: 3 }], 'only the newest swap is queued')
  assert.deepEqual(calls[1].address, [pool, empty])
  advance(source.limits.hotInterval)
  await source.lookback(tracked(source, now()))
  assert.deepEqual(calls[2].address, [empty], 'a found pool leaves the look-back')

  // The decode turns the queued swap into 24 h turnover; the trades job never looks back at it again.
  source.rpc.call = async (_, method, [block]) => {
    assert.equal(method, 'eth_getBlockByNumber')
    return { number: block, hash: swapLog(source, pool, head - 600, 3).blockHash,
      timestamp: '0x' + Math.floor((now() - 3600_000) / 1000).toString(16) }
  }
  await source.state()
  assert.ok(source.recentTrade.get('dex:bsc:' + pool, now() - DAY))
})

test('the look-back ends after a day of blocks or three failures, survives a restart and never fails the scan', async t => {
  const { engine, advance, now } = node(t), source = engine.evm.get('bsc')
  const [pool] = v2Pools(engine, 1)
  source.trackCursor.run('bsc', pool, 50_000_000, now())
  let calls = 0, fail = null
  source.rpc.call = async () => {
    calls++
    if (fail) throw fail
    return []
  }
  fail = new RateLimited(now() + 2 * source.limits.hotInterval)
  await source.lookback(tracked(source, now()))
  advance(source.limits.hotInterval)
  await source.lookback(tracked(source, now()))
  assert.equal(calls, 1, 'a refused call waits for the budget')
  advance(source.limits.hotInterval)
  fail = new Error('response too large')
  for (let i = 0; i < 3; i++) {
    const span = source.lookbackJob.span
    await source.lookback(tracked(source, now()))
    if (source.lookbackJob) assert.equal(source.lookbackJob.span, Math.floor(span / 2))
    advance(source.limits.hotInterval)
  }
  assert.equal(source.lookbackJob, null, 'given up after three failures')
  assert.deepEqual(engine.store.getSetting('engine-lookback/bsc'), [pool])
  const before = calls
  await source.lookback(tracked(source, now()))
  assert.equal(calls, before, 'done pools are remembered')

  // A day of blocks without any swap: the walk ends.
  engine.store.setSetting('engine-lookback/bsc', [])
  fail = null
  calls = 0
  for (let i = 0; i < 100 && (i === 0 || source.lookbackJob); i++) {
    await source.lookback(tracked(source, now()))
    advance(source.limits.hotInterval)
  }
  assert.equal(source.lookbackJob, null)
  assert.ok(calls > 1 && calls < 100)
  assert.deepEqual(engine.store.getSetting('engine-lookback/bsc'), [pool])
})

test('reference-only top deployments ride along in every llama request, and a reference outlives one rotation', async t => {
  const { engine } = node(t)
  const job = engine.scheduler.jobs.get('api:llama-prices')
  assert.ok(job, 'bundle ships the llama reference')
  const assets = engine.catalog.assets.filter(a => a.address !== 'native').sort((a, b) => Number(b.stable) - Number(a.stable))
  // Rank BTC so every chain's WBTC deployment (no price of its own) gets a seed value of 1.
  const btc = [...engine.registry.assets.values()].find(a => a.symbol === 'BTC')
  btc.rank = 1
  const wbtc = assets.filter(a => a.symbol?.toUpperCase() === 'WBTC').map(a => a.id)
  assert.ok(wbtc.length > 3)
  const seen = new Map()
  const turns = Math.ceil(192 / 24)
  for (let i = 0; i < turns; i++) {
    const batch = engine.referenceBatch(assets, 32 * (40 + i), 32, true)
    assert.ok(batch.length <= 8 + 24 + 32, 'one request carries at most 64 coins')
    assert.equal(new Set(batch).size, batch.length)
    for (const a of batch) seen.set(a.id, (seen.get(a.id) ?? 0) + 1)
  }
  for (const id of wbtc) assert.ok(seen.get(id) >= 1, id + ' is re-read within ' + turns + ' requests')
  // A deployment with its own proven price leaves the rotation.
  engine.book.snapshots.set(wbtc[0], { why: { provenSources: 1 } })
  for (let i = 0; i < turns; i++)
    assert.ok(!engine.referenceBatch(assets, 0, 32, true).some(a => a.id === wbtc[0]) || assets.slice(0, 32).some(a => a.id === wbtc[0]))
  // Validity: one full rotation (assets / 32 per 30 s) plus 10 min, never below 10 min or above an hour.
  const rotation = Math.ceil(assets.length / 32) * 30_000
  assert.equal(engine.book.referenceValidity, Math.min(3_600_000, rotation + 600_000))
  assert.ok(engine.book.referenceValidity > rotation)
})

test('a reference read one rotation ago still anchors a live row', t => {
  const { engine, store, advance, now } = node(t)
  const asset = engine.catalog.assets.find(a => a.chain === 'polygon' && a.symbol?.toUpperCase() === 'WBTC')
  store.writer.prepare('INSERT INTO engine_references VALUES (?,?,?,?)').run(asset.id, 'llama-prices', 90_000, now())
  const rotation = engine.book.referenceValidity - 600_000
  advance(rotation)
  engine.book.dirty = true
  engine.book.refreshed = 0
  const p = engine.book.refresh().get(asset.id)
  assert.equal(p?.visibility, 'live')
  advance(600_001)
  engine.book.refreshed = 0
  assert.notEqual(engine.book.refresh().get(asset.id)?.visibility, 'live')
})

test('a small node gives price scanners one scheduler turn in four, a normal node one in eight', async t => {
  const { Scheduler } = await import('../src/scheduler/index.js')
  for (const [every, expected] of [[4, 4], [8, 2]]) {
    const scheduler = new Scheduler({ clock: () => 0, random: () => 0.5, coverage: () => 0, scannerEvery: every })
    const ran = []
    scheduler.add({ id: 'evm:poly:state', lane: 'scanner', interval: 0, run: async () => { ran.push('scanner') } })
    for (let i = 0; i < 20; i++) scheduler.add({ id: 'job' + i, interval: 0, relevance: 5, run: async () => { ran.push('other') } })
    for (let i = 0; i < 16; i++) await scheduler.runOne()
    assert.equal(ran.filter(r => r === 'scanner').length >= expected, true, every + ': ' + ran.join(','))
  }
  const { engine } = node(t, 'small')
  assert.equal(engine.scheduler.scannerEvery, 4)
})
