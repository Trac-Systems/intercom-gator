import { weightedMedian } from '../aggregate/index.js'
import { formatUrl } from './http.js'
import { decimal } from '../obs/index.js'

/** Index by exact requested token identity. Never infer the token from a response ticker. */
export async function fetchReferences({ source, assets, http, save, clock, slot, slotMs = 400 }) {
  const now = clock()
  if (source.id === 'dexscreener') {
    const [asset] = assets
    if (!asset) return
    const json = await http.get(formatUrl(source.url, { chain: asset.chain, address: asset.address }), source.rpm)
    if (!Array.isArray(json)) throw new Error('Invalid pool reference response')
    const matches = json.filter(
      (p) =>
        p.chainId === asset.chain &&
        (p.baseToken?.address === asset.address ||
          (/^0x[0-9a-f]{40}$/.test(asset.address) && p.baseToken?.address?.toLowerCase() === asset.address))
    )
    const prices = matches
      .filter((p) => +p.priceUsd > 0)
      .map((p) => ({ value: +p.priceUsd, weight: Math.max(1, +p.liquidity?.usd || 0) }))
    const price = weightedMedian(prices)
    if (price > 0) save(asset.id, source.id, price, now)
    return
  }
  const selected = new Map(assets.map((a) => [source.id.startsWith('jupiter') ? a.address : a.id, a]))
  if (!selected.size) return
  const keys = [...selected.keys()]
  const json = await http.get(formatUrl(source.url, { coins: keys.join(','), mints: keys.join(',') }), source.rpm)
  const values = source.id === 'llama-prices' ? json?.coins : json
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid reference response')
  for (const [key, r] of Object.entries(values)) {
    const asset =
      selected.get(key) ?? (/^[a-z0-9-]+:0x[0-9a-f]{40}$/i.test(key) ? selected.get(key.toLowerCase()) : null)
    if (!asset || !r || (r.confidence != null && r.confidence < 0.7)) continue
    const price = decimal(r.usdPrice ?? r.price)
    const slotAge =
      Number.isSafeInteger(slot) && Number.isSafeInteger(r.blockId) && r.blockId <= slot + 32
        ? Math.max(0, slot - r.blockId) * slotMs
        : NaN
    const at = r.timestamp != null ? Number(r.timestamp) * 1000 : Math.round(now - slotAge)
    if (price && +price > 0 && Number.isSafeInteger(at) && at >= now - 600000 && at <= now + 30000) {
      save(asset.id, source.id.startsWith('jupiter') ? 'jupiter' : source.id, +price, at)
    }
  }
}
