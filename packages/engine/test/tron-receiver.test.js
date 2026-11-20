import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { loadBundle, bundleDigest } from '@gator/bundle'
import { FACTORIES } from '../src/sources/tron/deployments.js'
import { parsePage } from '../src/sources/tron/events.js'
import { channelFor } from '../src/obs/index.js'

const signedDigest = bundleDigest(loadBundle()).slice(0, 16)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const releases = { '0.1.0': 'ae1c336b49cc37240b1410b768484ccf96368bfa', '0.1.3': '6dc3f3e626c5e72fd4130d931b9b4d4ba16095a9' }
const { at, event } = JSON.parse(readFileSync(new URL('./fixtures/tron/funded-event.json', import.meta.url)))
const { pools: [p] } = parsePage(FACTORIES[1], { success: true, data: [event], meta: { page_size: 1 } },
  { from: 0, until: at })

// Load each archived receiver and its workspace imports. Third-party dependencies resolve
// from the surrounding installation. A source-only release/shallow checkout may lack these objects.
function archive(t, ref) {
  if (spawnSync('git', ['cat-file', '-e', ref + '^{commit}'], { cwd: root }).status !== 0) {
    t.skip('release Git object unavailable: ' + ref)
    return
  }
  const dir = mkdtempSync(join(import.meta.dirname, 'tron-release-'))
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

for (const [version, commit] of Object.entries(releases)) {
  test('unmodified v' + version + ' ignores TRON pool and price without a penalty', async t => {
    const released = archive(t, commit)
    if (!released) return
    const [{ Engine, migrations }, { loadBundle }, { openStore }, intelModule] = await Promise.all([
      released('engine'), released('bundle'), released('store'), released('engine', 'intel/index.js'),
    ])
    const store = openStore({ file: ':memory:', migrations: [...migrations, ...intelModule.migrations] })
    const now = 1795134200000, transport = new LocalTransport(), peer = 'b'.repeat(64)
    const engine = new Engine({ bundle: loadBundle(), store, transport, clock: () => now, backgroundJobs: [],
      patches: { patchFeed: false, snapshot: false }, rpcConfig: { fetch: () => assert.fail('unexpected old-node RPC') } })
    const intel = intelModule.createIntel({ engine, dailyMarket: () => [], sampleGlobal() {} })
    try {
      await engine.start()
      await intel.start()
      assert.equal(engine.obs.digest, signedDigest)
      const rank = engine.hints.rank(peer), id = 'dex:tron:' + p.pool
      const send = (channel, message) => transport.emit('message', channel, { channel, message, from: peer, ts: now })
      const hint = { t: 'pool', v: 1, chain: 'tron', pool: p.pool, kind: p.kind, dex: p.dex,
        token0: p.token0, token1: p.token1, block: p.block, tx: p.tx }
      send('gator/new', hint)
      // Even hash bytes whose unprefixed spelling is valid base58 cannot enter the old Solana discovery path.
      send('gator/new', { ...hint, tx: '0x' + 'ab'.repeat(32) })
      const share = market => send(channelFor(market), { t: 'obs', v: 1, b: engine.obs.digest, at: now,
        o: [[market, '1.0001', '0', null, null, null, now]] })
      share(id)
      // Positive control traverses precisely the same release listener, digest and quota.
      share('cex:bitstamp:BTC-USD')
      assert.ok(store.reader.prepare('SELECT 1 FROM engine_latest WHERE market=? AND reporter=?').get('cex:bitstamp:BTC-USD', peer))
      assert.equal(store.reader.prepare('SELECT 1 FROM engine_latest WHERE market=?').get(id), undefined)
      assert.equal(engine.registry.markets.has(id), false)
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
  })
}
