import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { loadBundle } from '@gator/bundle'
import { openStore } from '@gator/store'
import { Engine, migrations } from '../src/index.js'
import { seedPlan } from '../src/sources/evm.js'
import { word } from '../src/sources/evm-abi.js'
import { RateLimited } from '../src/scheduler/index.js'

const key = n => word(n)
const address = n => '0x' + word(n).slice(-40)
const start = Date.UTC(2026, 10, 19)
function node(t, own = 1, n = 7) {
  const bundle = loadBundle(), store = openStore({ file: ':memory:', migrations, profile: 'small' })
  t.after(() => store.close())
  const transport = Object.assign(new EventEmitter(), { publicKey: key(own) })
  let now = start
  const engine = new Engine({ store, bundle, transport, profile: 'small', clock: () => now,
    rpcConfig: { fetch: () => assert.fail('unexpected upstream request') } })
  const standing = store.writer.prepare('INSERT OR REPLACE INTO engine_standing VALUES (?,?,?,1)')
  const seen = store.writer.prepare('INSERT OR REPLACE INTO store_reporters_seen VALUES (?,?)')
  function peer(i, agreements = 3, last = now) {
    standing.run(key(i), agreements, last)
    seen.run(key(i), last)
  }
  for (let i = 1; i <= n; i++) if (i !== own) peer(i)
  return { engine, store, peer, advance: ms => { now += ms } }
}

function pools(engine, count, hinted = true) {
  const source = engine.evm.get('bsc')
  const deploy = source.chain.deployments.find(d => d.kind === 'v2')
  const [token0, token1] = source.quotes.keys()
  return Array.from({ length: count }, (_, i) => engine.registry.pool({
    chain: 'bsc', pool: address(100 + i), dex: deploy.name, kind: deploy.kind,
    token0, token1, firstSeen: start, liquidity: 100_000 - i,
  }, {}, hinted).id)
}

test('membership counts recent proven signers once, drops muted/weightless peers and expires locally', t => {
  const { engine, store, peer, advance } = node(t, 1, 1)
  peer(2); peer(3); peer(4); peer(5, 2); peer(6, 3, start - 31 * 60_000); peer(7); peer(8)
  store.upsertReporter({ key: key(7), mutedUntil: start + 60_000 })
  store.upsertReporter({ key: key(8), weight: 0 })
  const coverage = engine.dexCoverage
  assert.deepEqual(coverage.members().peers, [2, 3, 4].map(key))
  advance(31 * 60_000)
  assert.equal(coverage.members().size, 1)
})

test('one to three signers preserve the legacy seed plan, tracked pool priorities and state pages', async t => {
  const { engine, peer, advance } = node(t, 1, 1), source = engine.evm.get('bsc')
  const ids = pools(engine, 50, false)
  const legacy = seedPlan({ ...source, coverage: null })
  for (const n of [1, 2, 3]) {
    if (n > 1) peer(n)
    advance(300_000)
    assert.deepEqual(seedPlan(source), legacy)
    assert.equal(engine.dexCoverage.trades(source), null)
    const page = []
    source.readPoolState = async (rows, rpc) => {
      assert.equal(rpc, source.rpc)
      page.push(...rows.map(p => 'dex:bsc:' + p.pool))
    }
    await source.refreshState()
    assert.deepEqual(page, ids.slice(8 * (n - 1), 8 * n))
  }
  peer(4)
  advance(60_000)
  assert.notDeepEqual(seedPlan(source).pairs, legacy.pairs)
})

test('scheduled EVM state reads cover assigned verified hints via public RPC and retry a deferred page', async t => {
  const { engine, advance } = node(t), source = engine.evm.get('bsc')
  const ids = pools(engine, 120)
  const idsRead = [], job = engine.scheduler.jobs.get('evm:bsc:state')
  source.readPoolState = async (rows, rpc) => {
    assert.equal(rpc, source.rpc.publicOnly)
    idsRead.push(rows.map(p => p.id))
    if (idsRead.length === 1) throw new RateLimited(start + 1)
  }
  assert.equal(job.ready(), true)
  await assert.rejects(job.run(), RateLimited)
  await job.run()
  assert.deepEqual(idsRead[0], idsRead[1])
  advance(source.limits.period)
  await job.run()
  const plan = engine.dexCoverage.plan('bsc', 'state', () => true)
  assert.ok(idsRead.flat().every(id => ids.includes(id)))
  assert.ok(idsRead.flat().some(id => plan.tail.some(p => p.id === id)))
  assert.ok(idsRead[2].some(id => !idsRead[1].includes(id)))
})

test('trade scans and block decoding for registered peer-origin pools stay on public endpoints', async t => {
  const { engine, store } = node(t), source = engine.evm.get('bsc')
  const [id] = pools(engine, 1)
  const p = source.poolInfo.get('bsc', id.split(':')[2])
  const topic = Object.values(source.chain.events).find(e => e.signature === 'Swap(address,uint256,uint256,uint256,uint256,address)').topic
  source.rpc.call = () => assert.fail('used a configured endpoint')
  const hash = '0x' + key(90), height = '0x62'
  const calls = []
  source.rpc.publicOnly.call = async (_, method) => {
    calls.push(method)
    if (method === 'eth_blockNumber') return '0x64'
    if (method === 'eth_getBlockByNumber') return { number: height, hash, timestamp: '0x' + (start / 1000).toString(16) }
    if (method === 'eth_getLogs') return [{ address: p.pool, blockHash: hash, blockNumber: height,
      transactionHash: hash, logIndex: '0x0', topics: [topic, hash, hash],
      data: '0x' + [10n ** 19n, 0, 0, 2n * 10n ** 19n].map(word).join('') }]
    assert.fail(method)
  }
  const observations = []
  source.publish = rows => observations.push(...rows)
  const job = engine.scheduler.jobs.get('evm:bsc:trades')
  assert.equal(job.ready(), true)
  await job.run()
  await source.state()
  assert.deepEqual(calls, ['eth_blockNumber', 'eth_getLogs', 'eth_getBlockByNumber'])
  assert.equal(observations[0][0], id)
  assert.ok(+observations[0][2] > 0)
  assert.equal(store.reader.prepare('SELECT fromHint FROM engine_market_data WHERE market=?').get(id).fromHint, 1)
})
