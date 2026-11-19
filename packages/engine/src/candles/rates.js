import { multiplyPrice } from '../aggregate/decimal.js'
import { decimal } from '../obs/index.js'
import { deadHistory } from './provider.js'

export const QUOTE_BAND = 0.005
export const QUOTE_WICK = 0.02

/** Bound the error in intra-hour USD extrema. Clip a narrow body's moderate wick to the body. */
export function quoteFactor(rate) {
  const [bottom, top] = +rate.open <= +rate.close ? [rate.open, rate.close] : [rate.close, rate.open]
  if (+rate.high <= +rate.low * (1 + QUOTE_BAND)) return rate
  if (+top <= +bottom * (1 + QUOTE_BAND) && +rate.high <= +rate.low * (1 + QUOTE_WICK))
    return { open: rate.open, close: rate.close, high: top, low: bottom }
  return null
}

export function dollarFields(bar, factor) {
  return Object.fromEntries(['open', 'high', 'low', 'close'].map(k =>
    [k, factor ? multiplyPrice(bar[k], factor[k]) : decimal(bar[k])]))
}

function inverse(bar) {
  return { open: 1 / +bar.open, close: 1 / +bar.close, high: 1 / +bar.low, low: 1 / +bar.high }
}

/** The non-USD fiat in a registered dollar or stablecoin cross, in either orientation. */
export function bridgeCurrency(pair, assets) {
  if (pair.quote.startsWith('fiat:') && pair.quote !== 'fiat:USD' &&
      (pair.base === 'fiat:USD' || assets?.get(pair.base)?.stable)) return pair.quote
  if (pair.base.startsWith('fiat:') && pair.base !== 'fiat:USD' &&
      (pair.quote === 'fiat:USD' || assets?.get(pair.quote)?.stable)) return pair.base
  return null
}

/** Fill hourly fiat/USD gaps with actual synchronous stable/USD and stable/fiat (or fiat/stable)
 * bars. registry.active requires recent, positive own/proven turnover. Prefer the asset's venue. */
export async function addFiatRates(history, market, range, fx, expected, read) {
  const { registry, store } = history, { from, to, limit } = range
  const fiat = market.quote, now = history.clock()
  const bridges = []
  for (const pair of registry.markets.values()) {
    const inverted = pair.quote === fiat
    if (!inverted && pair.base !== fiat) continue
    if (pair.kind !== 'cex' || !pair.symbol || pair.id === market.id || !registry.active?.get(pair.id) ||
        registry.halted?.has(pair.id) || !registry.venues.get(pair.exchange)?.candles?.intervals?.['1h']) continue
    if (bridgeCurrency(pair, registry.assets) !== fiat) continue
    const anchor = inverted ? pair.base : pair.quote
    const tick = registry.venues.get(pair.exchange).lastTickers?.get(pair.id)
    const turnover = tick ? tick.volume * (inverted ? 1 : tick.price) : 0
    bridges.push({ pair, inverted, anchor, turnover })
  }
  bridges.sort((a, b) => Number(b.pair.exchange === market.exchange) - Number(a.pair.exchange === market.exchange) ||
    Number(b.anchor === 'fiat:USD') - Number(a.anchor === 'fiat:USD') ||
    b.turnover - a.turnover || a.pair.id.localeCompare(b.pair.id))
  for (const { pair, inverted, anchor } of bridges) {
    if (fx.size >= expected) break
    const stableBars = anchor === 'fiat:USD' ? null : store.candles({ asset: anchor, tf: '1h', from, to, limit })
    if (stableBars && stableBars.length < Math.min(12, expected)) continue
    const key = JSON.stringify([pair.id, from, to, limit])
    const cached = history.fiatSeries.get(key)
    let bars = cached?.expires > now ? cached.bars : null
    if (!bars) {
      bars = await read(pair)
      if (!bars) continue
      // Reuse raw closed hours, never a partial current hour or a derived peg. The consumer
      // always checks current market eligibility and re-reads the stablecoin's own USD bars.
      if (to <= now - (now % 3_600_000)) {
        if (history.fiatSeries.size >= 64) history.fiatSeries.delete(history.fiatSeries.keys().next().value)
        history.fiatSeries.set(key, { bars, expires: now + (bars.length ? 3_600_000 : 60_000) })
      }
    }
    if (!bars.length || deadHistory(bars) || registry.halted?.has(pair.id) || !registry.active.get(pair.id)) continue
    const spot = registry.venues.get(pair.exchange).lastTickers?.get(pair.id)
    if (spot && !history.plausible(pair.id, bars, new Map(), to, spot.price)) continue
    const usd = new Map(stableBars?.map(b => [b.ts, b]) ?? [])
    for (const bar of bars) {
      if (fx.has(bar.ts)) continue
      const stable = usd.get(bar.ts)
      const dollar = stable && quoteFactor(stable)
      if (stableBars && !dollar) continue
      const leg = inverted ? inverse(bar) : bar
      const fields = dollarFields(leg, dollar)
      if (Object.values(fields).every(v => +v > 0) && quoteFactor(fields)) fx.set(bar.ts, fields)
    }
  }
}
