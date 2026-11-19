/**
 * Ticker collisions. A CEX ticker can name different projects on different venues: `RAIN` is one project on Bitget
 * ($65.40) and another on HTX, Gate, Bitrue, KuCoin, MEXC and WEEX ($0.0044). The registry binds a ticker that is
 * unique in the bundle to that one token on every venue, so both projects' markets land on the same asset.
 *
 * Detection (pure, per aggregation): an asset's usable markets are sorted by USD price and cut wherever two
 * neighbours are more than SPLIT_FACTOR (10×) apart. Real moves do not do that between venues of one project inside
 * one target window (a 3× pump with lagging venues stays one cluster); separate projects are typically several
 * orders of magnitude apart. With more than one cluster one is kept:
 *  (a) the cluster carrying the asset's own price: a proven DEX pool of the token, a reference price read for its
 *      address, or a market pinned by the bundle `symbolMap` (bundle mappings always win over a split);
 *  (b) otherwise the cluster with more distinct venues (own/proven ones first, then all reporting venues);
 *  (c) otherwise the one with more USD turnover (each market valued at its own price);
 *  a full tie detaches nothing (the guard below then withholds the price).
 * Only own/proven evidence votes when there is any, so unproven keys cannot invent a cluster that wins.
 *
 * Detachment: a CEX venue label (`htx` + `RAIN`) whose markets all sit outside the kept cluster is excluded from the
 * asset's price, volume, trust and counts. A pair whose venue label also trades inside the kept cluster is a dead
 * or broken pair of the same project and is only left out of that aggregation. DEX pools and `symbolMap` markets
 * are never detached; they stay in the asset and the 10× guard (aggregate/index.js) withholds the USD price if
 * they still disagree. Fresh markets with own/proven
 * evidence are detached durably by the registry (`unresolved:<venue>:<label>`, remembered with ratio and time) and
 * re-checked once a day.
 */
export const SPLIT_FACTOR = 10
export const SPLIT_REVIEW_MS = 86_400_000
const GAP = Math.log(SPLIT_FACTOR) + 1e-9

/** `cex:<venue>:<BASE>-<QUOTE>` → the venue and the venue's base label; null for DEX markets. */
export function venueLabel(market) {
  if (market?.kind !== 'cex') return null
  const [, venue, pair] = market.id.split(':')
  const label = pair?.split('-')[0]
  return venue && label ? { venue, label, key: venue + ':' + label } : null
}

/** A quote's USD rate: 1 for USD, otherwise a priced, non-stale snapshot of the quote asset; null when unknown. */
export function quoteRate(snapshots, quote) {
  if (quote === 'fiat:USD') return 1
  const fx = snapshots?.get(quote)
  return fx?.price > 0 && Number.isFinite(fx.price) && !fx.why?.stale ? fx.price : null
}

/**
 * A market's 24 h USD turnover: the venue's own USD figure, else base turnover × the market's own price × the quote's
 * USD rate. Never the asset's aggregate price (a colliding ticker would multiply one project's coins by the other's
 * price). Null when the quote has no rate.
 */
export function marketUsdVolume(p, snapshots) {
  if (!p) return null
  if (p.usdVolume != null) return p.usdVolume
  if (p.baseVolume == null) return null
  if (p.baseVolume === 0) return 0
  const rate = quoteRate(snapshots, p.quote)
  return rate == null || !(p.price > 0) ? null : p.baseVolume * p.price * rate
}

const distance = (price, low, high) => Math.max(0, Math.log(low / price), Math.log(price / high))

/** The cluster nearest to `price`, if it lies within SPLIT_FACTOR of it and no other cluster is as near. */
function nearest(clusters, price) {
  let best = -1, bestDistance = Infinity, tie = false
  clusters.forEach((members, i) => {
    const d = distance(price, members[0].price, members.at(-1).price)
    if (d < bestDistance - 1e-12) [best, bestDistance, tie] = [i, d, false]
    else if (Math.abs(d - bestDistance) <= 1e-12) tie = true
  })
  return !tie && bestDistance <= GAP ? best : -1
}

/**
 * Split `entries` (aggregate entries: { market, price (USD), volume, proven }) into price clusters and pick the one
 * to keep. Only own/proven entries (all entries when none is proven) and the reference price form clusters; other
 * entries join the nearest cluster within SPLIT_FACTOR or are dropped as strays, so unproven keys can neither bridge
 * two projects nor invent a cluster. Entries more than SPLIT_FACTOR from the kept cluster's turnover-weighted
 * centre are excluded. Returns null when nothing is excluded.
 * @param {Array<object>} entries
 * @param {{ reference?: number|null, pinned?: (market: object) => boolean, dexAnchor?: boolean }} [options]
 * `dexAnchor: false` for a native coin: its pools trade a wrapped token, and its exchange tickers are not ambiguous.
 * @returns {null | { excluded: Set<object>, detached: Set<object>, kept: object }}
 */
export function splitCollisions(entries, { reference = null, pinned = () => false, dexAnchor = true } = {}) {
  const valid = entries.filter(e => e.price > 0 && Number.isFinite(e.price))
  const anyProven = valid.some(e => e.proven)
  const voters = valid.filter(e => !anyProven || e.proven)
  // The reference read for the token's address joins the vote as a point without venue or turnover.
  const anchor = reference > 0 && Number.isFinite(reference)
    ? { market: { id: '', kind: 'reference' }, price: reference, proven: true, virtual: true } : null
  const sorted = [...voters, ...(anchor ? [anchor] : [])]
    .sort((a, b) => a.price - b.price || (a.market.id < b.market.id ? -1 : 1))
  if (!sorted.length) return null
  const clusters = [[sorted[0]]]
  for (let i = 1; i < sorted.length; i++) {
    if (Math.log(sorted[i].price / sorted[i - 1].price) > GAP) clusters.push([])
    clusters.at(-1).push(sorted[i])
  }
  const members = clusters.map(c => c.filter(e => !e.virtual))
  const strays = new Set()
  for (const e of valid) {
    if (voters.includes(e)) continue
    const i = nearest(clusters, e.price)
    if (i < 0) strays.add(e)
    else members[i].push(e)
  }
  const described = clusters.map((voting, index) => {
    const real = voting.filter(e => !e.virtual)
    const anchorKind = voting.some(e => e.virtual) ? 'reference'
      : dexAnchor && real.some(e => e.market.kind === 'dex') ? 'dex'
        : real.some(e => pinned(e.market)) ? 'symbolMap' : null
    return {
      index, real, members: members[index], anchor: anchorKind,
      venues: new Set(real.map(e => e.market.exchange)).size,
      // Peer-only venues of the cluster: they break a tie between proven clusters but cannot create one.
      reported: new Set(members[index].map(e => e.market.exchange)).size,
      volume: real.reduce((sum, e) => sum + (e.volume > 0 ? e.volume : 0), 0),
    }
  })
  let candidates = described.filter(c => c.members.length)
  if (!candidates.length) return null
  if (candidates.some(c => c.anchor)) candidates = candidates.filter(c => c.anchor)
  candidates.sort((a, b) => b.venues - a.venues || b.reported - a.reported || b.volume - a.volume || a.index - b.index)
  const [keep, next] = candidates
  if (next && keep.venues === next.venues && keep.reported === next.reported && keep.volume === next.volume) {
    // A full tie names no project: detach nothing (the guard then withholds the price); strays still go.
    return strays.size ? { excluded: strays, detached: new Set(),
      kept: { reason: 'tie', markets: [], venues: 0, supported: false } } : null
  }
  const reason = keep.anchor ??
    (!next ? 'only' : keep.venues > next.venues || keep.reported > next.reported ? 'venues' : 'volume')
  // Everything more than SPLIT_FACTOR from the kept project's price is out, also when dead pairs in between chain
  // the clusters together (0.06 → 0.075 → 0.11 → 0.26 → 1.0 for MANA on Binance.US). The centre is a median with
  // one vote per venue: dead pairs often keep reporting large stale turnover, so turnover cannot place it.
  const centre = keep.real.length ? venueCentre(keep.real) : reference
  const near = e => Math.abs(Math.log(e.price / centre)) <= GAP
  const kept = valid.filter(near)
  const keptLabels = new Set(kept.map(e => venueLabel(e.market)?.key).filter(Boolean))
  const excluded = new Set(), detached = new Set()
  for (const e of valid) {
    if (near(e)) continue
    const label = venueLabel(e.market)
    // A CEX label with no market near the kept price is another project on that venue: detached. A pair of a label
    // that also trades near it is a dead or broken pair of the same project (Binance.US ATOM-BTC still quoting
    // $23): only left out. Identity-bound evidence (pools, bundle-pinned labels) with own/proven support stays,
    // and the guard judges it.
    if (label && !pinned(e.market) && !keptLabels.has(label.key)) detached.add(e)
    else if (anyProven && e.proven && ((e.market.kind === 'dex' && dexAnchor) || pinned(e.market))) continue
    excluded.add(e)
  }
  if (!excluded.size) return null
  return {
    excluded,
    detached,
    kept: {
      reason,
      markets: kept.map(e => e.market.id).sort(),
      venues: new Set(kept.map(e => e.market.exchange)).size,
      // A durable detachment needs a kept side the node can stand behind: own/proven evidence or a reference read.
      supported: (anyProven && kept.some(e => e.proven)) || keep.anchor === 'reference',
    },
  }
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[(sorted.length - 1) >> 1] / 2 + sorted[sorted.length >> 1] / 2
}
/** The median of per-venue median prices: one vote per venue, whatever its pairs or turnover. */
function venueCentre(entries) {
  const venues = Map.groupBy(entries, e => e.market.exchange ?? e.market.id)
  return median([...venues.values()].map(list => median(list.map(e => e.price))))
}

/** The plain diagnostic record of one aggregation's split; `fresh` lists the entries inside the target window. */
export function describeSplit(split, fresh, keptPrice) {
  return {
    kept: { ...split.kept, price: keptPrice },
    detached: [...split.detached].map(e => {
      const { venue, label, key } = venueLabel(e.market)
      return { market: e.market.id, venue, label, key, price: e.price, ratio: keptPrice > 0 ? e.price / keptPrice : null,
        volume: e.volume, proven: e.proven, current: fresh.has(e) }
    }),
  }
}

/**
 * Current splits for the owner: assets with detached venue labels (durable) and assets whose remaining core markets
 * still disagree by more than SPLIT_FACTOR (no USD price published). Ratios are live when the markets have prices.
 */
export function collisionReport({ registry, book }) {
  const snapshots = book.refresh()
  const rows = new Map()
  const row = asset => {
    if (!rows.has(asset)) {
      const a = registry.assets.get(asset), p = snapshots.get(asset)
      // price/trust/venues describe the kept side (the asset as published now).
      rows.set(asset, { asset, symbol: a?.symbol ?? null, name: a?.name ?? null, price: p?.price ?? null,
        trust: p?.trust ?? null, venues: p ? (p.why?.exchanges ?? 0) + (p.why?.pools ?? 0) : null, reason: null,
        guard: null, detached: [] })
    }
    return rows.get(asset)
  }
  const byLabel = new Map()
  for (const m of registry.markets.values()) {
    const label = m.base.startsWith('unresolved:') && venueLabel(m)
    if (label && registry.splits.has(label.key)) {
      if (!byLabel.has(label.key)) byLabel.set(label.key, [])
      byLabel.get(label.key).push(m)
    }
  }
  for (const [key, split] of registry.splits) {
    if (split.reviewing) continue
    const markets = byLabel.get(key) ?? []
    const prices = markets.map(m => {
      const p = book.marketPrices.get(m.id), rate = p && quoteRate(snapshots, p.quote)
      return rate ? p.price * rate : null
    }).filter(Boolean).sort((a, b) => a - b)
    const live = prices.length ? prices[(prices.length - 1) >> 1] / 2 + prices[prices.length >> 1] / 2 : null
    const target = row(split.asset)
    target.reason ??= split.reason ?? null
    const price = live ?? split.price
    target.detached.push({
      venue: split.venue, label: split.label, markets: markets.map(m => m.id).sort(), price,
      ratio: price > 0 && target.price > 0 ? price / target.price : split.ratio,
      keptPrice: target.price ?? split.keptPrice, since: split.at, checkedAt: split.checkedAt,
    })
  }
  for (const [asset, c] of book.collisions ?? []) if (c.guard) row(asset).guard = c.guard
  return [...rows.values()]
    .map(r => ({ ...r, detached: r.detached.sort((a, b) => a.venue.localeCompare(b.venue)) }))
    .sort((a, b) => (a.symbol ?? a.asset).localeCompare(b.symbol ?? b.asset) || a.asset.localeCompare(b.asset))
}
