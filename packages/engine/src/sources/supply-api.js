import { decimal } from '../obs/index.js'
import { units } from './supply-emission.js'

export const DAY = 86_400_000
const supportedChains = new Set(['arbitrum', 'base', 'celo', 'ethereum', 'linea', 'mantle', 'optimism',
  'polygon_pos', 'robinhood', 'scroll', 'unichain', 'zksync_era'])
export function growthepieChain(id) {
  const origin = ({ polygon: 'polygon_pos', zksync: 'zksync_era' })[id] ?? id
  return supportedChains.has(origin) ? origin : null
}

// These signed token identities have no stablecoin category in older registries. Both have a
// deployment-specific RPC row in the provider's table, including bridge and treasury adjustments.
export const tableTokens = new Set(['ethereum:0xfa2b947eec368f42195f24f36d2af29f7c24cec2',
  'arbitrum:0x7dff72693f6a4149b17e7c6314655f6a9f7c8b33'])
export const tableEligible = asset => !!asset && (asset.stable || tableTokens.has(asset.id))

/** The provider apportions bridged supply across chains and deducts known treasury balances.
 * Use its on-chain token quantity, ignoring any third-party price or logo columns. */
export function stablecoinRows(payload, chain, assets, now) {
  const { columns, rows } = payload?.data?.table ?? {}
  const fields = ['date', 'origin_key', 'address', 'decimals', 'method', 'value']
  if (!Array.isArray(columns) || columns.length > 96 || !fields.every(k => columns.includes(k)) ||
      new Set(columns).size !== columns.length || !Array.isArray(rows) || rows.length > 4096)
    throw new Error('Invalid stablecoin table')
  const indices = fields.map(k => columns.indexOf(k)), results = new Map(), duplicates = new Set()
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    const [date, origin, address, decimals, method, raw] = indices.map(i => row[i])
    if (origin !== growthepieChain(chain) || method !== 'rpc' || typeof address !== 'string' ||
        !/^0x[\da-f]{40}$/i.test(address) || typeof date !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(date)) continue
    const id = chain + ':' + address.toLowerCase(), asset = assets.get(id)
    if (!tableEligible(asset) || asset.decimals !== decimals) continue
    const at = Date.parse(date + 'T00:00:00Z'), value = decimal(raw)
    if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== date || at > now ||
        now - at > 4 * DAY || value === null) continue
    if (results.has(id)) duplicates.add(id)
    results.set(id, { value, at, method: 'chain-circulating', source: 'growthepie-stablecoins' })
  }
  for (const id of duplicates) results.delete(id)
  return results
}

export function ethereumSupply(data, now) {
  const field = data?.supply?.finalizedTotalWei, chain = data?.supply?.finalizedAsOf
  if (data?.chainId !== 1 || field?.status !== 'exact' || typeof field.value !== 'string' || !/^\d{1,78}$/.test(field.value) ||
      !Number.isSafeInteger(chain?.block) || chain.block < 0 || !Number.isSafeInteger(field.asOf) ||
      chain.timestamp !== field.asOf || field.asOf * 1000 > now || now - field.asOf * 1000 > 7 * DAY)
    throw new Error('Invalid finalized ETH supply')
  const value = units(BigInt(field.value), 18)
  return { value, total: value, at: field.asOf * 1000, block: chain.block, source: 'ethereum-supply',
    method: 'net-issuance', estimate: true }
}
