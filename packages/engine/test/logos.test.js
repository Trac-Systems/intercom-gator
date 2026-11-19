import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '@gator/store'
import { loadBundle } from '@gator/bundle'
import { migrations } from '../src/index.js'
import { RateLimited, RequestBudget } from '../src/scheduler/index.js'
import { HttpSources } from '../src/sources/http.js'
import {
  Logos, LOGO_LIMITS, checksumAddress, inspectImage, logoRefs, retryDelay,
} from '../src/logos/index.js'
import { withLogos } from '../src/logos/rows.js'

/** Smallest well-formed headers for each accepted container (pixel data is never decoded). */
function png(width, height, { animated = false } = {}) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length)
    head.write(type, 4, 'latin1')
    return Buffer.concat([head, data, Buffer.alloc(4)])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    ...(animated ? [chunk('acTL', Buffer.alloc(8))] : []), chunk('IDAT', Buffer.alloc(4)), chunk('IEND', Buffer.alloc(0))])
}
function jpeg(width, height) {
  const sof = Buffer.from([0xff, 0xc0, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0])
  const app0 = Buffer.from([0xff, 0xe0, 0, 4, 0, 0])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])])
}
function webp(kind, width, height, flags = 0) {
  const body = Buffer.alloc(18)
  if (kind === 'VP8L') {
    body[0] = 0x2f
    body.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 1)
  } else if (kind === 'VP8X') {
    body[0] = flags
    body.writeUIntLE(width - 1, 4, 3)
    body.writeUIntLE(height - 1, 7, 3)
  } else {
    body.set([0x9d, 0x01, 0x2a], 3)
    body.writeUInt16LE(width, 6)
    body.writeUInt16LE(height, 8)
  }
  const out = Buffer.concat([Buffer.from('RIFF0000WEBP' + kind, 'latin1'), Buffer.alloc(4), body])
  out.writeUInt32LE(out.length - 8, 4)
  return out
}

test('image checks accept PNG, JPEG and WebP headers and reject everything else', () => {
  assert.deepEqual(inspectImage(png(256, 256)), { ext: 'png', type: 'image/png', width: 256, height: 256 })
  assert.deepEqual(inspectImage(jpeg(200, 180)), { ext: 'jpg', type: 'image/jpeg', width: 200, height: 180 })
  assert.equal(inspectImage(webp('VP8L', 128, 128)).width, 128)
  assert.equal(inspectImage(webp('VP8X', 512, 512)).height, 512)
  assert.equal(inspectImage(webp('VP8 ', 64, 64)).ext, 'webp')
  const rejects = [
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), /not a PNG/],
    [Buffer.from('GIF89a\x10\x00\x10\x00', 'latin1'), /not a PNG/],
    [Buffer.from('<!doctype html><title>404</title>'), /not a PNG/],
    [png(513, 513), /larger than 512 px/],
    [png(300, 200), /not square/],
    [png(8, 8), /smaller/],
    [png(64, 64, { animated: true }), /animated/],
    [webp('VP8X', 64, 64, 0x02), /animated/],
    [Buffer.concat([png(64, 64), Buffer.alloc(LOGO_LIMITS.maxBytes)]), /larger than 65536 bytes/],
  ]
  for (const [bytes, reason] of rejects) assert.throws(() => inspectImage(bytes), reason)
})

test('references cover the shipped chains, tokens and exchanges with licensed sources', () => {
  const bundle = loadBundle()
  const refs = logoRefs(bundle)
  const sources = new Map(bundle.tokens.sources.map(s => [s.id, s]))
  assert.ok([...refs.keys()].filter(k => k.startsWith('chain:')).length >= 29)
  assert.ok([...refs.keys()].filter(k => k.startsWith('asset:')).length >= 1000)
  assert.ok([...refs.keys()].filter(k => k.startsWith('exchange:')).length >= 20)
  assert.equal(sources.get('trustwallet-assets').license, 'MIT')
  // Pinned to one commit: the same URL always names the same bytes.
  for (const c of bundle.chains.filter(c => c.logo)) {
    assert.match(c.logo, /^https:\/\/raw\.githubusercontent\.com\/trustwallet\/assets\/[0-9a-f]{40}\//)
    assert.ok(sources.has(c.logoSource))
  }
  assert.equal(refs.get('asset:base:native'), refs.get('chain:ethereum'))
  assert.equal(checksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'), '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')
})

function setup(t, { fetch, bundle, now = { t: 1_800_000_000_000 } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'engine-logos-'))
  const store = openStore({ file: join(dir, 'test.db'), migrations })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const clock = () => now.t
  const budget = new RequestBudget('normal', undefined, clock)
  const http = new HttpSources({ budget, clock })
  bundle ??= {
    chains: [
      { id: 'ethereum', family: 'evm', logo: 'https://logos.example/eth.png',
        tokenLogo: 'https://logos.example/eth/{address}.png' },
      { id: 'solana', family: 'solana', tokenLogo: 'https://logos.example/sol/{address}.png' },
      { id: 'bitcoin', family: 'bitcoin', tokenLogo: 'https://logos.example/btc/{address}.png' },
    ],
    tokens: { tokens: [{ id: 'ethereum:native', logo: 'https://logos.example/eth.png' }],
      exchanges: [], exchangeLogos: [{ id: 'kraken', logo: 'https://venue.example/icon.png' }] },
  }
  const make = () => new Logos({ store, http, budget, clock, bundle, fetch })
  return { store, http, budget, now, make }
}

test('a logo is fetched on demand, stored by SHA-256 and served locally; failures are negative-cached', async t => {
  const image = png(256, 256)
  const sha = createHash('sha256').update(image).digest('hex')
  const calls = []
  const answers = new Map([['https://logos.example/eth.png', () => new Response(image, { headers: { 'content-type': 'image/png' } })],
    ['https://venue.example/icon.png', () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })]])
  const fetch = async (url, init) => {
    calls.push({ url, redirect: init.redirect })
    const answer = answers.get(url)
    if (!answer) return new Response('missing', { status: 404 })
    return answer()
  }
  const { make, now, store } = setup(t, { fetch })
  let logos = make()
  // One host is asked at most once a second (half of 120 requests per minute).
  const step = () => { now.t += 1000; return logos.fetchNext() }
  assert.equal(logos.chain('ethereum'), null, 'first view answers at once and queues the fetch')
  assert.equal(logos.asset('ethereum:native'), null)
  assert.equal(logos.exchange('unknown'), null)
  assert.equal(logos.demanded.size, 2)
  assert.equal(await step(), 'chain:ethereum')
  assert.equal(calls[0].redirect, 'error')
  assert.equal(logos.chain('ethereum'), '/img/' + sha + '.png')
  await assert.rejects(logos.fetchNext(), RateLimited, 'same host within 1 s waits')
  assert.equal(await step(), 'asset:ethereum:native')
  assert.equal(logos.asset('ethereum:native'), '/img/' + sha + '.png', 'same bytes, one stored image')
  assert.equal(store.reader.prepare('SELECT count(*) AS n FROM engine_logo_images').get().n, 1)
  assert.deepEqual(logos.image(sha, 'png'), { type: 'image/png', bytes: image })
  assert.equal(logos.image(sha, 'webp'), null)
  assert.equal(logos.image('../' + sha, 'png'), null)

  // An SVG from the internet is refused and not retried for an hour.
  assert.equal(logos.exchange('kraken'), null)
  assert.equal(await step(), 'exchange:kraken')
  const row = store.reader.prepare("SELECT failures,nextRetry,reason FROM engine_logos WHERE ref='exchange:kraken'").get()
  assert.deepEqual({ ...row }, { failures: 1, nextRetry: now.t + 3_600_000, reason: 'not a PNG, WebP or JPEG image' })
  assert.equal(logos.exchange('kraken'), null)
  assert.equal(logos.next(), null, 'cooling down: nothing to fetch')
  assert.equal(retryDelay(2, true), 4 * 3_600_000)
  assert.equal(retryDelay(1, false), 600_000)

  // The state survives a restart; after the retry time the reference is due again and can succeed.
  logos = make()
  assert.equal(logos.chain('ethereum'), '/img/' + sha + '.png')
  now.t += 3_600_000
  answers.set('https://venue.example/icon.png', () => new Response(webp('VP8L', 180, 180)))
  assert.equal(logos.exchange('kraken'), null)
  assert.equal(await step(), 'exchange:kraken')
  assert.match(logos.exchange('kraken'), /^\/img\/[0-9a-f]{64}\.webp$/)
})

test('oversize bodies, network errors and the request budget are handled without blocking', async t => {
  let mode = 'big'
  const fetch = async () => {
    if (mode === 'big') return new Response(new Uint8Array(70_000), { headers: { 'content-length': '70000' } })
    if (mode === 'stream') return new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(30_000)) } }))
    throw new TypeError('fetch failed')
  }
  const { make, now, budget, store } = setup(t, { fetch })
  const logos = make()
  const step = () => { now.t += 1000; return logos.fetchNext() }
  logos.chain('ethereum')
  await step()
  assert.match(store.reader.prepare("SELECT reason FROM engine_logos WHERE ref='chain:ethereum'").get().reason, /larger/)
  now.t += 3_600_000
  mode = 'stream'
  logos.chain('ethereum')
  await step()
  assert.equal(store.reader.prepare("SELECT failures FROM engine_logos WHERE ref='chain:ethereum'").get().failures, 2)
  now.t += 4 * 3_600_000
  mode = 'down'
  logos.asset('ethereum:native')
  await step()
  const down = store.reader.prepare("SELECT reason,nextRetry FROM engine_logos WHERE ref='asset:ethereum:native'").get()
  assert.deepEqual({ ...down }, { reason: 'network error', nextRetry: now.t + 600_000 })
  // An exhausted budget surfaces as RateLimited so the scheduler waits; nothing is recorded as failed.
  budget.setLimit(1)
  now.t += 3_600_000
  budget.take()
  logos.asset('ethereum:native')
  await assert.rejects(logos.fetchNext(), RateLimited)
  assert.equal(store.reader.prepare("SELECT failures FROM engine_logos WHERE ref='asset:ethereum:native'").get().failures, 1)
})

test('discovered EVM and Solana tokens use the chain template; other families and bad ids do not', async t => {
  const { make } = setup(t, { fetch: async () => new Response('', { status: 404 }) })
  const logos = make()
  assert.equal(logos.resolve('asset:ethereum:0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'),
    'https://logos.example/eth/0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed.png')
  assert.equal(logos.resolve('asset:solana:So11111111111111111111111111111111111111112'),
    'https://logos.example/sol/So11111111111111111111111111111111111111112.png')
  assert.equal(logos.resolve('asset:bitcoin:bc1qxyz'), null)
  assert.equal(logos.resolve('asset:ethereum:0xZZ'), null)
  assert.equal(logos.resolve('asset:solana:../../etc'), null)
  assert.equal(logos.resolve('asset:ethereum:native'), 'https://logos.example/eth.png')
})

test('pre-warm walks chains and exchanges, then the top-ranked assets, within the profile count', async t => {
  const { make, store, now } = setup(t, { fetch: async () => new Response('', { status: 404 }) })
  store.writer.prepare("INSERT INTO assets(id,chain,address,symbol,name,rank) VALUES ('ethereum:native','ethereum','native','ETH','Ether',1)").run()
  const logos = make()
  assert.deepEqual(logos.prewarm(now.t), ['chain:ethereum', 'exchange:kraken', 'asset:ethereum:native'])
  const order = []
  for (let i = 0; i < 4; i++) { now.t += 1000; order.push(await logos.fetchNext()) }
  assert.deepEqual(order, ['chain:ethereum', 'exchange:kraken', 'asset:ethereum:native', null])
  assert.equal(logos.hasWork(), false)
  assert.deepEqual(logos.stats(), { refs: 3, stored: 0, failed: 3, queued: 0 })
})

test('API rows gain logo fields without changing anything else', () => {
  const logos = { asset: id => (id === 'a:1' ? '/img/a.png' : null), chain: id => '/img/' + id + '.png',
    exchange: id => (id === 'kraken' ? '/img/k.png' : null) }
  assert.deepEqual(withLogos(logos, 'markets', { items: [{ id: 'a:1', x: 1 }], total: 1 }),
    { items: [{ id: 'a:1', x: 1, logo: '/img/a.png' }], total: 1 })
  assert.deepEqual(withLogos(logos, 'chains', { items: [{ chain: 'base' }] }).items[0].logo, '/img/base.png')
  assert.deepEqual(withLogos(logos, 'exchanges', { items: [{ id: 'kraken' }] }).items[0].logo, '/img/k.png')
  const detail = withLogos(logos, 'assets', { id: 'a:1', markets: [{ id: 'cex:kraken:A-USD' }, { id: 'dex:base:0x1' }] })
  assert.deepEqual([detail.logo, ...detail.markets.map(m => m.venueLogo)], ['/img/a.png', '/img/k.png', null])
  assert.equal(withLogos(logos, 'assets', { id: 'a:1' }, 'candles').logo, undefined)
  assert.equal(withLogos(logos, 'search', { tokens: [{ id: 'a:1' }] }).tokens[0].logo, '/img/a.png')
  assert.equal(withLogos(logos, 'portfolio', { holdings: [{ asset: 'a:1' }] }).holdings[0].logo, '/img/a.png')
  assert.deepEqual(withLogos(logos, 'derivatives', { items: [{ exchange: 'kraken' }] }), { items: [{ exchange: 'kraken' }] })
  assert.equal(withLogos(undefined, 'markets', null), null)
})

test('storage pressure evicts template-derived logos first and does not refetch them for a day', async t => {
  let n = 0
  const fetch = async () => new Response(png(64 + n++, 64 + n))
  const { make, now, store } = setup(t, { fetch })
  const logos = make()
  const derived = 'ethereum:0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'
  for (const ask of [() => logos.chain('ethereum'), () => logos.asset(derived)]) {
    ask()
    now.t += 1000
    await logos.fetchNext()
  }
  assert.ok(logos.chain('ethereum') && logos.asset(derived))
  assert.equal(store.transaction(() => logos.evict(store.writer, now.t)), 2)
  assert.equal(store.reader.prepare('SELECT count(*) AS n FROM engine_logo_images').get().n, 0)
  assert.equal(logos.asset(derived), null)
  assert.equal(logos.due('asset:' + derived, now.t) || logos.due('chain:ethereum', now.t), false, 'evicted references wait a day')
  const order = []
  const second = make()
  now.t += 86_400_000 + 1000
  for (const ask of [() => second.chain('ethereum'), () => second.asset(derived)]) ask()
  order.push(await second.fetchNext())
  now.t += 1000
  order.push(await second.fetchNext())
  assert.deepEqual(order.sort(), ['asset:' + derived, 'chain:ethereum'].sort())
  // With both stored again, the template-derived image is the first to go.
  assert.equal(store.transaction(() => second.evict(store.writer, now.t)), 2)
})

