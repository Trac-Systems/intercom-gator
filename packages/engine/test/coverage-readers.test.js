import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { loadBundle } from '@gator/bundle'
import { openStore } from '@gator/store'
import { Engine, migrations } from '../src/index.js'
import { discoveryState, migrations as intelMigrations } from '../src/intel/schema.js'
import { ReporterSlice } from '../src/coverage/split.js'
import { verifySeedIdentity } from '../src/coverage/seed-identity.js'
import { seedPlan } from '../src/sources/evm.js'
import { v4PoolId, v4StateCall, word, ZERO } from '../src/sources/evm-abi.js'
import { channelFor } from '../src/obs/index.js'
import { RateLimited } from '../src/scheduler/index.js'

const key = n => word(n)
const address = n => '0x' + word(n).slice(-40)
const start = Date.UTC(2026, 10, 19)
function node(t, own = 1, n = 7, extraMigrations = []) {
  const bundle = loadBundle(), store = openStore({ file: ':memory:', migrations: [...migrations, ...extraMigrations], profile: 'small' })
  const joined = new Set()
  const transport = Object.assign(new EventEmitter(), { publicKey: key(own), channels: () => [...joined],
    join: async id => { joined.add(id); return true }, leave: async id => joined.delete(id), send: () => true,
    peerCount: () => 0 })
  let now = start
  const engine = new Engine({ store, bundle, transport, profile: 'small', clock: () => now,
    backgroundJobs: [], patches: { patchFeed: false }, rpcConfig: { fetch: () => assert.fail('unexpected upstream request') } })
  t.after(async () => { await engine.stop(); store.close() })
  const standing = store.writer.prepare('INSERT OR REPLACE INTO engine_standing VALUES (?,?,?,1)')
  const seen = store.writer.prepare('INSERT OR REPLACE INTO store_reporters_seen VALUES (?,?)')
  function peer(i, agreements = 3, last = now) {
    standing.run(key(i), agreements, last)
    seen.run(key(i), last)
  }
  for (let i = 1; i <= n; i++) if (i !== own) peer(i)
  return { engine, store, peer, advance: ms => { now += ms } }
}

function pools(engine, count, hinted = true) {
  const source = engine.evm.get('bsc')
  const deploy = source.chain.deployments.find(d => d.kind === 'v2')
  const [token0, token1] = source.quotes.keys()
  return Array.from({ length: count }, (_, i) => engine.registry.pool({
    chain: 'bsc', pool: address(100 + i), dex: deploy.name, kind: deploy.kind,
    token0, token1, firstSeen: start, liquidity: 100_000 - i,
  }, {}, hinted).id)
}

test('membership counts recent proven signers once, drops muted/weightless peers and expires locally', t => {
  const { engine, store, peer, advance } = node(t, 1, 1)
  peer(2); peer(3); peer(4); peer(5, 2); peer(6, 3, start - 31 * 60_000); peer(7); peer(8)
  store.upsertReporter({ key: key(7), mutedUntil: start + 60_000 })
  store.upsertReporter({ key: key(8), weight: 0 })
  const coverage = engine.dexCoverage
  assert.deepEqual(coverage.members().peers, [2, 3, 4].map(key))
  advance(31 * 60_000)
  assert.equal(coverage.members().size, 1)
})

test('one to three signers preserve the legacy seed plan, tracked pool priorities and state pages', async t => {
  const { engine, peer, advance } = node(t, 1, 1), source = engine.evm.get('bsc')
  const ids = pools(engine, 50, false)
  const legacy = seedPlan({ ...source, coverage: null })
  for (const n of [1, 2, 3]) {
    if (n > 1) peer(n)
    advance(300_000)
    assert.deepEqual(seedPlan(source), legacy)
    assert.equal(engine.dexCoverage.trades(source), null)
    const page = []
    source.readPoolState = async (rows, rpc) => {
      assert.equal(rpc, source.rpc)
      page.push(...rows.map(p => 'dex:bsc:' + p.pool))
    }
    await source.refreshState()
    // Solo page (DESIGN 5.3): the token anchors (here one pool), then the address rotation up to 128 reads.
    assert.deepEqual(page, ids)
  }
  peer(4)
  advance(60_000)
  assert.notDeepEqual(seedPlan(source).pairs, legacy.pairs)
})

test('scheduled EVM state reads cover assigned verified hints via public RPC and retry a deferred page', async t => {
  const { engine, advance } = node(t), source = engine.evm.get('bsc')
  const ids = pools(engine, 120)
  const idsRead = [], job = engine.scheduler.jobs.get('evm:bsc:state')
  source.readPoolState = async (rows, rpc) => {
    assert.equal(rpc, source.rpc.publicOnly)
    idsRead.push(rows.map(p => p.id))
    if (idsRead.length === 1) throw new RateLimited(start + 1)
  }
  assert.equal(job.ready(), true)
  await assert.rejects(job.run(), RateLimited)
  await job.run()
  assert.deepEqual(idsRead[0], idsRead[1])
  advance(source.limits.period)
  await job.run()
  const plan = engine.dexCoverage.plan('bsc', 'state', () => true)
  assert.ok(idsRead.flat().every(id => ids.includes(id)))
  assert.ok(idsRead.flat().some(id => plan.tail.some(p => p.id === id)))
  assert.ok(idsRead[2].some(id => !idsRead[1].includes(id)))
})

test('trade scans and block decoding for registered peer-origin pools stay on public endpoints', async t => {
  const { engine, store, advance } = node(t), source = engine.evm.get('bsc')
  const [id] = pools(engine, 1)
  const p = source.poolInfo.get('bsc', id.split(':')[2])
  const topic = Object.values(source.chain.events).find(e => e.signature === 'Swap(address,uint256,uint256,uint256,uint256,address)').topic
  source.rpc.call = () => assert.fail('used a configured endpoint')
  const hash = '0x' + key(90), height = '0x62'
  const calls = []
  source.rpc.publicOnly.call = async (_, method) => {
    calls.push(method)
    if (method === 'eth_blockNumber') return '0x64'
    if (method === 'eth_getBlockByNumber') return { number: height, hash, timestamp: '0x' + (start / 1000).toString(16) }
    if (method === 'eth_getLogs') return [{ address: p.pool, blockHash: hash, blockNumber: height,
      transactionHash: hash, logIndex: '0x0', topics: [topic, hash, hash],
      data: '0x' + [10n ** 19n, 0, 0, 2n * 10n ** 19n].map(word).join('') }]
    assert.fail(method)
  }
  const observations = []
  source.publish = rows => observations.push(...rows)
  const job = engine.scheduler.jobs.get('evm:bsc:trades')
  assert.equal(job.ready(), true)
  await job.run()
  const stateJob = engine.scheduler.jobs.get('evm:bsc:state')
  let pages = 0
  source.readPoolState = async () => { pages++ }
  await stateJob.run()
  // The due state page runs before decoding (DESIGN 5.3), so the queued swap is decoded in the same turn.
  assert.equal(pages, 1)
  assert.deepEqual(calls, ['eth_blockNumber', 'eth_getLogs', 'eth_getBlockByNumber'])
  // Simulate other jobs occupying the node until the next state page is also due: one page, no new decode reads.
  advance(source.limits.period)
  await stateJob.run()
  assert.equal(pages, 2)
  assert.deepEqual(calls, ['eth_blockNumber', 'eth_getLogs', 'eth_getBlockByNumber'])
  assert.equal(observations[0][0], id)
  assert.ok(+observations[0][2] > 0)
  assert.equal(store.reader.prepare('SELECT fromHint FROM engine_market_data WHERE market=?').get(id).fromHint, 1)
})

test('up to three reporters keep the existing on-demand Solana spot-check source', async t => {
  const { engine, peer, advance } = node(t, 1, 1)
  const a = 'A'.repeat(32), b = 'B'.repeat(32), pool = 'R'.repeat(32)
  const market = engine.registry.pool({ chain: 'solana', dex: 'raydium', kind: 'pool', pool,
    token0: a, token1: b, firstSeen: start }, {}, true)
  const urls = []
  engine.http.getPublic = async url => { urls.push(new URL(url)); return [] }
  const job = engine.scheduler.jobs.get('sol:raydium')
  const origin = new URL(engine.catalog.apis.find(api => api.id === 'dexscreener').url).origin
  for (const n of [1, 2, 3]) {
    if (n > 1) peer(n)
    advance(60_000)
    await job.spotCheck(market.id)
    assert.equal(urls.at(-1).origin, origin)
  }
  assert.equal(urls.length, 3)
})

test('all three Solana readers rotate the common directory, discovery pages and exact public venue reads', async t => {
  const { engine, store } = node(t)
  const a = { address: 'A'.repeat(32), symbol: 'A' }, b = { address: 'B'.repeat(32), symbol: 'B' }
  const ids = { raydium: 'R'.repeat(32), orca: 'O'.toLowerCase().repeat(32), meteora: 'M'.repeat(32) }
  for (const [dex, pool] of Object.entries(ids)) {
    const reader = engine.solanaReaders.get(dex), { source, chain } = reader.options
    const market = engine.registry.pool({ chain, pool, token0: a.address, token1: b.address,
      kind: 'pool', dex, firstSeen: start }, {}, true)
    const list = [], exact = [], wire = []
    let wrong = false
    const raw = () => {
      const second = wrong ? a : b
      if (dex === 'raydium') return { id: pool, mintA: a, mintB: second, price: 2, day: { volume: 300 }, tvl: 50_000 }
      if (dex === 'orca') return { address: pool, tokenA: a, tokenB: second, price: 2, stats: { '24h': { volume: 300 } }, tvlUsdc: 50_000 }
      return { address: pool, token_x: a, token_y: second, current_price: 2, volume: { '24h': 300 }, tvl: 50_000 }
    }
    reader.options.http = {
      get: async url => {
        list.push(new URL(url))
        return dex === 'raydium' ? { data: { data: [] } } : { data: [], meta: { cursor: { next: 'opaque:next' } } }
      },
      getPublic: async url => {
        exact.push(new URL(url))
        return dex === 'raydium' ? { data: [raw()] } : dex === 'orca' ? { data: raw() } : raw()
      },
    }
    reader.options.publish = rows => wire.push(...rows)
    const job = engine.scheduler.jobs.get('sol:' + dex)
    for (let i = 0; i < 4; i++) await job.run()
    assert.equal(list.length, 2)
    assert.equal(exact.length, 2)
    assert.equal(exact[0].origin, new URL(source.url).origin)
    if (dex === 'raydium') assert.equal(exact[0].searchParams.get('ids'), pool)
    else assert.ok(exact[0].pathname.endsWith('/' + pool))
    if (dex === 'orca') assert.equal(list[1].searchParams.get('next'), 'opaque:next')
    else assert.ok(Number(list[1].searchParams.get('page')) >= 2)
    assert.ok(wire.every(row => row[0] === market.id && row[3] === '300'))
    assert.equal(wire.length, 2)
    wrong = true
    await job.spotCheck(market.id)
    assert.equal(wire.length, 2)
    assert.equal(store.reader.prepare('SELECT fromHint FROM engine_market_data WHERE market=?').get(market.id).fromHint, 1)
  }
})

test('a solo node can read the verified hint backlog with idle capacity without displacing its local state page', async t => {
  const { engine } = node(t, 1, 1), source = engine.evm.get('bsc')
  const [id] = pools(engine, 1)
  source.spotCheck = async (market, rpc) => {
    assert.equal(market, id)
    assert.equal(rpc, source.rpc.publicOnly)
  }
  const job = engine.scheduler.jobs.get('dex:backlog')
  assert.equal(job.idleOnly, true)
  assert.equal(job.ready(), true)
  assert.equal(engine.scheduler.jobs.get('evm:bsc:state').ready(), false)
  await job.run()
  assert.equal(engine.store.getSetting('dex-coverage/idle'), id)
})

test('shared core proves a signer, one wire tail report reaches rankings and coverage until the hour expires', async t => {
  const sender = node(t, 2, 1), receiver = node(t, 1, 1), a = sender.engine, b = receiver.engine
  await a.start()
  await b.start()
  const frames = []
  a.transport.send = (channel, message) => {
    frames.push([channel, message])
    b.transport.emit('message', channel, { channel, from: a.transport.publicKey, message })
    return true
  }
  const [core] = pools(a, 1, false)
  pools(b, 1, false)
  const { token1 } = b.evm.get('bsc').poolInfo.get('bsc', core.split(':')[2])
  function register(engine) {
    const market = engine.registry.pool({ chain: 'bsc', dex: 'pancakeswap-v2', kind: 'v2', pool: address(900),
      token0: address(901), token1, liquidity: 25_000, firstSeen: start }, {}, engine === b)
    engine.registry.fixedRanks.set(market.base, 700)
    engine.registry.assets.get(market.base).rank = 700
    const fx = engine.registry.register({ kind: 'cex', exchange: 'bitstamp', base: market.quote,
      quote: 'fiat:USD', id: 'cex:bitstamp:QUOTE-USD' })
    return { market, fx }
  }
  register(a)
  const { market, fx } = register(b), id = market.id
  const row = (market, price, volume, at) => [[market, price, volume, null, null, null, at]]
  // A moving price: the wire budget re-sends an unchanged row only as a heartbeat (half the coverage window).
  for (let round = 0; round < 3; round++) {
    const price = ['2', '2.02', '2.04'][round]
    a.publish(row(core, price, '100', a.clock()))
    b.publish(row(core, price, '100', b.clock()))
    assert.equal(b.book.isProven(a.transport.publicKey), round === 2)
    sender.advance(60_001)
    receiver.advance(60_001)
  }
  b.publish(row(fx.id, '1', '10000', b.clock()))
  a.publish(row(id, '2', '100', a.clock()))
  assert.equal(frames.at(-1)[0], channelFor(id))
  assert.deepEqual(Object.keys(frames.at(-1)[1]).sort(), ['at','b','o','t','v'])
  assert.equal(b.book.coverage(id, 3_600_000), 1)
  assert.equal(b.asset(market.base).visibility, 'live')
  assert.equal(b.asset(market.base).trust, 'yellow')
  assert.ok(b.markets({ chain: 'bsc' }).some(r => r.id === market.base))
  assert.ok(b.queries.chains().find(c => c.chain === 'bsc').pools > 0)
  assert.equal(b.focus.coverage(market.base).peers.reporters1h, 1)
  assert.equal(b.focus.coverage(market.base).local.observations24h, 0)
  receiver.advance(59 * 60_000)
  b.publish(row(fx.id, '1', '10000', b.clock()))
  assert.equal(b.asset(market.base).visibility, 'live')
  receiver.advance(60_001)
  assert.equal(b.book.coverage(id, 3_600_000), 0)
  assert.equal(b.asset(market.base).visibility, 'stale')
})

test('a cold node verifies a funded seed via a public factory, then admits a reordered proven quote', async t => {
  const sender = node(t, 2, 7).engine, receiver = node(t, 1, 7).engine
  await sender.start()
  await receiver.start()
  const source = sender.evm.get('bsc'), verify = receiver.evm.get('bsc')
  const [token0, token1] = [...source.quotes.values()].filter(t => ['USDC','USDT'].includes(t.symbol)).map(t => t.address).sort()
  const pool = address(500), factory = source.chain.deployments.find(d => d.kind === 'v2')
  const record = { chain: 'bsc', pool, token0, token1, kind: 'v2', dex: factory.name, firstSeen: start }
  const market = sender.registry.pool(record)
  const frames = []
  sender.transport.send = (channel, message) => { frames.push({ channel, from: sender.transport.publicKey, message }); return true }
  const receive = frame => receiver.transport.emit('message', frame.channel, frame)
  const reserves = '0x' + word(20_000n * 10n ** 18n).repeat(2) + word(0)
  source.chain.multicall = verify.chain.multicall = null
  await source.readPoolState([record], { batch: async () => [reserves] })
  const hint = frames.find(f => f.channel === 'gator/new'), quote = frames.find(f => f.channel === channelFor(market.id))
  assert.equal(hint.message.tx, null)
  receive(quote)
  assert.equal(receiver.registry.markets.has(market.id), false)
  assert.equal(receiver.book.coverage(market.id, 3_600_000), 0)
  // Unknown senders and token identities outside the signed seed universe cannot request a receipt-less lookup.
  receive({ ...hint, from: key(42) })
  receive({ ...hint, message: { ...hint.message, token0: address(5) } })
  assert.equal(receiver.hints.size, 0)
  receive(hint)
  assert.equal(receiver.hints.size, 1)
  const calls = []
  verify.rpc.publicOnly.call = async (_, method) => { assert.equal(method, 'eth_blockNumber'); return '0x10' }
  verify.rpc.publicOnly.batch = async (_, batch) => batch.map(({ params: [c, block] }) => {
    calls.push(c.to)
    assert.equal(block, '0x10')
    if (c.to === factory.address) {
      assert.equal(c.data, '0xe6a43905' + word(token0) + word(token1))
      return '0x' + word(pool)
    }
    assert.equal(c.to, pool)
    return reserves
  })
  await receiver.verifyHint()
  assert.deepEqual(calls, [factory.address, pool])
  assert.equal(receiver.registry.markets.get(market.id).fromHint, 1)
  assert.equal(receiver.book.coverage(market.id, 3_600_000), 1)
  assert.equal(receiver.store.reader.prepare('SELECT count(*) n FROM engine_pool_history').get().n, 0)
  const wrong = address(501)
  receive({ ...hint, message: { ...hint.message, pool: wrong } })
  await receiver.verifyHint()
  assert.equal(receiver.registry.markets.has('dex:bsc:' + wrong), false)
  assert.ok(receiver.hints.rank(sender.transport.publicKey) < 0)
})

test('the shipped factory seed pages branch after their shared pair on every EVM reader', t => {
  const { engine, store } = node(t, 1, 1), members = Array.from({ length: 7 }, (_, i) => key(i + 1))
  let legacyCount = 0, splitCount = 0
  for (const source of engine.evm.values()) {
    function page(roster) {
      source.coverage = { members: () => roster }
      source.plan = null
      store.setSetting(source.seedCursor, {})
      return (source.nextProbes()?.batch ?? []).map(p => p.key)
    }
    const baseline = page(new ReporterSlice(key(1), []))
    const seven = members.map(k => page(new ReporterSlice(k, members)))
    for (const probes of seven) assert.equal(probes[0], baseline[0], source.chain.id)
    legacyCount += baseline.length
    splitCount += new Set(seven.flat()).size
  }
  assert.equal(engine.evm.size, 20)
  assert.ok(splitCount > legacyCount * 1.5, 'distinct funded-or-empty factory probes across seven signers')
})

test('receipt-less V4 registration requires the derived no-hook ID and funded public state at the same block', async t => {
  const { engine } = node(t), source = engine.evm.get('ethereum')
  const token1 = [...source.quotes.values()].find(q => q.symbol === 'USDC').address
  const d = source.chain.deployments.find(d => d.kind === 'v4')
  const pool = v4PoolId(ZERO, token1, 500, 10), hint = { token0: 'native', token1, pool, kind: 'v4', dex: d.name, chain: 'ethereum' }
  source.chain.multicall = null
  let funded = false, reads = 0
  const rpc = { call: async () => '0x10', batch: async (_, calls) => calls.map(({ params: [c, block] }) => {
    reads++
    assert.equal(block, '0x10')
    assert.equal(c.to, d.address)
    if (c.data === v4StateCall(d.address, pool).data) return '0x' + word(2n ** 96n)
    assert.equal(c.data, v4StateCall(d.address, pool, 3).data)
    return '0x' + word(funded ? 10n ** 27n : 0n)
  }) }
  assert.equal(await verifySeedIdentity(source, { ...hint, pool: '0x' + word(8) }, rpc, new Map()), false)
  assert.equal(reads, 0)
  assert.equal(await verifySeedIdentity(source, hint, rpc, new Map()), null)
  assert.equal(source.poolInfo.get('ethereum', pool), undefined)
  funded = true
  assert.equal(await verifySeedIdentity(source, hint, rpc, new Map()), true)
  assert.equal(source.poolInfo.get('ethereum', pool).spacing, 10)
})

test('an expired in-memory hint can be recovered from stored announcements through the public verifier', async t => {
  const { engine, store } = node(t, 1, 7, intelMigrations)
  const source = engine.evm.get('bsc'), d = source.chain.deployments.find(d => d.kind === 'v2')
  const id = p => 'dex:bsc:' + p
  const rows = Array.from({ length: 32 }, (_, index) => address(index + 1))
  const off = rows.find(p => !engine.storedDiscoveries.preference(id(p)))
  const own = rows.find(p => engine.storedDiscoveries.preference(id(p)) && p > off)
  const [token0, token1] = source.quotes.keys()
  const history = discoveryState(store)
  for (const pool of [off, own]) {
    const message = { t: 'pool', v: 1, chain: 'bsc', dex: d.name, kind: 'v2', token0, token1, pool,
      tx: '0x' + key(90), block: 100 }
    history.save({ market: id(pool), message, reporters: new Set([key(40), key(2)]), firstSeen: start - 86400_000 })
  }
  const verified = []
  source.verifyPoolHint = async (hint, rpc) => {
    assert.equal(rpc, source.rpc.publicOnly)
    verified.push([hint.pool, hint.reporter])
    return false
  }
  assert.equal(engine.hints.size, 0)
  const job = engine.scheduler.jobs.get('discovery:verify')
  assert.equal(job.ready(), true)
  await job.run()
  assert.deepEqual(verified, [[own, key(2)]])
  assert.equal(engine.registry.markets.has(id(own)), false)
  assert.equal(job.ready(), false)
})

test('a signer outside the Orca cursor stream spends its discovery turn on a registered pool', async t => {
  const { engine } = node(t, 3, 7), reader = engine.solanaReaders.get('orca')
  assert.equal(engine.dexCoverage.members().priority('directory:orca:cursor'), null)
  const pool = 'S'.repeat(32), token0 = 'A'.repeat(32), token1 = 'B'.repeat(32)
  engine.registry.pool({ chain: 'solana', pool, token0, token1, kind: 'pool', dex: 'orca', firstSeen: start })
  let lists = 0, exact = 0
  reader.options.http = {
    get: async () => { lists++; return { data: [], meta: { cursor: { next: 'cursor' } } } },
    getPublic: async url => { exact++; assert.ok(url.endsWith('/' + pool)); return { data: null } },
  }
  await reader.run()
  await reader.run()
  assert.equal(lists, 1)
  assert.equal(exact, 1)
})

test('a stored creation from a provisional signer can request public verification without earning price standing', async t => {
  const { engine, store } = node(t, 1, 7, intelMigrations)
  const source = engine.evm.get('bsc'), signer = key(40)
  const pool = Array.from({ length: 32 }, (_, i) => address(i + 1)).find(p => engine.storedDiscoveries.preference('dex:bsc:' + p))
  const d = source.chain.deployments.find(d => d.kind === 'v2'), [token0, token1] = source.quotes.keys()
  discoveryState(store).save({ market: 'dex:bsc:' + pool, firstSeen: start, reporters: new Set([signer]),
    message: { t: 'pool', v: 1, chain: 'bsc', kind: 'v2', dex: d.name, pool, token0, token1, tx: '0x' + key(90), block: 100 } })
  let calls = 0
  source.verifyPoolHint = async (hint, rpc) => {
    calls++
    assert.equal(hint.reporter, signer)
    assert.equal(rpc, source.rpc.publicOnly)
    return null
  }
  await engine.verifyHint()
  assert.equal(calls, 1)
  assert.equal(engine.book.isProven(signer), false)
  assert.equal(engine.registry.markets.has('dex:bsc:' + pool), false)
})
