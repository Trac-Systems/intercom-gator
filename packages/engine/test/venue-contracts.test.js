import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { loadBundle } from '@gator/bundle'
import { openStore } from '@gator/store'
import { Engine, migrations } from '../src/index.js'
import { chooseContract, checkPrice } from '../src/sources/venue-contracts/evidence.js'
import { RateLimited } from '../src/scheduler/index.js'
import { word } from '../src/sources/evm-abi.js'

const A = '0x' + '12'.repeat(20), B = '0x' + '34'.repeat(20)
const ID = 'ethereum:' + A, NEW = 'ethereum:' + B
const DAY = 86_400_000
const currency = (label, address, network = 'ETH') => ({ currency: label, chains: [{ name: network, addr: address }] })
const tick = (label, price = 2, quote = 'USD') => ({ currency_pair: label + '_' + quote, last: String(price),
  base_volume: '100', quote_volume: '200', highest_bid: String(price * 0.99), lowest_ask: String(price * 1.01) })

class Transport extends EventEmitter {
  publicKey = 'a'.repeat(64)
  sent = []
  async join() { return true }
  async leave() { return true }
  channels() { return [] }
  send(ch, message) { this.sent.push([ch, message]); return true }
}

async function setup(t, store) {
  let now = 1_800_000_000_000
  const http = { directory: [currency('LOCALX', A)], tickers: [tick('LOCALX')], calls: [] }
  const fetch = async (url, init) => {
    http.calls.push({ url, method: init.method ?? 'GET' })
    if (url.endsWith('/spot/currencies')) return Response.json(http.directory)
    if (url.endsWith('/spot/tickers')) return Response.json(http.tickers)
    throw new Error('Unexpected HTTP read ' + url)
  }
  const own = !store
  store ??= openStore({ file: ':memory:', migrations, profile: 'small' })
  const engine = new Engine({ bundle: loadBundle(), store, transport: new Transport(), clock: () => now,
    backgroundJobs: [], rpcConfig: { fetch, retries: 0 }, patches: { patchFeed: false } })
  await engine.start()
  clearTimeout(engine.timer)
  t.after(async () => { await engine.stop(); if (own) store.close() })
  const { registry } = engine, venue = registry.venues.get('gate')
  const run = async suffix => {
    now += 15_000
    return engine.scheduler.jobs.get('cex:gate' + suffix).run()
  }
  return { engine, store, http, registry, venue, now: () => now, advance: n => { now += n },
    directory: () => run(':contracts'), poll: () => run(''), verify: () => run(':verify-contracts'),
    base: label => registry.markets.get('cex:gate:' + label + '-USD')?.base }
}

test('a new listing binds both market legs only after public ERC-20 verification and retains the wire market ID', async t => {
  const f = await setup(t), { registry, engine, http, store } = f
  await f.poll()
  await f.directory()
  assert.equal(f.base('LOCALX'), 'unresolved:gate:LOCALX')
  assert.equal(registry.assets.has(ID), false)
  // Single-call transport fallback on a chain with no declared multicall. Check the exact selectors and target.
  registry.chains.get('ethereum').multicall = null
  engine.rpc.publicOnly = { batch: async (chain, calls) => {
    assert.equal(chain, 'ethereum')
    assert.deepEqual(calls.map(x => x.params[0].data.slice(0, 10)),
      ['0x06fdde03', '0x95d89b41', '0x313ce567', '0x18160ddd', '0xdd62ed3e'])
    assert.ok(calls.every(x => x.method === 'eth_call' && x.params[0].to === A))
    const str = s => '0x' + Buffer.from(s).toString('hex').padEnd(64, '0')
    return [str('Local Token'), str('CHAINX'), '0x' + word(6), '0x' + word(123_000_000), '0x' + word(0)]
  } }
  await f.verify()
  assert.equal(f.base('LOCALX'), ID)
  assert.deepEqual([engine.asset(ID).name, engine.asset(ID).symbol, engine.asset(ID).decimals],
    ['Local Token', 'CHAINX', 6])
  assert.equal(engine.asset(ID).nameSource, 'on-chain')
  // A previous price under this reused market ID cannot be assigned to the replacement contract.
  assert.equal(store.writer.prepare('SELECT COUNT(*) n FROM engine_latest WHERE market=?').get('cex:gate:LOCALX-USD').n, 0)
  http.tickers = [tick('LOCALX'), tick('ETH', 2000, 'LOCALX')]
  await f.poll()
  assert.equal(registry.markets.get('cex:gate:ETH-LOCALX').quote, ID)
  assert.equal(registry.resolve(registry.venues.get('kucoin'), 'LOCALX'), 'unresolved:kucoin:LOCALX')
  assert.equal(registry.resolve(registry.venues.get('kucoin'), 'CHAINX'), 'unresolved:kucoin:CHAINX')
  assert.ok(engine.transport.sent.some(([, m]) => m.t === 'obs' && m.b === engine.obs.digest &&
    m.o.some(r => r[0] === 'cex:gate:LOCALX-USD' && r.length === 7)))
  assert.ok(!JSON.stringify(engine.transport.sent).includes(A))
  assert.equal(http.calls.filter(c => c.url.endsWith('/spot/currencies')).length, 1)
})

test('same ticker selects separate contracts at separate venues and an existing split cannot reclaim its rejected asset', async t => {
  const f = await setup(t), { registry } = f
  registry.registerToken('ethereum', A, { symbol: 'COINCIDE', decimals: 9 })
  registry.registerToken('ethereum', B, { symbol: 'COINCIDE', decimals: 9 })
  const gate = f.venue, kucoin = registry.venues.get('kucoin')
  f.http.tickers = [tick('COINCIDE')]; f.http.directory = [currency('COINCIDE', A)]
  await f.poll(); await f.directory()
  const m = registry.cex('kucoin', 'COINCIDE', 'USD')
  kucoin.lastTickers = new Map([[m.id, { at: f.now(), price: 2 }]])
  f.engine.http.getPublic = async () => ({ code: '200000', data: [
    { currency: 'COINCIDE', chains: [{ chainId: 'eth', contractAddress: B }] }] })
  await f.engine.scheduler.jobs.get('cex:kucoin:contracts').run()
  assert.equal(registry.resolve(gate, 'COINCIDE'), ID)
  assert.equal(registry.resolve(kucoin, 'COINCIDE'), NEW)
  registry.splits.set('gate:COINCIDE', { asset: NEW })
  assert.equal(registry.resolve(gate, 'COINCIDE'), ID)
  registry.splits.set('gate:COINCIDE', { asset: ID })
  assert.equal(registry.resolve(gate, 'COINCIDE'), 'unresolved:gate:COINCIDE')
})

test('unknown network and wrong-chain/no-code responses never register a listing', async t => {
  const f = await setup(t)
  f.registry.registerToken('ethereum', A, { symbol: 'KNOWN', decimals: 18 })
  f.http.tickers = [tick('LOCALX'),tick('NEWSYM')]
  f.http.directory = [currency('LOCALX', A, 'ETHEREUM-LOOKALIKE'), currency('NEWSYM', A, 'BASE')]
  await f.directory(); await f.poll()
  f.registry.chains.get('base').multicall = null
  f.engine.rpc.publicOnly = { batch: async chain => { assert.equal(chain, 'base'); return Array(5).fill('0x') } }
  await f.verify()
  assert.equal(f.base('LOCALX'), 'unresolved:gate:LOCALX')
  assert.equal(f.base('NEWSYM'), 'unresolved:gate:NEWSYM')
  assert.equal(f.registry.assets.has('base:' + A), false)
  assert.equal(f.venue.contracts.pending.size, 0)
})

test('a fresh independent DEX price vetoes a >3x disagreement, logs locally and allows an exact 3x boundary', async t => {
  const f = await setup(t)
  f.registry.registerToken('ethereum', A, { symbol: 'LOCALX', decimals: 18 })
  f.store.writer.prepare('INSERT INTO engine_references VALUES (?,?,?,?)').run(ID, 'dexscreener', 7, f.now())
  await f.poll(); await f.directory()
  assert.equal(f.base('LOCALX'), 'unresolved:gate:LOCALX')
  assert.equal(f.store.getSetting('engine-cex-contract-refusals/gate')[0].asset, ID)
  f.http.tickers = [tick('LOCALX', 21)]
  await f.poll()
  assert.equal(f.base('LOCALX'), ID)
  f.http.tickers = [tick('LOCALX', 21.001)]
  await f.poll()
  assert.equal(f.base('LOCALX'), 'unresolved:gate:LOCALX')
})

test('delist, halt, relist and restart require fresh venue evidence and detach the old contract', async t => {
  const f = await setup(t)
  for (const address of [A, B]) f.registry.registerToken('ethereum', address, { symbol: 'LOCALX', decimals: 18 })
  await f.poll(); await f.directory()
  assert.equal(f.base('LOCALX'), ID)
  f.http.tickers = [{ ...tick('LOCALX'), highest_bid: '0', lowest_ask: '0' }]
  await f.poll()
  assert.ok(f.registry.halted.has('cex:gate:LOCALX-USD'))
  assert.equal(f.base('LOCALX'), 'unresolved:gate:LOCALX')
  f.http.tickers = [tick('LOCALX')]
  await f.poll()
  assert.equal(f.base('LOCALX'), 'unresolved:gate:LOCALX')
  f.http.directory = [{ ...currency('LOCALX', A), delisted: true }]
  await f.directory()
  assert.equal(f.base('LOCALX'), 'unresolved:gate:LOCALX')
  f.advance(DAY)
  f.http.directory = [currency('LOCALX', B)]
  await f.poll(); await f.directory()
  assert.equal(f.base('LOCALX'), NEW)
  assert.equal(f.store.writer.prepare('SELECT * FROM asset_markets WHERE asset=? AND market=?').get(ID, 'cex:gate:LOCALX-USD'), undefined)
  await f.engine.stop()
  const again = await setup(t, f.store)
  assert.equal(again.base('LOCALX'), 'unresolved:gate:LOCALX')
  again.http.directory = [currency('LOCALX', B)]
  await again.directory(); await again.poll()
  assert.equal(again.base('LOCALX'), NEW)
  await again.engine.stop()
})

test('multiple deployments need a signed group or a unique known pool-depth winner', () => {
  const tokens = new Map([[ID, { coin: 'one', coinSupply: 'escrow-backed' }], [NEW, { coin: 'one', coinSupply: 'issuance' }]])
  const both = [ID, NEW], assets = new Set(both)
  assert.equal(chooseContract(both, tokens, assets, new Map()), NEW)
  tokens.get(NEW).coin = 'two'
  assert.equal(chooseContract(both, tokens, assets, new Map([[ID, 200]])), null)
  tokens.clear()
  assert.equal(chooseContract(both, tokens, assets, new Map()), null)
  assert.equal(chooseContract(both, tokens, assets, new Map([[ID, 20], [NEW, 20]])), null)
  assert.equal(chooseContract(both, tokens, assets, new Map([[ID, 20], [NEW, 21]])), NEW)
  assert.equal(checkPrice([{ quote: ID, price: 4, weight: 1 }], [{ quote: ID, price: 1 }], { snapshots: new Map() }, 0),
    'price differs by more than 3x')
})

test('one missing full ticker snapshot quarantines an immediately reused label and preserves a continuously traded quote', async t => {
  const f = await setup(t)
  f.registry.registerToken('ethereum', A, { decimals: 18 })
  f.registry.registerToken('ethereum', B, { decimals: 18 })
  f.http.tickers = [tick('LOCALX', 2, 'LOCALQ'), tick('LOCALQ')]
  f.http.directory = [currency('LOCALX', A), currency('LOCALQ', B)]
  await f.poll(); await f.directory()
  const m = () => f.registry.markets.get('cex:gate:LOCALX-LOCALQ')
  assert.equal(m().base, ID)
  f.http.tickers = [tick('LOCALQ')]
  await f.poll()
  assert.equal(m().base, 'unresolved:gate:LOCALX')
  f.http.tickers.push(tick('LOCALX', 50, 'LOCALQ'))
  await f.poll()
  assert.equal(m().base, 'unresolved:gate:LOCALX')
  assert.equal(m().quote, NEW)
  await f.directory()
  assert.equal(m().base, ID)
})

test('an earlier verification reply cannot resurrect the deployment removed by a newer directory', async t => {
  const f = await setup(t)
  f.registry.chains.get('ethereum').multicall = null
  await f.poll(); await f.directory()
  let release
  f.engine.rpc.publicOnly = { batch: () => new Promise(resolve => { release = resolve }) }
  const pending = f.verify()
  f.http.directory = [currency('LOCALX', B)]
  await f.directory()
  release(['0x' + Buffer.from('ABC').toString('hex').padEnd(64, '0'), '0x' + Buffer.from('ABC').toString('hex').padEnd(64, '0'),
    '0x' + word(0), '0x' + word(200), '0x' + word(0)])
  await pending
  assert.equal(f.registry.assets.has(ID), false)
  assert.equal(f.base('LOCALX'), 'unresolved:gate:LOCALX')
  assert.deepEqual([...f.venue.contracts.pending], [NEW])
  assert.equal(f.venue.contracts.retry.has(ID), false)
})

test('a source outage expires local evidence even if only the book is read, and the directory retries hourly', async t => {
  const f = await setup(t), job = f.engine.scheduler.jobs.get('cex:gate:contracts')
  f.registry.registerToken('ethereum', A, { decimals: 18 })
  await f.poll(); await f.directory()
  assert.equal(f.base('LOCALX'), ID)
  assert.equal(job.ready(), false)
  f.advance(3_600_001)
  f.engine.book.refresh()
  assert.equal(f.base('LOCALX'), 'unresolved:gate:LOCALX')
  f.advance(DAY)
  const fetch = f.engine.http.getPublic.bind(f.engine.http)
  f.engine.http.getPublic = async (...args) => {
    if (args[0].endsWith('/spot/currencies')) throw new Error('fixture outage')
    return fetch(...args)
  }
  await assert.rejects(f.directory(), /fixture outage/)
  assert.equal(job.ready(), false)
  await f.poll()
  assert.equal(f.base('LOCALX'), 'unresolved:gate:LOCALX')
  f.advance(3_600_000)
  assert.equal(job.ready(), true)
})

test('a rate-limited TRC-20 resumes at the deferred selector and fiat and signed mappings stay authoritative', async t => {
  const f = await setup(t), tron = 'T' + 'A'.repeat(33), methods = []
  const eth = f.registry.resolve(f.venue, 'ETH')
  f.http.directory = [currency('LOCALX', tron, 'TRX'), currency('ETH', A), currency('USD', B)]
  f.http.tickers = [tick('LOCALX'), tick('ETH')]
  await f.poll(); await f.directory()
  assert.equal(f.registry.resolve(f.venue, 'ETH'), eth)
  assert.equal(f.registry.resolve(f.venue, 'USD'), 'fiat:USD')
  const fetch = f.engine.http.getPublic.bind(f.engine.http)
  f.engine.http.getPublic = async (url, rpm, cost, body) => {
    if (url.endsWith('/spot/tickers')) return fetch(url, rpm, cost, body)
    assert.ok(url.endsWith('/wallet/triggerconstantcontract'))
    assert.equal(cost, 1)
    assert.equal(body.contract_address, tron)
    methods.push(body.function_selector)
    if (methods.length === 2) throw new RateLimited(f.now() + 1000)
    const value = body.function_selector === 'decimals()' ? word(6) : Buffer.from('TRONCOIN').toString('hex').padEnd(64, '0')
    return { result: { result: true }, constant_result: [value] }
  }
  await f.verify()
  assert.equal(f.base('LOCALX'), 'unresolved:gate:LOCALX')
  await f.poll(); await f.verify()
  assert.deepEqual(methods, ['name()', 'symbol()', 'symbol()', 'decimals()'])
  assert.equal(f.base('LOCALX'), 'tron:' + tron)
  assert.equal(f.engine.asset('tron:' + tron).nameSource, 'on-chain')
})

test('an address-only pool placeholder needs verification and a confirmed split detaches both local legs', async t => {
  const f = await setup(t)
  f.registry.registerToken('ethereum', A)
  f.http.tickers = [tick('LOCALX'), tick('ETH', 1000, 'LOCALX')]
  await f.poll(); await f.directory()
  assert.equal(f.base('LOCALX'), 'unresolved:gate:LOCALX')
  assert.ok(f.venue.contracts.pending.has(ID))
  f.registry.registerToken('ethereum', A, { decimals: 18 })
  await f.poll()
  assert.equal(f.base('LOCALX'), ID)
  const q = 'cex:gate:ETH-LOCALX', prices = new Map([[q, { ...f.registry.markets.get(q) }]])
  const record = { kept: { supported: true, price: 100, reason: 'dex' },
    detached: [{ key: 'gate:LOCALX', venue: 'gate', label: 'LOCALX', price: 2, proven: true, current: true }] }
  f.registry.applySplits(new Map([[ID, record]]), prices, f.now())
  assert.equal(f.base('LOCALX'), 'unresolved:gate:LOCALX')
  assert.equal(f.registry.markets.get(q).quote, 'unresolved:gate:LOCALX')
  assert.equal(prices.get(q).quote, 'unresolved:gate:LOCALX')
})
