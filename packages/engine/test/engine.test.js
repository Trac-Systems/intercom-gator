import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Engine, migrations } from '../src/index.js'
import { openStore } from './store-fixture.js'

class HubPeer extends EventEmitter {
  constructor(hub, id, clock) {
    super()
    Object.assign(this, { hub, clock, publicKey: id.toString(16).padStart(64, '0') })
    this.joined = new Set()
    hub.add(this)
  }
  async join(c) {
    this.joined.add(c)
    return true
  }
  async leave(c) {
    return this.joined.delete(c)
  }
  channels() {
    return [...this.joined]
  }
  peerCount() {
    return this.hub.size - 1
  }
  send(channel, message) {
    for (const p of this.hub)
      if (p !== this && p.joined.has(channel)) {
        p.emit('message', channel, {
          channel,
          from: this.publicKey,
          ts: this.clock(),
          message: structuredClone(message),
        })
      }
    return true
  }
}

function venue(id) {
  return {
    id,
    name: id.toUpperCase(),
    kind: 'spot',
    restBase: 'https://' + id + '.invalid',
    rateLimit: { requestsPerMinute: 120 },
    symbols: { mode: 'delimiter', separator: '-', order: 'base-quote' },
    tickers: {
      method: 'GET',
      path: '/tickers',
      mapping: { list: 'data', rows: 'array', fields: { symbol: 'pair', last: 'last', baseVolume: 'vol' } },
    },
    candles: {
      method: 'GET',
      path: '/bars?pair={symbol}&tf={interval}&n={limit}',
      intervals: ['1m'],
      maxLimit: 100,
    },
  }
}
const bundle = {
  tokens: {
    tokens: [
      {
        id: 'bitcoin:native',
        decimals: 8,
        symbol: 'BTC',
        name: 'Bitcoin',
        rank: 1,
        circulatingSupply: 1000,
        totalSupply: 2000,
      },
    ],
  },
  dex: { events: [], kinds: [], evm: [], solana: [] },
  chains: [],
  apis: [],
  exchanges: [venue('alpha'), venue('beta')],
}

test('three engines retain their own fresh price and see the same reporters and venues; history survives restart', async (t) => {
  let now = 1740000000000
  const clock = () => now,
    hub = new Set(),
    engines = [],
    httpCalls = []
  for (let i = 0; i < 3; i++) {
    const store = openStore({ file: ':memory:', profile: 'small', migrations })
    const transport = new HubPeer(hub, i + 1, clock)
    const engine = new Engine({
      bundle,
      store,
      transport,
      clock,
      random: () => 0.5,
      rpcConfig: {
        bundleDigest: '0'.repeat(64),
        fetch: async (url) => {
          httpCalls.push(url)
          if (url.includes('/bars'))
            return Response.json({ data: [[Math.floor(now / 60000) * 60000 - 60000, '99', '102', '98', '100']] })
          return Response.json({ data: [{ pair: 'BTC-USD', last: String(100 + i / 10), vol: '100' }] })
        },
      },
    })
    engines.push(engine)
    t.after(async () => {
      await engine.stop()
      store.close()
    })
    await engine.start()
  }
  for (const e of engines) {
    for (const venue of ['alpha', 'beta']) await e.scheduler.jobs.get('cex:' + venue).run()
  }
  const results = engines.map((e) => e.asset('bitcoin:native'))
  for (const [i, token] of results.entries()) {
    assert.equal(token.price, 100 + i / 10)
    // Each engine read both venues itself and they agree, so its own evidence is green.
    assert.equal(token.trust, 'green')
    assert.equal(token.whyTrusted.ownSources, 2)
    assert.deepEqual(token.sources, { agents: 3, exchanges: 2, pools: 0 })
    assert.equal(token.volume24h, 200 * token.price)
    assert.equal(token.whyTrusted.provenAgents, 1)
    assert.equal(token.whyTrusted.provenSources, 2)
  }
  const [e] = engines
  assert.equal(e.search('Bit')[0].id, 'bitcoin:native')
  assert.equal(e.markets()[0].price, 100)
  assert.equal(e.global().marketCap, 100000)
  assert.equal(e.exchanges().length, 2)
  assert.equal(e.network().myReportsPerHour, 2)
  const candles = await e.candles('bitcoin:native', { tf: '1m', backfill: false })
  // One bar from the aggregated price; six raw quotes from three reporters do not each draw a sample.
  assert.deepEqual([candles[0].open, candles[0].high, candles[0].low, candles[0].close], ['100', '100', '100', '100'])
  now += 2000
  const start = Math.floor(now / 60000) * 60000 - 60000
  const past = await e.candles('bitcoin:native', { from: start, to: start + 60000, limit: 1 })
  assert.equal(past[0].source, 'cex:alpha:BTC-USD')
  assert.match(httpCalls.at(-1), /tf=1m/)
  now += 31 * 60000
  assert.ok(engines.every((node) => node.asset('bitcoin:native').trust === 'red'))
  await e.stop()
  assert.equal(e.transport.channels().length, 0)
  await e.start()
  assert.equal(e.asset('bitcoin:native').price, 100)
})

test('root controls preserve profile ceilings, local limits, sequence monotonicity and existing channel subscriptions', async (t) => {
  const { ROOT_KEY } = await import('../src/sources/bundle-adapter.js')
  const store = openStore({ file: ':memory:', migrations, profile: 'small' }),
    clock = () => 1740000000000
  const transport = new HubPeer(new Set(), 7, clock)
  await transport.join('gator/new')
  const engine = new Engine({
    store,
    bundle,
    transport,
    clock,
    rpcConfig: { requestsPerMinute: 8, bundleDigest: '1'.repeat(64) },
  })
  t.after(async () => {
    await engine.stop()
    store.close()
  })
  await Promise.all([engine.start(), engine.start()])
  const send = (from, patch) =>
    transport.emit('message', 'gator/ctl', { from, channel: 'gator/ctl', message: { t: 'engine', v: 1, ...patch } })
  send('a'.repeat(64), { seq: 5, targets: [1, 1, 1] })
  assert.deepEqual(engine.scheduler.targets, [5, 3, 2])
  send(ROOT_KEY, { seq: 2, targets: [999, 0, 3], budgets: { small: 999 } })
  assert.deepEqual(engine.scheduler.targets, [10, 1, 3])
  assert.equal(engine.budget.limit, 8)
  send(ROOT_KEY, { seq: 1, budgets: { small: 2 } })
  send(ROOT_KEY, { seq: 3, targets: 'bad' })
  assert.equal(store.getSetting('engine-settings').seq, 2)
  send(ROOT_KEY, { seq: 4, budgets: { small: 0 } })
  assert.equal(engine.budget.limit, 1)
  await Promise.all([engine.stop(), engine.stop()])
  assert.deepEqual(transport.channels(), ['gator/new'])
})

test('verified pool hints use public endpoints for the receipt, pinned block, token reads and enrichment', async t => {
  const { readFile } = await import('node:fs/promises')
  const { word } = await import('../src/sources/evm-abi.js')
  const fixture = JSON.parse(await readFile(new URL('./fixtures/source-bundle.json', import.meta.url)))
  const bundled = 'https://public.invalid', configured = 'https://configured.invalid'
  const chain = fixture.chains[0]
  chain.multicall3 = null
  chain.endpoints = [{ protocol: 'evm-jsonrpc', url: bundled, limits: 6000 }]
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  let now = 1740000000000
  const clock = () => now
  const transport = new HubPeer(new Set(), 1, clock), visited = []
  const tx = '0x' + word(21), pool = '0x' + word(30), hash = '0x' + word(40)
  const addresses = [11, 12].map(n => '0x' + word(n).slice(-40))
  const [token0, token1] = addresses
  const event = fixture.dex.events.find(e => e.id === 'v4-init')
  const deployment = fixture.dex.evm[0].deployments.find(d => d.kind === 'v4')
  const log = { topics: [event.topic0, pool, '0x' + word(token0), '0x' + word(token1)],
    address: deployment.address, data: '0x' + word(1).repeat(5), transactionHash: tx,
    blockNumber: '0x2', logIndex: '0x0', blockHash: hash }
  const engine = new Engine({ bundle: fixture, store, clock, transport,
    rpcConfig: { endpoints: { ethereum: [configured] }, retries: 0, sleep: async ms => { now += ms },
      fetch: async (url, init) => {
        const { method, id } = JSON.parse(init.body)
        visited.push([url, method])
        let result = null
        if (method === 'eth_getTransactionReceipt') result = { transactionHash: tx, blockHash: hash, blockNumber: '0x2', logs: [log] }
        if (method === 'eth_getBlockByNumber') result = { number: '0x2', hash, timestamp: '0x' + Math.floor(now / 1000).toString(16) }
        if (method === 'eth_call') result = '0x' + word(6)
        return Response.json({ jsonrpc: '2.0', id, result })
      } } })
  const hint = { t: 'pool', v: 1, chain: 'ethereum', pool, token0, token1, tx, block: 2, dex: 'uniswap-v4', kind: 'v4' }
  const from = 'a'.repeat(64)
  const send = message => engine.receive('gator/new', { channel: 'gator/new', from, message })
  const verify = () => engine.scheduler.jobs.get('discovery:verify').run()
  const localStanding = engine.hints.rank(from)
  send({ ...hint, token0: '0x' + word(99).slice(-40) })
  await verify()
  assert.equal(engine.registry.markets.has('dex:ethereum:' + pool), false)
  assert.ok(engine.hints.rank(from) < localStanding)
  send(hint)
  await verify()
  assert.ok(engine.registry.markets.has('dex:ethereum:' + pool))
  const { Registry } = await import('../src/registry/index.js')
  assert.equal(new Registry(store, engine.catalog).markets.get('dex:ethereum:' + pool).fromHint, 1)
  assert.equal(engine.evm.get('ethereum').queueSize.get('ethereum').n, 0)
  assert.ok(addresses.every(address => !engine.scheduler.jobs.has('meta:ethereum:' + address)))
  const reopened = new Engine({ bundle: fixture, store, clock, transport, rpcConfig: engine.rpcConfig })
  const beforeNames = visited.length
  await reopened.scheduler.jobs.get('names').run()
  assert.ok(visited.slice(beforeNames).some(([, method]) => method === 'eth_call'))
  assert.ok(visited.every(([url]) => url === bundled))
  await engine.rpc.call('ethereum', 'eth_blockNumber', [])
  assert.equal(visited.at(-1)[0], configured)
})

test('a price disagreement prioritizes a public spot check even when the target is satisfied', async t => {
  const { channelFor } = await import('../src/obs/index.js')
  const store = openStore({ file: ':memory:', migrations })
  let now = 1740000000000, calls = 0
  const clock = () => now, transport = new HubPeer(new Set(), 1, clock)
  const engine = new Engine({ bundle, store, clock, transport, backgroundJobs: ['cex:alpha'], random: () => 0.5,
    rpcConfig: { bundleDigest: '0'.repeat(64), fetch: async url => {
      assert.equal(new URL(url).hostname, 'alpha.invalid')
      calls++
      return Response.json({ data: [{ pair: 'BTC-USD', last: '100', vol: '1' }] })
    } } })
  t.after(async () => { await engine.stop(); store.close() })
  await engine.start()
  engine.scheduler.setTargets([1, 1, 1])
  await engine.step()
  assert.equal(calls, 1)
  const market = 'cex:alpha:BTC-USD', channel = channelFor(market)
  now += 16_000
  assert.equal(await engine.step(), null)
  engine.http.get = () => assert.fail('spot check reached a configured mirror')
  transport.emit('message', channel, { channel, from: 'a'.repeat(64),
    message: { t: 'obs', v: 1, b: '0'.repeat(16), at: now, o: [[market, '104', 1, null, null, null, now]] } })
  assert.equal(await engine.step(), 'cex:alpha')
  assert.equal(calls, 2)
  assert.equal(engine.asset('bitcoin:native').price, 100)
})
