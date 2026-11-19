import assert from 'node:assert/strict'
import test from 'node:test'
import { openStore } from './store-fixture.js'
import { migrations } from '../src/schema.js'
import { CandleHistory, HistoryTimeout, IDLE_MARKET_MS, MISMATCH_IDLE_MS, QUOTE_BAND, QUOTE_WICK } from '../src/candles/index.js'
import { registerHistorySeed, SEED_PARALLEL, SEED_RETRY } from '../src/candles/seed.js'
import { HttpSources } from '../src/sources/http.js'
import { RateLimited, RequestBudget, Scheduler } from '../src/scheduler/index.js'
import { multiplyPrice } from '../src/aggregate/decimal.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const to = 1_800_000_000_000 - (1_800_000_000_000 % HOUR)
const from = to - DAY
const USDT = 'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7'
const IRYS = 'ethereum:0x50f41f589afaca2ef41fdf590fe7b90cd26dee64'
const RAIN = 'arbitrum:0x25118290e6a5f4139381d072181157035864099d'

// Venue specs as the bundle adapter builds them (bitget/gate/mexc/coinbase/upbit 1h klines).
const venues = new Map(
  Object.entries({
    bitget: 'https://api.bitget.com/api/v2/spot/market/candles?symbol={symbol}&granularity={interval}&limit={limit}',
    gate: 'https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair={symbol}&interval={interval}&limit={limit}',
    mexc: 'https://api.mexc.com/api/v3/klines?symbol={symbol}&interval={interval}&limit={limit}',
    kucoin: 'https://api.kucoin.com/api/v1/market/candles?symbol={symbol}&type={interval}&startAt={startSec}&endAt={endSec}',
    coinbase:
      'https://api.coinbase.com/api/v3/brokerage/market/products/{symbol}/candles?start={startSec}&end={endSec}&granularity={interval}&limit={limit}',
    upbit: 'https://api.upbit.com/v1/candles/minutes/{interval}?market={symbol}&count={limit}',
  }).map(([id, url]) => [id, { id, rpm: id === 'coinbase' || id === 'mexc' ? 12 : 1200, candles: { url, intervals: { '1h': id === 'upbit' ? '60' : '1h' }, max: 1000 } }])
)

function market(id, symbol, quote) {
  const [, exchange, pair] = id.split(':')
  const [base] = pair.split('-')
  return { id, kind: 'cex', exchange, symbol, quote, base: { IRYS, RAIN }[base] }
}

/** USDT's own hourly bars on the owner's node: never flat (0.9988-0.9990), so the old low === high rule
 * discarded every USDT-quoted venue bar (IRYS, RAIN and ~20,000 other markets). */
const usdtBars = (spread = 0.0002) =>
  Array.from({ length: 24 * 8 + 2 }, (_, i) => {
    const ts = to - 8 * DAY - HOUR + i * HOUR
    return { ts, open: '0.9989', high: String(+(0.9988 + spread).toFixed(6)), low: '0.9988', close: '0.9989' }
  })

const venueRows = (exchange, base, n = 24) =>
  Array.from({ length: n }, (_, i) => {
    const ts = to - n * HOUR + i * HOUR,
      p = base * (1 + i / 100)
    const digits = (n) => n.toPrecision(8)
    const o = digits(p),
      h = digits(p * 1.4),
      l = digits(p * 0.8),
      c = digits(p * 1.2)
    if (exchange === 'gate') return [String(ts / 1000), '1000', c, h, l, o]
    if (exchange === 'coinbase') return { start: String(ts / 1000), open: o, high: h, low: l, close: c }
    return [ts, o, h, l, c, '10']
  })

function fixture({ markets, main, rates = { [USDT]: usdtBars() }, local = [], respond }) {
  const registry = {
    markets: new Map(markets.map((m) => [m.id, m])),
    venues,
    main: new Map(Object.entries(main ?? {}).map(([asset, id]) => [asset, { id }])),
    assets: new Map([[USDT, { id: USDT, stable: true }]]),
    active: new Map(markets.map((m) => [m.id, true])),
  }
  const store = { candles: ({ asset }) => rates[asset] ?? (asset === markets[0]?.base ? local : []) }
  const asked = []
  const http = {
    get(url, rpm, cost, body, timeout) {
      const host = new URL(url).host.split('.').at(-2).replace('gateio', 'gate')
      asked.push({ host, timeout, url })
      return respond(host, url)
    },
  }
  const scheduler = new Scheduler({ clock: () => to, coverage: () => 0 })
  return { h: new CandleHistory({ store, registry, http, clock: () => to, scheduler }), asked }
}

test('IRYS: KRW main without rates and a throttled USD venue are skipped for free; USDT bars convert at the quote rate', async () => {
  const { h, asked } = fixture({
    markets: [
      market('cex:upbit:IRYS-KRW', 'KRW-IRYS', 'fiat:KRW'),
      market('cex:coinbase:IRYS-USD', 'IRYS-USD', 'fiat:USD'),
      market('cex:bitget:IRYS-USDT', 'IRYSUSDT', USDT),
      market('cex:gate:IRYS-USDT', 'IRYS_USDT', USDT),
    ],
    main: { [IRYS]: 'cex:upbit:IRYS-KRW' },
    respond: async (host) => {
      if (host === 'coinbase') throw new RateLimited(to + 10_000)
      if (host === 'bitget') return { code: '00000', data: venueRows('bitget', 0.05) }
      throw new Error('unexpected ' + host)
    },
  })
  const rows = await h.get(IRYS, { tf: '1h', from, to, limit: 24 })
  assert.equal(rows.length, 24)
  // No request for the KRW main (no KRW rates); coinbase was throttled before sending; bitget filled everything.
  assert.deepEqual(asked.map((a) => a.host), ['coinbase', 'bitget'])
  assert.equal(h.requests, 1)
  // One bar more than the range: the venue's latest bar is the open hour at `to`.
  assert.match(asked[1].url, /limit=25$/)
  const first = rows[0]
  assert.equal(first.source, 'cex:bitget:IRYS-USDT')
  const rate = usdtBars().find((r) => r.ts === first.ts)
  assert.equal(first.close, multiplyPrice('0.060000000', rate.close))
  assert.equal(first.high, multiplyPrice('0.070000000', rate.high))
  assert.equal(first.low, multiplyPrice('0.040000000', rate.low))
  assert.ok(+first.low <= +first.open && +first.open <= +first.high)
})

test('a quote without enough local bars yet (fresh node) costs no request', async () => {
  const { h, asked } = fixture({
    markets: [market('cex:bitget:IRYS-USDT', 'IRYSUSDT', USDT), market('cex:gate:IRYS-USDT', 'IRYS_USDT', USDT)],
    rates: { [USDT]: usdtBars().slice(-2) },
    respond: async () => ({ data: venueRows('bitget', 0.05) }),
  })
  assert.deepEqual(await h.get(IRYS, { tf: '1h', from, to, limit: 24 }), [])
  assert.deepEqual(asked, [])
})

test('RAIN: another project under the same ticker (15,000x the price) is skipped and not asked again', async () => {
  const markets = [market('cex:gate:RAIN-USDT', 'RAIN_USDT', USDT), market('cex:mexc:RAIN-USDT', 'RAINUSDT', USDT)]
  const { h, asked } = fixture({
    markets,
    respond: async (host) => (host === 'gate' ? venueRows('gate', 68.6) : venueRows('mexc', 0.0043)),
  })
  h.store.getPrice = (asset) => (asset === RAIN ? { price: '0.0043352694' } : undefined)
  const rows = await h.get(RAIN, { tf: '1h', from, to, limit: 24 })
  assert.equal(rows.length, 24)
  assert.ok(rows.every((r) => r.source === 'cex:mexc:RAIN-USDT' && +r.close < 0.01))
  await h.get(RAIN, { tf: '1h', from, to, limit: 24 })
  assert.deepEqual(asked.map((a) => a.host), ['gate', 'mexc', 'mexc'])
  // The node's own price may still be settling: a mismatch is re-checked after half an hour, not six.
  assert.equal(h.idle.get('cex:gate:RAIN-USDT:1h'), to + MISMATCH_IDLE_MS)

  // With overlapping local bars the node's own closes are the reference (here: the right project is at $68).
  const local = [{ ts: to - HOUR, open: '68', high: '69', low: '68', close: '68.5' }]
  const own = fixture({
    markets,
    local,
    respond: async (host) => (host === 'gate' ? venueRows('gate', 68.6) : venueRows('mexc', 0.0043)),
  })
  const mine = await own.h.get(RAIN, { tf: '1h', from, to, limit: 24 })
  assert.equal(mine.length, 24)
  assert.ok(mine.filter((r) => r.source).every((r) => r.source === 'cex:gate:RAIN-USDT'))
})

test('a halted pair (no bars in a day or more) is skipped without a request for six hours', async () => {
  let now = to
  const { h, asked } = fixture({
    markets: [market('cex:coinbase:IRYS-USD', 'IRYS-USD', 'fiat:USD'), market('cex:bitget:IRYS-USDT', 'IRYSUSDT', USDT)],
    // Binance.US-style: the ticker still reports a last price, the klines end long ago.
    respond: async (host) => (host === 'coinbase' ? { candles: [] } : { data: [] }),
  })
  h.clock = () => now
  await assert.rejects(h.get(IRYS, { tf: '1h', from, to, limit: 24 }), /No trading/)
  assert.equal(asked.length, 2)
  // Both pairs are idle now: no request, the caller gets its local bars (none here).
  assert.deepEqual(await h.get(IRYS, { tf: '1h', from, to, limit: 24 }), [])
  assert.equal(asked.length, 2)
  // A short (1 h) empty range proves nothing about the pair.
  now += IDLE_MARKET_MS
  await h.get(IRYS, { tf: '1h', from: to - HOUR, to, limit: 1 }).catch(() => {})
  assert.equal(asked.length, 4)
  await h.get(IRYS, { tf: '1h', from: to - HOUR, to, limit: 1 }).catch(() => {})
  assert.equal(asked.length, 6)
})

test('a quote wick (thin USDT-USD pair printing 0.9901) converts at the body; a moving quote body is skipped', async () => {
  const quote = usdtBars().map((r) =>
    r.ts === from ? { ...r, low: '0.9901' } : r.ts === from + HOUR ? { ...r, open: '0.9989', close: '0.9850', low: '0.9850' } : r
  )
  const { h } = fixture({
    markets: [market('cex:bitget:IRYS-USDT', 'IRYSUSDT', USDT)],
    rates: { [USDT]: quote },
    respond: async () => ({ data: venueRows('bitget', 0.05) }),
  })
  const rows = await h.get(IRYS, { tf: '1h', from, to, limit: 24 })
  // The wick hour stays (body 0.9989 → 0.9989, within the band); the hour whose body moved 1.4% is skipped.
  assert.equal(rows.length, 23)
  const wick = rows.find((r) => r.ts === from)
  assert.equal(wick.low, multiplyPrice('0.040000000', '0.9989'))
  assert.equal(wick.high, multiplyPrice('0.070000000', '0.9989'))
  assert.ok(!rows.some((r) => r.ts === from + HOUR))
  assert.ok(QUOTE_WICK > QUOTE_BAND)
})

test('quote bars wider than the band are skipped; USD pairs need no rate', async () => {
  const wide = usdtBars().map((r) =>
    r.ts === from ? { ...r, high: String(0.9988 * (1 + QUOTE_WICK * 2)), close: String(0.9988 * (1 + QUOTE_WICK)) } : r
  )
  const { h } = fixture({
    markets: [market('cex:bitget:IRYS-USDT', 'IRYSUSDT', USDT)],
    rates: { [USDT]: wide },
    respond: async () => ({ data: venueRows('bitget', 0.05) }),
  })
  const rows = await h.get(IRYS, { tf: '1h', from, to, limit: 24 })
  assert.equal(rows.length, 23)
  assert.ok(!rows.some((r) => r.ts === from))
})

test('RAIN: a hanging venue hits the hard timeout and the next venue answers; the call never outlives its wait', async () => {
  const markets = [
    market('cex:mexc:RAIN-USDT', 'RAINUSDT', USDT),
    market('cex:gate:RAIN-USDT', 'RAIN_USDT', USDT),
    market('cex:kucoin:RAIN-USDT', 'RAIN-USDT', USDT),
  ]
  const hang = () => new Promise(() => {})
  let { h, asked } = fixture({
    markets,
    main: { [RAIN]: 'cex:mexc:RAIN-USDT' },
    respond: async (host) => (host === 'mexc' ? hang() : venueRows('gate', 1.2)),
  })
  let started = performance.now()
  const rows = await h.get(RAIN, { tf: '1h', from, to, limit: 24, timeout: 100, wait: 2000 })
  assert.ok(performance.now() - started < 1000)
  assert.deepEqual(asked.map((a) => a.host), ['mexc', 'gate'])
  // The venue request itself carries the hard timeout.
  assert.equal(asked[0].timeout, 100)
  assert.equal(rows.length, 24)
  assert.equal(rows[0].source, 'cex:gate:RAIN-USDT')

  // Every venue hangs: an API caller gets the node's own bars after `wait`, without an error.
  const local = [{ ts: to - HOUR, open: '1', high: '1', low: '1', close: '1' }]
  ;({ h, asked } = fixture({ markets, local, respond: hang }))
  started = performance.now()
  const own = await h.get(RAIN, { tf: '1h', from, to, limit: 24, wait: 300 })
  const elapsed = performance.now() - started
  assert.ok(elapsed >= 250 && elapsed < 1500, 'elapsed ' + elapsed)
  assert.deepEqual(own, local)
  // Without any bar the timeout is the error.
  ;({ h } = fixture({ markets, respond: hang }))
  await assert.rejects(h.get(RAIN, { tf: '1h', from, to, limit: 24, wait: 2000, timeout: 50 }), HistoryTimeout)
})

test('all venues throttled: nothing sent, the caller learns when the first bucket frees up', async () => {
  const { h } = fixture({
    markets: [market('cex:mexc:RAIN-USDT', 'RAINUSDT', USDT), market('cex:gate:RAIN-USDT', 'RAIN_USDT', USDT)],
    respond: async (host) => {
      throw new RateLimited(to + (host === 'gate' ? 3000 : 9000))
    },
  })
  const error = await h.get(RAIN, { tf: '1h', from, to, limit: 24 }).catch((e) => e)
  assert.ok(error instanceof RateLimited)
  assert.equal(error.retryAt, to + 3000)
  assert.equal(h.requests, 0)
})

test('a venue request timeout can only shorten the configured one', async () => {
  const budget = new RequestBudget('large')
  let aborted
  const fetch = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject((aborted = init.signal.reason))))
  const http = new HttpSources({ budget, clock: Date.now, fetch, timeout: 8000 })
  const started = performance.now()
  // AbortSignal.timeout does not hold the event loop open; the test does.
  const hold = setTimeout(() => {}, 5000)
  await assert.rejects(http.get('https://api.example.com/k', 600, 1, null, 60))
  clearTimeout(hold)
  assert.ok(performance.now() - started < 1000)
  assert.equal(aborted.name, 'TimeoutError')
})

function seedEngine(t, { assets, markets = [], profile = 'small', scheduler } = {}) {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  let now = to + 30 * 60_000
  store.trackMarketActivity(() => now, store.onPrune)
  const quote = () => {
    for (const [i, id] of assets.entries())
      store.upsertPrice({ asset: id, price: '1', at: now, marketCap: 1e9 / (i + 1), visibility: 'live' })
  }
  for (const [i, id] of assets.entries()) store.upsertAsset({ id, symbol: id, name: id, rank: i + 1 })
  quote()
  const calls = []
  const pending = []
  const engine = {
    store,
    profile,
    clock: () => now,
    book: { dirty: false },
    registry: { markets: new Map(markets.map((m) => [m.id, m])), venues },
    scheduler,
    registerJob() {},
    respond: null,
    async candles(id, options) {
      calls.push([id, options])
      if (engine.respond) return engine.respond(id, options)
      const bars = []
      for (let ts = options.from; ts < options.to; ts += HOUR)
        bars.push({ ts, open: '5', high: '6', low: '4', close: '5', source: 'cex:v:' + id })
      return bars
    },
  }
  // Live assets keep being priced while the clock moves.
  const tick = (ms) => {
    now += ms
    quote()
  }
  return { engine, store, calls, pending, tick, now: () => now }
}

const cex = (base, quote, exchange = 'bitget') => ({
  id: `cex:${exchange}:${base}-${quote}`,
  kind: 'cex',
  exchange,
  symbol: base + quote,
  base,
  quote,
})

test('seed: quote assets first, top N gets eight days, every other live CEX asset two days, DEX-only none', async (t) => {
  const assets = ['big:native', 'mid:native', USDT, 'tail:native', 'dexonly:native']
  const { engine, calls, tick } = seedEngine(t, {
    assets,
    markets: [
      cex('big:native', 'fiat:USD'),
      cex('mid:native', USDT),
      cex(USDT, 'fiat:USD', 'coinbase'),
      cex('tail:native', USDT),
    ],
  })
  const seed = registerHistorySeed(engine, { count: 2 })
  // USDT ranks third but converts the others' venue bars, so it goes first.
  assert.equal(seed.due(), USDT)
  await seed.run(10)
  assert.deepEqual(calls.map(([id]) => id), [USDT, 'big:native', 'mid:native', 'tail:native'])
  assert.equal(engine.book.dirty, true)
  const limit = Object.fromEntries(calls.map(([id, o]) => [id, o.limit]))
  // USDT ranks outside the top 2 but converts eight days of the others' history, so it gets eight days too.
  assert.deepEqual(limit, { [USDT]: 192, 'big:native': 192, 'mid:native': 192, 'tail:native': 48 })
  assert.equal(seed.due(), undefined)
  // An hour later the tail asset still has its change24h bar and the top ones are complete: nothing is sent.
  tick(HOUR)
  assert.equal(seed.due(), undefined)
  // After a day of downtime (no local bars) the eight days miss a day and the tail's change24h window has moved
  // past the imported two days: everything is due again, quotes first.
  tick(DAY + 2 * HOUR)
  calls.length = 0
  await seed.run(10)
  assert.deepEqual(calls.map(([id]) => id), [USDT, 'big:native', 'mid:native', 'tail:native'])
})

const settle = (promise) => promise.catch(() => {})

test('seed: failed imports retry in minutes with backoff; throttled imports wait only for the bucket', async (t) => {
  const { engine, calls, tick, now } = seedEngine(t, {
    assets: ['a:native', 'b:native'],
    markets: [cex('a:native', 'fiat:USD'), cex('b:native', 'fiat:USD')],
  })
  const seed = registerHistorySeed(engine, { count: 2 })
  engine.respond = async (id) => {
    if (id === 'a:native') throw new Error('venue down')
    return []
  }
  await settle(seed.run(10))
  // a failed; b got no venue bars at all (no convertible quote yet): both retry after one minute, not next hour.
  assert.deepEqual(calls.map(([id]) => id), ['a:native', 'b:native'])
  assert.equal(seed.state.get('a:native').retryAt, now() + SEED_RETRY[0])
  assert.equal(seed.state.get('b:native').retryAt, now() + SEED_RETRY[0])
  assert.equal(seed.due(), undefined)
  tick(SEED_RETRY[0])
  assert.equal(seed.due(), 'a:native')
  await settle(seed.run(10))
  assert.equal(seed.state.get('a:native').failures, 2)
  assert.equal(seed.state.get('a:native').retryAt, now() + SEED_RETRY[1])
  // Throttled: the bucket's retry time, no failure counted.
  tick(SEED_RETRY[1])
  engine.respond = async () => {
    throw new RateLimited(now() + 7000)
  }
  await settle(seed.run(1))
  assert.equal(seed.state.get('a:native').failures, 2)
  assert.equal(seed.state.get('a:native').retryAt, now() + 7000)
  // The backoff is capped at half an hour.
  engine.respond = async () => {
    throw new Error('venue down')
  }
  for (let i = 0; i < 12; i++) {
    tick(SEED_RETRY.at(-1))
    await settle(seed.run(10))
  }
  assert.equal(seed.state.get('a:native').retryAt, now() + SEED_RETRY.at(-1))
  // Recovery: venue bars settle the asset.
  engine.respond = null
  tick(SEED_RETRY.at(-1))
  await settle(seed.run(10))
  assert.equal(seed.state.get('a:native').failures, 0)
  assert.equal(seed.due(), undefined)
})

test('seed: a paced loop of its own starts imports without any scheduler turn', async (t) => {
  const assets = Array.from({ length: 12 }, (_, i) => 'x' + i + ':native')
  const { engine, calls } = seedEngine(t, {
    assets,
    markets: assets.map((id) => cex(id, 'fiat:USD')),
    profile: 'large',
    scheduler: { backgroundJobs: null },
  })
  engine.respond = () => new Promise(() => {})
  engine.active = true
  t.after(() => {
    engine.active = false
    engine.abort = { signal: { aborted: true } }
  })
  registerHistorySeed(engine, { count: 2 })
  await new Promise((r) => setTimeout(r, 700))
  // Four imports in flight on a large node, all started by the loop's own timer.
  assert.equal(calls.length, SEED_PARALLEL.large)
})

test('seed: parallel imports stay within the history share, leave half the budget to others above a floor', async (t) => {
  const assets = Array.from({ length: 12 }, (_, i) => 'x' + i + ':native')
  const { engine, calls, tick } = seedEngine(t, {
    assets,
    markets: assets.map((id) => cex(id, 'fiat:USD')),
    profile: 'large',
    scheduler: { backgroundJobs: ['cex:x'] },
  })
  const release = []
  engine.respond = (id, options) =>
    new Promise((resolve) =>
      release.push(() => resolve([{ ts: options.to - HOUR, open: '1', high: '1', low: '1', close: '1', source: 'cex:v' }]))
    )
  engine.budget = { used: 0, limit: 100 }
  engine.history = { requests: 0 }
  engine.active = true
  const seed = registerHistorySeed(engine, { count: 2 })
  seed.pump()
  assert.equal(calls.length, SEED_PARALLEL.large)
  // Full: nothing more until one finishes.
  seed.pump()
  assert.equal(calls.length, SEED_PARALLEL.large)
  for (const done of release.splice(0)) done()
  await new Promise((r) => setImmediate(r))
  // History sent 40% of the budget this minute: the loop waits.
  engine.history.requests = 40
  seed.pump()
  assert.equal(calls.length, SEED_PARALLEL.large)
  // A minute later: the other jobs use half the budget, but history is below its floor (15%): it competes anyway,
  // so a small node whose market jobs fill the budget still imports history.
  tick(61_000)
  engine.history.requests = 41
  engine.budget.used = 50
  seed.pump()
  assert.equal(calls.length, 2 * SEED_PARALLEL.large)
  for (const done of release.splice(0)) done()
  await new Promise((r) => setImmediate(r))
  // Above its floor history waits for the market jobs while they use half the budget.
  engine.history.requests = 56
  seed.pump()
  assert.equal(calls.length, 2 * SEED_PARALLEL.large)
  // Never once the whole budget is spent, floor or not.
  tick(61_000)
  engine.budget.used = 100
  seed.pump()
  assert.equal(calls.length, 2 * SEED_PARALLEL.large)
  engine.budget.used = 0
  seed.pump()
  assert.equal(calls.length, 3 * SEED_PARALLEL.large)
  for (const done of release.splice(0)) done()
})

test('history seed imports KRW-quoted hourly bars using matching USDT/KRW and actual USDT/USD hours', async t => {
  const token = market('cex:upbit:IRYS-KRW', 'KRW-IRYS', 'fiat:KRW')
  const bridge = { ...market('cex:upbit:USDT-KRW', 'KRW-USDT', 'fiat:KRW'), base: USDT }
  const { engine, store } = seedEngine(t, { assets: [IRYS, USDT], markets: [token, bridge] })
  const start = to - 8 * DAY
  const candleTime = i => start + i * HOUR
  for (let i = 0; i < 192; i++) {
    if (i !== 2) store.recordPrices([{ asset: USDT, at: candleTime(i), price: '0.96' }])
  }
  // The token's local close always wins over imported history for its hour.
  store.recordPrices([{ asset: IRYS, at: candleTime(3), price: '1.5' }])
  const { h, asked } = fixture({
    markets: [token, bridge],
    respond: async (_, url) => {
      const fx = new URL(url).searchParams.get('market') === 'KRW-USDT'
      return Array.from({ length: 192 }, (_, i) => {
        const p = i % 2 ? 1300 : 1200
        return { candle_date_time_utc: new Date(candleTime(i)).toISOString(),
          opening_price: fx ? p : 2400, trade_price: fx ? p + 1 : 2402,
          high_price: fx ? (i === 1 ? 1.1 * p : p + 2) : 2404, low_price: fx ? p - 1 : 2390 }
      })
    },
  })
  h.store = store
  engine.registry = h.registry
  engine.candles = h.get.bind(h)
  const seed = registerHistorySeed(engine, { count: 1 })
  assert.equal(await seed.run(1), 189)
  assert.equal(asked.length, 2)
  assert.match(asked[0].url, /market=KRW-USDT/)
  const bars = store.candles({ asset: IRYS, tf: '1h', from: start, to, limit: 192 })
  const byTime = new Map(bars.map(b => [b.ts, b]))
  const first = bars[0]
  assert.ok(Math.abs(+first.open - 1.92) < 1e-12)
  assert.ok(Math.abs(+first.high - 2404 * 0.96 / 1199) < 1e-12)
  assert.ok(Math.abs(+first.low - 2390 * 0.96 / 1202) < 1e-12)
  assert.ok(Math.abs(+first.close - 2402 * 0.96 / 1201) < 1e-12)
  assert.equal(byTime.has(candleTime(1)), false) // Too-wide FX wick.
  assert.equal(byTime.has(candleTime(2)), false) // No stable/USD anchor for that hour.
  assert.equal(byTime.get(candleTime(3)).close, '1.5')
  assert.equal(byTime.has(to - DAY), true)
})

test('fiat bridge selection prefers the same venue, then a proven active alternative, within the request budget', async () => {
  for (const fiat of ['TRY', 'THB', 'EUR', 'JPY', 'BRL', 'IDR']) {
    const quote = 'fiat:' + fiat
    const token = market('cex:bitget:IRYS-' + fiat, 'IRYS' + fiat, quote)
    const same = { ...market('cex:bitget:USDT-' + fiat, 'USDT' + fiat, quote), base: USDT }
    // Fiat as base, stablecoin as quote: use the quoted rate in the original direction.
    const other = { ...market('cex:mexc:' + fiat + '-USDT', fiat + 'USDT', USDT), base: quote }
    const { h, asked } = fixture({ markets: [token, other, same], respond: async (_, url) => {
      const symbol = new URL(url).searchParams.get('symbol')
      const p = symbol === other.symbol ? 0.25 : symbol === same.symbol ? 4 : 8
      return Array.from({ length: 24 }, (_, i) => [from + i * HOUR, p, p * 1.001, p * 0.999, p])
    } })
    const opts = { tf: '1h', from, to, limit: 24, attempts: 2 }
    assert.equal((await h.get(IRYS, { ...opts, attempts: 1 })).length, 0)
    assert.equal(asked.length, 0)
    const rows = await h.get(IRYS, opts)
    assert.equal(rows.length, 24)
    assert.match(asked[0].url, new RegExp('symbol=' + same.symbol))
    assert.equal(+rows[0].close, 2 * 0.9989)
    const cached = await h.get(IRYS, { ...opts, attempts: 1 })
    assert.equal(cached.length, 24)
    assert.equal(asked.length, 3) // Only the asset request, reusing the closed bridge hours.
    h.registry.halted = new Map([[same.id, { reason: 'status' }]])
    h.registry.active.set(other.id, false)
    assert.deepEqual(await h.get(IRYS, opts), [])
    assert.equal(asked.length, 3)
    h.registry.active.set(other.id, true)
    assert.equal(+(await h.get(IRYS, opts))[0].close, +rows[0].close)
    assert.match(asked[3].url, new RegExp('symbol=' + other.symbol))
  }
})

test('a flat or mispriced fiat bridge cannot establish a dollar rate', async () => {
  const token = market('cex:bitget:IRYS-TRY', 'IRYSTRY', 'fiat:TRY')
  const bridge = { ...market('cex:bitget:USDT-TRY', 'USDTTRY', 'fiat:TRY'), base: USDT }
  for (const [p, flat] of [[40, true], [400, false]]) {
    const { h, asked } = fixture({
      markets: [token, bridge],
      respond: async () => Array.from({ length: 24 }, (_, i) =>
        [from + i * HOUR, p, flat ? p : p * 1.001, p, p]),
    })
    h.registry.venues = new Map(venues)
    h.registry.venues.set('bitget', { ...venues.get('bitget'), lastTickers: new Map([[bridge.id, { price: 40, at: to }]]) })
    assert.deepEqual(await h.get(IRYS, { tf: '1h', from, to, limit: 24 }), [])
    assert.equal(asked.length, 1)
    assert.match(asked[0].url, /USDTTRY/)
  }
})

test('an active fiat-only asset gets background history after its USD market disappears', async t => {
  const quote = 'fiat:THB', token = cex(IRYS, quote), bridge = cex(USDT, quote)
  const { engine, store, calls } = seedEngine(t, { assets: [IRYS, USDT], markets: [token, bridge] })
  store.writer.prepare('DELETE FROM prices').run()
  engine.registry.assets = new Map([[IRYS, { id: IRYS }], [USDT, { id: USDT, stable: true }]])
  engine.registry.active = new Map([[token.id, true], [bridge.id, false]])
  const seed = registerHistorySeed(engine, { count: 1 })
  assert.equal(seed.due(), undefined)
  engine.registry.active.set(bridge.id, true)
  // The next scheduled registry scan sees the fiat bridge.
  const later = registerHistorySeed(engine, { count: 1 })
  assert.equal(later.due(), IRYS)
  assert.equal(await later.run(1), 48)
  assert.equal(calls[0][0], IRYS)
  assert.equal(store.candles({ asset: IRYS, tf: '1h', from: to - 2 * DAY, to, limit: 48 }).length, 48)
  assert.deepEqual(store.listMarkets(), [])
})

test('partial USD bars retry a proven fiat route when the 24h bar is still missing', async t => {
  const token = cex(IRYS, 'fiat:TRY'), bridge = cex(USDT, 'fiat:TRY')
  const { engine, store, tick, now } = seedEngine(t, { assets: [IRYS], markets: [token, bridge] })
  engine.registry.assets = new Map([[IRYS, { id: IRYS }], [USDT, { id: USDT, stable: true }]])
  engine.registry.active = new Map([[token.id, true], [bridge.id, true]])
  const seed = registerHistorySeed(engine, { count: 0 })
  let offset = HOUR
  engine.respond = () => [{ ts: to - offset, open: '1', high: '1.1', low: '1', close: '1', source: token.id }]
  assert.equal(await seed.run(1), 1)
  assert.equal(seed.state.get(IRYS).retryAt, now() + SEED_RETRY[0])
  assert.equal(seed.due(), undefined)
  tick(SEED_RETRY[0])
  offset = DAY
  assert.equal(await seed.run(1), 1)
  assert.equal(seed.state.get(IRYS).retryAt, 0)
  assert.equal(seed.due(), undefined)
  assert.equal(store.candles({ asset: IRYS, tf: '1h' }).length, 2)
})

test('a paced venue can use successive slots for sparse dollar bars, its fiat bridge, then the missing fiat bars', async () => {
  const thin = market('cex:bitget:IRYS-USDT', 'IRYSUSDT', USDT)
  const token = market('cex:bitget:IRYS-TRY', 'IRYSTRY', 'fiat:TRY')
  const bridge = { ...market('cex:bitget:USDT-TRY', 'USDTTRY', 'fiat:TRY'), base: USDT }
  let now = to, next = 0
  const sent = [], local = []
  const { h } = fixture({ markets: [thin, token, bridge], main: { [IRYS]: thin.id }, local, respond: async (_host, url) => {
    if (now < next) throw new RateLimited(next)
    next = now + 10_000
    const symbol = new URL(url).searchParams.get('symbol')
    sent.push(symbol)
    if (symbol === thin.symbol) return venueRows('bitget', 1, 3)
    const p = symbol === bridge.symbol ? 50 : 55
    return Array.from({ length: 24 }, (_, i) => [from + i * HOUR, p, p * 1.001, p * 0.999, p])
  } })
  h.clock = h.scheduler.clock = () => now
  const opts = { tf: '1h', from, to, limit: 24, attempts: 4 }
  local.push(...await h.get(IRYS, opts))
  assert.equal(local.length, 3)
  now += 60_000
  assert.equal((await h.get(IRYS, opts)).length, 3)
  now += 120_000
  assert.equal((await h.get(IRYS, opts)).length, 24)
  assert.deepEqual(sent, ['IRYSUSDT', 'USDTTRY', 'IRYSTRY'])
})
