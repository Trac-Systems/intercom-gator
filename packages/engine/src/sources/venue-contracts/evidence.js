import { weightedMedian } from '../../aggregate/index.js'

const HOUR = 3_600_000

// Only the signed group's own members can represent it. Without that statement use a unique, measured pool-depth
// winner among the venue's deployments. An unknown token, an address tie or alphabetical order proves no liquidity.
export function chooseContract(ids, tokens, assets, depths) {
  if (ids?.length === 1) return ids[0]
  if (!ids?.length) return null
  const groups = new Set(ids.map(id => tokens.get(id)?.coin).filter(Boolean))
  if (groups.size > 1) return null
  if (groups.size && ids.every(id => tokens.get(id)?.coin)) {
    const issuance = ids.filter(id => tokens.get(id).coinSupply === 'issuance')
    return [...(issuance.length ? issuance : ids)].sort((a, b) =>
      (depths.get(b) ?? 0) - (depths.get(a) ?? 0) || a.localeCompare(b))[0]
  }
  const ranked = ids.filter(id => assets.has(id) && depths.get(id) > 0)
    .sort((a, b) => depths.get(b) - depths.get(a))
  return ranked.length && depths.get(ranked[0]) > (depths.get(ranked[1]) ?? 0) ? ranked[0] : null
}

function add(map, key, value) {
  if (map.has(key)) map.get(key).push(value)
  else map.set(key, [value])
}

function rate(book, id, now) {
  if (id === 'fiat:USD') return 1
  const p = book.snapshots.get(id)
  return p?.price > 0 && !p.why.stale && now - p.at <= HOUR &&
    (p.why.provenSources || p.why.referenceProviders?.length) ? p.price : null
}

/** Fresh address-specific DEX prices, indexed once for all venue jobs. Keep quotes in their original units too,
 * so a token/USDT pool and a token/USDT listing can be compared even before this node has a dollar rate. */
export function dexEvidence(engine) {
  const { book, clock } = engine, now = clock()
  const prices = new Map(), depths = new Map()
  for (const p of book.marketPrices.values()) {
    if (p.kind !== 'dex' || !p.provenAgents.length || !(p.price > 0) || now - p.at > HOUR) continue
    const weight = Math.max(1, p.usdVolume || 0)
    add(prices, p.base, { quote: p.quote, price: p.price, weight })
    add(prices, p.quote, { quote: p.base, price: 1 / p.price, weight })
  }
  for (const r of engine.store.writer.prepare(
    "SELECT asset,price FROM engine_references WHERE provider='dexscreener' AND at>=? AND price>0").iterate(now - HOUR))
    add(prices, r.asset, { quote: 'fiat:USD', price: r.price, weight: 1 })
  for (const { base, quote, liquidity } of book.poolDepths.iterate()) {
    depths.set(base, Math.max(depths.get(base) ?? 0, liquidity))
    depths.set(quote, Math.max(depths.get(quote) ?? 0, liquidity))
  }
  return { prices, depths }
}

export function venueQuotes(venue, registry, now) {
  const result = new Map()
  for (const [id, tick] of venue.lastTickers ?? []) {
    if (!(tick.price > 0) || now - (tick.contractPriceAt ?? tick.at) > HOUR ||
        now - tick.at > HOUR || registry.halted?.has(id) || venue.contracts?.missing.has(id)) continue
    const m = registry.markets.get(id)
    if (!m) continue
    const [base, quote] = id.split(':')[2].split('-')
    const until = Math.min(tick.at, tick.contractPriceAt ?? tick.at) + HOUR + 1
    add(result, base, { market: id, quote: m.quote, price: tick.price, until })
    add(result, quote, { market: id, quote: m.base, price: 1 / tick.price, until })
  }
  return result
}

/** A DEX anchor with no comparable venue price withholds the binding. Direct pair comparisons need no FX.
 * Every comparable venue pair must pass against the turnover-weighted median of independent pool observations. */
export function checkPrice(references, ticks, book, now) {
  if (!references?.length) return 'ok'
  let checked = false
  for (const tick of ticks) {
    const fx = rate(book, tick.quote, now), values = []
    for (const ref of references) {
      const otherFx = ref.quote === tick.quote ? 1 : rate(book, ref.quote, now)
      const converted = ref.quote === tick.quote ? ref.price : fx && otherFx && ref.price * otherFx / fx
      if (converted > 0 && Number.isFinite(converted)) values.push({ value: converted, weight: ref.weight })
    }
    if (!values.length) continue
    const anchor = weightedMedian(values)
    if (tick.price > 3 * anchor || anchor > 3 * tick.price) return 'price differs by more than 3x'
    checked = true
  }
  return checked ? 'ok' : 'no comparable quote'
}
