// Turn decoded fills into priced, attributable sales and estimate a "sale floor" from sales only.
import { decodeSale } from './decode.js'

/** @typedef {{ chain: string, tx: string, idx: number, block: number, at: number, collection: string,
 * tokenId: string, qty: number, standard: string, marketplace: string, protocol: string, currency: string,
 * priceEth: number|null, priceUsd: number|null, unitEth: number|null, seller: string|null, buyer: string|null,
 * fees: number|null, bundle: number }} Sale */

/**
 * Group decoded logs by transaction and build one sale per (tx, collection, token). Seaport match orders emit
 * an OrderFulfilled per side; both describe the same NFT, so the first priced side wins and the other only fills
 * in the missing seller or buyer.
 * @param {object[]} logs raw logs, any order
 * @param {{ chain: string, marketplaces: Map<string, {name: string, protocol: string}>,
 *   currencies: Map<string, {symbol: string, decimals: number, unit: 'ETH'|'USD'}>, timeOf: (log: object) => number,
 *   ethUsd: (at: number) => number|null }} ctx
 * @returns {{ sales: Sale[], skipped: { bundle: number, currency: number, malformed: number } }}
 */
export function salesFromLogs(logs, ctx) {
  const skipped = { bundle: 0, currency: 0, malformed: 0 }
  const ordered = [...logs].sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex))
  const byKey = new Map()
  for (const log of ordered) {
    const market = ctx.marketplaces.get(String(log.address).toLowerCase())
    const block = Number(log.blockNumber), idx = Number(log.logIndex)
    if (!market || !Number.isSafeInteger(block) || !Number.isSafeInteger(idx) || !/^0x[0-9a-f]{64}$/i.test(log.transactionHash ?? '')) {
      skipped.malformed++
      continue
    }
    const fill = decodeSale(log)
    if (!fill || fill.protocol !== market.protocol) { skipped.malformed++; continue }
    const collections = new Set(fill.items.map((i) => i.collection))
    // A bundle across collections has no per-collection price.
    if (collections.size !== 1) { skipped.bundle++; continue }
    let eth = 0, usd = 0, unit = null
    const at = ctx.timeOf(log), ethUsd = ctx.ethUsd(at)
    for (const p of fill.payments) {
      const c = ctx.currencies.get(p.token)
      if (!c) { unit = 'unknown'; break }
      const amount = Number(p.amount) / 10 ** c.decimals
      if (c.unit === 'ETH') { eth += amount; usd += ethUsd == null ? NaN : amount * ethUsd }
      else { usd += amount; eth += ethUsd ? amount / ethUsd : NaN }
      unit = unit == null || unit === c.unit ? c.unit : 'mixed'
    }
    if (unit === 'unknown' || !(eth > 0 || usd > 0)) { skipped.currency++; continue }
    const totalQty = fill.items.reduce((n, i) => n + i.qty, 0n)
    const tx = log.transactionHash.toLowerCase()
    for (const item of fill.items) {
      const key = tx + ':' + item.collection + ':' + item.tokenId
      const known = byKey.get(key)
      if (known) {
        known.seller ??= fill.seller
        known.buyer ??= fill.buyer
        continue
      }
      const share = Number(item.qty) / Number(totalQty), qty = Number(item.qty)
      const priceEth = Number.isFinite(eth) ? eth * share : null, priceUsd = Number.isFinite(usd) ? usd * share : null
      byKey.set(key, {
        chain: ctx.chain, tx, idx, block, at, collection: item.collection, tokenId: item.tokenId,
        qty: Number.isSafeInteger(qty) ? qty : 1, standard: item.standard, marketplace: market.name, protocol: fill.protocol,
        currency: unit === 'USD' ? 'USD' : unit === 'mixed' ? 'mixed' : 'ETH',
        priceEth, priceUsd, unitEth: priceEth == null ? null : priceEth / Math.max(1, qty),
        seller: fill.seller, buyer: fill.buyer, fees: fill.fees, bundle: fill.items.length,
      })
    }
  }
  return { sales: [...byKey.values()], skipped }
}

/** Wash-like trade: the seller bought it from themselves, or the token returns to an earlier seller within a day
 * (A→B→A) without marketplace fees or royalties. `previous` is the token's earlier sales, newest first. */
export function washFlag(sale, previous = []) {
  if (sale.seller && sale.buyer && sale.seller === sale.buyer) return 'self'
  if (!sale.buyer || !sale.seller) return null
  const loop = previous.some((p) => p.at >= sale.at - 86_400_000 && p.at <= sale.at && p.seller === sale.buyer && p.buyer === sale.seller)
  return loop && (sale.fees === 0 || previous.some((p) => p.fees === 0)) ? 'loop' : null
}

/** Nearest-rank percentile of positive numbers (p in 0..1). */
export function percentile(values, p) {
  const sorted = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b)
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]
}

export const FLOOR = Object.freeze({ percentile: 0.1, window: 86_400_000, lastSales: 20, lookback: 7 * 86_400_000, minSales: 3 })

/** "Sale floor": the 10th percentile unit price of unflagged sales in the 24 h before `at`, or of the last 20 such
 * sales within 7 days when the day has fewer than 20. Never a listing floor. `sales` newest first. */
export function saleFloor(sales, at) {
  const eligible = sales.filter((s) => !s.flag && s.at <= at && s.at > at - FLOOR.lookback && s.unitEth > 0)
  const day = eligible.filter((s) => s.at > at - FLOOR.window)
  const sample = day.length >= FLOOR.lastSales ? day : eligible.slice(0, FLOOR.lastSales)
  if (sample.length < FLOOR.minSales) return null
  const eth = percentile(sample.map((s) => s.unitEth), FLOOR.percentile)
  const usdRate = sample.map((s) => (s.priceUsd > 0 && s.priceEth > 0 ? s.priceUsd / s.priceEth : null)).find((x) => x != null)
  return { eth, usd: usdRate == null ? null : eth * usdRate, sales: sample.length }
}
