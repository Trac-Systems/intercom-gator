import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { engineWith, replay } from './add-token-fixture.js'

// Real public reads recorded 2026-11-20 00:07–00:09 UTC (.tmp recording script, read-only, 40 calls): node A adds
// DMT-NAT and its background search finds all three creations; a modern receiver B and an archived v0.1.0
// receiver (ae1c336) verify the three gator/new records and B measures the pools.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/add-token-dmt-nat-network.json', import.meta.url)))
const at = Date.parse(fixture.recordedAt) - 180_000
// The records node A sent live, stored as tuples of `announcedFields`.
const sentLive = fixture.announced.map(row => Object.fromEntries(fixture.announcedFields.map((k, i) => [k, row[i]])))
const DMT = '0x249130f5e2dd4cf278180c0df8273f3592ad1247'
const POOLS = { eth: '0xb44cc02c4ffa5ad68cc66ab404800a4f0029e5b6a9752b7cffc1bf8bbaaa92a3',
  usdc: '0x6ad53eb6c9f2f86b4d1edd95395d783eef8de8e182776539f776ceb9d90de524', weth: '0x4105f6d2b072deaee750f0fe0a69372a57da6fb8' }
const ADDER = 'a1'.repeat(32)

/** Every node reads CEX markets itself: ETH and USDC get local USD evidence the way a running node has it. */
function cexEvidence(engine, clock) {
  const { registry } = engine
  engine.publish([[registry.cex('coinbase', 'ETH', 'USD').id, '3000', '50000', null, null, null, clock()],
    [registry.cex('kraken', 'ETH', 'USD').id, '3000.5', '50000', null, null, null, clock()],
    [registry.cex('coinbase', 'USDC', 'USD').id, '1', '5000000', null, null, null, clock()],
    [registry.cex('kraken', 'USDC', 'USD').id, '1.0001', '5000000', null, null, null, clock()]])
  engine.book.dirty = true
  engine.book.refresh()
}
function deliver(engine, records) {
  for (const message of records) engine.receive('gator/new', { channel: 'gator/new', from: ADDER, message })
}
/** Budget and endpoint waits fast-forward the node's clock (both releases' RateLimited carry retryAt). */
async function patiently(node, run) {
  for (let i = 0; i < 50; i++) {
    try { return await run() } catch (error) {
      if (!(error?.retryAt > 0)) throw error
      node.advance(Math.max(1, error.retryAt - node.clock()))
    }
  }
  assert.fail('still rate limited')
}
async function verifyAll(node) {
  for (let i = 0; i < 20 && node.engine.hints.size; i++) await patiently(node, () => node.engine.verifyHint())
}

/** Node A: the add plus its background creation search (all three creations are found and announced). */
async function adder(t) {
  const a = await engineWith(replay(fixture.records), { at })
  t.after(async () => { await a.engine.stop(); a.store.close() })
  a.store.writer.prepare("INSERT INTO prices(asset,price,at,trust) VALUES ('ethereum:native','3000',?,'green')").run(a.clock())
  const result = await a.engine.addTokens.add({ address: DMT, chain: 'ethereum' })
  const job = a.engine.scheduler.jobs.get('discovery:added-creation')
  for (let i = 0; i < 40; i++) {
    if (!a.store.reader.prepare("SELECT 1 FROM engine_added_pools WHERE state='searching'").get()) break
    a.store.writer.prepare('UPDATE engine_added_pools SET retryAt=0').run()
    await patiently(a, () => job.run())
  }
  const announced = a.sent.filter(([ch, m]) => ch === 'gator/new' && m.t === 'pool').map(([, m]) => m)
  return { ...a, result, announced }
}

test('a second node that only receives the gator/new records registers DMT-NAT\'s pools and prices it', async t => {
  const a = await adder(t)
  const token = a.result.tokens[0]
  assert.deepEqual(a.announced.map(m => m.pool).sort(), Object.values(POOLS).sort())
  const byPool = list => [...list].sort((x, y) => (x.pool < y.pool ? -1 : 1))
  assert.deepEqual(byPool(a.announced), byPool(sentLive))
  const depth = Object.fromEntries(Object.entries(POOLS).map(([k, pool]) => [k, token.pools.find(p => p.pool === pool).liquidityUsd]))
  // The adding node's numbers (ETH at $3,000): ~$4.07k ETH V4, ~$1.28k WETH V2, ~$404 USDC V4.
  assert.ok(depth.eth > 4000 && depth.eth < 4200 && depth.weth > 1200 && depth.weth < 1350 && depth.usdc > 380 && depth.usdc < 430, JSON.stringify(depth))

  const b = await engineWith(replay(fixture.records), { at })
  t.after(async () => { await b.engine.stop(); b.store.close() })
  cexEvidence(b.engine, b.clock)
  deliver(b.engine, a.announced)
  await verifyAll(b)
  for (const pool of Object.values(POOLS)) assert.equal(b.engine.registry.markets.get('dex:ethereum:' + pool)?.fromHint, 1, pool)
  // The receiver measures every announced pool once through public endpoints and keeps those >= $100 priced.
  // (Replay: the recorded measurement read the pools in their recorded verification order.)
  b.store.writer.prepare(`UPDATE engine_announced_pools SET checkAt=CASE pool WHEN ? THEN 1 WHEN ? THEN 2 ELSE 3 END`)
    .run(POOLS.usdc, POOLS.eth)
  const measured = await patiently(b, () => b.engine.announcedPools.measure('ethereum'))
  assert.equal(measured, 3)
  const kept = b.store.reader.prepare('SELECT pool,depth,belowSince FROM engine_announced_pools ORDER BY depth DESC').all()
  assert.deepEqual(kept.map(r => r.pool), [POOLS.eth, POOLS.weth, POOLS.usdc])
  for (const r of kept) {
    assert.equal(r.belowSince, null)
    const own = depth[Object.keys(POOLS).find(k => POOLS[k] === r.pool)]
    assert.ok(Math.abs(r.depth - own) / own < 0.02, 'same depth as the adder: ' + r.depth + ' vs ' + own)
  }
  const detail = b.engine.asset('ethereum:' + DMT)
  assert.ok(detail.priceReal > 1e-8 && detail.priceReal < 1e-6, 'priced: ' + detail.priceReal)
  const markets = detail.markets.filter(m => m.kind === 'dex')
  assert.deepEqual(markets.map(m => m.id).sort(), Object.values(POOLS).map(p => 'dex:ethereum:' + p).sort())
  assert.ok(markets.every(m => m.price > 0))
  // Pool by pool in USD (ETH $3,000, USDC $1): the receiver's own reads match what the adding node measured, and
  // its asset price lies within the adder's pool prices.
  const usd = { native: 3000, '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 3000, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 1 }
  const adderUsd = {}, receiverUsd = {}
  for (const pool of Object.values(POOLS)) {
    const p = token.pools.find(x => x.pool === pool), other = p.token0 === DMT ? p.token1 : p.token0
    adderUsd[pool] = p.token0 === DMT ? p.price0in1 * usd[other] : usd[other] / p.price0in1
    receiverUsd[pool] = markets.find(m => m.id === 'dex:ethereum:' + pool).price * usd[other]
    assert.ok(Math.abs(receiverUsd[pool] - adderUsd[pool]) / adderUsd[pool] < 0.02, pool + ': ' + receiverUsd[pool] + ' vs ' + adderUsd[pool])
  }
  const range = Object.values(adderUsd)
  assert.ok(detail.priceReal >= Math.min(...range) * 0.98 && detail.priceReal <= Math.max(...range) * 1.02)
  assert.equal(detail.visibility, 'dust')
  // Dust rules hide it from ranked lists only: the hidden-inclusive list shows it with its price.
  const ranked = b.engine.queries.marketList({ limit: 500 })
  assert.equal(ranked.items.some(r => r.id === 'ethereum:' + DMT), false)
  const all = b.engine.queries.marketList({ limit: 500, include: 'hidden' })
  const row = all.items.find(r => r.id === 'ethereum:' + DMT)
  assert.ok(row && row.priceReal > 0 && row.visibility === 'dust')
  // A pool that falls under the floor is re-measured and forgotten after 24 h, keeping its registered identity.
  const fmt = o => Object.entries(o).map(([k, v]) => k.slice(0, 8) + '=' + v.toPrecision(4)).join(' ')
  t.diagnostic(`adder A pools USD ${fmt(adderUsd)} (result priceUsd ${token.priceUsd.toPrecision(4)}); receiver B pools USD ` +
    `${fmt(receiverUsd)}, asset ${detail.priceReal.toPrecision(4)} (${detail.trust}, ${detail.visibility}), depths ` +
    kept.map(r => Math.round(r.depth)).join('/') + ' USD')
})

test('a receiver keeps at most 64 announced pools per chain and forgets pools 24 h below the $100 floor', async t => {
  const a = await adder(t)
  const b = await engineWith(replay(fixture.records), { at })
  t.after(async () => { await b.engine.stop(); b.store.close() })
  cexEvidence(b.engine, b.clock)
  deliver(b.engine, a.announced)
  await verifyAll(b)
  const { limits } = b.engine.announcedPools
  // The rule under test, not the reads: the USDC pool measures $404 here.
  b.engine.evm.get('ethereum').snapshots = async pools => pools.map(() => ({ price: 1.2e-7, liquidity: 404 }))
  // 64 deeper announced pools already kept on this chain: the USDC pool ($404) is not kept, only re-measured.
  const insert = b.store.writer.prepare(`INSERT INTO engine_announced_pools(chain,pool,since,checkAt,checks,depth)
    VALUES ('ethereum',?,0,?,1,?)`)
  for (let i = 0; i < limits.perChain; i++) insert.run('0x' + String(i).padStart(40, 'f'), b.clock() + 3_600_000, 50_000)
  b.store.writer.prepare("UPDATE engine_announced_pools SET checkAt=? WHERE pool<>?").run(b.clock() + 3_600_000, POOLS.usdc)
  await patiently(b, () => b.engine.announcedPools.measure('ethereum'))
  const usdc = () => b.store.reader.prepare('SELECT * FROM engine_announced_pools WHERE pool=?').get(POOLS.usdc)
  assert.ok(usdc().belowSince > 0)
  assert.equal(usdc().checkAt - b.clock() <= limits.recheck[1], true)
  // 24 h later (still not kept) it is dropped from the measurement set; the market itself stays registered.
  b.advance(limits.forgetAfter + 1000)
  b.store.writer.prepare('UPDATE engine_announced_pools SET checkAt=? WHERE pool<>?').run(b.clock() + 3_600_000, POOLS.usdc)
  b.store.writer.prepare('UPDATE engine_announced_pools SET checkAt=0 WHERE pool=?').run(POOLS.usdc)
  await patiently(b, () => b.engine.announcedPools.measure('ethereum'))
  assert.equal(usdc(), undefined)
  assert.ok(b.engine.registry.markets.has('dex:ethereum:' + POOLS.usdc))
})

// The archived v0.1.0 engine (ae1c336): GATOR_V010_DIR, or a git archive made for this test.
function legacyRelease(t) {
  if (process.env.GATOR_V010_DIR) return { dir: process.env.GATOR_V010_DIR }
  const dir = mkdtempSync(join(import.meta.dirname, 'v010-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  try {
    execFileSync('sh', ['-c', 'cd "$(git rev-parse --show-toplevel)" && git archive ae1c336 packages | tar -x -C "$1"', 'sh', dir],
      { cwd: import.meta.dirname, stdio: 'ignore' })
  } catch { return null }
  return existsSync(join(dir, 'packages/engine/src/index.js')) ? { dir } : null
}

test('a v0.1.0 receiver verifies the announced records with no penalty or strike', async t => {
  const legacy = legacyRelease(t)
  if (!legacy) return t.skip('ae1c336 is not available (shallow clone without git history)')
  const load = path => import(pathToFileURL(resolve(legacy.dir, 'packages', path)))
  const [old, oldBundle] = [await load('engine/src/index.js'), await load('bundle/src/index.js')]
  const a = await adder(t)
  const c = await engineWith(replay(fixture.records), { at, Engine: old.Engine, migrations: old.migrations,
    bundle: oldBundle.loadBundle() })
  t.after(async () => { await c.engine.stop(); c.store.close() })
  const before = c.engine.hints.rank(ADDER)
  deliver(c.engine, a.announced)
  assert.equal(c.engine.hints.size, 3)
  await verifyAll(c)
  for (const pool of Object.values(POOLS)) assert.ok(c.engine.registry.markets.has('dex:ethereum:' + pool), pool)
  assert.equal(c.engine.hints.rank(ADDER), before)
  assert.equal(c.engine.hints.penalties.size, 0)
  assert.equal(c.engine.book.muted(ADDER), false)
  // v0.1.0 registers the token and its three pools (peer origin) but never reads peer-origin pool state itself:
  // it shows DMT-NAT as unconfirmed, without a price of its own, until a peer's px report for these markets arrives.
  const detail = c.engine.asset('ethereum:' + DMT)
  assert.equal(detail.priceReal, null)
  assert.equal(detail.visibility, 'unconfirmed')
  assert.equal(detail.markets.filter(m => m.kind === 'dex').length, 3)
})
