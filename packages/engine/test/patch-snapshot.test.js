import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keyFromSeed, MemoryTransport } from '@gator/net'
import { signPatch } from '../../bundle/src/index.js'
import { Engine, migrations } from '../src/index.js'
import { seedPublicKey } from '../src/patches/root.js'
import { openStore } from './store-fixture.js'
import { extensions, ops, PATCHED, patchMessage, release, RELEASE, rootKey, seed, tap } from './tap-release.js'

// The release ships its patch feed file (packages/bundle/data/patches/<release digest>.json, the integrator drops the
// root-signed export in). At startup it goes through the feed checks (file version, release digest, root envelope
// signature on gator/ctl, then sequence, base, shape, URL policy, patch signature, schema and digest) and only when it
// reaches beyond the stored chain. Without the file the node behaves as before.

class FakeTransport extends EventEmitter {
  publicKey = 'ab'.repeat(32)
  joined = new Set()
  async join(channel) { this.joined.add(channel); return true }
  async leave(channel) { return this.joined.delete(channel) }
  channels() { return [...this.joined] }
  peerCount() { return 0 }
  send() { return true }
}

async function publisher(t, signer = seed, channel = 'gator/ctl') {
  const transport = new MemoryTransport({ wallet: keyFromSeed(signer.toString('hex')), rootKey: seedPublicKey(signer) })
  t.after(() => transport.close())
  assert.ok(await transport.join(channel))
  return message => {
    let signed
    transport.once('message', (_, envelope) => { signed = envelope })
    assert.ok(transport.send(channel, message))
    return signed
  }
}

/** A release data directory holding `patches/<RELEASE>.json` (written as given; objects as JSON). */
function shipped(t, content) {
  const dir = mkdtempSync(join(tmpdir(), 'gator-snapshot-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'patches'))
  const file = join(dir, 'patches', RELEASE + '.json')
  if (content !== undefined) writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content) + '\n')
  return file
}

function boot(t, { snapshot, store, log = [] } = {}) {
  const own = !store
  store ??= openStore({ file: ':memory:', migrations, profile: 'small' })
  const engine = new Engine({ bundle: release, extensions, store, transport: new FakeTransport(), backgroundJobs: [],
    clock: () => 1_763_586_000_000, rpcConfig: { fetch: async () => new Response('{}', { status: 503 }) },
    patches: { rootKey, log: line => log.push(line), patchFeed: false, snapshot } })
  t.after(async () => { await engine.stop(); if (own) store.close() })
  return { engine, store, log }
}
const rows = store => store.writer.prepare('SELECT seq,newDigest,envelope FROM engine_patches ORDER BY pos').all()

test('the shipped snapshot applies at startup, before the catalog is built, and the extension reads it', async t => {
  const sign = await publisher(t)
  const env = sign(patchMessage(7))
  const file = shipped(t, { v: 1, release: RELEASE, envelopes: [env] })
  const { engine, store, log } = boot(t, { snapshot: file })
  assert.equal(engine.patches.digest(), PATCHED)
  assert.deepEqual(engine.patches.status().snapshot, { result: 'applied', reason: null, appliedDigest: PATCHED })
  // No restart needed: the registry is built from the patched bundle, read through the extension.
  assert.equal(engine.registry.assets.has(tap), true)
  assert.equal(engine.registry.cex('gate', 'TAPPROTOCOL', 'USDT').base, tap)
  assert.equal(engine.registry.cex('mexc', 'TAP', 'USDT').base, tap)
  assert.deepEqual(engine.patches.status().newChains, [])
  assert.deepEqual(rows(store).map(r => [r.seq, r.newDigest]), [[7, PATCHED]])
  assert.deepEqual(JSON.parse(rows(store)[0].envelope), env)
  await engine.start()
  assert.equal(engine.obs.digest, PATCHED.slice(0, 16))
  assert.deepEqual(log, [])
  await engine.stop()
  // The next start replays the stored chain; the same snapshot is not newer and changes nothing.
  const again = boot(t, { snapshot: file, store })
  assert.equal(again.engine.patches.digest(), PATCHED)
  assert.equal(again.engine.patches.status().snapshot.result, 'unchanged')
  assert.equal(rows(store).length, 1)
})

test('a tampered, foreign or malformed snapshot is rejected and the node starts on the signed release', async t => {
  const sign = await publisher(t), stranger = await publisher(t, randomBytes(32)), elsewhere = await publisher(t, seed, 'soc/official')
  const msg = patchMessage(7)
  const env = sign(msg)
  const tamperedOps = structuredClone(env)
  tamperedOps.message.patch.ops[2].value.decimals = 8
  const otherSeed = randomBytes(32)
  const innerByStranger = sign({ t: 'patch', v: 1, seq: 7, patch: signPatch(release, ops, otherSeed) })
  for (const [reason, content] of [
    ['envelope', { v: 1, release: RELEASE, envelopes: [tamperedOps] }],
    ['envelope', { v: 1, release: RELEASE, envelopes: [{ ...env, sig: '0'.repeat(128) }] }],
    ['envelope', { v: 1, release: RELEASE, envelopes: [stranger(msg)] }],
    ['envelope', { v: 1, release: RELEASE, envelopes: [elsewhere(msg)] }],
    ['signature', { v: 1, release: RELEASE, envelopes: [innerByStranger] }],
    ['release', { v: 1, release: PATCHED, envelopes: [env] }],
    ['format', { v: 2, release: RELEASE, envelopes: [env] }],
    ['json', '{"v":1,'],
    ['size', ' '.repeat((1 << 20) + 1)],
  ]) {
    const { engine, store, log } = boot(t, { snapshot: shipped(t, content) })
    assert.equal(engine.patches.digest(), RELEASE, reason)
    assert.equal(engine.patches.status().snapshot.result, 'rejected', reason)
    assert.equal(engine.patches.status().snapshot.reason, reason)
    assert.deepEqual(rows(store), [], reason)
    assert.equal(engine.registry.assets.has(tap), false)
    assert.ok(log.some(line => line.startsWith('Shipped bundle patch snapshot rejected')), reason + ' ' + log)
  }
})

test('no snapshot file: the node behaves exactly as without the option', t => {
  for (const snapshot of [shipped(t), undefined, false]) {
    const { engine, store, log } = boot(t, { snapshot })
    assert.equal(engine.patches.digest(), RELEASE)
    assert.deepEqual(engine.patches.status().snapshot, { result: 'none', reason: null, appliedDigest: null })
    assert.deepEqual(rows(store), [])
    assert.deepEqual(log, [])
  }
})

test('a stored chain newer than the shipped snapshot wins; an older snapshot never rewinds it', async t => {
  const sign = await publisher(t)
  const store = openStore({ file: ':memory:', migrations, profile: 'small' })
  t.after(() => store.close())
  const first = boot(t, { store })
  // A later rebase from the release (seq 9) arrived over the network before this start.
  const later = { t: 'patch', v: 1, seq: 9, patch: signPatch(release, ops.slice(0, 4), seed) }
  first.engine.receive('gator/ctl', { channel: 'gator/ctl', from: rootKey, message: later })
  assert.equal(first.engine.patches.seq, 9)
  await first.engine.stop()
  const file = shipped(t, { v: 1, release: RELEASE, envelopes: [sign(patchMessage(7))] })
  const { engine, log } = boot(t, { store, snapshot: file })
  assert.equal(engine.patches.digest(), later.patch.newDigest)
  assert.equal(engine.patches.status().snapshot.result, 'unchanged')
  assert.deepEqual(rows(store).map(r => r.seq), [9])
  assert.deepEqual(log, [])
})
