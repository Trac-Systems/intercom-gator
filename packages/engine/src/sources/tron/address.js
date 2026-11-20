import { createHash } from 'node:crypto'
import { createBase58check } from '@scure/base'

const check = createBase58check(bytes => createHash('sha256').update(bytes).digest())
const base58Address = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

/** Network-prefixed TRON hex (41 + 20 bytes), or null for a bad checksum or network. */
export function tronHex(address) {
  if (typeof address !== 'string' || !base58Address.test(address)) return null
  try {
    const bytes = check.decode(address)
    return bytes.length === 21 && bytes[0] === 0x41 ? Buffer.from(bytes).toString('hex') : null
  } catch {
    return null
  }
}

/** Convert a TRON hex address or an address from a TVM ABI/event to its registry spelling. */
export function tronAddress(hex) {
  if (typeof hex !== 'string') return null
  if (/^0x[0-9a-f]{40}$/i.test(hex)) hex = '41' + hex.slice(2)
  return /^41[0-9a-f]{40}$/i.test(hex) ? check.encode(Buffer.from(hex, 'hex')) : null
}

export function abiAddress(address) {
  const hex = tronHex(address)
  if (!hex) throw new TypeError('Invalid TRON mainnet address')
  return '0x' + hex.slice(2)
}
