import { createHash } from 'node:crypto'

// Ref Finance v2 (classic AMM): https://guide.ref.finance/developers/contracts — release data in reader code (§5.4).
export const REF = 'v2.ref-finance.near'
export const WNEAR = 'wrap.near'
export const USDT = 'usdt.tether-token.near'
export const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'

const ACCOUNT = /^(?=.{2,64}$)(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/

export const nearToken = id => (id === WNEAR ? 'native' : typeof id === 'string' && ACCOUNT.test(id) ? id : null)
/**
 * Market key of a Ref pool for the v1 wire pattern (0x + 64 hex): 24 bytes of sha256(contract), then the pool id as a
 * big-endian u64, so a receiver can recover and check the pool without a lookup table.
 */
export const refKey = (id, contract = REF) =>
  '0x' + createHash('sha256').update(contract).digest('hex').slice(0, 48) + BigInt(id).toString(16).padStart(16, '0')
/** @returns {number|null} the Ref pool id of a market key, or null for another contract. */
export const refId = (key, contract = REF) => (typeof key === 'string' && key.length === 66 && key === refKey(BigInt('0x' + key.slice(50)), contract)
  ? Number(BigInt('0x' + key.slice(50))) : null)
