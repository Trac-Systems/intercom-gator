import test from 'node:test'
import assert from 'node:assert/strict'
import { Registry } from '../src/registry/index.js'
import { EvmSource } from '../src/sources/evm.js'
import { v4PoolId, v4StateCall, word, ZERO } from '../src/sources/evm-abi.js'
import { migrations } from '../src/schema.js'
import { openStore } from './store-fixture.js'
import { RateLimited } from '../src/scheduler/index.js'

const addr = n => '0x' + word(n).slice(-40)
const data = (...words) => '0x' + words.map(n => word(BigInt.asUintN(256, BigInt(n)))).join('')
const second = 1000, hour = 3600 * second
const initial = Date.UTC(2026, 10, 19)
const create = data(1), swap = data(2), init = data(3), trade = data(4)
const quote = addr(12), base = addr(11), manager = addr(4)
const events = Object.fromEntries([
  [create, 'factory', 'PairCreated(address,address,address,uint256)'],
  [swap, 'pool', 'Swap(address,uint256,uint256,uint256,uint256,address)'],
  [init, 'manager', 'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)'],
  [trade, 'manager', 'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'],
].map(([topic, emitter, signature]) => [topic, { topic, emitter, signature }]))

// Exercise both sides of the actual aggregate3 wire format. Each inner call may fail independently.
function aggregate(input, answer) {
  assert.equal(input.slice(0, 10), '0x82ad56cb')
  const args = input.slice(10)
  const number = (hex, offset) => Number(BigInt('0x' + hex.slice(offset, offset + 64)))
  const start = number(args, 0) * 2, count = number(args, start), table = start + 64
  const tuples = Array.from({ length: count }, (_, i) => {
    const pos = table + number(args, table + 64 * i) * 2
    const to = '0x' + args.slice(pos + 24, pos + 64)
    const bytes = pos + number(args, pos + 128) * 2
    const size = number(args, bytes)
    const result = answer(to, '0x' + args.slice(bytes + 64, bytes + 64 + 2 * size))
    const payload = result?.slice(2) ?? ''
    return word(Number(result != null)) + word(64) + word(payload.length / 2) +
      payload.padEnd(Math.ceil(payload.length / 64) * 64, '0')
  })
  let offset = 32 * count
  return data(32, count) + tuples.map(t => { const start = offset; offset += t.length / 2; return word(start) }).join('') + tuples.join('')
}

function fixture(t, overrides = {}) {
  const store = openStore({ file: ':memory:', migrations, profile: 'small' })
  t.after(() => store.close())
  const chain = { id: 'eth', family: 'evm', range: 20, quotes: [quote], events,
    multicall: addr(90), deployments: [
      { address: addr(1), name: 'v2', kind: 'v2', topics: [create, swap] },
      { address: addr(2), name: 'v3', kind: 'v3', feeTiersPpm: [100, 2500], topics: [swap] },
      { address: addr(3), name: 'velo', kind: 'velodrome-v2', topics: [swap] },
      { address: manager, name: 'v4', kind: 'v4', topics: [init, trade] },
    ], ...overrides }
  const assets = [[base, 'A'], [quote, 'USDC']].map(([address, symbol]) =>
    ({ id: 'eth:' + address, chain: 'eth', address, decimals: 6, name: symbol, symbol, stable: symbol === 'USDC' }))
  const registry = new Registry(store, { assets, chains: [chain], exchanges: [] })
  const rows = [], discoveries = [], requests = []
  let now = initial, head = 100
  const rpc = { call: async (_, method, [arg, tag]) => {
    requests.push({ method, arg, tag })
    if (method === 'eth_getBlockByNumber') return { number: arg === 'latest' ? '0x' + head.toString(16) : arg,
      timestamp: '0x' + Math.floor(now / second).toString(16) }
    if (method === 'eth_getLogs') return rpc.logs?.(arg) ?? []
    assert.equal(method, 'eth_call')
    assert.equal(arg.to, chain.multicall)
    return aggregate(arg.data, rpc.answer)
  } }
  const open = () => new EvmSource({ store, registry, chain, rpc, clock: () => now,
    publish: batch => rows.push(...batch), discover: p => discoveries.push(p) })
  return { store, registry, rpc, open, rows, discoveries, requests,
    advance: (ms, blocks) => { now += ms; head += blocks },
    register: (pool, options = {}) => registry.pool({ chain: 'eth', pool, token0: base, token1: quote,
      dex: 'v2', kind: 'v2', firstSeen: now, ...options }) }
}

test('creation catches up, records the skipped range and resumes even with a saturated trade lane', async t => {
  const f = fixture(t), source = f.open()
  source.advance.run('eth', 1)
  f.store.transaction(() => {
    for (let i = 0; i < 4096; i++) source.enqueue.run('eth', 1, i, '{}')
  })
  await source.logs()
  const filter = f.requests.at(-1).arg
  assert.deepEqual(filter, { address: [addr(1), manager], topics: [[create, init]], fromBlock: '0x4f', toBlock: '0x62' })
  assert.deepEqual(f.store.getSetting('engine-gap/eth/creation'), { from: 2, to: 78, count: 1, at: initial })
  f.advance(30 * second, 3)
  await f.open().logs()
  assert.equal(f.requests.at(-1).arg.fromBlock, '0x63')
  assert.equal(source.cursor.get('eth').block, 101)
})

test('small profile rotates bounded address chunks and includes a low-depth watched pool', async t => {
  const f = fixture(t), source = f.open()
  for (let i = 0; i < 40; i++) f.register(addr(i + 100), { liquidity: 1000 - i })
  f.register(addr(999), { token0: addr(501), liquidity: 1 })
  f.store.watch('eth:' + addr(501))
  const ids = []
  for (let i = 0; i < 4; i++) {
    await source.trades()
    const filter = f.requests.at(-1).arg
    assert.deepEqual(filter.topics, [[swap]])
    assert.equal(filter.address.length, 8)
    ids.push(...filter.address)
    f.advance(60 * second, 2)
  }
  assert.equal(new Set(ids).size, 32)
  assert.ok(ids.includes(addr(999)))
  assert.ok(ids.includes(addr(100)) && !ids.includes(addr(131)))
  const restart = f.open()
  await restart.trades()
  assert.equal(f.requests.at(-1).arg.fromBlock, '0x63')
})

test('manager trade scans filter by pool ID and reject other IDs and emitters in RPC responses', async t => {
  const f = fixture(t), source = f.open(), id = data(500)
  f.register(id, { dex: 'v4', kind: 'v4' })
  f.rpc.logs = filter => {
    assert.deepEqual(filter.topics, [[trade], [id]])
    assert.equal(filter.address, manager)
    const log = { address: manager, topics: [trade, id, data(7)], data: data(4e6, -2e6, 2n ** 96n, 3000, 0, 500),
      blockNumber: filter.toBlock, transactionHash: data(9), logIndex: '0x0' }
    return [log, { ...log, address: addr(77), logIndex: '0x1' }, { ...log, topics: [trade, data(501), data(7)], logIndex: '0x2' }]
  }
  await source.trades()
  assert.equal(source.queueSize.get('eth').n, 1)
  await source.state()
  assert.deepEqual(f.rows, [['dex:eth:' + id, '1', '4', null, null, null, initial]])
})

test('V4 no-hook native/USDC key agrees with the Uniswap Ethereum subgraph example', () => {
  assert.equal(v4PoolId(ZERO, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 500, 10),
    '0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27') // gitleaks:allow (public pool ID)
})

test('seed V2, configured V3, V4 and volatile/stable Velodrome from funded state; retry negatives after expiry', async t => {
  const f = fixture(t), source = f.open(), liquidity = data(10n ** 17n)
  const sqrt = 2n ** 96n, pair = word(base) + word(quote)
  const id = v4PoolId(base, quote, 500, 10)
  const slot0 = v4StateCall(manager, id).data, active = v4StateCall(manager, id, 3).data
  const queries = []
  f.rpc.answer = (to, input) => {
    queries.push([to, input])
    if (to === manager) return input === active ? liquidity : input === slot0 ? data(sqrt + (500n << 208n)) : data(0)
    if (to === addr(1)) { assert.equal(input, '0xe6a43905' + pair); return data(101) }
    if (to === addr(2)) {
      assert.equal(input.slice(0, 138), '0x1698ee82' + pair)
      const fee = Number(BigInt('0x' + input.slice(-64)))
      assert.ok([100, 2500].includes(fee))
      return fee === 2500 ? data(102) : data(106)
    }
    if (to === addr(3)) {
      assert.equal(input.slice(0,138), '0x79bc57d5' + pair)
      return input.endsWith(word(1)) ? data(103) : data(104)
    }
    if (input === '0x0902f1ac') return data(10_000e6, 20_000e6, 0)
    if (input === '0x3850c7bd') return data(sqrt, 0, 0, 0, 0, 0, 1)
    if (input === '0x1a686502') return to === addr(106) ? data(0) : liquidity
    if (input.startsWith('0x70a08231')) return data(20_000e6)
    assert.fail('unexpected state query ' + input)
  }
  await source.seed()
  assert.equal(f.store.reader.prepare('SELECT count(*) AS n FROM pools').get().n, 5)
  assert.equal(f.rows.length, 5)
  assert.equal(f.discoveries.length, 0)
  const row = n => f.rows.find(r => r[0] === 'dex:eth:' + n)
  assert.equal(row(addr(101))[1], '2')
  assert.equal(row(addr(102))[1], '1')
  assert.ok(Math.abs(+row(addr(103))[1] - 14/13) < 1e-10)
  assert.equal(row(addr(104))[1], '2')
  assert.equal(row(id)[1], '1')
  assert.ok(!row(addr(106)))
  assert.ok(f.rows.every(r => r[2] === '0' && r[6] === initial))
  const depth = f.store.reader.prepare('SELECT liquidity FROM pools WHERE pool=?')
  assert.equal(depth.get(addr(101)).liquidity, 40_000)
  assert.ok(depth.get(id).liquidity >= 10_000)
  assert.ok(f.requests.filter(r => r.method === 'eth_call').every(r => r.tag === '0x64'))
  assert.equal(f.requests.length, 3)
  const restart = f.open()
  await restart.seed()
  f.advance(5 * hour, 200)
  await restart.seed()
  assert.equal(f.requests.length, 3)
  f.advance(hour, 1)
  await restart.seed()
  assert.equal(f.requests.length, 6)
  f.rows.length = 0
  const restartAgain = f.open()
  await restartAgain.refreshState()
  assert.equal(row(addr(103))[1], String(14 / 13))
  assert.equal(row(id)[1], '1')
  assert.equal(restartAgain.poolInfo.get('eth', id).spacing, 10)
  assert.equal(restartAgain.poolInfo.get('eth', addr(103)).stable, 1)
  assert.ok(depth.get(id).liquidity >= 10_000)
})

test('state budget interruption reuses the same lookup and rejects a positive but dusty pool', async t => {
  const f = fixture(t, { deployments: [{ address: addr(1), kind: 'v2', name: 'v2', topics: [create,swap] }] })
  let lookups = 0, reads = 0
  f.rpc.answer = (to) => {
    if (to === addr(1)) { lookups++; return data(101) }
    if (++reads === 1) throw new RateLimited(initial + 30 * second)
    return data(100e6, 10e6, 0)
  }
  const src = f.open()
  await assert.rejects(src.seed(), RateLimited)
  f.advance(5 * 60 * second, 300)
  await src.seed()
  assert.equal(lookups, 1)
  assert.equal(f.rows.length, 0)
  assert.equal(f.store.reader.prepare('SELECT count(*) AS n FROM pools').get().n, 0)
  assert.equal(f.requests.at(-1).tag, '0x64')
})

async function simulateHour(t, profile) {
  const { loadBundle } = await import('@gator/bundle')
  const { Engine } = await import('../src/index.js')
  const bundle = structuredClone(loadBundle())
  const chains = bundle.dex.evm.map(d => d.chain)
  const counts = new Map(chains.map(id => [id, 0])), swaps = new Map()
  const jobs = chains.flatMap(id => ['logs','trades','state','seed'].map(key => 'evm:' + id + ':' + key))
  for (const chain of bundle.chains.filter(c => counts.has(c.id))) {
    chain.endpoints = [0, 1, 2].map(i => ({ url: 'https://' + chain.id + '.' + i + '.example',
      protocol: 'evm-jsonrpc', limits: '12/minute', getLogs: { allowed: true, maxRange: 128 } }))
  }
  const store = openStore({ file: ':memory:', migrations, profile })
  t.after(() => store.close())
  let now = initial
  const times = []
  const fetch = async (url, options) => {
    const id = new URL(url).hostname.split('.')[0]
    counts.set(id, counts.get(id) + 1)
    times.push(now)
    const r = JSON.parse(options.body)
    let result
    if (r.method === 'eth_getBlockByNumber') {
      result = { number: r.params[0] === 'latest' ? '0x' + Math.floor((now - initial) / second + 500).toString(16) : r.params[0],
        timestamp: '0x' + Math.floor(now / second).toString(16) }
    } else if (r.method === 'eth_getLogs') {
      const filter = r.params[0]
      const log = swaps.get(id)
      result = filter.address.includes(log.address) ? [{ ...log, blockNumber: filter.toBlock }] : []
    } else {
      assert.equal(r.method, 'eth_call')
      result = aggregate(r.params[0].data, () => data(0))
    }
    return Response.json({ id: r.id, jsonrpc: '2.0', result })
  }
  const engine = new Engine({ bundle, store, backgroundJobs: jobs, clock: () => now, random: 9472,
    transport: { publicKey: 'a'.repeat(64) }, rpcConfig: { fetch, retries: 0 } })
  engine.rpc.sleep = async ms => { now += ms }
  for (const { chain, definition } of engine.evm.values()) {
    const factory = chain.deployments.find(d => ['v2','v3','pancake-v3','velodrome-v2'].includes(d.kind))
    const event = factory.topics.map(t => chain.events[t]).find(e => e.signature.startsWith('Swap('))
    const payload = event.dataWords === 4 ? data(1e6,0,0,2e6) :
      data(1e6,-2e6,2n ** 96n,10,0,...Array(event.dataWords - 5).fill(0))
    const pool = addr(999), quote = definition.quoteTokens[0]
    engine.registry.pool({ pool, chain: chain.id, token0: addr(901), token1: quote.address.toLowerCase(),
      dex: factory.name, kind: factory.kind, firstSeen: now }, { token0: { decimals: 6 }, token1: quote })
    swaps.set(chain.id, { address: pool, topics: [event.topic,data(1),data(2)], data: payload,
      transactionHash: data(3), logIndex: '0x0' })
  }
  const tick = Math.ceil(60_000 / engine.budget.limit)
  for (; now < initial + hour; now += tick) {
    try { await engine.scheduler.runOne() } catch (error) { if (!(error instanceof RateLimited)) throw error }
  }
  const total = times.length
  let left = 0, peak = 0
  for (let i = 0; i < total; i++) {
    while (times[left] <= times[i] - 60 * second) left++
    peak = Math.max(peak, i - left + 1)
  }
  assert.ok(peak <= engine.budget.limit && total <= engine.budget.limit * 30)
  for (const [id, n] of counts) {
    const { period, hotInterval } = engine.evm.get(id).limits
    // Ten calls per period, plus the warm-up seed pages (a lookup and a header each) of the priority prefix.
    assert.ok(n > 0 && n <= 10 * Math.ceil(hour / period) + 2 * Math.ceil(hour / hotInterval), id + ' ' + n)
  }
  t.diagnostic(JSON.stringify({ profile, requestsPerChain: Object.fromEntries(counts), total, peakPerMinute: peak }))
}
for (const profile of ['small', 'normal', 'large']) {
  test('one scheduled hour on every shipped EVM chain fits the shared ' + profile + '-profile RPC budget',
    t => simulateHour(t, profile))
}

test('a provider limited to one address and one call per minute advances the creation cursor without rereading the head', async t => {
  const f = fixture(t), source = f.open()
  const completed = []
  let busy = true
  f.rpc.logs = filter => {
    if (filter.address.length > 1) throw new Error('address cap')
    if (filter.address[0] === manager && busy) {
      busy = false
      throw new RateLimited(initial + 60_000)
    }
    completed.push(filter.address[0])
    return []
  }
  await assert.rejects(source.logs(), /address cap/)
  f.advance(30_000, 10)
  await assert.rejects(source.logs(), RateLimited)
  assert.equal(source.cursor.get('eth'), undefined)
  f.advance(60_000, 20)
  await source.logs()
  assert.deepEqual(completed, [addr(1), manager])
  assert.equal(f.requests.filter(r => r.method === 'eth_getBlockByNumber').length, 1)
  assert.equal(source.cursor.get('eth').block, 98)
  await source.logs()
  assert.ok(source.cursor.get('eth').block > 98)
})

test('state seeding resumes at the next fee or factory after restart without multicall', async t => {
  const f = fixture(t, { multicall: null })
  const lookups = []
  f.rpc.batch = async (_, calls) => calls.map(({ method, params: [call, tag] }) => {
    assert.equal(method, 'eth_call')
    assert.equal(tag, '0x64')
    lookups.push(call)
    return data(0)
  })
  for (let i = 0; i < 3; i++) await f.open().seed()
  assert.deepEqual(lookups.map(c => c.to), [addr(1), addr(2), addr(2)])
  assert.deepEqual(lookups.slice(1).map(c => c.data.slice(-64)), [word(100),word(2500)])
  assert.equal(f.store.getSetting('engine-seed/eth').next, 3)
})

test('a positive seed reaches the ordinary engine market book before any trade or receipt exists', async t => {
  const { loadBundle } = await import('@gator/bundle')
  const { MemoryTransport } = await import('@gator/net')
  const { Engine } = await import('../src/index.js')
  const bundle = structuredClone(loadBundle())
  const dex = bundle.dex.evm.find(d => d.chain === 'ethereum')
  dex.deployments = dex.deployments.filter(d => d.name === 'Uniswap V2')
  dex.quoteTokens = dex.quoteTokens.filter(q => ['USDC', 'WETH'].includes(q.symbol))
  bundle.dex.evm = [dex]
  const tokens = dex.quoteTokens.map(q => q.address.toLowerCase())
  bundle.tokens.tokens = bundle.tokens.tokens.filter(t => tokens.some(a => t.id === 'ethereum:' + a))
  const store = openStore({ file: ':memory:', migrations, profile: 'small' })
  const transport = new MemoryTransport({ skipPow: true })
  const fetch = async (_url, options) => {
    const r = JSON.parse(options.body)
    let result
    if (r.method === 'eth_getBlockByNumber') result = { number: '0x64', timestamp: '0x' + (initial / second).toString(16) }
    else {
      assert.equal(r.method, 'eth_call')
      assert.equal(r.params[1], '0x64')
      result = aggregate(r.params[0].data, (to, input) => {
        if (input.startsWith('0xe6a43905')) {
          assert.equal(to, dex.deployments[0].address)
          assert.equal(input.slice(10), tokens.toSorted().map(word).join(''))
          return data(999)
        }
        assert.equal(to, addr(999))
        assert.equal(input, '0x0902f1ac')
        return data(20_000e6, 10n ** 19n, 0)
      })
    }
    return Response.json({ id: r.id, jsonrpc: '2.0', result })
  }
  const engine = new Engine({ bundle, store, transport, clock: () => initial, backgroundJobs: ['evm:ethereum:seed'],
    rpcConfig: { fetch, retries: 0, bundleDigest: '0'.repeat(64) } })
  t.after(async () => { await engine.stop(); await transport.close(); store.close() })
  await engine.start()
  clearTimeout(engine.timer)
  await engine.step()
  const market = 'dex:ethereum:' + addr(999)
  const price = engine.book.marketPrices.get(market)
  assert.equal(price.price, 2000)
  assert.equal(price.baseVolume, 0)
  assert.deepEqual(price.provenAgents, [transport.publicKey])
  assert.equal(store.reader.prepare('SELECT count(*) AS n FROM engine_trades').get().n, 0)
  assert.deepEqual({ ...store.reader.prepare('SELECT block,tx,liquidity FROM pools WHERE pool=?').get(addr(999)) },
    { block: null, tx: null, liquidity: 40_000 })
})

test('upgrading a legacy queue keeps known trades and verified factory events and accounts for discarded rows', async t => {
  const f = fixture(t)
  f.register(addr(101))
  const insert = f.store.writer.prepare("INSERT INTO engine_logs VALUES ('eth',20,?,?,-1)")
  const common = { transactionHash: data(80), blockNumber: '0x14' }
  insert.run(1, JSON.stringify({ ...common, address: addr(101), topics: [swap, data(8), data(9)],
    logIndex: '0x1', data: data(1e6,0,0,2e6) }))
  insert.run(2, JSON.stringify({ ...common, address: addr(999), topics: [swap, data(8), data(9)],
    logIndex: '0x2', data: data(1e6,0,0,2e6) }))
  insert.run(3, JSON.stringify({ ...common, address: addr(1), topics: [create, data(base), data(quote)],
    logIndex: '0x3', data: data(102, 1) }))
  const src = f.open()
  assert.deepEqual(f.store.reader.prepare('SELECT idx,creation FROM engine_logs ORDER BY idx').all()
    .map(r => [r.idx,r.creation]), [[1,0],[3,1]])
  assert.deepEqual(f.store.getSetting('engine-gap/eth/legacy-untracked-or-overflow'), { from: 20, to: 20, count: 1, at: initial })
  // The due state refresh runs first (busy chains never got one); the known pool reads as unfunded here.
  f.rpc.answer = () => data(0)
  await src.scheduledState()
  assert.equal(src.queueSize.get('eth').n, 0)
  assert.equal(f.discoveries[0].pool, addr(102))
  assert.equal(f.rows[0][0], 'dex:eth:' + addr(101))
})

test('public-only hint markets stay outside the local tracking set until independently discovered', async t => {
  const f = fixture(t), src = f.open()
  const hint = { chain: 'eth', pool: addr(100), token0: base, token1: quote, kind: 'v2', dex: 'v2', firstSeen: initial }
  f.registry.pool(hint, {}, true)
  await src.trades()
  assert.equal(f.requests.length, 0)
  f.registry.pool(hint)
  await src.trades()
  assert.deepEqual(f.requests.at(-1).arg.address, [addr(100)])
})

test('fast-chain creation scans cover a polling period when the provider supports the range', async t => {
  const f = fixture(t, { blockTime: 100, range: 128, endpoints: [{ range: 2000 }] }), src = f.open()
  src.advance.run('eth', 98)
  f.advance(150 * second, 1500)
  await src.logs()
  const filter = f.requests.at(-1).arg
  assert.equal(Number(filter.fromBlock), 99)
  assert.equal(Number(filter.toBlock), 1598)
  assert.equal(f.store.getSetting('engine-gap/eth/creation'), undefined)
})
