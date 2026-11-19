import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { bundleDigest, loadBundle, validateBundle } from '@gator/bundle'
import { openStore } from '@gator/store'
import { Engine, migrations } from '../src/index.js'
import { createIntel, migrations as intelMigrations } from '../src/intel/index.js'
import { SupplyClaims } from '../src/sources/supply-claims.js'
import { channelFor } from '../src/obs/index.js'

// A v0.1.0 node next to a node with the TAP/TNK bundle. The engine's receive paths (obs, gator/new, gator/meta,
// focus) are unchanged since v0.1.0, so this engine running the v0.1.0 dataset is the v0.1.0 code path.
const tap = 'tap-protocol:native', tnk = 'trac:native'
const tapErc20 = 'ethereum:0x5e7f6e008c6d9d7ad4c7eb75bd4ce62864cc7454'
const pool = '0x1563e9af51616e78830de3325da752de369c1714'
const usdt = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const peer = 'b'.repeat(64)
const start = Date.UTC(2026, 10, 19, 21)

/** The shipped bundle without this release's TAP/TNK additions (what a v0.1.0 node knows). */
function v010Bundle() {
  const b = structuredClone(loadBundle())
  b.chains = b.chains.filter(c => !['tap-protocol', 'trac'].includes(c.id))
  b.tokens.tokens = b.tokens.tokens.filter(t => ![tap, tnk, tapErc20].includes(t.id))
  b.tokens.coinGroups = b.tokens.coinGroups.filter(g => g.id !== 'tap-protocol-tap')
  for (const e of b.exchanges) delete e.symbolMap
  return b
}

class Transport extends EventEmitter {
  publicKey = 'a'.repeat(64)
  topics = new Map()
  sent = []
  channels() { return [...this.topics.keys()] }
  async join(channel, policy) { this.topics.set(channel, policy); return true }
  async leave(channel) { return this.topics.delete(channel) }
  send(channel, message) { this.sent.push([channel, message]); return true }
}

async function node(t, bundle) {
  const transport = new Transport()
  const store = openStore({ file: ':memory:', profile: 'small', migrations: [...migrations, ...intelMigrations] })
  let now = start
  const engine = new Engine({ bundle, transport, store, clock: () => now, backgroundJobs: [], random: () => 0.5,
    rpcConfig: { bundleDigest: bundleDigest(bundle), fetch: () => assert.fail('Unexpected HTTP read'), timeout: 500,
      retries: 0, requestsPerMinute: 60 } })
  await engine.start()
  clearTimeout(engine.timer)
  const intel = createIntel({ engine, dailyMarket: () => [], sampleGlobal() {}, now: () => now })
  t.after(async () => { await intel.stop(); await engine.stop(); store.close() })
  const envelope = (channel, message) => ({ id: 'e' + Math.random(), channel, from: peer, ts: now, message })
  const deliver = (channel, message) => transport.emit('message', channel, envelope(channel, message))
  return { engine, store, transport, intel, envelope, deliver, now: () => now, advance: ms => { now += ms } }
}

const rows = at => [
  ['cex:gate:TAPPROTOCOL-USDT', '0.04393', '79097', '3495.79609', '0.04392', '0.04393', at],
  ['cex:gate:TNK-USDT', '0.07231', '20619', '1565.47168', '0.07259', '0.07274', at],
  ['dex:ethereum:' + pool, '0.04334', '120000', null, null, null, at],
]
const peerRows = store => store.writer.prepare('SELECT count(*) AS n FROM engine_latest WHERE reporter=?').get(peer).n
const strikes = store => store.writer.prepare('SELECT strikes,mutedUntil FROM reporters WHERE key=?').get(peer)

test('the v0.1.0-equivalent bundle knows none of the new identities and still validates', () => {
  const b = v010Bundle()
  assert.equal(b.chains.some(c => ['tap-protocol', 'trac'].includes(c.id)), false)
  assert.equal(b.exchanges.some(e => Object.hasOwn(e, 'symbolMap')), false)
  // The new schema accepts a bundle without venue maps, so v0.1.0 data (and its patches) still load.
  validateBundle(b)
  assert.notEqual(bundleDigest(b), bundleDigest(loadBundle()))
})

test('a v0.1.0 node quietly drops TAP/TNK observations from a new-release node and never penalises it', async t => {
  const { engine, store, deliver, now } = await node(t, v010Bundle())
  const newDigest = bundleDigest(loadBundle()).slice(0, 16)
  // 1. A different bundle digest: the whole batch is ignored before validation (DESIGN §5.2, obs.b).
  for (const row of rows(now())) deliver(channelFor(row[0]), { t: 'obs', v: 1, b: newDigest, at: now(), o: [row] })
  assert.equal(peerRows(store), 0)
  // 2. Even under the node's own digest, rows for markets its registry cannot resolve never reach the book.
  const own = engine.obs.digest
  for (const row of rows(now())) deliver(channelFor(row[0]), { t: 'obs', v: 1, b: own, at: now(), o: [row] })
  assert.equal(peerRows(store), 0)
  assert.equal(engine.registry.markets.has('dex:ethereum:' + pool), false)
  assert.equal(engine.registry.assets.has(tap), false)
  // 3. The node reads Gate itself: the labels stay unresolved, a peer's matching row is stored, no asset is priced.
  const gate = engine.registry.cex('gate', 'TAPPROTOCOL', 'USDT', 'TAPPROTOCOL_USDT')
  assert.equal(gate.base, 'unresolved:gate:TAPPROTOCOL')
  engine.publish([[gate.id, '0.04393', '79097', null, null, null, now()]])
  deliver(channelFor(gate.id), { t: 'obs', v: 1, b: own, at: now(), o: [rows(now())[0]] })
  assert.equal(peerRows(store), 1, 'delivery reaches the book once the market is known')
  engine.book.dirty = true
  engine.book.refresh()
  assert.equal(engine.book.snapshots.has(tap), false)
  assert.equal(strikes(store), undefined)
  assert.equal(engine.book.muted(peer), false)
})

test('a v0.1.0 node ignores TAP/TNK pool, listing, claim, risk and supply messages and focus requests', async t => {
  const { engine, store, intel, envelope, deliver, now } = await node(t, v010Bundle())
  const poolMsg = { t: 'pool', v: 1, chain: 'ethereum', pool, dex: 'uniswap-v2', kind: 'v2',
    token0: tapErc20.split(':')[1], token1: usdt, block: 15_000_000, tx: '0x' + '1'.repeat(64) }
  const listings = []
  engine.on('listingHint', h => listings.push(h))
  deliver('gator/new', poolMsg)
  deliver('gator/new', { t: 'listing', v: 1, exchange: 'gate', symbol: 'TAPPROTOCOL-USDT', firstSeen: now() })
  // The listing is an ordinary hint for a venue it knows; the pool waits for public receipt verification.
  assert.deepEqual(listings, [{ exchange: 'gate', symbol: 'TAPPROTOCOL-USDT' }])
  assert.equal(engine.registry.markets.has('dex:ethereum:' + pool), false)
  for (const asset of [tap, tnk]) {
    const meta = [
      { t: 'claim', v: 1, asset, kind: 'website', value: 'https://tapscope.io' },
      { t: 'claim', v: 1, asset, kind: 'supply', value: '21000000', method: 'tap-reader', at: now() },
      { t: 'risk', v: 1, asset, at: now(), flags: { ownerMint: false }, method: 'native' },
    ]
    for (const m of meta) {
      deliver('gator/meta', m)
      await intel.consume('gator/meta', envelope('gator/meta', m))
    }
    const supply = new SupplyClaims(engine)
    supply.receive('gator/meta', envelope('gator/meta', meta[1]))
    assert.equal(supply.hints.size, 0)
    assert.equal(store.getAsset(asset), undefined)
    assert.equal(store.getRisk(asset), undefined)
    await assert.rejects(engine.focus.set(asset), err => err.status === 400)
  }
  assert.equal(strikes(store), undefined)
  assert.equal(engine.book.muted(peer), false)
})

test('a new-release node equally drops v0.1.0 observations by digest, without penalty', async t => {
  const { store, deliver, now } = await node(t, loadBundle())
  const oldDigest = bundleDigest(v010Bundle()).slice(0, 16)
  for (const row of rows(now())) deliver(channelFor(row[0]), { t: 'obs', v: 1, b: oldDigest, at: now(), o: [row] })
  assert.equal(peerRows(store), 0)
  assert.equal(strikes(store), undefined)
})

test('a v0.1.0 node patched with the two chains and natives binds MEXC TAP and both TNK labels; Gate TAPPROTOCOL waits', async t => {
  // The 4-op patch an integrator can sign for v0.1.0 nodes (no symbolMap: v0.1.0's schema rejects it; no ERC-20 or coin
  // group: v0.1.0's group cap would fall back to the bridged share). Chains and tokens take effect at the next start.
  const shipped = loadBundle(), b = v010Bundle()
  b.chains.push(...['tap-protocol', 'trac'].map(id => structuredClone(shipped.chains.find(c => c.id === id))))
  const { coin, coinSupply, ...tapNative } = structuredClone(shipped.tokens.tokens.find(x => x.id === tap))
  b.tokens.tokens.push(tapNative, structuredClone(shipped.tokens.tokens.find(x => x.id === tnk)))
  validateBundle(b)
  const { engine } = await node(t, b)
  const { registry } = engine
  assert.equal(registry.cex('mexc', 'TAP', 'USDT').base, tap)
  assert.equal(registry.cex('mexc', 'TNK', 'USDT').base, tnk)
  assert.equal(registry.cex('gate', 'TNK', 'USDT').base, tnk)
  assert.equal(registry.cex('gate', 'TAPPROTOCOL', 'USDT').base, 'unresolved:gate:TAPPROTOCOL')
  assert.equal(registry.cex('gate', 'TRAC', 'USDT').base, 'ethereum:0xaa7a9ca87d3694b5755f213b5d04094b8d0f0a6f')
  // Patched v0.1.0 nodes share obs only with each other: their digest differs from the new release's.
  assert.notEqual(bundleDigest(b), bundleDigest(shipped))
})
