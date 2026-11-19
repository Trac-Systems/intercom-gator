import { atPath } from './bundle-adapter.js'
import { formatUrl } from './http.js'

const labels = [
  'symbol',
  'instId',
  'instrument_name',
  'instrument_id',
  'instrument',
  'contract_code',
  'contractName',
  'market',
  'ticker',
  'name',
  's',
  'i',
  'productId',
]

/** A derivative instrument has its own identity and units, even when the underlying has a spot market. */
function collect(json, fields, requested, save) {
  const pending = [[json, requested]]
  while (pending.length) {
    const [row, inherited] = pending.pop()
    if (row === null || typeof row !== 'object') continue
    const array = Array.isArray(row)
    const symbol = array
      ? typeof row[0] === 'string'
        ? row[0]
        : inherited
      : (labels.map((k) => row[k]).find((v) => typeof v === 'string') ?? inherited)
    if (typeof symbol === 'string' && symbol.length <= 80) {
      const funding = atPath(row, fields.fundingRate),
        oi = atPath(row, fields.openInterest)
      if ([funding, oi].some((v) => ['string', 'number'].includes(typeof v) && v !== '' && Number.isFinite(+v))) {
        save(symbol, funding, oi)
        continue
      }
    }
    for (const [key, value] of Object.entries(row)) {
      if (value && typeof value === 'object') {
        const marketKey = !array && /^[A-Z0-9]+[-_:][A-Z0-9_-]+$/.test(key) ? key : symbol
        pending.push([value, marketKey])
      }
    }
  }
}

/** A derivatives request identical to the venue's ticker request (Hyperliquid metaAndAssetCtxs, Phemex 24hr/all) is
 * already read by the ticker job, which saves funding and open interest from the same rows through the same fields.
 * A second job only spent upstream weight (Hyperliquid: ~60 × 20 weight per hour) and, for joined rows, saved nothing. */
export function sameAsTicker(venue, d) {
  return !!venue.ticker && d.url === venue.ticker.url && (d.method ?? 'GET') === (venue.ticker.method ?? 'GET') &&
    JSON.stringify(d.body ?? null) === JSON.stringify(venue.ticker.body ?? null)
}

export function derivativeJobs(venue, http, clock, save) {
  const byUrl = Map.groupBy(venue.derivatives.filter((d) => !sameAsTicker(venue, d)), (d) => d.url)
  return [...byUrl].map(([url, descriptions], index) => {
    const spec = descriptions[0],
      fields = Object.fromEntries(descriptions.map((d) => [d.kind, d.field]))
    let cursor = 0
    return {
      id: 'cex:' + venue.id + ':derivatives:' + index,
      interval: 60000,
      relevance: 0.3,
      ready: () => !url.includes('{symbol}') || !!spec.sample || venue.instruments.size > 0,
      run: async () => {
        const instruments = [...new Set([spec.sample, ...venue.instruments].filter(Boolean))]
        const symbol = instruments.length ? instruments[cursor % instruments.length] : null
        const now = clock()
        const data = await http.get(formatUrl(url, { symbol, unixMs: now }), venue.rpm, 1, spec.body)
        collect(data, fields, url.includes('{symbol}') ? symbol : null, (id, f, oi) =>
          save(venue.id, id, f, oi, now)
        )
        cursor++
      },
    }
  })
}
