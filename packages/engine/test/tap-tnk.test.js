import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { bundleDigest, validateBundle } from '@gator/bundle'
import { openStore } from '@gator/store'
import { migrations as socialMigrations } from '@gator/social'
import { Engine, migrations } from '../src/index.js'
import { createRouter } from '../../api/src/routes.js'
import { tickerRecords } from '../src/sources/bundle-adapter.js'
import { seedPlan } from '../src/sources/evm.js'
import { tapMintedTotal } from '../src/sources/supply-feeds.js'
import { extensions, PATCHED, release, tap, tapBundle, tapErc20, tnk } from './tap-release.js'

// TAP Protocol (Bitcoin ordinals metaprotocol, tick "tap") and Trac Network (TNK) are CEX-only natives. TAP also
// trades as the bridged ERC-20 that PaidExtras charges in, in the Uniswap V2 TAP/USDT pool below.
// A v0.1.1 node holds the signed v0.1.0 release plus the shared root patch (chains, natives, the plain ERC-20, the
// TAP reader APIs) and reads it through the release extension (venue labels, the TAP coin group).
const ethUsdt = 'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7'
const originTrail = 'ethereum:0xaa7a9ca87d3694b5755f213b5d04094b8d0f0a6f'
const pool = '0x1563e9af51616e78830de3325da752de369c1714'
const start = Date.UTC(2026, 10, 19, 21)

class Transport extends EventEmitter {
  publicKey = 'a'.repeat(64)
  topics = new Map()
  channels() { return [...this.topics.keys()] }
  async join(channel, policy) { this.topics.set(channel, policy); return true }
  async leave(channel) { return this.topics.delete(channel) }
  sent = []
  send(channel, message) { this.sent.push([channel, message]); return true }
}

async function engineFor(t, bundle, profile = 'small', { backgroundJobs = [], fetch, ext = extensions } = {}) {
  const store = openStore({ file: ':memory:', profile, migrations: [...migrations, ...socialMigrations] })
  let now = start
  const engine = new Engine({ bundle, extensions: ext, transport: new Transport(), store, clock: () => now, backgroundJobs,
    random: () => 0.5,
    rpcConfig: { bundleDigest: '0'.repeat(64), fetch: fetch ?? (() => assert.fail('Unexpected HTTP read')), timeout: 500,
      retries: 0, requestsPerMinute: 60 } })
  await engine.start()
  clearTimeout(engine.timer)
  t.after(async () => { await engine.stop(); store.close() })
  return { engine, store, advance: ms => { now += ms }, now: () => now }
}

test('after the shared patch v0.1.1 reads TAP Protocol, Trac Network and the bridged TAP as one coin', async t => {
  const signed = tapBundle()
  const chain = id => signed.chains.find(c => c.id === id)
  const token = id => signed.tokens.tokens.find(t => t.id === id)
  assert.equal(bundleDigest(signed), PATCHED)
  assert.deepEqual([chain('tap-protocol').family, chain('tap-protocol').native, chain('tap-protocol').endpoints],
    ['cex-only', { symbol: 'TAP', decimals: 18 }, []])
  assert.deepEqual([chain('trac').family, chain('trac').native, chain('trac').explorer],
    ['cex-only', { symbol: 'TNK', decimals: 18 }, 'https://explorer.trac.network'])
  // Signed data carries no coin group; the release extension adds it for this node only.
  assert.equal(token(tap).coin, undefined)
  assert.equal(token(tapErc20).coin, undefined)
  const { engine } = await engineFor(t, signed)
  const read = id => engine.bundle.tokens.tokens.find(t => t.id === id)
  assert.deepEqual([read(tap).coin, read(tap).coinSupply], ['tap-protocol-tap', 'issuance'])
  // The ERC-20 holds only the bridged share (3.14M of 21M on 2026-11-19), so it never adds supply to the coin.
  assert.deepEqual([read(tapErc20).coin, read(tapErc20).coinSupply, read(tapErc20).decimals],
    ['tap-protocol-tap', 'escrow-backed', 18])
  assert.equal(read(tnk).coin, undefined)
  assert.ok(engine.bundle.tokens.coinGroups.some(g => g.id === 'tap-protocol-tap'))
  // The signed chain is untouched: same digest as every other version holding this patch.
  assert.equal(engine.patches.current, signed)
  assert.equal(bundleDigest(engine.patches.current), PATCHED)
  // PaidExtras' payment token is the same contract (DESIGN.md §8).
  assert.equal(tapErc20, 'ethereum:0x5e7f6e008c6d9d7ad4c7eb75bd4ce62864cc7454')
})

test('Gate and MEXC labels bind to the signed natives through the extension venue maps (pinned); TRAC stays OriginTrail', async t => {
  const { engine } = await engineFor(t, tapBundle())
  const { registry } = engine
  const gate = registry.cex('gate', 'TAPPROTOCOL', 'USDT', 'TAPPROTOCOL_USDT')
  const mexc = registry.cex('mexc', 'TAP', 'USDT', 'TAPUSDT')
  const gateTnk = registry.cex('gate', 'TNK', 'USDT', 'TNK_USDT')
  const mexcTnk = registry.cex('mexc', 'TNK', 'USDT', 'TNKUSDT')
  assert.deepEqual([gate.id, gate.base, gate.quote], ['cex:gate:TAPPROTOCOL-USDT', tap, ethUsdt])
  assert.deepEqual([mexc.id, mexc.base], ['cex:mexc:TAP-USDT', tap])
  assert.deepEqual([gateTnk.base, mexcTnk.base], [tnk, tnk])
  // Explicit bundle mappings are never detached by a collision split.
  for (const m of [gate, mexc, gateTnk, mexcTnk]) assert.equal(registry.mapped(m), true, m.id)
  // OriginTrail's TRAC (an unrelated ERC-20) keeps its own identity on both venues.
  assert.equal(registry.cex('gate', 'TRAC', 'USDT').base, originTrail)
  assert.equal(registry.cex('mexc', 'TRAC', 'USDT').base, originTrail)
  // The wire market IDs keep the venue's own labels, as a v0.1.0 node already names these pairs.
  assert.equal(registry.known('cex:gate:TAPPROTOCOL-USDT').base, tap)
})

test('the existing Gate and MEXC ticker mappings read price, 24 h volume and the venue 24 h move', async t => {
  const { engine } = await engineFor(t, tapBundle())
  const gate = engine.registry.venues.get('gate'), mexc = engine.registry.venues.get('mexc')
  // Live rows, 2026-11-19 ~21:05 UTC.
  const [g] = tickerRecords(gate, [{ currency_pair: 'TAPPROTOCOL_USDT', last: '0.04393', lowest_ask: '0.04393',
    highest_bid: '0.04392', change_percentage: '-2.74', base_volume: '79097', quote_volume: '3495.79609' }])
  assert.deepEqual([g.pair, g.price, g.baseVolume, g.quoteVolume, g.bid, g.ask],
    [['TAPPROTOCOL', 'USDT'], '0.04393', '79097', '3495.79609', '0.04392', '0.04393'])
  assert.ok(Math.abs(g.dayRatio - 0.9726) < 1e-9)
  mexc.catalogCache.set('TNKUSDT', { pair: ['TNK', 'USDT'], derivative: false, halted: false })
  const [m] = tickerRecords(mexc, [{ symbol: 'TNKUSDT', lastPrice: '0.07271', openPrice: '0.07846', volume: '718135.44',
    quoteVolume: '55441.59768', bidPrice: '0.07225', askPrice: '0.07338', priceChangePercent: '-0.0732' }])
  assert.deepEqual([m.pair, m.price, m.baseVolume], [['TNK', 'USDT'], '0.07271', '718135.44'])
  assert.ok(Math.abs(m.dayRatio - 0.07271 / 0.07846) < 1e-12)
})

/** Gate + MEXC for TAP and TNK, Bitstamp for USDT/USD; tokens: the new ones and the Tether group. */
async function venues(t, options) {
  const bundle = structuredClone(tapBundle())
  bundle.exchanges = bundle.exchanges.filter(e => ['gate', 'mexc', 'bitstamp'].includes(e.id))
  bundle.tokens.tokens = bundle.tokens.tokens.filter(token => token.coin === 'tether-usdt' || token.id.endsWith(':native') ||
    [tap, tnk, tapErc20].includes(token.id))
  // A slim but valid signed bundle: the node's extension (coin group) is checked against the bundle's coin rules.
  for (const token of bundle.tokens.tokens) token.links = []
  validateBundle(bundle)
  const f = await engineFor(t, bundle, 'small', options)
  const { engine } = f
  const read = (venue, base, quote, price, volume) => {
    const market = engine.registry.cex(venue, base, quote)
    engine.publish([[market.id, String(price), String(volume), null, null, null, f.now()]])
    engine.book.dirty = true
    return market
  }
  const intel = { risk: { get: () => null }, claims: { list: () => [] }, placements: { state: () => null },
    newTokens: { list: () => [] } }
  const request = createRouter({ engine, store: f.store, transport: engine.transport, social: new EventEmitter(),
    release: { bundle }, clock: f.now, intel })
  read('bitstamp', 'USDT', 'USD', 1, 5e6)
  return { ...f, read, request }
}

test('two own venue reads make TAP and TNK green; the TAP page lists both venues and the Ethereum pool', async t => {
  const { engine, read, request, now } = await venues(t)
  read('gate', 'TAPPROTOCOL', 'USDT', 0.04393, 79097)
  read('mexc', 'TAP', 'USDT', 0.0438, 126890.81)
  read('gate', 'TNK', 'USDT', 0.07231, 20619)
  read('mexc', 'TNK', 'USDT', 0.07271, 718135.44)
  const market = engine.registry.pool({ chain: 'ethereum', pool, token0: tapErc20.split(':')[1],
    token1: ethUsdt.split(':')[1], dex: 'uniswap-v2', kind: 'v2', block: 1, tx: null, firstSeen: now() })
  assert.deepEqual([market.id, market.base, market.quote], ['dex:ethereum:' + pool, tapErc20, ethUsdt])
  engine.publish([[market.id, '0.04334', '120000', null, null, null, now()]])
  engine.book.dirty = true
  engine.book.refresh()
  for (const id of [tap, tnk]) {
    const p = engine.book.snapshots.get(id)
    assert.equal(p.trust, 'green', id + ' ' + JSON.stringify(p.why))
    assert.ok(p.why.independentSources >= 2)
  }
  assert.ok(Math.abs(engine.book.snapshots.get(tap).price - 0.0439) < 0.0005)
  assert.ok(Math.abs(engine.book.snapshots.get(tnk).price - 0.0725) < 0.0005)
  const page = await request('GET', '/assets/' + tap)
  assert.equal(page.coin, 'tap-protocol-tap')
  assert.equal(page.coinGroup.members, 2)
  assert.deepEqual(page.contracts.map(c => [c.id, c.chainName, c.role, c.explorer]), [
    [tap, 'TAP Protocol', 'native', 'https://tapscope.io'],
    [tapErc20, 'Ethereum', 'bridged', 'https://etherscan.io/token/0x5e7f6e008c6d9d7ad4c7eb75bd4ce62864cc7454'],
  ])
  const ids = page.markets.map(m => m.id ?? m.market)
  for (const id of ['cex:gate:TAPPROTOCOL-USDT', 'cex:mexc:TAP-USDT', 'dex:ethereum:' + pool]) assert.ok(ids.includes(id), id)
  // The markets list shows the coin once.
  const list = await request('GET', '/markets', { include: 'hidden' })
  assert.equal(list.items.filter(r => r.coin === 'tap-protocol-tap').length, 1)
})

test('without a TAP Protocol supply the coin has no cap, even when the bridged ERC-20 has its own', async t => {
  const { engine, read, request, now } = await venues(t)
  read('gate', 'TAPPROTOCOL', 'USDT', 0.04393, 79097)
  read('mexc', 'TAP', 'USDT', 0.0438, 126890.81)
  const market = engine.registry.pool({ chain: 'ethereum', pool, token0: tapErc20.split(':')[1],
    token1: ethUsdt.split(':')[1], dex: 'uniswap-v2', kind: 'v2', block: 1, tx: null, firstSeen: now() })
  engine.publish([[market.id, '0.04334', '120000', null, null, null, now()]])
  // The ERC-20's totalSupply() on 2026-11-19: the bridged 3.14M, not TAP's 21M.
  engine.setSupply(tapErc20, { totalSupply: 3140670.894284045 })
  engine.book.dirty = true
  const list = await request('GET', '/markets', { include: 'hidden' })
  const row = list.items.find(r => r.coin === 'tap-protocol-tap')
  assert.ok(row)
  assert.equal(row.marketCap, null)
  assert.equal(row.coinMarketCap, null)
  const page = await request('GET', '/assets/' + tap)
  assert.equal(page.coinGroup.marketCap, null)
})

test('the Ethereum seeder always probes the bridged TAP, beyond the small profile rank cutoff', async t => {
  const bundle = tapBundle()
  const { engine } = await engineFor(t, bundle, 'small')
  const source = engine.evm.get('ethereum')
  const plan = seedPlan(source)
  const address = tapErc20.split(':')[1], usdt = ethUsdt.split(':')[1]
  // Unranked bundle tokens sort by address; TAP sits beyond the first 100 Ethereum tokens of the shipped bundle.
  const unranked = bundle.tokens.tokens.filter(t => t.id.startsWith('ethereum:0x')).map(t => t.id.split(':')[1]).sort()
  assert.ok(unranked.indexOf(address) >= source.limits.tokens)
  assert.ok(plan.pairs.some(([a, b]) => a === address && b === usdt), 'TAP/USDT pair probed')
  const v2 = plan.methods.find(m => m.d.address === '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f')
  assert.ok(v2, 'Uniswap V2 factory probed')
})

// The TAP reader's tap deployment and mint remainder, 2026-11-19 ~21:10 UTC.
const deployment = { result: { tick: 'tap', max: '21000000000000000000000000', lim: '21000000000000000000000000', dec: 18,
  blck: 801996, tx: 'cbc1900b8b0f02fdf481137c587896781a721a35369d4eae47c7445622ecb671', vo: 0, val: '546',
  ins: 'cbc1900b8b0f02fdf481137c587896781a721a35369d4eae47c7445622ecb671i0', num: 21953432, ts: 1691356378 } }

test('the TAP reader gives the minted total and rejects another tick, other decimals or an open mint', () => {
  assert.deepEqual(tapMintedTotal(deployment, { result: '0' }, start),
    { total: '21000000', at: start, method: 'tap-minted-total', source: 'tap-reader-deployment' })
  assert.equal(tapMintedTotal(deployment, { result: '1000000000000000000000000' }, start).total, '20000000')
  for (const [d, left] of [
    [{ result: { ...deployment.result, tick: 'tap2' } }, '0'], [{ result: { ...deployment.result, dec: 8 } }, '0'],
    [deployment, deployment.result.max], [deployment, '-1'], [{ result: { ...deployment.result, max: 21e24 } }, '0'],
  ]) assert.throws(() => tapMintedTotal(d, { result: left }, start))
})

test('the TAP Protocol supply job sets a local total and the coin lists a cap from total supply', async t => {
  const urls = []
  const fetch = async url => {
    urls.push(String(url))
    if (String(url) === 'https://tap-reader-tw.tap-hosting.xyz/getDeployment/tap') return Response.json(deployment)
    if (String(url) === 'https://tap-reader-tw.tap-hosting.xyz/getMintTokensLeft/tap') return Response.json({ result: '0' })
    assert.fail('Unexpected HTTP read ' + url)
  }
  const { engine, read, request, advance } = await venues(t, { backgroundJobs: ['supply:tap-protocol'], fetch })
  const job = engine.scheduler.jobs.get('supply:tap-protocol')
  assert.ok(job)
  // Both reads share one host budget; a deferred second read resumes without repeating the first.
  for (let i = 0; i < 20 && engine.registry.assets.get(tap).totalSupply == null; i++) {
    try { await job.run() } catch (error) { if (error.message !== 'Request budget unavailable') throw error }
    advance(10_000)
  }
  assert.deepEqual(urls, ['https://tap-reader-tw.tap-hosting.xyz/getDeployment/tap',
    'https://tap-reader-tw.tap-hosting.xyz/getMintTokensLeft/tap'])
  assert.equal(engine.registry.assets.get(tap).totalSupply, 21e6)
  assert.equal(engine.registry.assets.get(tap).supply ?? null, null)
  // Unclear terms keep the reading local: nothing goes out on gator/meta.
  assert.deepEqual(engine.transport.sent.filter(([channel]) => channel === 'gator/meta'), [])
  read('gate', 'TAPPROTOCOL', 'USDT', 0.04393, 79097)
  read('mexc', 'TAP', 'USDT', 0.0438, 126890.81)
  const list = await request('GET', '/markets', { include: 'hidden' })
  const row = list.items.find(r => r.coin === 'tap-protocol-tap')
  const price = engine.book.snapshots.get(tap).price
  assert.ok(Math.abs(row.marketCap - 21e6 * price) < 1, JSON.stringify(row))
  const page = await request('GET', '/assets/' + tap)
  assert.equal(page.capBasis, 'total')
  assert.ok(Math.abs(page.marketCap - 21e6 * price) < 1)
})

test('without the shared patch the TAP/TNK extension entries name unknown assets: they are skipped', async t => {
  const { engine } = await engineFor(t, release)
  // Only the Binance-Peg USDT display name applies; venues, coins and the digest are the signed release's own.
  assert.deepEqual(engine.bundle.tokens.tokens.filter(token => token.displayName).map(token => token.id),
    ['bsc:0x55d398326f99059ff775485246999027b3197955'])
  assert.equal(engine.bundle.exchanges.some(e => Object.hasOwn(e, 'symbolMap')), false)
  assert.equal(engine.registry.assets.has(tap), false)
  assert.equal(engine.registry.cex('gate', 'TAPPROTOCOL', 'USDT').base, 'unresolved:gate:TAPPROTOCOL')
  assert.equal(engine.registry.mapped(engine.registry.cex('gate', 'TAPPROTOCOL', 'USDT')), false)
  assert.equal(engine.registry.cex('gate', 'TRAC', 'USDT').base, originTrail)
  assert.equal(engine.patches.digest(), bundleDigest(release))
})
