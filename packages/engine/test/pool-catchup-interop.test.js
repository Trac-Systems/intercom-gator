import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createMemoryHub, MemoryTransport } from '@gator/net'
import { Engine, migrations } from '../src/index.js'
import { CATCHUP_JOB, POOL_CHANNEL } from '../src/intel/pool-catchup.js'
import { RateLimited } from '../src/scheduler/index.js'
import { openStore } from './store-fixture.js'
import { historyBundle, poolLedger } from './fixtures/pool-history.js'

// GATOR_V010_DIR can point at a git archive of ae1c336. The default exercises the same
// unjoined-channel gate in the unchanged vendored Intercom transport without requiring Git.
const legacyDir = process.env.GATOR_V010_DIR
const released = path => import(pathToFileURL(resolve(legacyDir, 'packages', path)))
async function until(predicate) {
  const end = performance.now() + 5000
  while (!await predicate()) {
    if (performance.now() > end) assert.fail('Timed out waiting for a signed frame')
    await delay(20)
  }
}

test('signed pool-history traffic stays off the v0.1.0 channels over a shared connection', async t => {
  const hub = createMemoryHub(), bundle = historyBundle(), ledger = poolLedger(bundle, Date.now() - 60_000)
  let now = Date.now()
  const clock = () => now
  const legacyNet = legacyDir ? await released('net/src/index.js') : { MemoryTransport }
  const legacy = new legacyNet.MemoryTransport({ hub }), endpoints = []
  let oldEngine
  if (legacyDir) {
    const old = await released('engine/src/index.js')
    const store = openStore({ file: ':memory:', migrations: old.migrations })
    oldEngine = new old.Engine({ store, transport: legacy, bundle, clock, backgroundJobs: [],
      rpcConfig: { fetch: ledger.fetch, retries: 0 }, patches: { patchFeed: false } })
    endpoints.push(oldEngine)
    assert.throws(() => legacyNet.policyFor(POOL_CHANNEL))
    await oldEngine.start()
  } else await legacy.join('gator/new')
  t.after(async () => {
    for (const e of endpoints) {
      await e.stop()
      e.store.close()
      await e.transport.close()
    }
    if (!oldEngine) await legacy.close()
  })
  assert.ok(!legacy.channels().includes(POOL_CHANNEL))
  async function modern(seed) {
    const store = openStore({ file: ':memory:', migrations, profile: 'large' })
    const transport = new MemoryTransport({ hub })
    const engine = new Engine({ store, transport, bundle, clock, backgroundJobs: [CATCHUP_JOB],
      rpcConfig: { fetch: ledger.fetch, retries: 0 }, patches: { patchFeed: false } })
    endpoints.push(engine)
    if (seed) await ledger.seed(engine, 1)
    await engine.start()
    await engine.catchup.membership
    clearInterval(engine.catchup.timer)
    clearTimeout(engine.timer)
    return engine
  }
  const receiver = await modern(false)
  for (let i = 0; i < 3; i++) {
    now += 20_000
    receiver.catchup.tick()
    await receiver.scheduler.runOne()
  }
  assert.deepEqual(receiver.catchup.state.peers, [])
  assert.equal(receiver.catchup.waiting, undefined)
  assert.deepEqual(ledger.receipts, [])
  const sender = await modern(true)
  const seen = [], errors = [], wire = []
  legacy.on('message', (ch, e) => seen.push([ch,e.message.t]))
  oldEngine?.on('sourceError', e => errors.push(e))
  await until(() => {
    if (seen.length) return true
    sender.transport.send('gator/new', { t: 'listing', v: 1, exchange: 'bitstamp', symbol: 'BTC-USD', firstSeen: now })
  })
  assert.equal(legacy.peerCount(), 2)
  const prior = oldEngine?.hints.rank(sender.transport.publicKey)
  seen.length = 0
  sender.transport.on('message', (ch, env) => { if (ch === POOL_CHANNEL) wire.push(env) })
  // Bound logging checks to the protocol exchange, after the normal channel handshakes.
  const logs = ['log','warn','error'].map(name => t.mock.method(console, name, () => {}))
  try {
    await until(() => {
      if (receiver.catchup.state.peers.length) return true
      sender.catchup.send('offer')
    })
    receiver.catchup.tick()
    await until(() => receiver.catchup.state.page)
    for (let i = 0; i < 10 && !receiver.catchup.state.count; i++) {
      now += 1000
      try { await receiver.scheduler.runOne() } catch (e) { if (!(e instanceof RateLimited)) throw e }
    }
    assert.equal(receiver.catchup.state.count, 1)
    assert.ok(receiver.registry.markets.has('dex:ethereum:' + ledger.record(1).pool))
    assert.ok(wire.some(env => env.message.t === 'page' && env.pow.difficulty === 10 && env.sig))
    assert.deepEqual(seen, [])
    assert.deepEqual(errors, [])
    if (oldEngine) {
      assert.equal(oldEngine.hints.rank(sender.transport.publicKey), prior)
      assert.equal(oldEngine.hints.size, 0)
      assert.equal(oldEngine.book.muted(sender.transport.publicKey), false)
    }
    for (const log of logs) assert.equal(log.mock.callCount(), 0)
  } finally { for (const log of logs) log.mock.restore() }
  sender.transport.send('gator/new', { t: 'listing', v: 1, exchange: 'bitstamp', symbol: 'ETH-USD', firstSeen: now })
  await until(() => seen.length)
  assert.deepEqual(seen, [['gator/new','listing']])
})
