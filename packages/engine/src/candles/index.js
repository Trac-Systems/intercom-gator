import { deadHistory, historyParams, providerBars } from './provider.js'
import { fillBody, formatUrl } from '../sources/http.js'
import { decimal } from '../obs/index.js'
import { RateLimited } from '../scheduler/index.js'
import { updateHalts } from '../sources/cex.js'
import { addFiatRates, dollarFields, quoteFactor } from './rates.js'
export { QUOTE_BAND, QUOTE_WICK } from './rates.js'
export { deadHistory } from './provider.js'

const WIDTH = Object.freeze({ '1m': 60000, '5m': 300000, '1h': 3600000, '1d': 86400000 })
const DAY = WIDTH['1d']
/** Hard cap on one venue history request (fetch timeout and a race, in case a transport ignores the signal). */
export const VENUE_TIMEOUT = 5000
/** Default upstream wait of one get(): an API caller gets what the node has after a few seconds. */
export const HISTORY_WAIT = 4000
/** A market whose day-or-longer history came back empty or flat (halted, delisted, nobody trades it) is skipped
 * without a request for this long. */
export const IDLE_MARKET_MS = 6 * 3_600_000
/** A venue series more than this factor away from the asset's own price (its local bars where they overlap,
 * otherwise the current price for a range ending within three hours) is another project under the same ticker
 * (RAIN-USDT at $68 against RAIN at $0.0043): skipped and marked idle. */
export const PRICE_FACTOR = 3
/** A price mismatch is re-checked sooner than a halted pair: the node's own price can still be settling. */
export const MISMATCH_IDLE_MS = 30 * 60_000

export class HistoryTimeout extends Error {
  constructor(ms) {
    super('Venue history timed out after ' + ms + ' ms')
  }
}

function within(promise, ms) {
  let timer
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new HistoryTimeout(ms)), ms)
  })
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
}

/** The store builds the four UTC frames atomically with observation insertion.
 * Backfill returns bounded upstream bars; only actual historical quote/USD rates may convert them. */
export class CandleHistory {
  constructor({ store, registry, http, clock, scheduler, outliers = () => null }) {
    Object.assign(this, { store, registry, http, clock, scheduler, outliers })
    /** Upstream history requests actually sent (throttled skips cost nothing). */
    this.requests = 0
    /** `${market}:${tf}` -> skip until (engine clock) */
    this.idle = new Map()
    this.fiatSeries = new Map()
    this.partialHours = new Map()
    /** asset -> ts -> closed daily venue bar, for the 16 assets charted last */
    this.days = new Map()
  }
  markIdle(key, ms = IDLE_MARKET_MS) {
    const now = this.clock()
    if (this.idle.size >= 10_000) for (const [k, until] of this.idle) if (until <= now) this.idle.delete(k)
    if (this.idle.size < 10_000) this.idle.set(key, now + ms)
  }
  /** Venue markets with candles for `tf`, best first: the main (highest-volume) market, then USD pairs, then
   * stablecoin quotes, then the rest; active markets before idle ones. */
  candidates(asset, tf) {
    const { registry } = this
    const main = registry.main.get(asset)?.id
    // A market the price currently leaves out as an outlier would import another price series.
    const outlying = new Set(this.outliers(asset) ?? [])
    const rank = (m) =>
      m.id === main ? 0 : m.quote === 'fiat:USD' ? 1 : registry.assets.get(m.quote)?.stable ? 2 : 3
    return [...registry.markets.values()]
      .filter(
        (m) =>
          m.base === asset &&
          m.kind === 'cex' &&
          !outlying.has(m.id) &&
          m.symbol &&
          registry.venues.get(m.exchange)?.candles?.intervals?.[tf] != null
      )
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          Number(registry.active?.get(b.id) ?? 0) - Number(registry.active?.get(a.id) ?? 0) ||
          a.id.localeCompare(b.id)
      )
  }
  /** Venue bars (in USD) against the asset's own price: the median ratio to overlapping local bars, else the
   * latest venue close against the current price when the range ends within three hours. No reference: accepted. */
  plausible(asset, converted, ownBars, to, spot) {
    if (!converted.length) return true
    const near = (ratio) => Math.abs(Math.log(ratio)) <= Math.log(PRICE_FACTOR)
    const ratios = converted
      .filter((b) => ownBars.get(b.ts) > 0)
      .map((b) => +b.close / ownBars.get(b.ts))
      .sort((a, b) => a - b)
    if (ratios.length) return near(ratios[ratios.length >> 1])
    const price = +(spot ?? this.store.getPrice?.(asset)?.price ?? NaN)
    if (!(price > 0) || to < this.clock() - 3 * 3_600_000) return true
    return near(+converted.at(-1).close / price)
  }
  async market(market, tf, from, to, limit, { timeout = VENUE_TIMEOUT } = {}) {
    const venue = this.registry.venues.get(market.exchange),
      spec = venue?.candles
    if (!spec?.intervals[tf] || !market.symbol) return []
    // "Latest N bars" venues include the open bar at `to`, which the range excludes: one more fills the range,
    // so one venue is enough instead of trying the next ones for the missing oldest hour.
    const tick = venue.lastTickers?.get(market.id)
    const started = this.clock()
    // A pair might have resumed during the open hour. Inspect it too before declaring a halt,
    // while still returning only the caller's requested closed bars.
    const sourceTo = tick && tf === '1h' && to === started - started % WIDTH[tf] ? started + 1 : to
    // A range longer than one venue page asks for its newest page. Start-anchored venues (Binance startTime, Kraken
    // since) answered with the OLDEST bars of the range: an ALL chart from 1983 got 2015-2018 and nothing after.
    const start = Math.max(from, sourceTo - Math.min(limit + 1, spec.max ?? Infinity) * WIDTH[tf])
    const params = historyParams(market, spec, tf, start, sourceTo, limit + 1)
    const url = formatUrl(spec.url, params)
    // POST venues (Hyperliquid candleSnapshot) carry the range in the body; GET sent them a bodyless 405.
    const body = spec.method === 'POST' && spec.body ? fillBody(spec.body, params) : null
    const json = await within(
      this.scheduler.demand('candles:' + market.id, body ? url + ' ' + JSON.stringify(body) : url, () =>
        this.http.get(url, venue.rpm, spec.cost ?? 1, body, timeout).then(
          (json) => {
            this.requests++
            return json
          },
          (error) => {
            if (!(error instanceof RateLimited)) this.requests++
            throw error
          }
        )
      ),
      timeout + 100
    )
    const bars = new Map()
    let latest = -Infinity
    for (const row of providerBars(venue.id, json, tf)) {
      const ts = row.at
      if (!Number.isSafeInteger(ts) || ts <= 0 || ts % WIDTH[tf]) continue
      const fields = Object.fromEntries(['open', 'high', 'low', 'close'].map((k) => [k, decimal(row[k])]))
      if (
        Object.values(fields).some((v) => v == null || !(+v > 0)) ||
        +fields.low > Math.min(+fields.open, +fields.close) ||
        +fields.high < Math.max(+fields.open, +fields.close)
      )
        continue
      latest = Math.max(latest, ts)
      if (ts < from || ts >= to) continue
      bars.set(ts, { ts, tf, ...fields, source: market.id, quote: market.quote })
    }
    const now = this.clock(), halt = this.registry.halted?.get(market.id)
    // A historical query, an empty/error payload, a date partition or the first page of a long
    // range says nothing about trading today. Only a valid series that reaches for the present counts.
    if (tick && tick === venue.lastTickers.get(market.id) && tf === '1h' &&
        tick.at >= now - DAY && latest <= now &&
        sourceTo >= started && sourceTo <= started + WIDTH['1h'] && !spec.url.includes('{yyyymmdd}') &&
        Math.ceil((sourceTo - from) / WIDTH[tf]) <= params.limit) {
      // DigiFinex retains deleted pairs in all-tickers, with a frozen positive book and turnover.
      // Its symbol-specific API explicitly reports a suspended trade (20002) or an invalid symbol (20019).
      const rejected = venue.id === 'digifinex' && [20002, 20019].includes(json?.code) &&
        market.symbol.toUpperCase() === market.id.split(':')[2].replace('-', '_')
      const old = Number.isFinite(latest) && latest + WIDTH[tf] < now - DAY && !(tick.tradeAt >= now - DAY)
      if (!halt && (rejected || old)) {
        const evidence = { reason: rejected ? 'inactive symbol' : 'old candles', price: tick.price, volume: tick.volume,
          count: tick.count, lastId: tick.lastId, checkedAt: now }
        updateHalts(this.registry, new Map([[market.id, evidence]]))
      } else if ((halt?.reason === 'old candles' || halt?.reason === 'inactive symbol') &&
                 latest + WIDTH[tf] >= now - DAY) {
        updateHalts(this.registry, new Map([[market.id, null]]))
      }
    }
    return [...bars.values()].sort((a, b) => a.ts - b.ts).slice(0, limit)
  }
  /** `wait` bounds the upstream time (ms), `timeout` each venue request and `attempts` the requests actually sent;
   * venues whose bucket is throttled or whose quote has no local rates are skipped without a request. */
  async get(
    asset,
    {
      tf = '1m',
      from,
      to = this.clock() + 1,
      limit = 500,
      backfill = true,
      wait = HISTORY_WAIT,
      timeout = VENUE_TIMEOUT,
      attempts = 3,
    } = {}
  ) {
    if (
      !Object.hasOwn(WIDTH, tf) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 2000 ||
      !Number.isSafeInteger(to) ||
      to < 0
    )
      throw new RangeError('Invalid candle range')
    from ??= Math.max(0, to - limit * WIDTH[tf])
    if (!Number.isSafeInteger(from) || from < 0 || from > to) throw new RangeError('Invalid candle start')
    const market = this.registry.markets.get(asset)
    if (market) return this.market(market, tf, from, to, limit)
    const local = this.store.candles({ asset, tf, from, to, limit })
    const expected = Math.min(limit, Math.ceil(to / WIDTH[tf]) - Math.ceil(from / WIDTH[tf]))
    if (!backfill || local.length >= expected) return local
    // The asset's highest-volume market first, then USD pairs (no conversion). A thin pair's history carries
    // stale wicks or, when nobody trades it, flat bars at an old price (FLOKI/USD drew a week of steps).
    const stable = !!this.registry.assets.get(asset)?.stable
    const bars = new Map(local.map((b) => [b.ts, b]))
    const ownBars = new Map(local.map((b) => [b.ts, +b.close]))
    // Closed days a venue already sent stay valid: a 1Y or ALL chart's next load (or its retry) asks only for what is
    // still missing. Each load fetched every page again, and a venue that allows one long read per window (Bitfinex)
    // left a busy node's ALL chart at a few bars, load after load.
    const days = tf === '1d' ? this.days.get(asset) : null
    if (days) {
      this.days.delete(asset)
      this.days.set(asset, days)
      for (const [ts, bar] of days) if (ts >= from && ts < to && !bars.has(ts)) bars.set(ts, bar)
      if (bars.size >= expected) return [...bars.values()].sort((a, b) => a.ts - b.ts).slice(0, limit)
    }
    const started = performance.now()
    let lastError,
      sent = 0,
      retryAt = Infinity
    // Fiat bridge requests use the same wait and attempts as the asset. Throttled reads cost no attempt.
    const read = async (pair) => {
      const left = wait - (performance.now() - started)
      if (sent >= attempts || left <= 0) return null
      const allowed = Math.max(50, Math.floor(Math.min(timeout, left)))
      try {
        const result = await this.market(pair, tf, from, to, limit, { timeout: allowed })
        sent++
        return result
      } catch (error) {
        if (error instanceof RateLimited) retryAt = Math.min(retryAt, error.retryAt)
        else sent++
        // A venue whose own HTTP answer timed out on a full-length read (binance.us from outside the US) took the
        // whole wait of a chart load; skip it for a while. A HistoryTimeout can be our own request queue: no mark.
        if (allowed >= 3000 && error?.name === 'TimeoutError') this.markIdle(pair.id + ':' + tf, MISMATCH_IDLE_MS)
        lastError = error
        return null
      }
    }
    const now = this.clock()
    const candidates = this.candidates(asset, tf)
    // A deep range (1Y, ALL and its older pages) asks first the venues that can serve the most of it: those that
    // take a start or end take up to their page size; those that only send their newest bars help only a range that
    // ends today. The three attempts of an ALL chart went to crypto.com (newest 300 days), binance.us and a pair
    // listed 54 days ago, before Bitfinex (10,000 days a page) was reached. An undeclared page size counts as 1,000.
    // Ties keep the quality order above.
    if (expected > 300) {
      const serves = (m) => {
        const spec = this.registry.venues.get(m.exchange)?.candles
        const ranged = /\{(?:startMs|startSec|lastMs|endMs|endSec|yyyymmdd)\}/.test(spec?.url ?? '')
        return ranged || to >= now - WIDTH[tf] ? Math.min(expected, spec?.max ?? 1000) : 0
      }
      const score = new Map(candidates.map((m) => [m, serves(m)]))
      candidates.sort((a, b) => score.get(b) - score.get(a))
    }
    const closedFiatRange = tf === '1h' && to <= now - now % WIDTH[tf] &&
      candidates.some(m => m.quote !== 'fiat:USD' && m.quote.startsWith('fiat:'))
    for (const market of candidates) {
      if (sent >= attempts || performance.now() - started >= wait || bars.size >= expected) break
      const key = market.id + ':' + tf
      if (to >= this.clock() - WIDTH['1h'] && this.registry.halted?.has(market.id)) continue
      if ((this.idle.get(key) ?? 0) > this.clock()) continue
      // Do not spend the venue's next rate-limit slot re-reading the same sparse USD pair
      // after the seed saved every hour it supplied. Leave that slot for the fiat listing.
      const partial = closedFiatRange && this.partialHours.get(market.id)
      if (partial && partial.expires > this.clock() && partial.from === from && partial.to === to &&
          partial.limit === limit && partial.hours.every(ts => bars.has(ts))) continue
      const rates =
        market.quote === 'fiat:USD' ? null : this.store.candles({ asset: market.quote, tf, from, to, limit })
      // A quote with (almost) no local bars yet, e.g. USDT on a fresh node before its own import: the venue's bars
      // could not convert, so spend nothing on them.
      const fx = new Map(rates?.map((r) => [r.ts, r]) ?? [])
      if (tf === '1h' && rates && fx.size < expected && market.quote.startsWith('fiat:'))
        await addFiatRates(this, market, { from, to, limit }, fx, expected, pair => sent + 1 < attempts ? read(pair) : null)
      if (rates && fx.size < Math.min(12, expected)) continue
      const history = await read(market)
      if (!history) continue
      if (to >= this.clock() - WIDTH['1h'] && this.registry.halted?.has(market.id)) continue
      const dead = !history.length || (!stable && deadHistory(history))
      // A short range may be empty for a thin market; a day or more without a bar is a halted or delisted pair.
      // Only a range reaching today says so: an empty page from before the listing (an ALL chart's older pages)
      // marked the best daily markets idle for 6 h, and 1Y then fell back to the node's own few bars.
      if (dead && to - from >= DAY && to >= this.clock() - DAY) this.markIdle(key)
      if (dead) {
        lastError = new Error('No trading in ' + market.id + ' history')
        continue
      }
      const converted = []
      for (const row of history) {
        const ts = row.ts
        const rate = fx.get(ts)
        if (rates && !rate) continue
        // An OHLC bar in a moving quote cannot supply exact intra-bar USD extrema.
        const factor = rate && quoteFactor(rate)
        if (rate && !factor) continue
        const fields = dollarFields(row, factor)
        converted.push({ asset, tf, ts, ...fields, source: market.id })
      }
      if (!this.plausible(asset, converted, ownBars, to)) {
        this.markIdle(key, MISMATCH_IDLE_MS)
        lastError = new Error('History of ' + market.id + ' does not match the asset price')
        continue
      }
      for (const bar of converted) if (!bars.has(bar.ts)) bars.set(bar.ts, bar)
      if (closedFiatRange && history.length < expected && converted.length === history.length) {
        if (this.partialHours.size >= 128) this.partialHours.delete(this.partialHours.keys().next().value)
        this.partialHours.set(market.id, { from, to, limit, expires: this.clock() + WIDTH[tf],
          hours: converted.map(b => b.ts) })
      }
    }
    if (bars.size === local.length && lastError) {
      // Nothing was sent anywhere: report when the earliest throttled venue frees up.
      if (!sent && retryAt < Infinity) throw new RateLimited(retryAt)
      if (!bars.size) throw lastError
    }
    if (tf === '1d') {
      const closed = this.clock() - DAY, kept = this.days.get(asset) ?? new Map()
      for (const [ts, bar] of bars) if (!ownBars.has(ts) && ts < closed && kept.size < 10_000) kept.set(ts, bar)
      if (kept.size && !this.days.has(asset)) {
        if (this.days.size >= 16) this.days.delete(this.days.keys().next().value)
        this.days.set(asset, kept)
      }
    }
    return [...bars.values()].sort((a, b) => a.ts - b.ts).slice(0, limit)
  }
}
