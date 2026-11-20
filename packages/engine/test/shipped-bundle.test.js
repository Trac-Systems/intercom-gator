import assert from 'node:assert/strict'
import test from 'node:test'
import { bundleDigest, loadBundle } from '@gator/bundle'
import { MemoryTransport } from '@gator/net'
import { openStore } from '@gator/store'
import { Engine, migrations } from '../src/index.js'
import { createExtrasVerifier, migrations as intelMigrations } from '../src/intel/index.js'
import { engineData } from '../src/intel/market-data.js'
import { adaptBundle, tickerRecords } from '../src/sources/bundle-adapter.js'
import { channelFor } from '../src/obs/index.js'
import { historyParams, providerBars } from '../src/candles/provider.js'

const bundle = loadBundle()

async function start(t, fetch = () => { throw new Error('Unexpected network request') }) {
  const transport = new MemoryTransport({ skipPow: true })
  const store = openStore({ file: ':memory:', migrations: [...migrations, ...intelMigrations], profile: 'small' })
  const engine = new Engine({ transport, store, bundle, backgroundJobs: [], rpcConfig: { fetch } })
  t.after(async () => {
    await engine.stop()
    await transport.close()
    store.close()
  })
  await engine.start()
  return engine
}

test('the shipped bundle starts the registry, exchange feeds, chain jobs and DEX event tables', async (t) => {
  const e = await start(t)
  assert.equal(e.obs.digest, bundleDigest(bundle).slice(0, 16))
  assert.equal(e.registry.assets.size, bundle.tokens.tokens.length)
  for (const a of e.catalog.assets) assert.equal(a.chain + ':' + a.address, a.id)
  for (const venue of bundle.exchanges) {
    assert.ok(e.scheduler.jobs.has('cex:' + venue.id))
    assert.equal(e.registry.venues.get(venue.id).ticker.url, new URL(venue.tickers.path, venue.restBase).href)
  }
  for (const dex of bundle.dex.evm) {
    assert.ok(e.scheduler.jobs.has('evm:' + dex.chain + ':logs'))
    assert.ok(e.scheduler.jobs.has('evm:' + dex.chain + ':state'))
    assert.ok(e.scheduler.jobs.has('evm:' + dex.chain + ':seed'))
    assert.ok(e.scheduler.jobs.has('evm:' + dex.chain + ':trades'))
    const source = e.evm.get(dex.chain)
    for (const d of dex.deployments) {
      const kind = bundle.dex.kinds.find(k => k.id === d.kind)
      assert.deepEqual(source.chain.deployments.find(v => v.address === d.address.toLowerCase()).feeTiersPpm ?? null, d.feeTiersPpm)
      for (const id of kind.events) {
        const event = bundle.dex.events.find(v => v.id === id)
        assert.equal(source.chain.events[event.topic0].signature, event.signature)
        assert.equal(source.deployment(d.address, { topic: event.topic0 }).kind, d.kind)
      }
    }
  }
  for (const d of bundle.dex.solana) assert.ok(e.scheduler.jobs.has('sol:' + d.api))
  const indodax = e.registry.venues.get('indodax')
  const [ticker] = tickerRecords(indodax, { tickers: { btc_idr: { last: '2', vol_btc: '4', vol_idr: '8' } } })
  assert.deepEqual([ticker.baseVolume, ticker.quoteVolume], ['4', '8'])
  // Live CEX.IO rows (2026-11-19) carry only the indicative last price.
  const cex = e.registry.venues.get('cex-io')
  const [quiet] = tickerRecords(cex, { ok: 'ok', data: { 'BTC-USD': { bestBid: '1', bestAsk: '3', last: '2', volume: '5' } } })
  assert.deepEqual([quiet.pair, quiet.price, quiet.baseVolume], [['BTC', 'USD'], '2', '5'])
  // crypto.com's vv is the USD notional for every quote (live ETH_BTC 2026-11-19: v 720.3399 ETH, vv 1274447.57).
  const cdc = e.registry.venues.get('crypto-com')
  cdc.catalogCache.set('ETH_BTC', { pair: ['ETH', 'BTC'], derivative: false })
  const [cross] = tickerRecords(cdc, { result: { data: [{ i: 'ETH_BTC', a: '0.028249', v: '720.3399', vv: '1274447.57' }] } })
  assert.deepEqual([cross.usdVolume, cross.quoteVolume, cross.baseVolume], ['1274447.57', null, '720.3399'])
  // WEEX lists BTCUSDT and XBTUSDT, an unrelated token (live 2026-11-20: 59066.00 vs 0.00006131). Peers through v0.1.13
  // aliased XBT to BTC on every venue and sent the token as Bitcoin. The alias stays only where no BTC label exists.
  const weex = e.registry.venues.get('weex')
  weex.catalogCache.set('BTCUSDT', { pair: ['BTC', 'USDT'], derivative: false })
  weex.catalogCache.set('XBTUSDT', { pair: ['XBT', 'USDT'], derivative: false })
  weex.catalogCache.set('XBTUSDC', { pair: ['XBT', 'USDC'], derivative: false })
  const weexRows = [...tickerRecords(weex, [
    { symbol: 'XBTUSDT', lastPrice: '0.00006131', volume: '16794951.5' },
    { symbol: 'BTCUSDT', lastPrice: '59066.00', volume: '24080.987465' },
    { symbol: 'XBTUSDC', lastPrice: '0.00006', volume: '1' },
  ])]
  assert.deepEqual(weexRows.map(r => [r.raw, r.pair.join('-'), r.price]), [['BTCUSDT', 'BTC-USDT', '59066.00'], ['XBTUSDC', 'BTC-USDC', '0.00006']],
    'only the same-pair duplicate is dropped; a lone alias stays and the collision split handles its price')
  const kraken = e.registry.venues.get('kraken')
  kraken.catalogCache.set('XXBTZUSD', { pair: ['XBT', 'USD'], derivative: false })
  const krakenRows = [...tickerRecords(kraken, { error: [], result: { XXBTZUSD: { c: ['59050.1', '1'], v: ['10', '20'], b: ['59050', '1', '1'], a: ['59051', '1', '1'], o: '58000' } } })]
  assert.deepEqual(krakenRows.map(r => r.pair.join('-')), ['BTC-USD'], "Kraken's XBT is Bitcoin")
})

test('a Solana pool quoted in wrapped SOL prices native SOL instead of a second SOL asset', async (t) => {
  const e = await start(t)
  const market = e.registry.pool({ chain: 'solana', pool: '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
    token0: 'So11111111111111111111111111111111111111112', token1: 'EPjFWJd5AufqSRxXRDx7ag4Psrc4TMLaKP5kxLMahjvz', dex: 'raydium', kind: 'amm', firstSeen: 1 }) // gitleaks:allow (public wrapped-SOL and USDC mint addresses)
  assert.ok(market)
  assert.ok([market.base, market.quote].includes('solana:native'))
  assert.equal(e.registry.assets.has('solana:So11111111111111111111111111111111111111112'), false)
})

test('intel resolves indexed pool slugs to shipped routers and lockers and leaves dormant contracts idle', async (t) => {
  const e = await start(t)
  for (const dex of bundle.dex.evm) {
    for (const [i, deployment] of dex.deployments.entries()) {
      if (!deployment.router) continue
      const pool = '0x' + (i + 1).toString(16).padStart(40, '0')
      const token0 = '0x' + (i + 1000).toString(16).padStart(40, '0')
      const normalized = e.evm.get(dex.chain).chain.deployments.find(d => d.address === deployment.address)
      e.registry.pool({ chain: dex.chain, pool, token0, token1: dex.quoteTokens[0].address,
        kind: deployment.kind, dex: normalized.name, firstSeen: Date.now() })
      const context = engineData(e).resolveContext(dex.chain + ':' + token0)
      assert.equal(context.pool.factory, deployment.address)
      assert.equal(context.pool.router, deployment.router)
      assert.equal(context.pool.routerKind, deployment.routerKind)
      assert.deepEqual(context.lockers, dex.lockers)
    }
  }
  // Only chains with a deployed contract are read; every other chain stays idle.
  const live = Object.entries(bundle.paidExtras).filter(([, address]) => address)
  assert.deepEqual(live, [['ethereum', '0x07e0fcf5e3d21cd5dbfa8b5c75ab1a210525fabc']])
  const reads = []
  const extras = createExtrasVerifier({ rpc: { call(chain, method, [call]) { reads.push([chain, method, call.to]) } }, bundle })
  await extras.refresh()
  assert.ok(reads.length > 0)
  for (const read of reads) assert.deepEqual(read, ['ethereum', 'eth_call', live[0][1]])
  assert.deepEqual(extras.active([]), [])
})

test('shipped candle routes preserve venue interval units, dates and timeframes', () => {
  const { exchanges } = adaptBundle(bundle)
  const coinw = exchanges.find(e => e.id === 'coinw')
  assert.equal(coinw.candles.intervals['1m'], '60')
  assert.equal(coinw.candles.intervals['1h'], '3600')
  const cex = exchanges.find(e => e.id === 'cex-io')
  const at = Date.UTC(2026, 0, 1)
  const params = historyParams({ id: 'cex:cex-io:BTC-USD', exchange: cex.id }, cex.candles, '1d', at, at + 86400000, 1)
  assert.equal(params.yyyymmdd, '20260101')
  const result = { data1m: '[]', data1d: JSON.stringify([[at / 1000, 2, 4, 1, 3]]) }
  const bar = { at, open: 2, high: 4, low: 1, close: 3 }
  assert.deepEqual(providerBars(cex.id, result, '1d'), [bar])
  assert.deepEqual(providerBars('indodax', { t: [at / 1000], o: [2], h: [4], l: [1], c: [3] }), [bar])
  const idr = exchanges.find(e => e.id === 'indodax')
  assert.equal(historyParams({ id: 'cex:indodax:USDT-IDR', exchange: idr.id, symbol: 'usdt_idr' },
    idr.candles, '1h', at, at + 3600000, 1).symbol, 'USDTIDR')
})

test('restricted observations feed local prices and candles while unclear observations reach the transport', async (t) => {
  const e = await start(t, async url => {
    if (url.includes('okx')) return Response.json({ data: [{ instId: 'ETH-USD', last: '2000', vol24h: '7' }] })
    if (url.includes('bitvavo')) return Response.json([{ market: 'BTC-ETH', last: '35', volume: '4', volumeQuote: '140' }])
    assert.ok(url.includes('bitstamp'))
    return Response.json([{ market: 'BTC/USD', last: '70000', volume: '4' }])
  })
  const sent = []
  t.mock.method(e.transport, 'send', (channel, msg) => { sent.push([channel, msg]); return true })
  await e.scheduler.jobs.get('cex:okx').run()
  assert.equal(e.asset('ethereum:native').price, 2000)
  assert.ok((await e.candles('ethereum:native', { tf: '1m', backfill: false })).length > 0)
  assert.deepEqual(sent, [])
  await e.scheduler.jobs.get('cex:bitstamp').run()
  assert.equal(e.asset('bitcoin:native').price, 70000)
  assert.deepEqual(sent.flatMap(([,msg]) => msg.o.map(r => r[0])), ['cex:bitstamp:BTC-USD'])
  const row = id => [id, '12', '1', null, null, null, Date.now()]
  assert.equal(channelFor('cex:okx:ETH-USD'), channelFor('cex:bitstamp:BNB-USD'))
  assert.equal(e.publish([row('cex:okx:ETH-USD'), row('cex:bitstamp:BNB-USD')]), 1)
  assert.ok(sent.every(([channel, msg]) => channel.startsWith('gator/px/') && msg.o.every(r => r[0].startsWith('cex:bitstamp:'))))
  e.discovery({ exchange: 'okx', symbol: 'ETH-USD', firstSeen: Date.now() })
  assert.equal(sent.length, 2)
  await e.scheduler.jobs.get('cex:bitvavo').run()
  assert.deepEqual(sent.at(-1)[1].o[0].slice(0, 4), ['cex:bitvavo:BTC-ETH', '35', '4', null])
  assert.equal(e.store.reader.prepare('SELECT quoteVol24hUsd FROM obs WHERE market=?')
    .get('cex:bitvavo:BTC-ETH').quoteVol24hUsd, '280000')
  const peer = 'f'.repeat(64), at = Date.now(), channel = channelFor('cex:okx:ETH-USD')
  e.transport.emit('message', channel, { channel, from: peer, message: { t: 'obs', v: 1, b: e.obs.digest, at,
    o: [['cex:okx:ETH-USD', '5000', '1', null, null, null, at]] } })
  assert.equal(e.store.getReporter(peer).strikes, 1)
  assert.equal(sent.length, 3)
  const venue = structuredClone(bundle.exchanges[0])
  venue.terms.redistribution = 'allowed'
  assert.equal(adaptBundle({ ...bundle, exchanges: [venue] }).exchanges[0].publishMarketData, true)
})
