import { DAY } from './supply-api.js'

// HYPE's HyperCore token id, fixed at genesis (spotMeta.tokens, index 150).
export const HYPE_TOKEN_ID = '0x0d01dc56dcaaca66ad901c959b4011ec'
/** A reading older than this withdraws the circulating figure (DESIGN §5.3 default for live state reads). */
export const MAX_AGE = 2 * DAY
const PLACES = 18

const quantity = value => typeof value === 'string' && /^\d{1,15}(\.\d{1,18})?$/.test(value)
const scaled = value => {
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole + fraction.padEnd(PLACES, '0'))
}
const trim = value => value.includes('.') ? value.replace(/\.?0+$/, '') : value
const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value)

/**
 * Hyperliquid's own token ledger for HYPE (`tokenDetails`). Circulating supply is total minus the listed
 * non-circulating balances (core contributors, Assistance Fund, burn addresses) minus future emissions; the
 * reader checks that identity before accepting the figure. Prices and the genesis balance list are ignored.
 * HyperEVM gas HYPE is HYPE moved from HyperCore (held by system address 0x2222…2222 until bridged), so this
 * one reading is the coin's whole supply and `hyperevm:native` carries none of its own.
 */
export function hyperliquidTokenDetails(data, now) {
  const { name, weiDecimals, maxSupply: max, totalSupply: total, circulatingSupply: value, futureEmissions: future,
    nonCirculatingUserBalances: held } = data ?? {}
  if (name !== 'HYPE' || weiDecimals !== 8 || ![max, total, value, future].every(quantity) ||
      !Array.isArray(held) || held.length > 64) throw new Error('Invalid Hyperliquid HYPE details')
  let excluded = 0n
  for (const row of held) {
    if (!Array.isArray(row) || row.length !== 2 || !address(row[0]) || !quantity(row[1]))
      throw new Error('Invalid Hyperliquid non-circulating balance')
    excluded += scaled(row[1])
  }
  const circulating = scaled(value), issued = scaled(total)
  // The API rounds each figure separately; allow one millionth of a token per listed balance.
  const drift = issued - excluded - scaled(future) - circulating
  const slack = BigInt(held.length + 2) * 10n ** BigInt(PLACES - 6)
  if (circulating > issued || issued > scaled(max) || drift > slack || drift < -slack)
    throw new Error('Inconsistent Hyperliquid HYPE supply')
  return { value: trim(value), total: trim(total), at: now, expiresAt: now + MAX_AGE,
    method: 'hyperliquid-token-details', source: 'hyperliquid-token-details' }
}

/** Native feed record (registered first in NATIVE_FEEDS; the spot-context feed stays as the fallback). */
export const HYPE_TOKEN_DETAILS = Object.freeze({
  api: 'hyperliquid-token-details', asset: 'hyperliquid:native',
  body: { type: 'tokenDetails', tokenId: HYPE_TOKEN_ID }, read: hyperliquidTokenDetails,
})

/**
 * HyperEVM ERC-20s whose `totalSupply()` is their whole supply. Tokens linked to a HyperCore spot token
 * mint the HyperCore supply to the system address `0x20…<token index>`: for HyperCore-native tokens (UBTC,
 * UETH, USOL, PURR, and any unknown linked token) the ERC-20 total is a pre-mint, not circulation, so they get
 * no ERC-20 supply reading. Measured 2026-11-19: UBTC total 21,000,000 with 20,999,487.94 at 0x20…c5.
 */
export const HYPEREVM_FULL_SUPPLY = new Set([
  'hyperevm:0xfd739d4e423301ce9385c1fb8850539d657c296d', // kHYPE (EVM-native; 0x20…79 holds kHYPE moved to HyperCore)
  'hyperevm:0x94e8396e0869c9f2200760af0621afd240e1cf38', // wstHYPE (EVM-native; 0x20…77)
  'hyperevm:0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb', // USDT0 (LayerZero OFT; 0x20…10c)
])
