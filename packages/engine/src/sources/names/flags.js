import { ISSUERS } from '../supply-issuer.js'
import { cleanLabel } from './text.js'

/** Rank is local and can change. Only signed identities exempt a known ticker; an unknown local top-100
 * token with a new symbol can protect its own measured identity without becoming a venue symbol alias. */
export function flagReader(engine, seeds) {
  const protectedIssuers = new Map(Object.values(ISSUERS).map(i => [i.symbol, new Set(Object.values(i.deployments))]))
  const signed = new Map()
  for (const a of seeds.values()) {
    const symbol = cleanLabel(a.symbol, 16, a.address)?.toUpperCase()
    if (!symbol) continue
    if (!signed.has(symbol)) signed.set(symbol, new Set())
    signed.get(symbol).add(a.id)
  }
  const readTop = engine.store.writer.prepare(`SELECT a.id,n.symbol AS measured FROM assets a
    LEFT JOIN engine_names n ON n.asset=a.id WHERE a.rank BETWEEN 1 AND 100 ORDER BY a.rank,a.id`)
  let ranked = new Map(), refreshAt = -Infinity
  return (id, label) => {
    // The signed bundle vouches for its identities even when the contract now reports another ticker
    // (Polygon USDT reads "USDT0" since Tether's upgrade; Arbitrum USDC.e reads "USDC").
    if (!label || seeds.has(id)) return []
    const now = engine.clock()
    if (now >= refreshAt) {
      ranked = new Map()
      for (const row of readTop.all()) {
        const seed = seeds.get(row.id)
        const symbol = (row.measured ?? cleanLabel(seed?.symbol, 16, seed?.address))?.toUpperCase()
        if (symbol && !ranked.has(symbol)) ranked.set(symbol, row.id)
      }
      refreshAt = now + 1000
    }
    const symbol = label.toUpperCase()
    const issuer = protectedIssuers.get(symbol)
    // Bridged deployments the signed bundle lists (Binance-Peg BSC-USD, USDC on BSC) are not the issuer's own
    // contracts but are not imitations either.
    if (issuer) return issuer.has(id) || signed.get(symbol)?.has(id) ? [] : ['imitates:' + symbol]
    if (!ranked.has(symbol) && !['BTC', 'ETH'].includes(symbol)) return []
    const canonical = signed.get(symbol)?.has(id) ?? (ranked.get(symbol) === id)
    return canonical ? [] : ['imitates:' + symbol]
  }
}
