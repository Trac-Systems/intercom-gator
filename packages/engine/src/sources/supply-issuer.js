import { DAY } from './supply-api.js'

/* Issuer feeds state each chain's own issuance of one stablecoin. Every row is pinned to one bundle
 * deployment, so a bridged copy elsewhere is never matched and each chain's issuance counts once. */
export const ISSUERS = {
  'tether-transparency': {
    symbol: 'USDT',
    deployments: {
      aptos: 'aptos:0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b',
      near: 'near:usdt.tether-token.near',
      eth: 'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7',
      tron: 'tron:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      sol: 'solana:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      ton: 'ton:EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
      ava: 'avalanche:0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7',
      celo: 'celo:0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e',
    },
  },
  'circle-eurc': {
    api: 'circle-stablecoins',
    symbol: 'EURC',
    // Native deployments only, from https://developers.circle.com/stablecoins/eurc-contract-addresses
    deployments: {
      ETH: 'ethereum:0x1abaea1f7c830bd89acc67ec4af516284b1bc33c',
      BASE: 'base:0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42',
      AVAX: 'avalanche:0xc891eb4cbdeff6e073e859e987815ed1505c2acd',
      SOL: 'solana:HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr',
    },
  },
  'circle-stablecoins': {
    symbol: 'USDC',
    deployments: {
      LINEA: 'linea:0x176211869ca2b568f2a7d4ee941e073a821ee1ff',
      SONIC: 'sonic:0x29219dd400f2bf60e5a23d13be72b486d4038894',
      NEAR: 'near:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
      ZKS: 'zksync:0x1d17cbcf0d6d143135ae902365d2e5e2a16538d4',
      ETH: 'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      SOL: 'solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      BASE: 'base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      ARB: 'arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      AVAX: 'avalanche:0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
      OP: 'optimism:0x0b2c639c533813f4aa9d7837caf62653d097ff85',
      POLY: 'polygon:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
      UNI: 'unichain:0x078d782b760474a361dda0af3839290b0ef57ad6',
      CELO: 'celo:0xceba9300f2b948710d2653dd7b07f33a8b32118c',
      APTOS: 'aptos:0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b',
      SUI: 'sui:0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    },
  },
}

const groups = new Map()
for (const { deployments } of Object.values(ISSUERS)) {
  const ids = Object.values(deployments)
  for (const id of ids) groups.set(id, ids)
}
/** Other pinned deployments of the same issuer token, or an empty list. */
export const issuerSiblings = id => (groups.get(id) ?? []).filter(other => other !== id)

const SCALE = 18
const fixed = raw => {
  const text = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw
  const m = typeof text === 'string' && /^(\d{1,15})(?:\.(\d{1,18}))?$/.exec(text)
  return m ? BigInt(m[1] + (m[2] ?? '').padEnd(SCALE, '0')) : null
}
const text = n => {
  const digits = n.toString().padStart(SCALE + 1, '0'), fraction = digits.slice(-SCALE).replace(/0+$/, '')
  return digits.slice(0, -SCALE) + (fraction ? '.' + fraction : '')
}
const fresh = (at, now) => Number.isFinite(at) && at <= now + 300_000 && now - at <= 4 * DAY

/** Tether's transparency report: issued on chain minus authorized-but-not-issued and quarantined.
 * `data.usdt.id` is the report time in Unix seconds. */
export function tetherRows(payload, now) {
  const usdt = payload?.data?.usdt
  const at = Number.isSafeInteger(usdt?.id) ? usdt.id * 1000 : NaN
  if (!usdt || typeof usdt !== 'object' || !fresh(at, now)) throw new Error('Invalid Tether transparency report')
  const results = new Map()
  for (const [key, id] of Object.entries(ISSUERS['tether-transparency'].deployments)) {
    const [issued, unissued, quarantined] = ['totaltokens_', 'reserve_balance_', 'quarantined_'].map(f => fixed(usdt[f + key]))
    if (issued === null || unissued === null || quarantined === null || !issued || unissued + quarantined > issued) continue
    results.set(id, { value: text(issued - unissued - quarantined), total: text(issued), at, method: 'issuer-circulating',
      source: 'tether-transparency' })
  }
  return results
}

/** Each native USDC and EURC row has its own update time and belongs to a different issuer group. */
export function circleRows(payload, now) {
  const coins = payload?.data
  if (!Array.isArray(coins) || !coins.length || coins.length > 64) throw new Error('Invalid Circle supply')
  const results = new Map()
  for (const group of [ISSUERS['circle-stablecoins'], ISSUERS['circle-eurc']]) {
    const matches = coins.filter(c => c?.symbol === group.symbol)
    if (matches.length !== 1 || !Array.isArray(matches[0].chains) || matches[0].chains.length > 256) continue
    const seen = new Set()
    for (const row of matches[0].chains) {
      if (!Object.hasOwn(group.deployments, row?.chain)) continue
      const id = group.deployments[row.chain]
      if (seen.has(id)) { results.delete(id); continue }
      seen.add(id)
      const amount = fixed(row.amount), at = typeof row.updateDate === 'string' ? Date.parse(row.updateDate) : NaN
      if (amount === null || !amount || !fresh(at, now)) continue
      results.set(id, { value: text(amount), at, method: 'issuer-circulating', source: 'circle-stablecoins' })
    }
  }
  return results
}
