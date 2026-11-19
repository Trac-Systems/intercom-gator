import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { keyFromSeed, MemoryTransport } from '@gator/net'
import {
  applyPatch,
  bundleDigest,
  loadBundle,
  patchDigest,
  signBundle,
  signPatch,
  validateBundle,
} from '../../bundle/src/index.js'
import { Engine, migrations } from '../src/index.js'
import { MAX_PATCH_BYTES, MAX_PATCH_OPS, publicHost, urlProblem } from '../src/patches/index.js'
import { seedPublicKey } from '../src/patches/root.js'
import { DEFAULT_FEED, feedUrl, MAX_FEED_BYTES } from '../src/patches/feed-format.js'
import { openStore } from './store-fixture.js'

const seed = randomBytes(32)
const rootKey = seedPublicKey(seed)
const otherSeed = randomBytes(32)

/** A small valid release (two exchanges, bitcoin + ethereum) built from the shipped data. */
function smallRelease() {
  const bundle = structuredClone(loadBundle())
  bundle.exchanges = bundle.exchanges.filter((e) => ['bitstamp', 'kraken'].includes(e.id))
  bundle.tokens.tokens = bundle.tokens.tokens.filter((t) => ['bitcoin:native', 'ethereum:native'].includes(t.id))
  for (const t of bundle.tokens.tokens) t.links = []
  bundle.chains = bundle.chains.filter((c) => ['bitcoin', 'ethereum'].includes(c.id))
  bundle.paidExtras = Object.fromEntries(bundle.chains.map((c) => [c.id, bundle.paidExtras?.[c.id] ?? '']))
  bundle.dex.evm = bundle.dex.evm.filter((c) => c.chain === 'ethereum')
  validateBundle(bundle)
  return bundle
}
const release = smallRelease()
const releaseDigest = bundleDigest(release)
const eth = release.chains.findIndex((c) => c.id === 'ethereum')
const kraken = release.exchanges.findIndex((e) => e.id === 'kraken')

class FakeTransport extends EventEmitter {
  publicKey = 'ab'.repeat(32)
  joined = new Set()
  sent = []
  async join(channel) {
    this.joined.add(channel)
    return true
  }
  async leave(channel) {
    return this.joined.delete(channel)
  }
  channels() {
    return [...this.joined]
  }
  peerCount() {
    return 0
  }
  send(channel, message) {
    this.sent.push([channel, message])
    return true
  }
}

function setup(t, { store, bundle = release, rpcConfig = {}, maxChain, patchFeed, clock = () => 1_750_000_000_000 } = {}) {
  const ownStore = !store
  store ??= openStore({ file: ':memory:', migrations, profile: 'small' })
  const log = []
  const transport = new FakeTransport()
  const engine = new Engine({
    bundle,
    store,
    transport,
    backgroundJobs: [],
    clock,
    rpcConfig: { fetch: async () => new Response('{}', { status: 503 }), ...rpcConfig },
    patches: { rootKey, log: (line) => log.push(line), maxChain, patchFeed },
  })
  t.after(async () => { await engine.stop(); if (ownStore) store.close() })
  const events = []
  engine.on('bundlePatch', (e) => events.push(e))
  const send = (message, from = rootKey) => engine.receive('gator/ctl', { channel: 'gator/ctl', from, message })
  return { engine, store, log, events, send, transport }
}

const issue = (base, ops, seq, key = seed) => ({ t: 'patch', v: 1, seq, patch: signPatch(base, ops, key) })
const endpointUrl = (url, i = 0) => [{ op: 'replace', path: `/chains/${eth}/endpoints/${i}/url`, value: url }]
const rows = (store) => store.writer.prepare('SELECT * FROM engine_patches ORDER BY pos').all()

test('the URL policy allows public https/wss hosts only', () => {
  for (const ok of [
    'https://rpc.example.org/v1?key={key}',
    'wss://stream.example.com:9443/ws',
    'https://8.8.8.8/',
    'https://[2606:4700:4700::1111]/dns',
    'https://sub.domain.example/{symbol}/x',
  ])
    assert.equal(urlProblem(ok), null, ok)
  for (const [bad, reason] of [
    ['http://rpc.example.org', 'scheme'],
    ['ws://rpc.example.org', 'scheme'],
    ['ftp://files.example.org', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['HTTPS://rpc.example.org', 'scheme'],
    ['https://user:pw@rpc.example.org', 'authority'],
    ['https://{host}/rpc', 'authority'],
    ['https://%6c%6fcalhost/', 'authority'],
    ['https://rpc.example.org/a b', 'characters'],
    ['https://127.0.0.1/', 'host'],
    ['https://127.1/', 'host'],
    ['https://2130706433/', 'host'],
    ['https://0x7f.0.0.1/', 'host'],
    ['https://0.0.0.0/', 'host'],
    ['https://10.1.2.3/', 'host'],
    ['https://172.16.5.4/', 'host'],
    ['https://192.168.1.1/', 'host'],
    ['https://100.64.0.1/', 'host'],
    ['https://169.254.169.254/latest', 'host'],
    ['https://[::1]/', 'host'],
    ['https://[::]/', 'host'],
    ['https://[::ffff:127.0.0.1]/', 'host'],
    ['https://[::ffff:8.8.8.8]/', 'host'],
    ['https://[fd12:3456::1]/', 'host'],
    ['https://[fe80::1]/', 'host'],
    ['https://[64:ff9b::a00:1]/', 'host'],
    ['https://localhost/', 'host'],
    ['https://LOCALHOST./', 'host'],
    ['https://api.localhost/', 'host'],
    ['https://printer.local/', 'host'],
    ['https://node.internal/', 'host'],
    ['https://router.home.arpa/', 'host'],
    ['https://intranet/', 'host'],
    ['wss://10.0.0.8/ws', 'host'],
  ])
    assert.equal(urlProblem(bad), reason, bad)
  for (const text of ['limits: 10 req/s', 'see https://docs.example', '/api/v2/ticker/{symbol}', 'eth_chainId'])
    assert.equal(urlProblem(text), null, text)
  assert.equal(publicHost('example.com.'), true)
})

test('a valid root patch applies, persists and is the new base; the accept/reject matrix changes nothing', (t) => {
  const { engine, store, log, events, send } = setup(t, { maxChain: 3 })
  assert.equal(engine.patches.digest(), releaseDigest)
  const first = issue(release, endpointUrl('https://rpc.patched.example/eth'), 10)
  send(first)
  assert.equal(engine.patches.head, first.patch.newDigest)
  assert.equal(bundleDigest(engine.bundle), first.patch.newDigest)
  assert.equal(engine.bundle.chains[eth].endpoints[0].url, 'https://rpc.patched.example/eth')
  assert.deepEqual(
    rows(store).map((r) => [r.seq, r.baseDigest, r.newDigest]),
    [[10, releaseDigest, first.patch.newDigest]]
  )
  assert.deepEqual(events, [{ seq: 10, digest: first.patch.newDigest, patches: 1, restart: [] }])
  assert.deepEqual(log, [])

  const head = engine.bundle
  const base = engine.patches.current
  const sig = (m, change) => ({ ...m, patch: { ...m.patch, signature: change(m.patch.signature) } })
  const flip = (hex) => hex.slice(0, -1) + (hex.at(-1) === '0' ? '1' : '0')
  const elsewhere = structuredClone(release)
  elsewhere.apis[0].name = 'Somewhere else'
  const wrongDigest = { baseDigest: first.patch.newDigest, ops: endpointUrl('https://rpc.two.example/eth', 1) }
  wrongDigest.newDigest = releaseDigest
  wrongDigest.signature = signBundle(patchDigest(wrongDigest), seed)
  const invalid = {
    baseDigest: first.patch.newDigest,
    ops: [0, 1, 2].map(() => ({ op: 'remove', path: `/chains/${eth}/endpoints/0` })),
    newDigest: '0'.repeat(64),
  }
  invalid.signature = signBundle(patchDigest(invalid), seed)
  const tooMany = issue(base, endpointUrl('https://rpc.many.example/eth'), 20)
  tooMany.patch.ops = Array.from({ length: MAX_PATCH_OPS + 1 }, () => tooMany.patch.ops[0])
  const huge = issue(base, [{ op: 'replace', path: '/apis/0/limitNote', value: 'x'.repeat(MAX_PATCH_BYTES) }], 21)
  const matrix = [
    ['sender', issue(base, endpointUrl('https://rpc.other.example/eth'), 11), 'cd'.repeat(32)],
    ['sender', issue(base, endpointUrl('https://rpc.other.example/eth'), 11, otherSeed), seedPublicKey(otherSeed)],
    ['signature', issue(base, endpointUrl('https://rpc.other.example/eth'), 12, otherSeed)],
    ['signature', sig(issue(base, endpointUrl('https://rpc.other.example/eth'), 13), flip)],
    ['base', issue(elsewhere, endpointUrl('https://rpc.other.example/eth'), 14)],
    ['seq', { ...first, patch: { ...first.patch, newDigest: releaseDigest } }],
    ['seq', issue(base, endpointUrl('https://rpc.lower.example/eth'), 9)],
    ['url', issue(base, endpointUrl('https://127.0.0.1:8545/'), 15)],
    ['url', issue(base, endpointUrl('https://169.254.169.254/'), 15)],
    ['url', issue(base, endpointUrl('https://[fd00::1]/'), 15)],
    ['url', issue(base, endpointUrl('https://rpc.corp.internal/'), 15)],
    ['url', issue(base, [{ op: 'replace', path: `/chains/${eth}/endpoints/0/wss`, value: 'wss://10.0.0.1/' }], 15)],
    ['size', tooMany],
    ['size', huge],
    ['schema', { t: 'patch', v: 1, seq: 16, patch: invalid }],
    ['digest', { t: 'patch', v: 1, seq: 17, patch: wrongDigest }],
    ['shape', { ...issue(base, endpointUrl('https://rpc.shape.example/eth'), 18), extra: true }],
    ['shape', { t: 'patch', v: 1, seq: '19', patch: first.patch }],
  ]
  for (const [reason, message, from] of matrix) {
    const before = log.length
    send(message, from)
    send(message, from) // re-sent copies are logged once
    assert.equal(log.length, before + 1, reason)
    assert.match(log.at(-1), new RegExp(': ' + reason + '$'), reason)
    assert.equal(engine.bundle, head, reason)
    assert.equal(engine.patches.head, first.patch.newDigest, reason)
    assert.equal(rows(store).length, 1, reason)
  }
  send(first) // an exact re-sent copy of an accepted patch is ignored without a log line
  assert.equal(log.length, matrix.length)
  // Logs carry the reason and seq only, never the payload.
  for (const line of log) assert.doesNotMatch(line, /127\.0\.0\.1|https?:|wss:|[0-9a-f]{64}/)
  assert.equal(events.length, 1)

  // Chain cap: appends stop at maxChain; a cumulative patch on the release digest replaces the chain.
  const second = issue(base, endpointUrl('https://rpc.two.example/eth', 1), 30)
  send(second)
  const third = issue(engine.patches.current, endpointUrl('https://rpc.three.example/eth', 2), 31)
  send(third)
  assert.equal(engine.patches.chain.length, 3)
  send(issue(engine.patches.current, endpointUrl('https://rpc.four.example/eth', 3), 32))
  assert.match(log.at(-1), /: chain-full$/)
  assert.equal(engine.patches.head, third.patch.newDigest)
  const squash = [...endpointUrl('https://rpc.squash.example/eth'), ...endpointUrl('https://rpc.squash2.example/eth', 1)]
  const cumulative = issue(release, squash, 33)
  send(cumulative)
  assert.equal(engine.patches.head, cumulative.patch.newDigest)
  assert.deepEqual(rows(store).map((r) => r.seq), [33])
  send(second) // an older patch for the replaced chain is a replay
  assert.match(log.at(-1), /\(seq 30\): seq$/)
  assert.equal(engine.patches.head, cumulative.patch.newDigest)
})

test('restart re-applies the stored chain; a broken link stops at the last good digest; upgrades drop it', async (t) => {
  const store = openStore({ file: ':memory:', migrations, profile: 'small' })
  t.after(() => store.close())
  const a = setup(t, { store })
  const one = issue(release, endpointUrl('https://rpc.one.example/eth'), 1)
  a.send(one)
  const two = issue(a.engine.patches.current, endpointUrl('https://rpc.two.example/eth', 1), 2)
  a.send(two)
  assert.equal(a.engine.patches.head, two.patch.newDigest)
  await a.engine.stop()

  const b = setup(t, { store, rpcConfig: { bundleDigest: releaseDigest } })
  assert.equal(b.engine.patches.head, two.patch.newDigest)
  assert.equal(bundleDigest(b.engine.bundle), two.patch.newDigest)
  const urls = b.engine.catalog.chains.find((c) => c.id === 'ethereum').endpoints.map((e) => e.url)
  assert.ok(urls.includes('https://rpc.one.example/eth') && urls.includes('https://rpc.two.example/eth'))
  assert.ok(b.engine.rpc.chains.get('ethereum').some((e) => e.url === 'https://rpc.two.example/eth'))
  assert.deepEqual(b.log, [])
  await b.engine.start()
  assert.equal(b.engine.obs.digest, two.patch.newDigest.slice(0, 16)) // effective digest, not the release digest
  b.send(one)
  assert.deepEqual(b.log, []) // a re-sent copy after restart is still recognised
  b.send(issue(release, endpointUrl('https://rpc.replay.example/eth'), 2))
  assert.match(b.log.at(-1), /: seq$/)
  await b.engine.stop()

  // Corrupt the second link: its signature no longer verifies.
  const last = rows(store).at(-1)
  const flipped = two.patch.signature.slice(0, -1) + (two.patch.signature.at(-1) === 'a' ? 'b' : 'a')
  store.writer
    .prepare('UPDATE engine_patches SET message=? WHERE pos=?')
    .run(last.message.replace(two.patch.signature, flipped), last.pos)
  const c = setup(t, { store })
  assert.equal(c.engine.patches.head, one.patch.newDigest)
  assert.equal(bundleDigest(c.engine.bundle), one.patch.newDigest)
  assert.deepEqual(rows(store).map((r) => r.seq), [1])
  assert.deepEqual(c.log, ['Stored bundle patch chain is broken; using the last good digest'])
  // The good prefix is still the base for the next patch.
  c.send(two)
  assert.equal(c.engine.patches.head, two.patch.newDigest)
  await c.engine.stop()

  // A new release: the stored chain no longer starts at its digest.
  const upgraded = structuredClone(release)
  upgraded.apis[0].name = 'Upgraded release'
  const d = setup(t, { store, bundle: upgraded })
  assert.equal(d.engine.patches.head, null)
  assert.equal(d.engine.patches.digest(), bundleDigest(upgraded))
  assert.equal(rows(store).length, 0)
  assert.deepEqual(d.log, ['Stored bundle patches dropped: they do not start at this release'])
})

test('RPC endpoints, venue specs and API sources swap live; other datasets wait for the next start', async (t) => {
  const calls = []
  const fetch = async (url, init) => {
    calls.push(String(url))
    const { id } = JSON.parse(init.body)
    return Response.json({ jsonrpc: '2.0', id, result: '0x1' })
  }
  const user = 'https://user.example/rpc'
  const { engine, events, send } = setup(t, {
    rpcConfig: { fetch, endpoints: { ethereum: [user] }, sleep: async () => {} },
  })
  await engine.start()
  assert.equal(engine.obs.digest, releaseDigest.slice(0, 16))
  const pool = engine.rpc.chains.get('ethereum')
  const userEntry = pool[0]
  assert.equal(userEntry.url, user)
  const kept = release.chains[eth].endpoints[1].url
  const keptBucket = engine.rpc.buckets.get(kept)
  const old = release.chains[eth].endpoints.map((e) => e.url)
  const fresh = release.chains[eth].endpoints.map((e, i) => ({ ...e, url: 'https://fresh' + i + '.example/eth' }))
  fresh[1] = release.chains[eth].endpoints[1]
  const venue = engine.registry.venues.get('kraken')
  const job = engine.scheduler.jobs.get('cex:kraken')
  const api = engine.catalog.apis[0]
  const patch = issue(
    release,
    [
      { op: 'replace', path: `/chains/${eth}/endpoints`, value: fresh },
      { op: 'replace', path: `/exchanges/${kraken}/restBase`, value: 'https://api.kraken-mirror.example' },
      { op: 'replace', path: `/exchanges/${kraken}/terms/redistribution`, value: 'restricted' },
      { op: 'replace', path: '/apis/0/base', value: 'https://prices.patched.example' },
      { op: 'replace', path: '/tokens/tokens/0/name', value: 'Renamed' },
    ],
    5
  )
  send(patch)
  assert.equal(engine.patches.head, patch.patch.newDigest)
  assert.equal(engine.obs.digest, patch.patch.newDigest.slice(0, 16))

  const urls = engine.rpc.chains.get('ethereum').map((e) => e.url)
  assert.equal(engine.rpc.chains.get('ethereum')[0], userEntry) // user endpoints stay first, untouched
  assert.deepEqual(new Set(urls), new Set([user, ...fresh.map((e) => e.url)]))
  assert.ok(old.every((url, i) => i === 1 || !urls.includes(url)))
  assert.equal(engine.rpc.buckets.get(kept), keptBucket) // known URLs keep their rate bucket
  userEntry.cooldown = Infinity // force a bundle endpoint
  assert.equal(await engine.rpc.call('ethereum', 'eth_chainId'), '0x1')
  assert.ok(fresh.some((e) => e.url === calls.at(-1)), calls.at(-1))

  assert.equal(engine.registry.venues.get('kraken'), venue) // same venue object, updated in place
  assert.equal(engine.scheduler.jobs.get('cex:kraken'), job)
  assert.ok(venue.ticker.url.startsWith('https://api.kraken-mirror.example/'))
  assert.equal(venue.publishMarketData, false)
  assert.equal(api.url.startsWith('https://prices.patched.example'), true)
  assert.deepEqual(events.at(-1).restart, ['tokens'])

  // Removing an exchange stops its jobs at once.
  const removal = issue(engine.patches.current, [{ op: 'remove', path: `/exchanges/${kraken}` }], 6)
  send(removal)
  assert.equal(engine.patches.head, removal.patch.newDigest)
  assert.ok(![...engine.scheduler.jobs.keys()].some((id) => id === 'cex:kraken' || id.startsWith('cex:kraken:')))
  assert.ok(engine.scheduler.jobs.has('cex:bitstamp'))
})

test('storage and live-update failures never escape into the transport; rejection logs are capped', (t) => {
  const { engine, store, log, events, send } = setup(t)
  const transaction = store.transaction
  store.transaction = () => {
    throw new Error('disk full')
  }
  const one = issue(release, endpointUrl('https://rpc.disk.example/eth'), 1)
  assert.doesNotThrow(() => send(one))
  assert.equal(engine.patches.head, null)
  assert.equal(engine.bundle, release)
  assert.deepEqual(log, ['Bundle patch could not be stored; nothing changed'])
  store.transaction = transaction

  // A live update that fails still leaves a verified, stored patch that the next start applies.
  const jobs = engine.scheduler.jobs
  engine.scheduler.jobs = null
  const removal = issue(release, [{ op: 'remove', path: `/exchanges/${kraken}` }], 2)
  assert.doesNotThrow(() => send(removal))
  engine.scheduler.jobs = jobs
  assert.equal(engine.patches.head, removal.patch.newDigest)
  assert.equal(bundleDigest(engine.bundle), removal.patch.newDigest)
  assert.equal(rows(store).length, 1)
  assert.deepEqual(events.at(-1).restart, ['all'])
  assert.match(log.at(-1), /takes effect at the next start/)

  for (let seq = 0; seq < 40; seq++)
    send(issue(release, endpointUrl('https://rpc.cap.example/' + seq), 100 + seq), 'cd'.repeat(32))
  assert.equal(log.length, 32)
})

/** Use Intercom's sender to produce the exact wire envelope, including its signature over seq. */
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

const document = (...envelopes) => ({ v: 1, release: releaseDigest, envelopes })

test('cumulative feed catches up an offline node once, switches live RPCs, and starts new chain jobs after restart', async t => {
  const sign = await publisher(t)
  const rpc = 'https://patchfeed.example/rpc'
  const cumulative = issue(release, endpointUrl(rpc), 40)
  const shipped = loadBundle()
  const ops = ['base', 'arbitrum'].flatMap(id => [
    { op: 'add', path: '/chains/-', value: shipped.chains.find(c => c.id === id) },
    { op: 'add', path: '/dex/evm/-', value: shipped.dex.evm.find(c => c.chain === id) },
    { op: 'add', path: '/tokens/tokens/-', value: { ...shipped.tokens.tokens.find(c => c.id === id + ':native'), links: [] } },
    { op: 'add', path: '/paidExtras/' + id, value: '' },
  ])
  const append = issue(applyPatch(release, cumulative.patch, rootKey), ops, 42)
  const body = JSON.stringify(document(sign(cumulative), { ignored: true }, sign(append)))
  let visits = 0
  const server = createServer((req, res) => {
    visits++
    res.end(body)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  let now = 1_750_000_000_000
  const requested = []
  const fetchFixture = (url, init) => {
    requested.push(url)
    if (init.method === 'POST') return Response.json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x1' })
    assert.equal(url, DEFAULT_FEED + releaseDigest + '.json')
    assert.equal(init.redirect, 'error')
    return fetch('http://127.0.0.1:' + server.address().port, init)
  }
  const a = setup(t, { rpcConfig: { fetch: fetchFixture }, clock: () => now })
  a.send(issue(release, endpointUrl('https://previous.example/rpc'), 25))
  await a.engine.start()
  const feed = a.engine.patches.feed
  assert.ok(feed.state.nextCheck >= now + 60_000 && feed.state.nextCheck <= now + 300_000)
  assert.equal(visits, 0)
  await Promise.all([feed.check(), feed.check()])
  assert.equal(visits, 1)
  assert.equal(a.engine.budget.used, 1)
  const status = a.engine.patches.status()
  assert.equal(status.feed.lastFetch, now)
  assert.equal(status.feed.result, 'applied')
  assert.equal(status.feed.appliedDigest, append.patch.newDigest)
  assert.ok(status.feed.nextCheck >= now + 330 * 60_000 && status.feed.nextCheck <= now + 390 * 60_000)
  assert.deepEqual(status.newChains, ['base', 'arbitrum'])
  assert.equal(status.restart, 'restart to use 2 new chains')
  assert.deepEqual(rows(a.store).map(r => r.seq), [40, 42])
  assert.ok(!a.engine.scheduler.jobs.has('evm:base:logs'))
  assert.equal(a.engine.rpc.chains.get('ethereum')[0].url, rpc)
  assert.equal(await a.engine.rpc.call('ethereum', 'eth_chainId'), '0x1')
  assert.equal(requested.at(-1), rpc)
  now += 6000
  await feed.check()
  assert.equal(visits, 2)
  assert.equal(feed.state.result, 'unchanged')
  assert.equal(a.events.length, 3)
  assert.deepEqual(rows(a.store).map(r => r.seq), [40, 42])
  const source = a.engine.sources().groups.flatMap(g => g.items).find(i => i.name === 'Bundle updates (GitHub)')
  assert.equal(source.requests1h, 2)
  assert.equal(source.state, 'ok')

  await a.engine.stop()
  assert.equal(feed.state.nextCheck, null)
  const b = setup(t, { store: a.store })
  await b.engine.start()
  for (const id of status.newChains) assert.ok(b.engine.scheduler.jobs.has('evm:' + id + ':logs'))
  assert.equal(b.engine.patches.status().restart, null)
  assert.equal(b.engine.patches.digest(), append.patch.newDigest)
  await b.engine.stop()
})

test('wrong release, forged sequence, wrong channel and author, and invalid inner signatures cannot change the node', async t => {
  const sign = await publisher(t), wrongChannel = await publisher(t, seed, 'soc/official'), wrongAuthor = await publisher(t, otherSeed)
  const msg = issue(release, endpointUrl('https://valid.example/rpc'), 12)
  const env = sign(msg)
  let now = Date.now(), response
  const { engine, store } = setup(t, { clock: () => now, rpcConfig: { fetch: async () => Response.json(response) } })
  await engine.start()
  const { feed } = engine.patches
  for (const [reason, input] of [
    ['release', { ...document(env), release: '0'.repeat(64) }],
    ['format', { ...document(env), v: 2 }],
    ['envelope', document({ ...env, message: { ...msg, seq: 13 } })],
    ['envelope', document({ ...env, sig: undefined })],
    ['envelope', document(wrongChannel(msg))],
    ['envelope', document(wrongAuthor(msg))],
    ['envelope', document({ ...env, padding: 'x'.repeat(MAX_PATCH_BYTES) })],
    ['signature', document(sign(issue(release, endpointUrl('https://valid.example/rpc'), 13, otherSeed)))],
    ['url', document(sign(issue(release, endpointUrl('https://127.0.0.1'), 14)))],
  ]) {
    response = input
    now += 60_000
    await feed.check()
    assert.equal(feed.state.reason, reason)
    assert.equal(feed.state.result, 'rejected')
    assert.equal(engine.patches.digest(), releaseDigest)
    assert.deepEqual(rows(store), [])
  }
  // A bad entry never suppresses a later valid copy. Unsigned relay fields are discarded.
  response = document({ ...env, sig: '0'.repeat(128) }, { ...env, injected: 'ignore' })
  now += 60_000
  await feed.check()
  assert.equal(feed.state.result, 'partial')
  assert.equal(feed.state.reason, 'envelope')
  assert.deepEqual(JSON.parse(rows(store)[0].envelope), env)
})

test('feed bounds apply to the decoded stream and declared size, a 404 is quiet, and budget exhaustion defers HTTP', async t => {
  let now = Date.now(), reply, calls = 0
  const { engine, log } = setup(t, { clock: () => now, rpcConfig: { requestsPerMinute: 1,
    fetch: async () => { calls++; return reply() } } })
  const { feed } = engine.patches
  await engine.start()
  reply = () => new Response('missing', { status: 404 })
  await feed.check()
  assert.equal(feed.state.result, 'not-found')
  assert.equal(feed.state.reason, null)
  const source = engine.sources().groups.flatMap(g => g.items).find(i => i.id === 'bundle-updates')
  assert.equal(source.errorShare1h, 0)
  assert.deepEqual(log, [])
  const fetched = feed.state.lastFetch
  now += 5000
  await feed.check()
  assert.equal(feed.state.reason, 'budget')
  assert.equal(feed.state.lastFetch, fetched)
  assert.ok(feed.state.nextCheck >= fetched + 60_000)
  assert.equal(calls, 1)

  for (const [reason, fixture] of [
    ['size', () => new Response('{}', { headers: { 'Content-Length': String(MAX_FEED_BYTES + 1) } })],
    ['size', () => new Response(Buffer.alloc(MAX_FEED_BYTES + 1, 32))],
    ['json', () => new Response('invalid JSON')],
    ['http-429', () => new Response(null, { status: 429 })],
  ]) {
    now += 60_000
    reply = fixture
    await feed.check()
    assert.equal(feed.state.reason, reason)
    assert.equal(feed.state.appliedDigest, null)
    assert.equal(engine.patches.digest(), releaseDigest)
  }
})

test('feed off and invalid override make no request; overrides stay on public GitHub raw HTTPS', async t => {
  let calls = 0
  for (const setting of [false, 'http://raw.githubusercontent.com/org/repo/main/patches']) {
    const { engine } = setup(t, { patchFeed: setting, rpcConfig: { fetch: async () => { calls++ } } })
    await engine.start()
    await engine.patches.feed.check()
    const { feed } = engine.patches.status()
    assert.equal(feed.nextCheck, null)
    assert.equal(feed.result, setting === false ? 'disabled' : 'rejected')
    assert.equal(feed.reason, setting === false ? null : 'feed-url')
  }
  assert.equal(calls, 0)
  const raw = 'https://raw.githubusercontent.com/org/repo/main/patches'
  assert.equal(feedUrl(raw, releaseDigest), raw + '/' + releaseDigest + '.json')
  assert.equal(feedUrl(raw + '/updates.json', releaseDigest), raw + '/updates.json')
  for (const url of ['https://127.0.0.1/org/repo/main/file', raw.replace('.com', '.com.example'),
    raw.replace('https://', 'https://user@'), raw + '?token=x', raw + '#section', raw.replace('.com/', '.com:444/')])
    assert.throws(() => feedUrl(url, releaseDigest), /feed-url/)
})

test('the startup and six-hour timers fetch automatically and stop cancels future checks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = Date.now(), calls = 0
  const { engine } = setup(t, { clock: () => now, rpcConfig: { fetch: async () => {
    calls++
    return new Response(null, { status: 404 })
  } } })
  await engine.start()
  clearTimeout(engine.timer)
  const { feed } = engine.patches
  function advance(ms) { now += ms; t.mock.timers.tick(ms) }
  advance(feed.state.nextCheck - now - 1)
  assert.equal(calls, 0)
  advance(1)
  await feed.pending
  assert.equal(calls, 1)
  advance(feed.state.nextCheck - now)
  await feed.pending
  assert.equal(calls, 2)
  await engine.stop()
  advance(7 * 3_600_000)
  assert.equal(calls, 2)
})

test('a fetch times out and a late response during shutdown cannot apply a patch', async t => {
  const sign = await publisher(t)
  const env = sign(issue(release, endpointUrl('https://late.example/rpc'), 3))
  const server = createServer(() => {})
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const { engine } = setup(t, { rpcConfig: { timeout: 50,
    fetch: (_, init) => fetch('http://127.0.0.1:' + server.address().port, init) } })
  await engine.start()
  await engine.patches.feed.check()
  assert.equal(engine.patches.feed.state.reason, 'timeout')

  const response = Promise.withResolvers()
  const b = setup(t, { rpcConfig: { fetch: () => response.promise } })
  await b.engine.start()
  const pending = b.engine.patches.feed.check()
  const aborted = new Promise(resolve => b.engine.http.signal.addEventListener('abort', resolve, { once: true }))
  const stopped = b.engine.stop()
  await aborted
  response.resolve(Response.json(document(env)))
  await Promise.all([stopped, pending])
  assert.equal(b.engine.patches.feed.state.result, 'cancelled')
  assert.equal(b.engine.patches.feed.state.nextCheck, null)
  assert.equal(b.engine.patches.digest(), releaseDigest)
  assert.deepEqual(rows(b.store), [])
})
