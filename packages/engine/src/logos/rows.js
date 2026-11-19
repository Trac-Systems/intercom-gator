/**
 * Adds `logo: '/img/<sha>.<ext>' | null` to the API rows that draw a token, chain or exchange mark. Asking for a row's
 * logo is the "on screen" signal: a missing image is queued for the low-priority logo job, and the row answers at once.
 * @param {{ asset(id: string): string|null, chain(id: string): string|null, exchange(id: string): string|null }} logos
 * @param {string} route first path segment under /api/v1
 * @param {any} result the route's response
 * @param {string} [sub] sub-route (assets/:id/<sub>)
 */
export function withLogos(logos, route, result, sub) {
  if (!logos || !result || typeof result !== 'object') return result
  const asset = (row, field = 'id') => (row && typeof row === 'object' ? { ...row, logo: logos.asset(row[field]) } : row)
  const list = (rows, fn) => (Array.isArray(rows) ? rows.map(fn) : rows)
  const venue = (m) => {
    if (!m || typeof m !== 'object') return m
    const [kind, id] = String(m.id ?? '').split(':')
    return { ...m, venueLogo: kind === 'cex' ? logos.exchange(id) : null }
  }
  switch (route) {
    case 'assets':
      if (sub === 'markets') return { ...result, items: list(result.items, venue) }
      if (sub) return result
      return { ...asset(result), markets: list(result.markets, venue) }
    case 'markets': case 'new':
      return { ...result, items: list(result.items, r => asset(r)) }
    case 'chains':
      return { ...result, items: list(result.items, r => ({ ...r, logo: logos.chain(r.chain) })) }
    case 'exchanges':
      return { ...result, items: list(result.items, r => ({ ...r, logo: logos.exchange(r.id) })) }
    case 'movers':
      return { ...result, gainers: list(result.gainers, r => asset(r)), losers: list(result.losers, r => asset(r)) }
    case 'search':
      return { ...result, tokens: list(result.tokens, r => asset(r)) }
    case 'portfolio':
      return { ...result, holdings: list(result.holdings, r => asset(r, 'asset')) }
    case 'alerts':
      return { ...result, items: list(result.items, r => asset(r, 'asset')) }
    case 'extras':
      return { ...result, items: list(result.items, r => (r?.token ? { ...r, token: asset(r.token) } : r)) }
    default:
      return result
  }
}
