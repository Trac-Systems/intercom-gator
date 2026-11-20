/**
 * Exchange trust is the rounded sum of four local measurements, on a 0–10 scale.
 * Agreement (0–5) uses the USD-volume-weighted median of |market USD / base USD − 1|
 * across fresh markets with a fresh, non-red base snapshot. Non-USD quotes also need
 * a fresh, non-red USD conversion. Agreement is 5 at ≤0.1%, 0 at ≥2%, linear between.
 * Freshness (0–2) is twice the share of venue USD volume inside each market's book
 * window. USD turnover falls back to base turnover × the market's own price × the quote's
 * USD rate (null without a rate; never the asset's aggregate price). When
 * all relevant weights are zero, agreement and freshness weight markets equally.
 * Confirmation (0–2) counts distinct eligible, proven reporters other than this node
 * with a source observation in the last hour. Zero, one, two and ≥3 score 0, 1, 1.5 and 2.
 * Book quality (0–1) uses the median (ask − bid) / midpoint of the ten highest-volume
 * markets with a fresh, positive, uncrossed quote (market ID breaks volume ties).
 * Prefer this node's quote, then a proven reporter's, then any eligible reporter's,
 * using the newest source time and then reporter ID within each group. Quality is
 * 1 at ≤0.1%, 0 at ≥1%, linear between, or 0.5 without quotes. Components are shown
 * to six decimal places. Fewer than three comparable markets leave the score null.
 * With no comparable markets agreement is null. With only local reporting the cap is 8.
 * Redistribution terms do not enter the calculation.
 * Headline venue volume counts only markets whose base is a known asset. Turnover in `unresolved:` bases has no
 * independent price to check it against (Bitget's tokenized stocks claimed $720B a day, rNVDA alone 100× its
 * BTC/USDT), so it is reported apart as `unresolvedVolume24h` and does not rank the venue.
 */
import { weightedMedian } from './index.js'
import { marketUsdVolume } from './collisions.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const precision = n => Math.round(n * 1e6) / 1e6
const declining = (n, good, bad, points) => precision(points * Math.max(0, Math.min(1, (bad - n) / (bad - good))))
const comparable = p => p?.price > 0 && p.trust !== 'red' && p.why.fresh && !p.why.stale

const addVolume = (sum, volume) => volume == null ? sum : (sum ?? 0) + volume
const unresolved = market => market.base?.startsWith('unresolved:')

// Keep the last measured rollup in each UTC hour. A snapshot is a venue's total
// rolling 24h USD volume at that time, not the sum of the observations in the hour.
function saveVolumes(db, totals, hour) {
  db.prepare('DELETE FROM engine_venue_volume WHERE hour<?').run(hour - 8 * DAY)
  const save = db.prepare(`INSERT INTO engine_venue_volume(hour,venue,volume) VALUES (?,?,?)
    ON CONFLICT(hour,venue) DO UPDATE SET volume=excluded.volume WHERE volume IS NOT excluded.volume`)
  for (const [id, volume] of totals) save.run(hour, id, volume)
}

/** The node's hourly store maintenance also samples venues while the dashboard is closed. */
export function trackVenueVolumes({ store, book, registry }) {
  store.onPrune((db, { now }) => {
    book.refresh()
    const totals = new Map()
    for (const m of registry.markets.values()) {
      if (m.exchange == null || unresolved(m) || book.volumeSuspects?.has(m.id)) continue
      const amount = marketUsdVolume(book.marketPrices.get(m.id), book.snapshots)
      totals.set(m.exchange, addVolume(totals.get(m.exchange) ?? null, amount))
    }
    saveVolumes(db, totals, now - now % HOUR)
  })
}

function betterQuote(priority, row, best) {
  if (!best) return true
  if (priority !== best.priority) return priority > best.priority
  if (row.srcTs !== best.at) return row.srcTs > best.at
  return row.reporter < best.reporter
}

// engine_latest already deduplicates by (market, reporter). The book's market spread
// measures disagreement between reporters, so use their actual bid and ask here.
// Reads the book's in-memory latest rows (loaded by book.refresh()); a scan of engine_latest + obs here cost as much as
// a whole book rebuild on a 179k-row node (11-20).
function* latestSince({ book }, since) {
  const standing = new Map()
  for (const [market, rows] of book.latest ?? []) {
    for (const [reporter, l] of rows) {
      if (l.srcTs < since) continue
      let s = standing.get(reporter)
      if (!s) {
        const r = book.reputation.get(reporter)
        standing.set(reporter, s = { agreements: book.standing.get(reporter)?.agreements ?? null,
          mutedUntil: r?.mutedUntil ?? 0, weight: r?.weight ?? 1 })
      }
      yield { market, reporter, srcTs: l.srcTs, bid: l.bid, ask: l.ask, ...s }
    }
  }
}
function recentEvidence({ registry, book }, now) {
  const reporters = new Map(), quotes = new Map()
  for (const r of latestSince({ book }, now - HOUR)) {
    const market = registry.markets.get(r.market)
    if (market?.exchange == null) continue
    let seen = reporters.get(market.exchange)
    if (!seen) reporters.set(market.exchange, seen = { all: new Set(), proven: new Set() })
    seen.all.add(r.reporter)
    if (r.mutedUntil > now || r.weight <= 0) continue
    const own = r.reporter === book.ownKey, proven = r.agreements >= 3
    if (proven && !own) seen.proven.add(r.reporter)

    const price = book.marketPrices.get(r.market), bid = Number(r.bid), ask = Number(r.ask)
    if (!price || r.srcTs < now - price.window || !(bid > 0 && ask >= bid)) continue
    const priority = own ? 2 : proven ? 1 : 0
    if (!betterQuote(priority, r, quotes.get(r.market))) continue
    quotes.set(r.market, { priority, at: r.srcTs, reporter: r.reporter, spread: (ask - bid) / (ask / 2 + bid / 2) })
  }
  return { reporters, quotes }
}

class Venue {
  markets = 0
  volume24h = null
  unresolvedVolume24h = null
  suspectVolume24h = null
  freshMarkets = 0
  freshVolume = 0
  deviations = []
  spreads = []
  chains = new Set()

  add(market, book, now, quote) {
    this.markets++
    const p = book.marketPrices.get(market.id), base = book.snapshots.get(market.base)
    const volume = marketUsdVolume(p, book.snapshots)
    // Implausible venue volume (volume-guard.js) is reported apart and never ranks the venue.
    const suspect = book.volumeSuspects?.has(market.id)
    if (suspect) this.suspectVolume24h = addVolume(this.suspectVolume24h, volume)
    else if (unresolved(market)) this.unresolvedVolume24h = addVolume(this.unresolvedVolume24h, volume)
    else this.volume24h = addVolume(this.volume24h, volume)
    if (!p || p.at < now - p.window) return
    this.freshMarkets++
    if (!unresolved(market) && !suspect) this.freshVolume += volume ?? 0
    if (quote) this.spreads.push({ id: market.id, volume: volume ?? 0, value: quote.spread })
    if (!comparable(base)) return
    const fx = book.snapshots.get(market.quote)
    const rate = market.quote === 'fiat:USD' ? 1 : comparable(fx) ? fx.price : null
    if (rate == null) return
    const deviation = Math.abs(p.price * rate / base.price - 1)
    if (Number.isFinite(deviation)) this.deviations.push({ value: deviation, weight: volume ?? 0 })
  }

  score(peers) {
    const comparedMarkets = this.deviations.length
    const deviation = weightedMedian(this.deviations) ??
      weightedMedian(this.deviations.map(d => ({ value: d.value, weight: 1 })))
    const agreement = deviation == null ? null : declining(deviation, 0.001, 0.02, 5)
    const freshness = precision(2 * (this.volume24h ? this.freshVolume / this.volume24h : this.freshMarkets / this.markets))
    const confirmation = [0, 1, 1.5, 2][Math.min(3, peers)]
    const top = this.spreads.sort((a, b) => b.volume - a.volume || a.id.localeCompare(b.id)).slice(0, 10)
    const spread = weightedMedian(top.map(s => ({ value: s.value, weight: 1 })))
    const book = spread == null ? 0.5 : declining(spread, 0.001, 0.01, 1)
    return {
      trustScore: comparedMarkets < 3 ? null : Math.round(agreement + freshness + confirmation + book),
      trustWhy: { agreement, freshness, confirmation, book, comparedMarkets },
    }
  }
}

export function exchangeRows(engine, now) {
  const { registry, book, store } = engine
  book.refresh()
  const { reporters, quotes } = recentEvidence(engine, now)
  const venues = new Map()
  for (const m of registry.markets.values()) {
    if (m.exchange == null) continue
    let venue = venues.get(m.exchange)
    if (!venue) {
      venue = new Venue()
      venue.kind = m.kind.toUpperCase()
      venues.set(m.exchange, venue)
    }
    if (m.kind === 'dex') venue.chains.add(registry.chains.get(m.chain)?.name ?? m.chain)
    venue.add(m, book, now, quotes.get(m.id))
  }
  const hour = now - now % HOUR
  const previous = new Map(store.reader.prepare('SELECT venue,volume FROM engine_venue_volume WHERE hour=?')
    .all(hour - DAY).map(row => [row.venue, row.volume]))
  store.transaction(db => saveVolumes(db, Array.from(venues, ([id, v]) => [id, v.volume24h]), hour))
  return Array.from(venues, ([id, v]) => ({
    id, name: registry.venues.get(id)?.name ?? id, kind: v.kind,
    ...(v.chains.size ? { chain: [...v.chains].sort().join(', ') } : {}),
    markets: v.markets, volume24h: v.volume24h ?? 0, unresolvedVolume24h: v.unresolvedVolume24h ?? 0,
    suspectVolume24h: v.suspectVolume24h ?? 0, reporters: reporters.get(id)?.all.size ?? 0,
    change24h: previous.get(id) > 0 && v.volume24h != null ? (v.volume24h / previous.get(id) - 1) * 100 : null,
    ...v.score(reporters.get(id)?.proven.size ?? 0),
  })).sort((a, b) => b.volume24h - a.volume24h || a.id.localeCompare(b.id))
}
