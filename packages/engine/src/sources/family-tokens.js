import { nearToken, USDC as NEAR_USDC, USDT as NEAR_USDT } from './near/identity.js'
import { tonAddress } from './ton/address.js'
import { USDT as TON_USDT } from './ton/deployments.js'

/** Token address rules and stable quotes for DEX families whose pools use the `0x<64 hex>` market key. */
const FAMILIES = {
  ton: { valid: a => typeof a === 'string' && (a === 'native' || tonAddress(a) === a), stable: new Set([TON_USDT]) },
  near: { valid: a => typeof a === 'string' && nearToken(a) === a, stable: new Set([NEAR_USDT, NEAR_USDC]) },
}

export const familyToken = family => Object.hasOwn(FAMILIES, family) ? FAMILIES[family] : null
export const LOCAL_POOL_CHAINS = new Set(Object.keys(FAMILIES))
