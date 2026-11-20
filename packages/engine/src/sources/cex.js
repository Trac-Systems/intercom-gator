import { decimal, validRow } from '../obs/index.js'
import { loadCatalog, tickerRecords } from './bundle-adapter.js'
import { formatUrl } from './http.js'

const DAY = 86_400_000
const HALT_PREFIX = 'engine-cex-halt/'
const requiredBook = new Set(['binance', 'binance-us', 'hitbtc', 'kraken', 'poloniex'])
const counted = new Set(['binance', 'binance-us', 'coinsph', 'weex'])

/** Only the node's independent venue reads set or clear a halt. Restore them before replaying the price book. */
export function marketHalts(registry) {
  if (!registry.halted) {
    const rows = registry.store.writer.prepare("SELECT key,value FROM settings WHERE key GLOB 'engine-cex-halt/*'").all()
    registry.halted = new Map(rows.map(({ key, value }) => [key.slice(HALT_PREFIX.length), JSON.parse(value)]))
    registry.haltRevision = 0
  }
  return registry.halted
}

export function updateHalts(registry, changes) {
  if (!changes.size) return
  const halted = marketHalts(registry)
  const clear = registry.store.writer.prepare('DELETE FROM settings WHERE key=?')
  registry.store.transaction(() => {
    for (const [id, evidence] of changes) {
      if (evidence) registry.store.setSetting(HALT_PREFIX + id, evidence)
      else clear.run(HALT_PREFIX + id)
    }
  })
  for (const [id, evidence] of changes) {
    if (evidence) halted.set(id, evidence)
    else halted.delete(id)
  }
  registry.haltRevision++
}

// Top-of-book sizes where the venue's all-tickers row carries them (Bitget/OKX bidSz, Binance bidQty, Bybit bid1Size,
// KuCoin bestBidSize, Kraken b[2]): local evidence for the volume guard only, never on the wire.
const SIZE_FIELDS = [['bidSz', 'askSz'], ['bidQty', 'askQty'], ['bid1Size', 'ask1Size'], ['bestBidSize', 'bestAskSize'],
  ['bidSize', 'askSize']]
export function bookSizes(venue, row) {
  if (venue === 'kraken') return [decimal(row.b?.[2]), decimal(row.a?.[2])]
  for (const [bid, ask] of SIZE_FIELDS) if (row[bid] != null || row[ask] != null) return [decimal(row[bid]), decimal(row[ask])]
  return null
}
/** The larger top-of-book side in quote units, or null when the venue gives no sizes. */
export function bookQuote(bid, ask, sizes) {
  if (!sizes) return null
  const value = Math.max(+bid * +sizes[0] || 0, +ask * +sizes[1] || 0)
  return value > 0 ? value : null
}

function tradeCount(venue, row) {
  if (counted.has(venue)) return decimal(row.count)
  if (venue === 'poloniex') return decimal(row.tradeCount)
  if (venue === 'kraken') return decimal(row.t?.[1])
  return null
}

/** Wire bid/ask are optional. Two explicit zeroes retain the venue's empty-book signal across the wire. */
export function zeroTickerBook(venue, bid, ask) {
  const fields = venue?.ticker?.fields
  return fields?.bid != null && fields.ask != null && bid != null && ask != null &&
    +bid === 0 && +ask === 0 && decimal(bid) != null && decimal(ask) != null
}

/** A tick's observation time (or the 24h window close) need not be its last trade time. */
function haltReason(venue, record, tick, previous, halt) {
  const { row, bid, ask } = record
  if (record.catalogHalted || (venue.id === 'coinbase' &&
      (row.trading_disabled === true || row.is_disabled === true || row.cancel_only === true)))
    return 'status'
  if (zeroTickerBook(venue, bid, ask) || (requiredBook.has(venue.id) &&
      venue.ticker.fields.bid != null && venue.ticker.fields.ask != null &&
      (bid == null || bid === '') && (ask == null || ask === ''))) return 'empty book'
  if (tick.tradeAt > 0 && tick.tradeAt < tick.at - DAY) return 'old trade'
  const updated = timestamp(record.at ?? row.closeTime ?? row.timestamp, null)
  if (updated > 0 && updated < tick.at - DAY) return 'old ticker'
  const count = tick.count
  if (count != null && +count === 0) return 'no trades'
  // A single rounded/zero rolling volume is inconclusive. Require another independent read and
  // preserve pairs reporting a recent trade (including a trade at the same price).
  if (count == null && !(tick.tradeAt > 0 && tick.tradeAt >= tick.at - DAY) && tick.volume === 0 &&
      ((previous?.volume === 0 && tick.price === previous.price && tick.at > previous.at) ||
       (halt?.reason === 'frozen volume' && tick.price === halt.price))) return 'frozen volume'
  if ((halt?.reason === 'old candles' || halt?.reason === 'inactive symbol') &&
      tick.price === halt.price && !(tick.volume > halt.volume) &&
      !(tick.tradeAt > halt.checkedAt) && !(count != null && halt.count != null && +count > +halt.count) &&
      tick.lastId === halt.lastId) return halt.reason
  return null
}

export function timestamp(raw, fallback) {
  if (raw == null) return fallback
  const n = Number(raw)
  if (Number.isFinite(n)) return Math.floor(n < 1e11 ? n * 1000 : n > 1e17 ? n / 1e6 : n > 1e14 ? n / 1000 : n)
  return Date.parse(raw)
}

function isDerivative(venue, raw, r, catalogDerivative) {
  if (venue.derivativeOnly || catalogDerivative || /(?:[-_:](PERP|SWAP)|F0:|PERPETUAL)/i.test(raw)) return true
  if (venue.id === 'bitmex') return r.typ !== 'IFXXXP' // spot instruments
  return /perp|future|option/i.test(String(r.product_type ?? r.market_type ?? ''))
}

export async function fetchTickers({ venue, http, registry, clock, publish, discover, saveDerivative }) {
  const spec = venue.ticker,
    now = clock()
  if (!venue.perSymbolCatalog) await loadCatalog(venue, http, now)
  let url = formatUrl(spec.url, { currency: venue.currency ?? 'BTC', kind: 'future' })
  if (venue.cursor && venue.id === 'coinbase') {
    const next = new URL(url)
    next.searchParams.set('cursor', venue.cursor)
    url = next.href
  }
  const json = await http.get(url, venue.rpm, spec.cost, spec.body)
  const rows = [],
    localQuoteVolumes = new Map(),
    listings = [],
    unknown = new Set()
  const baselineKey = 'engine-cex-baseline/' + venue.id
  const hasBaseline = registry.store.getSetting(baselineKey)
  const halted = marketHalts(registry), changes = new Map()
  const seen = venue.contracts ? new Set() : null
  venue.lastTickers ??= new Map()
  // Per market: the venue's tokenized-stock marker and top-of-book value (volume-guard.js; local only).
  venue.volumeEvidence ??= new Map()
  const remember = registry.store.writer.prepare('INSERT OR IGNORE INTO engine_cex_symbols VALUES (?,?,?)')
  registry.store.transaction(() => {
    for (const record of tickerRecords(venue, json)) {
      const { raw, pair, row, catalogDerivative } = record
      if (isDerivative(venue, raw, row, catalogDerivative)) {
        if (venue.instruments.size < 4096) venue.instruments.add(raw)
        saveDerivative?.(venue.id, raw, record.funding, record.openInterest, now)
        continue
      }
      if (!pair) {
        if (venue.perSymbolCatalog) unknown.add(raw)
        continue
      }
      const price = decimal(record.price)
      if (!(+price > 0) && !registry.markets.has('cex:' + venue.id + ':' + pair.join('-'))) continue
      const market = registry.cex(venue.id, ...pair, raw)
      const symbol = pair.join('-')
      if (remember.run(venue.id, symbol, now).changes && hasBaseline) {
        const listing = { exchange: venue.id, symbol, firstSeen: now }
        registry.store.upsertListing(listing)
        listings.push(listing)
      }
      if (!market) continue
      seen?.add(market.id)
      const book = bookQuote(record.bid, record.ask, bookSizes(venue.id, row))
      if (record.catalogStock || book != null) venue.volumeEvidence.set(market.id, { stock: record.catalogStock, book, at: now })
      else venue.volumeEvidence.delete(market.id)
      const base = decimal(record.baseVolume),
        quote = decimal(record.quoteVolume)
      const usd = decimal(record.usdVolume)
      const tradeAt = timestamp(row.trade_timestamp ?? (venue.id === 'bitvavo' ? row.closeTimestamp : null), null)
      const reported = base != null || quote != null || usd != null
      const rollingVolume = +base || (+price > 0 && +quote / +price) || +usd || 0
      const tick = { at: now, price: price == null ? null : +price, tradeAt, count: tradeCount(venue.id, row), lastId: row.lastId ?? null,
        volume: reported ? rollingVolume : null, dayRatio: record.dayRatio }
      const old = halted.get(market.id)
      const previous = venue.lastTickers.get(market.id)
      if (previous?.at > now) continue
      const reason = haltReason(venue, record, tick, previous, old)
      venue.lastTickers.set(market.id, tick)
      if (reason) {
        if (reason !== old?.reason) changes.set(market.id, reason === 'frozen volume' ? { reason, price: tick.price } : { reason })
        continue
      }
      if (!(+price > 0)) continue
      const volume = usd ?? (market.quote === 'fiat:USD' ? quote : null)
      const observation = [
        market.id,
        price,
        base ?? (quote != null ? decimal(+quote / +price) : '0'),
        volume,
        decimal(record.bid),
        decimal(record.ask),
        timestamp(record.at, now),
      ]
      if (venue.contracts) tick.contractPriceAt = validRow(observation, now) ? observation[6] : 0
      if (old) {
        if (!(venue.contracts ? tick.contractPriceAt : validRow(observation, now))) continue
        changes.set(market.id, null)
      }
      if (old || (previous && now - previous.at > 3_600_000)) venue.contracts?.resumed.add(market.id)
      // A local FX rate may include restricted exchange data. Convert only inside the book.
      if (volume == null && quote != null) localQuoteVolumes.set(observation, quote)
      rows.push(observation)
    }
    const cursor = json?.pagination?.next_cursor
    venue.cursor =
      json?.pagination?.has_next !== false &&
      typeof cursor === 'string' &&
      cursor.length <= 1024 &&
      cursor !== venue.cursor
        ? cursor
        : null
    if (!venue.cursor) registry.store.setSetting(baselineKey, true)
  })
  updateHalts(registry, changes)
  venue.contracts?.tickers(seen, !venue.cursor)
  if (venue.id === 'deribit') venue.currency = venue.currency === 'ETH' ? 'BTC' : 'ETH'
  for (const listing of listings) discover(listing)
  publish(rows, localQuoteVolumes)
  // Per-symbol catalog APIs run as separate paced requests so a large feed never fans out.
  if (unknown.size) venue.nextSymbol = unknown.values().next().value
  return rows.length
}

export function loadNextSymbol(venue, http, clock) {
  return loadCatalog(venue, http, clock(), venue.nextSymbol).then(() => {
    venue.nextSymbol = null
  })
}
