import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { loadBundle, bundleDigest } from '@gator/bundle'
import { openStore } from '@gator/store'
import { channelFor } from '../src/obs/index.js'
import { Engine, migrations } from '../src/index.js'
import { createIntel, migrations as intelMigrations } from '../src/intel/index.js'
import { poolKey } from '../src/sources/ton/address.js'
import { USDT } from '../src/sources/ton/deployments.js'
import { refKey } from '../src/sources/near/source.js'

const signedDigest = bundleDigest(loadBundle()).slice(0, 16)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const releases = { '0.1.0': 'ae1c336b49cc37240b1410b768484ccf96368bfa', '0.1.3': '6dc3f3e626c5e72fd4130d931b9b4d4ba16095a9' }
// Real pools: DeDust TON/USDT and Ref Finance stNEAR/wNEAR (pool 535), in the reader's market-key form.
const TON_POOL = poolKey('EQA-X_yo3fzzbDbJ_0bzFWKqtRuZFIRa1sJsveZJ1YpViO3r'), NEAR_POOL = refKey(535)
const records = [
  { t: 'pool', v: 1, chain: 'ton', pool: TON_POOL, dex: 'dedust', kind: 'v2', token0: 'native', token1: USDT, block: null, tx: null },
  { t: 'pool', v: 1, chain: 'near', pool: NEAR_POOL, dex: 'ref-finance', kind: 'v2', token0: 'meta-pool.near', token1: 'native', block: null, tx: null },
  // Creation-shaped variants a future sender might add: still dropped before any penalty.
  { t: 'pool', v: 1, chain: 'ton', pool: TON_POOL, dex: 'dedust', kind: 'v2', token0: 'native', token1: USDT, block: 1795134200000, tx: '0x' + 'ab'.repeat(32) },
]
const markets = ['dex:ton:' + TON_POOL, 'dex:near:' + NEAR_POOL]

// Load each archived receiver and its workspace imports. Third-party dependencies resolve
// from the surrounding installation. A source-only release/shallow checkout may lack these objects.
function archive(t, ref) {
  if (spawnSync('git', ['cat-file', '-e', ref + '^{commit}'], { cwd: root }).status !== 0) {
    t.skip('release Git object unavailable: ' + ref)
    return
  }
  const dir = mkdtempSync(join(import.meta.dirname, 'tonnear-release-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const packages = ['bundle', 'store', 'social', 'engine', 'net']
  const paths = packages.flatMap(pkg => ['src', 'package.json'].map(p => 'packages/' + pkg + '/' + p))
  const tar = execFileSync('git', ['archive', ref, 'package.json', 'packages/bundle/data', 'packages/net/vendor', ...paths],
    { cwd: root, maxBuffer: 16 << 20 })
  execFileSync('tar', ['-xf', '-', '-C', dir], { input: tar })
  mkdirSync(join(dir, 'node_modules/@gator'), { recursive: true })
  for (const pkg of packages) symlinkSync(join(dir, 'packages', pkg), join(dir, 'node_modules/@gator', pkg), 'junction')
  return (pkg, file = 'index.js') => import(pathToFileURL(join(dir, 'packages', pkg, 'src', file)))
}

class LocalTransport extends EventEmitter {
  publicKey = 'a'.repeat(64)
  channels() { return [] }
  async join() { return true }
  async leave() { return true }
  send() { return true }
}

async function receive({ Engine, migrations, loadBundle, openStore, intelModule }) {
  const store = openStore({ file: ':memory:', migrations: [...migrations, ...intelModule.migrations] })
  const now = 1795134200000, transport = new LocalTransport(), peer = 'b'.repeat(64)
  const engine = new Engine({ bundle: loadBundle(), store, transport, clock: () => now, backgroundJobs: [],
    patches: { patchFeed: false, snapshot: false }, rpcConfig: { fetch: () => assert.fail('unexpected receiver RPC') } })
  const intel = intelModule.createIntel({ engine, dailyMarket: () => [], sampleGlobal() {} })
  try {
    await engine.start()
    await intel.start()
    assert.equal(engine.obs.digest, signedDigest)
    const rank = engine.hints.rank(peer)
    const send = (channel, message) => transport.emit('message', channel, { channel, message, from: peer, ts: now })
    for (const record of records) send('gator/new', record)
    const share = market => send(channelFor(market), { t: 'obs', v: 1, b: engine.obs.digest, at: now,
      o: [[market, '1.0001', '0', null, null, null, now]] })
    for (const market of markets) share(market)
    // Positive control traverses precisely the same listener, digest and quota.
    share('cex:bitstamp:BTC-USD')
    assert.ok(store.reader.prepare('SELECT 1 FROM engine_latest WHERE market=? AND reporter=?').get('cex:bitstamp:BTC-USD', peer))
    for (const market of markets) {
      assert.equal(store.reader.prepare('SELECT 1 FROM engine_latest WHERE market=?').get(market), undefined)
      assert.equal(engine.registry.markets.has(market), false)
    }
    assert.equal(intel.newTokens.list().length, 0)
    assert.equal(engine.hints.size, 0)
    assert.equal(engine.hints.rank(peer), rank)
    assert.equal(engine.book.muted(peer), false)
    assert.equal(store.reader.prepare('SELECT 1 FROM reporters WHERE key=? AND (strikes>0 OR mutedUntil>?)').get(peer, now), undefined)
  } finally {
    await intel.stop()
    await engine.stop()
    store.close()
  }
}

for (const [version, commit] of Object.entries(releases)) {
  test('unmodified v' + version + ' ignores TON and NEAR pools and prices without a penalty', async t => {
    const released = archive(t, commit)
    if (!released) return
    const [{ Engine, migrations }, { loadBundle }, { openStore }, intelModule] = await Promise.all([
      released('engine'), released('bundle'), released('store'), released('engine', 'intel/index.js'),
    ])
    await receive({ Engine, migrations, loadBundle, openStore, intelModule })
  })
}

test('this release drops peer TON/NEAR pool records and unknown markets without a penalty', async () => {
  await receive({ Engine, migrations, loadBundle, openStore,
    intelModule: { createIntel, migrations: intelMigrations } })
})

test('this release accepts a peer price for a TON market it verified itself', async () => {
  const store = openStore({ file: ':memory:', migrations: [...migrations, ...intelMigrations] })
  const now = 1795134200000, transport = new LocalTransport(), peer = 'c'.repeat(64)
  const engine = new Engine({ bundle: loadBundle(), store, transport, clock: () => now, backgroundJobs: [],
    patches: { patchFeed: false, snapshot: false }, rpcConfig: { fetch: () => assert.fail('unexpected receiver RPC') } })
  try {
    await engine.start()
    const [record] = records
    // The local reader's admission path for the DeDust TON/USDT pool.
    const market = engine.registry.pool({ ...record, firstSeen: now, liquidity: 450_000 })
    assert.equal(market.id, markets[0])
    transport.emit('message', channelFor(market.id), { channel: channelFor(market.id), from: peer, ts: now,
      message: { t: 'obs', v: 1, b: engine.obs.digest, at: now, o: [[market.id, '1.6012', '0', null, null, null, now]] } })
    assert.ok(store.reader.prepare('SELECT 1 FROM engine_latest WHERE market=? AND reporter=?').get(market.id, peer))
  } finally {
    await engine.stop()
    store.close()
  }
})
