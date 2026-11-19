import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { bundleDigest } from '@gator/bundle'
import { openStore } from '@gator/store'
import { migrations as socialMigrations } from '@gator/social'
import { Engine, migrations } from '../src/index.js'
import { createIntel, migrations as intelMigrations } from '../src/intel/index.js'
import { createRouter } from '../../api/src/routes.js'
import { SupplyClaims } from '../src/sources/supply-claims.js'
import { channelFor } from '../src/obs/index.js'
import { extensions, PATCHED, patchMessage, release, RELEASE, rootKey, tap, tapErc20, tnk } from './tap-release.js'

// v0.1.0 and v0.1.1 nodes side by side. Both ship the same signed release (2e7fd025…). A v0.1.0 node is this engine
// without the release extension: v0.1.0 has no extension, and the paths these tests use (obs, gator/ctl patches,
// gator/new, gator/meta, focus, registry binding) are those of v0.1.0. The same ops were also applied with v0.1.0's
// own code (temp checkout of ae1c336; report WP-tap2).
const pool = '0x1563e9af51616e78830de3325da752de369c1714'
const usdt = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const peer = 'b'.repeat(64)
const start = Date.UTC(2026, 10, 19, 21)

class Transport extends EventEmitter {
  publicKey = 'a'.repeat(64)
  topics = new Map()
  sent = []
  channels() { return [...this.topics.keys()] }
  async join(channel, policy) { this.topics.set(channel, policy); return true }
  async leave(channel) { return this.topics.delete(channel) }
  send(channel, message) { this.sent.push([channel, message]); return true }
}

/** One node on the shipped release, as the daemon builds it (release digest in rpcConfig, root key seam for tests).
 * `v011` adds the release extension. Pass `store` to restart on the same data. */
const teardowns = new WeakMap()
async function node(t, { v011 = false, store } = {}) {
  const transport = new Transport()
  const own = !store
  store ??= openStore({ file: ':memory:', profile: 'small', migrations: [...migrations, ...intelMigrations,
    ...socialMigrations] })
  let now = start
  const engine = new Engine({ bundle: release, extensions: v011 ? extensions : null, transport, store, clock: () => now,
    backgroundJobs: [], random: () => 0.5, patches: { rootKey, log: () => {} },
    rpcConfig: { bundleDigest: RELEASE, fetch: () => assert.fail('Unexpected HTTP read'), timeout: 500,
      retries: 0, requestsPerMinute: 60 } })
  await engine.start()
  clearTimeout(engine.timer)
  const intel = createIntel({ engine, dailyMarket: () => [], sampleGlobal() {}, now: () => now })
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await intel.stop()
    await engine.stop()
  }
  // One teardown per test: stop every node first, then close the stores (a restarted node shares its store).
  let down = teardowns.get(t)
  if (!down) {
    teardowns.set(t, down = { stops: [], stores: [] })
    t.after(async () => { for (const s of down.stops) await s(); for (const s of down.stores) s.close() })
  }
  down.stops.push(stop)
  if (own) down.stores.push(store)
  const envelope = (channel, message, from = peer) => ({ id: 'e' + Math.random(), channel, from, ts: now, message })
  const deliver = (channel, message, from) => transport.emit('message', channel, envelope(channel, message, from))
  return { engine, store, transport, intel, envelope, deliver, stop, now: () => now }
}

const peerRows = (store, market) => store.writer.prepare('SELECT count(*) AS n FROM engine_latest WHERE reporter=?' +
  (market ? ' AND market=?' : '')).get(...[peer, market].filter(Boolean)).n
const strikes = store => store.writer.prepare('SELECT strikes,mutedUntil FROM reporters WHERE key=?').get(peer)
/** One row in the wire form a peer publishes: [market, price, base volume, quote volume, bid, ask, at]. */
const row = (market, price, at) => [market, String(price), '10000', null, null, null, at]
/** A peer publishes `market` under `b` and the node stores it (or not). */
function share(n, market, price, b = n.engine.obs.digest) {
  n.deliver(channelFor(market), { t: 'obs', v: 1, b, at: n.now(), o: [row(market, price, n.now())] })
  return peerRows(n.store, market)
}

test('v0.1.0 and v0.1.1 start on the one release digest; the extension changes neither the digest nor obs.b', async t => {
  const old = await node(t), next = await node(t, { v011: true })
  assert.equal(bundleDigest(release), RELEASE)
  for (const n of [old, next]) {
    assert.equal(n.engine.patches.digest(), RELEASE)
    assert.equal(n.engine.obs.digest, RELEASE.slice(0, 16))
  }
  // They share prices both ways.
  assert.equal(share(old, 'cex:gate:BTC-USDT', 91000, next.engine.obs.digest), 1)
  assert.equal(share(next, 'cex:gate:BTC-USDT', 91000, old.engine.obs.digest), 1)
})

test('one root patch moves v0.1.0 and v0.1.1 to the same digest and they keep sharing prices, TAP and TNK included', async t => {
  const old = await node(t), next = await node(t, { v011: true })
  // The same root-signed message reaches both (gator/ctl or the feed; identical checks).
  for (const n of [old, next]) {
    n.deliver('gator/ctl', patchMessage(), rootKey)
    assert.equal(n.engine.patches.digest(), PATCHED)
    assert.equal(n.engine.obs.digest, PATCHED.slice(0, 16))
    assert.deepEqual(n.engine.patches.status().newChains, ['tap-protocol', 'trac'])
  }
  assert.equal(share(old, 'cex:gate:BTC-USDT', 91000, next.engine.obs.digest), 1)
  // New tokens take effect at the next start (as for any patch); both restart on their stored chains.
  await old.stop()
  await next.stop()
  const old2 = await node(t, { store: old.store }), next2 = await node(t, { v011: true, store: next.store })
  for (const n of [old2, next2]) {
    assert.equal(n.engine.patches.digest(), PATCHED)
    assert.equal(n.engine.obs.digest, PATCHED.slice(0, 16))
    assert.equal(n.engine.registry.assets.has(tap), true)
  }
  assert.equal(old2.engine.obs.digest, next2.engine.obs.digest)
  // TNK on both venues and MEXC TAP bind on v0.1.0 too (CEX-only natives); v0.1.1 rows reach v0.1.0 and back.
  assert.equal(share(old2, 'cex:mexc:TNK-USDT', 0.07271, next2.engine.obs.digest), 1)
  assert.equal(share(old2, 'cex:gate:TNK-USDT', 0.07231, next2.engine.obs.digest), 1)
  assert.equal(share(old2, 'cex:mexc:TAP-USDT', 0.0438, next2.engine.obs.digest), 1)
  assert.equal(share(next2, 'cex:mexc:TAP-USDT', 0.0438, old2.engine.obs.digest), 1)
  // Gate's TAPPROTOCOL label is only in the v0.1.1 extension: v0.1.0 cannot place that market and ignores its rows.
  assert.equal(share(next2, 'cex:gate:TAPPROTOCOL-USDT', 0.04393, old2.engine.obs.digest), 1)
  assert.equal(share(old2, 'cex:gate:TAPPROTOCOL-USDT', 0.04393, next2.engine.obs.digest), 0)
  for (const n of [old2, next2]) {
    assert.equal(strikes(n.store), undefined)
    assert.equal(n.engine.book.muted(peer), false)
  }
})

test('after the shared patch a v0.1.0 node shows no wrong TAP number: no group, no bridged share as TAP cap', async t => {
  const first = await node(t)
  first.deliver('gator/ctl', patchMessage(), rootKey)
  await first.stop()
  const { engine, store, transport, now } = await node(t, { store: first.store })
  const { registry } = engine
  assert.equal(engine.bundle.tokens.coinGroups.some(g => g.id === 'tap-protocol-tap'), false)
  assert.equal(engine.bundle.tokens.tokens.find(x => x.id === tapErc20).coin, undefined)
  assert.equal(registry.cex('mexc', 'TAP', 'USDT').base, tap)
  assert.equal(registry.cex('gate', 'TNK', 'USDT').base, tnk)
  assert.equal(registry.cex('gate', 'TAPPROTOCOL', 'USDT').base, 'unresolved:gate:TAPPROTOCOL')
  assert.equal(registry.cex('gate', 'TRAC', 'USDT').base, 'ethereum:0xaa7a9ca87d3694b5755f213b5d04094b8d0f0a6f')
  const read = (market, price) => {
    engine.publish([[market.id, String(price), '100000', null, null, null, now()]])
    engine.book.dirty = true
  }
  read(registry.cex('mexc', 'TAP', 'USDT'), 0.0438)
  read(registry.cex('bitstamp', 'USDT', 'USD'), 1)
  const market = registry.pool({ chain: 'ethereum', pool, token0: tapErc20.split(':')[1], token1: usdt,
    dex: 'uniswap-v2', kind: 'v2', block: 1, tx: null, firstSeen: now() })
  read(market, 0.04334)
  // The ERC-20's own totalSupply() (the bridged 3.14M) stays the ERC-20's own figure.
  engine.setSupply(tapErc20, { totalSupply: 3140670.894284045 })
  const intel = { risk: { get: () => null }, claims: { list: () => [] }, placements: { state: () => null },
    newTokens: { list: () => [] } }
  const request = createRouter({ engine, store, transport, social: new EventEmitter(), release: { bundle: release },
    clock: now, intel })
  const list = await request('GET', '/markets', { include: 'hidden' })
  const native = list.items.find(r => r.id === tap), erc20 = list.items.find(r => r.id === tapErc20)
  assert.ok(native && erc20, 'two separate rows')
  // Two standalone coins (each row's coin is its own ID); TAP Protocol has no cap without a supply reading.
  assert.equal(native.coin, tap)
  assert.equal(native.marketCap, null)
  assert.equal(native.coinMarketCap ?? null, null)
  assert.equal(erc20.coin, tapErc20)
  assert.ok(Math.abs(erc20.marketCap - 3140670.894284045 * 0.04334) < 1)
  assert.equal(list.items.filter(r => r.coin === 'tap-protocol-tap').length, 0)
})

test('in the transition (only one side has the patch yet) observations are dropped by digest, without penalty', async t => {
  const old = await node(t), next = await node(t, { v011: true })
  next.deliver('gator/ctl', patchMessage(), rootKey)
  assert.equal(share(old, 'cex:gate:BTC-USDT', 91000, next.engine.obs.digest), 0)
  assert.equal(share(next, 'cex:gate:BTC-USDT', 91000, old.engine.obs.digest), 0)
  for (const n of [old, next]) {
    assert.equal(strikes(n.store), undefined)
    assert.equal(n.engine.book.muted(peer), false)
  }
  // Once the feed reaches the other side they share again.
  old.deliver('gator/ctl', patchMessage(), rootKey)
  assert.equal(share(old, 'cex:gate:BTC-USDT', 91000, next.engine.obs.digest), 1)
})

test('an unpatched v0.1.0 node ignores TAP/TNK pool, listing, claim, risk and supply messages and focus requests', async t => {
  const { engine, store, intel, envelope, deliver, now } = await node(t)
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
