import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { loadBundle } from '@gator/bundle'
import { openStore } from '@gator/store'
import { Engine, migrations } from '../src/index.js'
import { ReporterSlice } from '../src/coverage/split.js'
import { BACKFILL_JOB, HistoryBudget } from '../src/coverage/backfill.js'
import { historyRanges, logPage, PAGE_SIZE } from '../src/coverage/factory-history.js'
import { EndpointBucket, RateLimited, RequestBudget } from '../src/scheduler/index.js'
import { RpcError } from '../src/rpc/index.js'
import { word } from '../src/sources/evm-abi.js'
import { poolLedger, historyBundle } from './fixtures/pool-history.js'

const key = i => word(i)
function node(t, bundle = loadBundle()) {
  const store = openStore({ file: ':memory:', profile: 'normal', migrations })
  const transport = Object.assign(new EventEmitter(), { publicKey: key(1), send: () => true })
  const engine = new Engine({ bundle, store, transport, backgroundJobs: [], patches: { patchFeed: false },
    rpcConfig: { fetch: () => assert.fail('unexpected upstream request') } })
  t.after(() => store.close())
  return { engine, store, backfill: engine.backfill }
}

test('all twenty shipped EVM chains plan stable ranges for the seven factory protocols', t => {
  const { backfill, engine } = node(t)
  assert.equal(new Set(backfill.tasks.map(t => t.source.chain.id)).size, engine.evm.size)
  const kinds = new Set(backfill.tasks.map(t => t.factory.kind))
  assert.deepEqual([...kinds].sort(), ['pancake-v3','slipstream','solidly-v1','v2','v3','v4','velodrome-v2'])
  assert.ok(backfill.tasks.every(t => t.factory.topics.length > 0))
  for (const mode of ['index','logs']) {
    const ranges = historyRanges('c','f',mode,525_000_123).sort((a,b) => a.start - b.start)
    assert.equal(ranges[0].start, 0)
    assert.equal(ranges.at(-1).end, 525_000_123)
    for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i].start, ranges[i-1].end)
    const newer = historyRanges('c','f',mode,527_000_000)
    assert.ok(ranges.every(r => newer.some(n => n.key === r.key && n.end >= r.end)))
    assert.ok(historyRanges('c','f',mode,Number.MAX_SAFE_INTEGER).length < 6144)
  }
  const keys = Array.from({ length: 20 }, (_,i) => key(i + 1))
  for (const n of [1,3,7,20]) {
    const members = keys.slice(0,n).map(k => new ReporterSlice(k, keys.slice(0,n)))
    for (const r of historyRanges('polygon','factory','index',100_000))
      assert.equal(members.filter(m => m.priority(r.key) !== null).length, Math.min(3,n))
  }
})

test('block range refusals halve without skipping, dense blocks resume after the last log index', async t => {
  const bundle = historyBundle(), { backfill } = node(t,bundle)
  const task = backfill.tasks[0], ledger = poolLedger(bundle, Date.now())
  const logs = Array.from({length: PAGE_SIZE + 9}, (_,i) => ledger.log(i + 1)).reverse()
  const ranges = []
  const rpc = { async call(chain,method,[f]) {
    assert.equal(method, 'eth_getLogs')
    assert.equal(f.address, task.factory.address)
    ranges.push([Number(f.fromBlock), Number(f.toBlock)])
    if (ranges.length === 1) throw new RpcError('range', { kind: 'range' })
    if (ranges.length === 4) throw new RateLimited(99)
    return logs
  } }
  const query = { ...task, rpc, from: 100, end: 116, span: 16 }
  assert.deepEqual(await logPage(query), { retrySpan: 8 })
  const first = await logPage({ ...query, span: 8 })
  assert.equal(first.pools.length, PAGE_SIZE)
  assert.equal(first.next, 100)
  const second = await logPage({ ...query, from: first.next, after: first.after, span: 8 })
  assert.equal(second.next, 108)
  assert.deepEqual(first.pools.concat(second.pools).map(p => p.idx), Array.from({length: logs.length}, (_,i) => i+1))
  await assert.rejects(logPage(query), RateLimited)
  assert.deepEqual(ranges, [[100,115],[100,107],[100,107],[100,115]])
})

test('idle dispatches have a shared five-percent rolling limit and leave foreground budget and endpoint slots', t => {
  let now = 0
  const parent = new RequestBudget('small',60,() => now), history = new HistoryBudget(parent,() => now)
  const endpoint = new EndpointBucket(120, () => now)
  for (let i = 0; i < 3; i++) { endpoint.take(history); now += 1000 }
  assert.throws(() => endpoint.take(history), RateLimited)
  assert.equal(parent.used, 3)
  endpoint.take(parent)
  assert.equal(parent.used, 4)
  now = 60_000
  assert.equal(history.retryAt(), 0)
  parent.setLimit(19)
  assert.throws(() => history.take(), RateLimited)
  parent.setLimit(60)
  for (let i = parent.used; i < 30; i++) parent.take()
  assert.throws(() => history.take(), RateLimited)
  const { engine } = node(t)
  const scheduler = engine.scheduler
  scheduler.backgroundJobs = new Set([BACKFILL_JOB, 'evm:ethereum:logs'])
  assert.equal(scheduler.choose().id, 'evm:ethereum:logs')
  scheduler.jobs.get('evm:ethereum:logs').next = Infinity
  assert.equal(scheduler.choose(false), null)
  assert.equal(scheduler.choose().id, BACKFILL_JOB)
})

test('the archived bounds and unit cursor survive changes to reporter membership', t => {
  const { engine, store, backfill } = node(t)
  const task = backfill.tasks.find(t => t.source.chain.id === 'polygon' && t.factory.kind === 'v2')
  const { factory } = task
  task.bounds = { mode: 'index', end: 10_000, at: Date.now() }
  store.setSetting(task.key, task.bounds)
  backfill.mark.run('polygon', factory.address, 'index', 0, PAGE_SIZE, -1, 500, Date.now())
  backfill.mark.run('polygon', factory.address, 'index', PAGE_SIZE, PAGE_SIZE+3, -1, 500, Date.now())
  assert.equal(backfill.plan(task).ranges[0].next, PAGE_SIZE+3)
  const keys = Array.from({length:7}, (_,i) => key(i+1))
  engine.dexCoverage.members = () => new ReporterSlice(key(1),keys)
  const split = backfill.plan(task).ranges
  assert.ok(split.length > 0)
  assert.ok(split.every(r => engine.dexCoverage.members().priority(r.key) !== null && r.start !== 0))
  engine.dexCoverage.members = () => new ReporterSlice(key(1),[])
  assert.equal(backfill.plan(task).ranges[0].next, PAGE_SIZE+3)
})
