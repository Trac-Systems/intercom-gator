import { atPath } from '../sources/bundle-adapter.js'
import { timestamp } from '../sources/cex.js'

/** At least 80% of a dozen or more bars with open = high = low = close. */
export function deadHistory(rows) {
  if (rows.length < 12) return false
  const flat = rows.filter((r) => +r.open === +r.high && +r.high === +r.low && +r.low === +r.close).length
  return flat >= rows.length * 0.8
}

const positions = {
  bitbank: [5, 0, 1, 2, 3],
  bitfinex: [0, 1, 3, 4, 2],
  kucoin: [0, 1, 3, 4, 2],
  whitebit: [0, 1, 3, 4, 2],
  gate: [0, 5, 3, 4, 2],
  digifinex: [0, 5, 3, 4, 2],
  poloniex: [12, 2, 1, 0, 3],
}
const keys = {
  at: [
    'candle_date_time_utc',
    'start',
    'startTime',
    'startedAt',
    'time',
    'Time',
    'timestamp',
    'bucket_start_time',
    't',
    'idx',
    'i',
    'id',
  ],
  open: ['open', 'Open', 'o', 'opening_price', 'first_rate'],
  high: ['high', 'High', 'h', 'high_price', 'max_rate', 'max'],
  low: ['low', 'Low', 'l', 'low_price', 'min_rate', 'min'],
  close: ['close', 'Close', 'c', 'trade_price', 'last_rate', 'target_volume_last'],
}

/** Query responses use named bars, positional bars, or parallel TradingView series. */
export function providerBars(venue, json, tf) {
  if (venue === 'cex-io' && tf && Object.hasOwn(json ?? {}, 'data' + tf)) {
    const frame = json?.['data' + tf]
    if (typeof frame !== 'string') return []
    json = JSON.parse(frame)
  }
  const result = [],
    pending = [json]
  while (pending.length) {
    const node = pending.pop()
    if (!node || typeof node !== 'object') continue
    if (Array.isArray(node.t) && Array.isArray(node.o)) {
      for (const [i, at] of node.t.entries())
        result.push({ at: timestamp(at, NaN), open: node.o[i], high: node.h?.[i], low: node.l?.[i], close: node.c?.[i] })
      continue
    }
    let fields
    if (Array.isArray(node) && typeof node[0] !== 'object' && node.length >= 5) {
      const layout = positions[venue] ?? [0, 1, 2, 3, 4]
      fields = Object.fromEntries(['at', 'open', 'high', 'low', 'close'].map((k, i) => [k, node[layout[i]]]))
    } else if (!Array.isArray(node)) {
      fields = Object.fromEntries(
        Object.entries(keys).map(([k, aliases]) => [k, aliases.map((a) => atPath(node, a)).find((v) => v != null)])
      )
      if (node.candle_date_time_utc && !/[Z+-]\d*:?\d*$/.test(node.candle_date_time_utc.slice(10))) fields.at += 'Z'
    }
    if (fields && Object.values(fields).every((v) => typeof v === 'string' || typeof v === 'number')) {
      fields.at = timestamp(fields.at, NaN)
      result.push(fields)
    } else {
      for (const value of Object.values(node)) if (value && typeof value === 'object') pending.push(value)
    }
  }
  return result
}

export function historyParams(market, spec, tf, from, to, limit) {
  const [base, quote] = market.id.split(':')[2].split('-')
  let symbol = market.symbol
  if (market.exchange === 'bitstamp') symbol = symbol.replace('/', '').toLowerCase()
  if (market.exchange === 'bithumb') symbol = quote + '-' + base
  if (market.exchange === 'bitkub') symbol = base + '_' + quote
  if (market.exchange === 'indodax') symbol = symbol.replace('_', '').toUpperCase()
  const date = new Date(from).toISOString().slice(0, 10).replaceAll('-', '')
  return {
    symbol,
    base,
    quote,
    interval: spec.intervals[tf],
    limit: Math.min(limit, spec.max ?? limit),
    from,
    to,
    startSec: Math.floor(from / 1000),
    endSec: Math.floor(to / 1000),
    startMs: from,
    endMs: to,
    lastMs: Math.max(from, to - 1),
    yyyymmdd: market.exchange === 'bitbank' && tf === '1d' ? date.slice(0, 4) : date,
  }
}
