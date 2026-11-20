import { medianPrice, multiplyPrice } from './decimal.js'
import { coverageTarget } from '../scheduler/index.js'
import { describeSplit, splitCollisions, SPLIT_FACTOR } from './collisions.js'
import { HYPEREVM_FULL_SUPPLY } from '../sources/supply-hyperliquid.js'

// A cap from the total supply (no circulating figure) must be one the market can carry: at most this multiple of the
// asset's 24 h volume. Pre-mints, bridge escrows or a treasury holding most of the supply can sit on any chain; they
// give a total-based cap thousands of times the turnover (UBTC: $1.3T on a few million a day). Measured and reported
// circulating figures are not subject to it. Live 11-19: real total-based caps ran 3-700x volume, BTC 77x.
export const TOTAL_CAP_VOLUME_MULTIPLE = 2000

/** Supply behind a market cap: circulating, else the total where the total is real issuance. HyperEVM tokens linked
 * to HyperCore mint their whole HyperCore supply to the system address, so their totalSupply() is not issuance
 * (UBTC ranked first at $1.3T on it). */
export function capSupply(asset) {
  if (asset?.supply != null) return asset.supply
  if ((asset?.chain ?? String(asset?.id).split(':')[0]) === 'hyperevm' && !HYPEREVM_FULL_SUPPLY.has(asset.id)) return null
  return asset?.totalSupply ?? null
}
/** The cap, or null when it rests on the total supply and exceeds what the 24 h volume can carry. */
export function totalCapCheck(asset, cap, volume24h) {
  if (!(cap > 0)) return null
  if (asset?.supply != null) return cap
  return volume24h > 0 && cap <= TOTAL_CAP_VOLUME_MULTIPLE * volume24h ? cap : null
}

/** Average the two central values when cumulative weight lands exactly at half. */
export function weightedMedian(entries) {
  const values = entries
    .filter(({ value, weight }) => Number.isFinite(value) && Number.isFinite(weight) && weight > 0)
    .sort((a, b) => a.value - b.value)
  if (!values.length) return null
  const half = values.reduce((total, item) => total + item.weight, 0) / 2
  let sum = 0
  for (const [i, item] of values.entries()) {
    sum += item.weight
    if (sum === half && values[i + 1]) return item.value / 2 + values[i + 1].value / 2
    if (sum >= half) return item.value
  }
}

// Keep the combined provisional weight strictly below the locally supported weight.
// An exact half would average a trusted price with an arbitrarily distant price.
function capUnproven(entries) {
  let supported = 0, provisional = 0
  for (const entry of entries) {
    if (entry.proven) supported += entry.weight
    else provisional += entry.weight
  }
  if (!supported || provisional <= supported / 2) return entries
  const scale = supported / 2 / provisional
  return entries.map(entry => entry.proven ? entry : { ...entry, weight: entry.weight * scale })
}

// No venue may carry more than a third of the median's weight once four or more venues report: HTX's FUN/USDT turnover
// (another listing at $0.0019) outweighed nine venues at $0.0121 and set FUN's price. Water-filling: capped venues
// share the cap of the final total, so the bound holds after the scaling.
const VENUE_SHARE = 1 / 3
function capVenues(entries, weights) {
  const venueOf = e => (e.market.kind === 'dex' ? e.market.id : e.market.exchange) ?? e.market.id
  const sums = new Map()
  entries.forEach((e, i) => sums.set(venueOf(e), (sums.get(venueOf(e)) ?? 0) + weights[i].weight))
  if (sums.size < 4) return weights
  const scale = new Map([...sums.keys()].map(v => [v, 1]))
  for (let round = 0; round < 8; round++) {
    const total = [...sums].reduce((n, [v, w]) => n + w * scale.get(v), 0)
    if (!(total > 0)) return weights
    let changed = false
    for (const [v, w] of sums) {
      const capped = w * scale.get(v)
      if (capped > total * VENUE_SHARE * (1 + 1e-9)) { scale.set(v, scale.get(v) * total * VENUE_SHARE / capped); changed = true }
    }
    if (!changed) break
  }
  return weights.map((w, i) => scale.get(venueOf(entries[i])) === 1 ? w : { ...w, weight: w.weight * scale.get(venueOf(entries[i])) })
}

/** rows contains the latest sample per distinct, eligible reporter for this market. */
export function marketMedian(market, rows, now) {
  if (!rows.length) return null
  const { window } = coverageTarget(market.rank)
  const at = rows.reduce((n, row) => Math.max(n, row.srcTs), 0)
  const cutoff = at >= now - window ? now - window : at - window
  const recent = rows.filter((r) => r.srcTs >= cutoff && r.weight > 0)
  const own = recent.find(r => r.own && r.srcTs >= now - window)
  const proven = recent.filter(r => r.proven)
  const weights = capUnproven(recent)
  const priceText = own?.price ?? medianPrice(weights.map(r => ({ value: r.price, weight: r.weight })))
  // A state snapshot with no locally sampled swaps has a price but no measured turnover.
  // Use the fresh proven peers that observed activity in that pool, counting each reporter once.
  const peerTurnover = own && market.kind === 'dex' && own.quoteVol24hUsd == null && Number(own.baseVol24h) === 0
    ? proven.filter(r => Number(r.baseVol24h) > 0 || Number(r.quoteVol24hUsd) > 0) : []
  const volume = field => {
    if (own && !peerTurnover.length) return own[field] == null ? null : Number(own[field])
    const measured = (peerTurnover.length ? peerTurnover : recent).filter(r => r[field] != null)
    if (proven.length && !measured.some(r => r.proven)) return null
    return weightedMedian(capUnproven(measured).map(r => ({ value: Number(r[field]), weight: r.weight })))
  }
  const price = Number(priceText)
  if (!(price > 0)) return null
  // Disagreement is measured among own/proven reporters when the market has them, so an unproven key cannot turn
  // a locally checked market red with one invented price (it still triggers a spot check elsewhere).
  const extremes = (proven.length ? proven : recent).reduce(
    ([low, high], r) => [Math.min(low, +r.price), Math.max(high, +r.price)],
    [Infinity, 0]
  )
  return {
    ...market,
    at,
    window,
    price,
    priceText,
    baseVolume: volume('baseVol24h'),
    usdVolume: volume('quoteVol24hUsd'),
    agents: recent.map((r) => r.reporter),
    provenAgents: proven.map(r => r.reporter),
    ownFresh: !!own,
    spread: (extremes[1] - extremes[0]) / price,
  }
}

// The entries carrying the central weight: drop the lowest- and highest-priced entries while each tail stays within
// 10% of the total weight. One thin or mislabeled market cannot turn a widely traded asset red; a disagreement
// between substantial markets still does. With at most two entries nothing is dropped.
function coreEntries(entries, weights) {
  const core = new Set(entries)
  if (entries.length <= 2) return core
  const total = weights.reduce((sum, w) => sum + w.weight, 0)
  if (!(total > 0)) return core
  const order = entries.map((e, i) => i).sort((a, b) => entries[a].price - entries[b].price)
  for (const indices of [order, [...order].reverse()]) {
    let dropped = 0
    for (const i of indices) {
      if (core.size <= 1 || dropped + weights[i].weight > total * 0.1) break
      dropped += weights[i].weight
      core.delete(entries[i])
    }
  }
  return core
}

// A market of the same project far from where the others agree (a one-sided or stale book: HTX CTX/USDT printed
// $0.54 between bid 0.38 and ask 0.70 while Coinbase and Gemini traded $0.37) leaves the price, volume and trust when
// at least two independent sources agree within 3% of the median, carry two thirds of its weight and outnumber the
// outlying sources two to one. Half the venues lagging a real move is a disagreement, not an outlier. Only CEX
// tickers outside the bundle symbolMap qualify, and only below the 10× split: pools and pinned markets carry the
// token's identity, and a 10× gap stays with the collision guard.
const OUTLIER_FACTOR = 1.1
function outliers(used, weights, price, pinned = () => false) {
  if (used.length < 3) return null
  const sourceOf = e => (e.market.kind === 'dex' ? e.market.id : e.market.exchange) ?? e.market.id
  const agree = new Set(), out = new Set(), outSources = new Set()
  let total = 0, agreeing = 0
  used.forEach((e, i) => {
    total += weights[i].weight
    if (Math.abs(e.price / price - 1) <= 0.03 + 1e-12) {
      agreeing += weights[i].weight
      agree.add(sourceOf(e))
    } else if (Math.abs(Math.log(e.price / price)) > Math.log(OUTLIER_FACTOR)) {
      if (e.market.kind === 'dex' || pinned(e.market) || Math.abs(Math.log(e.price / price)) >= Math.log(SPLIT_FACTOR)) return
      out.add(e)
      outSources.add(sourceOf(e))
    }
  })
  return out.size && agree.size >= 2 && agree.size >= 2 * outSources.size && agreeing * 3 >= total * 2 ? out : null
}

function summarize(asset, entries, now, { reference, pinned, collisions, dayRatio } = {}) {
  const current = entries.filter((e) => now - e.market.at <= 3 * e.market.window && !e.fxStale)
  const timely = current.length ? current : entries
  // A path through a quote asset whose own sources disagree by more than 3% (often a ticker collision on some
  // venue) adds no reliable information; use it only when nothing better exists.
  const reliable = timely.filter((e) => e.fxSpread <= 0.03 + 1e-12)
  let used = reliable.length ? reliable : timely
  // The same ticker can be another project on some venues (collisions.js): keep one price cluster.
  // A native coin's pools trade its wrapped token; they never outvote its exchanges (inverted wSOL pools once
  // detached all 39 SOL exchange markets).
  const split = splitCollisions(used, { reference, pinned, dexAnchor: asset.address !== 'native' })
  if (split) used = used.filter((e) => !split.excluded.has(e))
  const weigh = () => {
    const totalVolume = used.reduce((sum, e) => sum + (e.suspect ? 0 : e.volume), 0)
    // An implausible venue volume (volume-guard.js) weighs no more than the largest counted one.
    const counted = used.reduce((max, e) => (e.suspect ? max : Math.max(max, e.volume || 0)), 0)
    const weightOf = e => (e.suspect && counted > 0 ? Math.min(e.volume, counted) : e.volume)
    // A provisional venue (or an unverified quote currency) cannot buy control of the
    // USD median with invented turnover. Keep zero-volume supported prices as anchors.
    const supportedVolume = used.some(e => e.proven && e.volume > 0)
    const weights = used.map(e => ({ value: e.priceText, proven: e.proven,
      weight: (e.proven && !supportedVolume) || !totalVolume ? 1 : weightOf(e) }))
    const capped = capUnproven(capVenues(used, weights))
    return { totalVolume, capped, priceText: medianPrice(capped) }
  }
  let { totalVolume, capped, priceText } = weigh()
  const dropped = Number(priceText) > 0 ? outliers(used, capped, Number(priceText), pinned) : null
  if (dropped) {
    used = used.filter((e) => !dropped.has(e))
    ;({ totalVolume, capped, priceText } = weigh())
  }
  const price = Number(priceText)
  if (!(price > 0) || !Number.isFinite(price)) return null
  const record = split && describeSplit(split, new Set(current), price)
  if (record) collisions?.set(asset.id, record)
  const core = coreEntries(used, capped)
  const agents = new Set(),
    provenAgents = new Set(),
    provenSources = new Set(),
    ownSources = new Set(),
    exchanges = new Set(),
    pools = new Set(),
    sources = new Set()
  let spread = 0,
    low = Infinity,
    high = 0,
    provenLow = Infinity,
    provenHigh = 0,
    coreWeight = 0,
    freshWeight = 0,
    coreCount = 0,
    freshCount = 0,
    at = 0,
    oldest = now
  for (const [i, entry] of used.entries()) {
    const { market, price: usd, fxAt, fxStale, fxFresh, proven, fxSpread } = entry
    for (const key of market.agents) agents.add(key)
    if (market.kind === 'dex') pools.add(market.id)
    else exchanges.add(market.exchange)
    const source = market.kind === 'dex' ? market.id : market.exchange
    sources.add(source)
    // Trust is judged on the core markets; thin outlying tails are counted above but do not decide it.
    if (!core.has(entry)) continue
    const entryFresh = !(now - market.at > market.window || fxStale || fxFresh === false)
    // Only fresh evidence confirms a price; an older core market still counts toward disagreement below.
    if (proven && entryFresh) {
      provenSources.add(source)
      for (const key of market.provenAgents) provenAgents.add(key)
      if (market.ownFresh) ownSources.add(source)
    }
    spread = Math.max(spread, market.spread, fxSpread)
    low = Math.min(low, usd)
    high = Math.max(high, usd)
    if (proven) [provenLow, provenHigh] = [Math.min(provenLow, usd), Math.max(provenHigh, usd)]
    const timestamp = Math.min(market.at, fxAt)
    oldest = Math.min(oldest, timestamp)
    at = Math.max(at, timestamp)
    coreWeight += capped[i].weight
    coreCount++
    if (entryFresh) {
      freshWeight += capped[i].weight
      freshCount++
    }
  }
  // Fresh when fresh core markets carry at least half the core weight. Requiring every core market to be fresh
  // let one slowly polled venue (Bitstamp USDT/USD) mark USDT, and through it every USDT-quoted market, as old.
  const fresh = coreWeight > 0 ? freshWeight * 2 >= coreWeight : freshCount * 2 >= coreCount
  // A core market more than SPLIT_FACTOR from the price after the split (pools or bundle-pinned markets of another
  // project, two equally supported projects) means there is no usable USD price: publish none rather than a red
  // guess. Judged on own/proven markets when there are any, so unproven keys cannot withhold a supported price.
  const [guardLow, guardHigh] = provenHigh > 0 ? [provenLow, provenHigh] : [low, high]
  const factor = Math.max(guardHigh / price, price / guardLow)
  if (factor > SPLIT_FACTOR + 1e-9) {
    collisions?.set(asset.id, { ...record, guard: { low: guardLow, high: guardHigh, price, ratio: factor } })
    return null
  }
  spread = Math.max(spread, (high - low) / price)
  const depegs = [...new Set([...core].flatMap((e) => e.depegs))].sort()
  // The venues' own 24 h move (last / open) over the core markets, weighted like the price; checks change24h.
  const days = dayRatio ? used.flatMap((e, i) => {
    const ratio = core.has(e) ? dayRatio(e.market) : null
    return ratio > 0 ? [{ value: ratio, weight: capped[i].weight }] : []
  }) : []
  const stale = current.length === 0
  // Green counts only own/proven identities across independently supported venues: five of them, or the node's
  // own fresh reads of two independent venues (peers cannot move a price the node measured itself, so a solo node
  // or a small network can still verify a price). Unproven reports remain visible and disagreement can still lower
  // trust.
  const confirmed = (provenAgents.size >= 5 && provenSources.size >= 2) || ownSources.size >= 2
  const trust =
    stale || spread > 0.03 + 1e-12
      ? 'red'
      : confirmed && spread <= 0.01 + 1e-12 && !depegs.length
        ? 'green'
        : 'yellow'
  // A cap is shown only for a price the node can stand behind: green, or yellow with two independent sources, the
  // token's own pool, or a native coin or stablecoin. One CEX ticker matched by symbol (Bitget RLB at $71 for Rollbit,
  // $109B) otherwise ranked a token third. The price and its caveat stay visible; a stale asset keeps its last cap.
  const capVisible = stale || trust === 'green' ||
    (trust === 'yellow' && (sources.size >= 2 || pools.size > 0 || asset.address === 'native' || !!asset.stable))
  const why = {
    agents: agents.size,
    provenAgents: provenAgents.size,
    provenSources: provenSources.size,
    ownSources: ownSources.size,
    provenVolume24h: used.reduce((sum, e) => sum + (e.proven && !e.suspect ? e.volume : 0), 0),
    // Flagged proven turnover (volume-guard.js): not a total or a rank, but evidence that the market trades.
    ...(used.some(e => e.suspect) && {
      suspectVolume24h: used.reduce((sum, e) => sum + (e.proven && e.suspect ? e.volume : 0), 0) }),
    exchanges: exchanges.size,
    pools: pools.size,
    independentSources: sources.size,
    spreadPct: spread * 100,
    ageMs: Math.max(0, now - oldest),
    fresh,
    stale,
    depegs,
    ...(dropped && { outliers: [...dropped].map((e) => e.market.id) }),
  }
  return {
    asset: asset.id,
    price,
    priceText,
    at,
    volume24h: totalVolume,
    trust,
    why,
    agents: agents.size,
    exchanges: exchanges.size,
    // Without a circulating figure the cap uses the total supply until one is measured or reported.
    marketCap: !capVisible ? null : totalCapCheck(asset, price * (capSupply(asset) ?? NaN), totalVolume),
    fdv: asset.totalSupply == null || !capVisible ? null : price * asset.totalSupply,
    dayRatio: days.length ? weightedMedian(days) : null,
  }
}

// A chain deployment without a price of its own (BSC USDT, Base USDC: their pools price other tokens, nothing prices
// them) borrows a signed sibling's measured price as its USD rate, so a chain's DEX prices never rest on one third-party
// reference (11-20: a lapsed llama reference dropped every DEX price on Base, BSC, Optimism and Polygon). It is refused
// when the deployment's own evidence disagrees with the sibling by more than this bound. 2% sits above a healthy peg read
// through a volatile pair (pool fee ≤ 1% plus up to a minute of drift between the pool and the venue reads) and below the
// 3% at which sources turn red, so a borrowed rate never hides a disagreement the trust rule would show.
export const BORROW_BOUND = 0.02
const TRUST_ORDER = { green: 0, yellow: 1, red: 2 }

/** The weighted median USD price the deployment's own fresh, supported pools imply against counter assets whose price
 * does not rest on it; null without such evidence. */
function ownEvidence(id, { byBase, byQuote, rates, paths, now }) {
  const implied = []
  for (const [list, side] of [[byBase.get(id), 'base'], [byQuote.get(id), 'quote']]) {
    for (const m of list ?? []) {
      if (!m.provenAgents.length || now - m.at > 3 * m.window || !(m.price > 0)) continue
      const counter = side === 'base' ? m.quote : m.base
      const rate = counter === id ? null : rates.get(counter)
      if (!rate || rate.why.stale || rate.why.fresh === false || paths.get(rate)?.has(id) || rate.why.borrowedFrom ||
          !(counter === 'fiat:USD' || rate.why.provenSources > 0 || rate.why.referenceProviders?.length)) continue
      const value = side === 'base' ? m.price * rate.price : rate.price / m.price
      if (!(value > 0) || !Number.isFinite(value)) continue
      const usd = m.usdVolume ?? (m.baseVolume > 0 ? m.baseVolume * (side === 'base' ? value : rate.price) : 0)
      implied.push({ value, usd })
    }
  }
  if (!implied.length) return null
  const total = implied.reduce((sum, e) => sum + e.usd, 0)
  return weightedMedian(implied.map(e => ({ value: e.value, weight: total > 0 ? e.usd : 1 })))
}

/** A deployment's USD rate taken from its sibling: the sibling's price, time and trust; no volume of its own. */
function borrowedRate(token, id, lender) {
  const price = lender.price
  return {
    asset: id,
    price,
    priceText: lender.priceText ?? String(price),
    at: lender.at,
    volume24h: null,
    marketCap: totalCapCheck(token, price * (capSupply(token) ?? NaN), null),
    fdv: token?.totalSupply == null ? null : token.totalSupply * price,
    agents: 0,
    exchanges: 0,
    trust: lender.trust,
    why: {
      agents: 0,
      provenAgents: lender.why.provenAgents,
      provenSources: lender.why.provenSources,
      ownSources: 0,
      provenVolume24h: 0,
      exchanges: 0,
      pools: 0,
      independentSources: 0,
      spreadPct: lender.why.spreadPct,
      ageMs: lender.why.ageMs,
      fresh: lender.why.fresh,
      stale: false,
      depegs: lender.why.depegs,
      borrowedFrom: lender.asset,
    },
  }
}

/**
 * Borrow decisions against the rates resolved without borrowing: a deployment that quotes a market and has no fresh
 * price of its own (none, stale or only a reference) takes its best measured sibling (green before yellow before red,
 * then more proven sources, volume, id; never a reference-only or stale one), unless its own pools or its reference
 * disagree by more than BORROW_BOUND. A refused deployment keeps the existing rules (its reference, when it has one).
 */
function borrowRates(lenders, assets, context) {
  const { rates, byQuote, references } = context
  const out = new Map()
  for (const [id, siblings] of lenders) {
    if (!byQuote.has(id)) continue
    const own = rates.get(id)
    if (own && !own.why.stale && !own.why.referenceProviders?.length) continue
    let lender = null
    for (const sibling of siblings) {
      const p = rates.get(sibling)
      if (!p || p.why.stale || p.why.referenceProviders?.length || p.why.borrowedFrom ||
          !(p.why.pools + p.why.exchanges > 0) || !(p.price > 0)) continue
      const order = !lender ? -1 : (TRUST_ORDER[p.trust] ?? 3) - (TRUST_ORDER[lender.trust] ?? 3) ||
        lender.why.provenSources - p.why.provenSources || (lender.volume24h ?? 0) - (p.volume24h ?? 0) ||
        (p.asset < lender.asset ? -1 : 1)
      if (order < 0) lender = p
    }
    if (!lender) continue
    const off = value => value > 0 && Math.abs(value / lender.price - 1) > BORROW_BOUND + 1e-12
    if (off(ownEvidence(id, context)) || off(references.get(id)?.price)) continue
    out.set(id, borrowedRate(assets.get(id), id, lender))
  }
  return out
}

/**
 * Use a USD-anchored conversion graph. Each path visits an asset at most once.
 * options.pinned(market) marks bundle symbolMap markets (never detached); options.collisions (a Map) receives each
 * asset's split and guard diagnostics from the final pass; options.referencePrices (asset → USD) anchors splits
 * (default: the fresh references); options.lenders (deployment → signed sibling ids, `priceSiblings`) lets a quote
 * without a price of its own borrow its sibling's (borrowRates).
 */
export function aggregateAssets(...args) {
  const steps = aggregateAssetsSteps(...args)
  for (;;) {
    const { done, value } = steps.next()
    if (done) return value
  }
}

/** aggregateAssets as a generator that yields every AGGREGATE_STEP assets, so a background rebuild can let requests
 * run in between. Callers that cannot pause use aggregateAssets. */
const AGGREGATE_STEP = 100
export function* aggregateAssetsSteps(assets, markets, now, references = new Map(),
  { pinned, collisions, referencePrices, dayRatio, lenders, suspects } = {}) {
  const byBase = new Map(), byQuote = new Map()
  for (const m of markets) {
    if (!byBase.has(m.base)) byBase.set(m.base, [])
    byBase.get(m.base).push(m)
    if (!byQuote.has(m.quote)) byQuote.set(m.quote, [])
    byQuote.get(m.quote).push(m)
  }
  const resolved = new Map(references)
  const fiat = { price: 1, at: Infinity, why: { stale: false, depegs: [] } }
  // Resolve direct fiat markets first, then quote assets in successive rounds. Freeze each
  // round's conversion rates to avoid circular valuation and insertion-order dependence.
  let frontier = new Map([['fiat:USD', fiat]])
  const rates = new Map([...references, ...frontier])
  const paths = new WeakMap()
  const evaluate = (asset, available) => {
    const entries = []
    const dependencies = new Set([asset.id])
    for (const market of byBase.get(asset.id) ?? []) {
      const rate = available.get(market.quote)
      if (!rate || market.quote === asset.id || paths.get(rate)?.has(asset.id)) continue
      const priceText = multiplyPrice(market.priceText ?? market.price, rate.priceText ?? rate.price)
      const price = Number(priceText)
      if (!(price > 0) || !Number.isFinite(price)) continue
      dependencies.add(market.quote)
      for (const id of paths.get(rate) ?? []) dependencies.add(id)
      const depegs = [...rate.why.depegs]
      if (assets.get(market.quote)?.stable && Math.abs(rate.price - 1) > 0.01) depegs.push(market.quote)
      entries.push({
        market,
        price,
        priceText,
        // The market's own USD price (market price × quote rate), never the asset's aggregate price.
        volume: market.usdVolume ?? market.baseVolume * price,
        // volume-guard.js: the reported volume stays out of the asset's 24 h volume and caps its median weight.
        suspect: suspects?.has(market.id) === true,
        fxAt: rate.at,
        fxStale: rate.why.stale,
        fxFresh: rate.why.fresh,
        fxSpread: (rate.why.spreadPct ?? 0) / 100,
        proven: market.provenAgents.length > 0 &&
          (rate === fiat || rate.why.provenSources > 0 || rate.why.referenceProviders?.length > 0),
        depegs,
      })
    }
    collisions?.delete(asset.id)
    const result = entries.length
      ? summarize(asset, entries, now, {
        reference: referencePrices?.get(asset.id) ?? references.get(asset.id)?.price, pinned, collisions, dayRatio })
      : null
    if (result) paths.set(result, dependencies)
    return result
  }
  let counted = 0
  const rounds = function* (first) {
    for (let depth = 0; depth < 4 && frontier.size; depth++) {
      frontier = new Map()
      for (const id of byBase.keys()) {
        if (++counted % AGGREGATE_STEP === 0) yield
        if (rates.has(id) && !(first && depth === 0 && references.has(id))) continue
        const asset = assets.get(id)
        const result = asset && evaluate(asset, rates)
        if (result) frontier.set(id, result)
      }
      for (const pair of frontier) rates.set(...pair)
    }
  }
  yield* rounds(true)
  // Borrowing is decided on the rates resolved without it, then the assets it makes reachable resolve in more rounds.
  const borrowed = lenders?.size ? borrowRates(lenders, assets, { byBase, byQuote, rates, paths, references, now }) : new Map()
  if (borrowed.size) {
    for (const [id, rate] of borrowed) {
      paths.set(rate, new Set([id, rate.why.borrowedFrom, ...(paths.get(rates.get(rate.why.borrowedFrom)) ?? [])]))
      rates.set(id, rate)
      resolved.set(id, rate)
    }
    frontier = new Map(borrowed)
    yield* rounds(false)
  }
  for (const id of byBase.keys()) {
    if (++counted % AGGREGATE_STEP === 0) yield
    // A borrowed deployment had no price of its own; any it gains now rests on a borrowed rate, so it stays borrowed.
    if (borrowed.has(id)) continue
    const asset = assets.get(id)
    const result = asset && evaluate(asset, rates)
    if (result) resolved.set(id, result)
  }
  return resolved
}
