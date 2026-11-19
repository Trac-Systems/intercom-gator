import { decimal } from '../obs/index.js'
import { formatUrl } from './http.js'

/** Look up a specific Solana pool in the signed public directory, matching both mints. */
export async function solanaPair(api, http, { chain, pool, dex, token0, token1 }) {
  const pairs = await http.getPublic(formatUrl(api.url, { chain, address: token0 }), api.rpm)
  if (!Array.isArray(pairs)) throw new Error('Invalid pool reference response')
  return pairs.find(p => p?.chainId === chain && p.dexId === dex && p.pairAddress === pool &&
    ((p.baseToken?.address === token0 && p.quoteToken?.address === token1) ||
     (p.baseToken?.address === token1 && p.quoteToken?.address === token0)))
}

export async function checkSolanaPrice(api, http, registry, id, publish, clock) {
  const market = registry.markets.get(id)
  const token0 = registry.assets.get(market.base).address, token1 = registry.assets.get(market.quote).address
  const pair = await solanaPair(api, http, { chain: market.chain, pool: id.split(':')[2], dex: market.exchange, token0, token1 })
  if (!pair || !(Number(pair.priceNative) > 0)) return
  const price = decimal(pair.baseToken.address === token0 ? pair.priceNative : 1 / Number(pair.priceNative))
  if (price) publish([[id, price, '0', decimal(pair.volume?.h24), null, null, clock()]])
}

/** Normalize pool directory responses into ordered mint identities, quote price and USD turnover. */
export function solanaPools(source, json) {
  let rows = json?.data,
    unpack
  switch (source.id) {
    case 'raydium':
      rows = rows?.data
      unpack = (r) => ({
        address: r.id,
        a: r.mintA,
        b: r.mintB,
        price: r.price,
        volume: r.day?.volume,
        liquidity: r.tvl,
        kind: r.type,
        program: r.programId,
      })
      break
    case 'orca':
      unpack = (r) => ({
        address: r.address,
        a: r.tokenA,
        b: r.tokenB,
        price: r.price,
        volume: r.stats?.['24h']?.volume,
        liquidity: r.tvlUsdc,
        kind: 'whirlpool',
        at: Date.parse(r.updatedAt),
      })
      break
    case 'meteora':
      unpack = (r) => ({
        address: r.address,
        a: r.token_x,
        b: r.token_y,
        price: r.current_price,
        volume: r.volume?.['24h'],
        liquidity: r.tvl,
        kind: 'dlmm',
      })
      break
    default:
      return []
  }
  if (!Array.isArray(rows)) throw new Error('Invalid Solana pool directory')
  return rows
    .filter((r) => r && typeof r === 'object')
    .map(unpack)
    .filter(
      (r) =>
        r.a?.address &&
        r.b?.address &&
        (!r.program || !source.programs?.length || source.programs.includes(r.program)) &&
        decimal(r.price) &&
        +r.price > 0
    )
}

export async function fetchSolana(options, page = 1, after = null) {
  const { source, http } = options
  const url = new URL(formatUrl(source.url, { page, limit: 100 }))
  if (after) url.searchParams.set('next', after)
  const json = await http.get(url.href, source.rpm)
  recordSolanaPools(options, solanaPools(source, json))
  const cursor = json?.meta?.cursor?.next
  const listed = source.id === 'raydium' ? json?.data?.data : json?.data
  return { more: listed?.length >= 100, cursor: typeof cursor === 'string' && cursor.length <= 512 ? cursor : null }
}

export function recordSolanaPools({ source, registry, publish, discover, clock, chain, fromHint = false }, pools) {
  const rows = []
  for (const p of pools) {
    const now = clock()
    const discovery = {
      chain,
      dex: source.id,
      pool: p.address,
      kind: p.kind ?? 'pool',
      token0: p.a.address,
      token1: p.b.address,
      firstSeen: now,
      liquidity: Number(p.liquidity) || null,
    }
    const exists = registry.markets.has('dex:' + chain + ':' + p.address)
    const market = registry.pool(discovery, { token0: p.a, token1: p.b }, fromHint)
    if (!market) continue
    if (!exists) discover(discovery)
    // Compare resolved asset ids: wrapped SOL resolves to solana:native, so a raw mint comparison inverted every SOL
    // pool (SOL at $0.0134 = 1/75, and SOL flipped between +1.5% and -100%).
    const price = market.base === registry.token(chain, p.a.address).id ? p.price : 1 / Number(p.price)
    const usdVolume = decimal(p.volume)
    // Directories publish USD turnover; zero is the conservative lower bound on unknown base turnover.
    rows.push([market.id, decimal(price), '0', usdVolume, null, null, Number.isFinite(p.at) ? p.at : now])
  }
  publish(rows)
}
