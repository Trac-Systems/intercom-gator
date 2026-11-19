import { DAY } from './supply-api.js'
import { emissionAtHeight } from './supply-emission.js'
import { HYPE_TOKEN_DETAILS } from './supply-hyperliquid.js'

const quantity = (value, places) => typeof value === 'string' && new RegExp(`^\\d{1,15}(\\.\\d{1,${places}})?$`).test(value)
const scaled = (value, places) => {
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole + fraction.padEnd(places, '0'))
}
const trim = value => value.includes('.') ? value.replace(/\.?0+$/, '') : value

/** SDF's lumen supply metrics: total minus SDF mandate, upgrade reserve and fee pool.
 * https://developers.stellar.org/docs/learn/fundamentals/lumens#lumen-supply-metrics */
export function stellarLumens(data, now) {
  const at = typeof data?.updatedAt === 'string' ? Date.parse(data.updatedAt) : NaN
  const { circulatingSupply: value, totalSupply: total } = data ?? {}
  if (!quantity(value, 7) || !quantity(total, 7) || scaled(value, 7) > scaled(total, 7) || !Number.isFinite(at) ||
      at > now + 300_000 || now - at > 2 * DAY) throw new Error('Invalid Stellar lumen supply')
  return { value: trim(value), total: trim(total), at, method: 'sdf-lumen-supply', source: 'stellar-lumens' }
}

// HYPE's spot token id and the USDC quote token, both fixed at Hyperliquid genesis.
const HYPE = '0x0d01dc56dcaaca66ad901c959b4011ec', USDC = 0
/** Hyperliquid's spot context states HYPE circulating and total supply. Prices in the reply are ignored. */
export function hyperliquidSpot(data, now) {
  const [meta, contexts] = Array.isArray(data) && data.length === 2 ? data : []
  const tokens = meta?.tokens, universe = meta?.universe
  if (![tokens, universe, contexts].every(a => Array.isArray(a) && a.length <= 16_384)) throw new Error('Invalid Hyperliquid spot meta')
  const token = tokens.find(t => t?.tokenId === HYPE)
  const pair = token?.name === 'HYPE' && tokens.find(t => t?.index === USDC)?.name === 'USDC' &&
    universe.find(u => Array.isArray(u?.tokens) && u.tokens[0] === token.index && u.tokens[1] === USDC)
  const context = pair && Number.isSafeInteger(pair.index) ? contexts[pair.index] : null
  const { circulatingSupply: value, totalSupply: total } = context ?? {}
  if (!context || context.coin !== pair.name || !quantity(value, 18) || !quantity(total, 18) ||
      scaled(value, 18) > scaled(total, 18)) throw new Error('Invalid Hyperliquid HYPE supply')
  return { value: trim(value), total: trim(total), at: now, method: 'hyperliquid-spot-supply', source: 'hyperliquid-spot' }
}

/** BCH keeps Bitcoin's subsidy schedule, so the issued amount follows from the tip height. */
export function bitcoinCashStats(data) {
  const block = data?.data?.best_block_height
  if (data?.context?.code !== 200 || !Number.isSafeInteger(block) || block < 478_559) throw new Error('Invalid BCH height')
  const value = emissionAtHeight('bitcoin-cash', block)
  return { value, total: value, block, method: 'scheduled-emission', estimate: true, source: 'bitcoin-cash-stats' }
}

/** API-only native feeds. Each activates once its asset exists in the signed bundle. */
export const NATIVE_FEEDS = [
  HYPE_TOKEN_DETAILS,
  { api: 'hyperliquid-spot', asset: 'hyperliquid:native', body: { type: 'spotMetaAndAssetCtxs' }, read: hyperliquidSpot },
  { api: 'bitcoin-cash-stats', asset: 'bitcoin-cash:native', read: bitcoinCashStats },
  { api: 'stellar-lumens', asset: 'stellar:native', read: stellarLumens },
]
