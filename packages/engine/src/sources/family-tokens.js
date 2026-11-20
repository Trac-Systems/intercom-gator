import { tonAddress } from './ton/address.js'
import { USDT as TON_USDT } from './ton/deployments.js'

const NEAR_ACCOUNT = /^(?=.{2,64}$)(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/

/** Token address rules and stable quotes for DEX families whose pools use the `0x<64 hex>` market key. */
const FAMILIES = {
  ton: { valid: a => a === 'native' || tonAddress(a) === a, stable: new Set([TON_USDT]) },
  near: { valid: a => a === 'native' || (a !== 'wrap.near' && NEAR_ACCOUNT.test(a)),
    stable: new Set(['usdt.tether-token.near', '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1']) }, // gitleaks:allow (public NEAR USDT/USDC token accounts)
}

export const familyToken = family => FAMILIES[family] ?? null
export const LOCAL_POOL_CHAINS = new Set(Object.keys(FAMILIES))
