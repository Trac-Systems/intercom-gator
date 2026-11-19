import { units } from './supply-emission.js'

/** QueryCommunityPoolResponse is a repeated DecCoin. The published application state encodes each
 * LegacyDec as a base-10 integer scaled by 10^18. Only native uatom belongs in ATOM's calculation. */
export function communityAtom(reply, block) {
  const response = reply?.result?.response, raw = response?.value
  if (reply?.error || response?.code !== 0 || response.height !== String(block) ||
      typeof raw !== 'string' || raw.length > 65536) throw new Error('Invalid community pool response')
  const bytes = Buffer.from(raw, 'base64')
  if (bytes.toString('base64') !== raw) throw new Error('Invalid community pool encoding')
  let offset = 0
  function field(tag, end) {
    if (bytes[offset++] !== tag) throw new Error('Invalid community pool field')
    let size = 0
    for (let i = 0; i < 3 && offset < end; i++) {
      const n = bytes[offset++]
      size += (n & 127) * 128 ** i
      if (n < 128 && offset + size <= end) return offset + size
      if (n < 128) break
    }
    throw new Error('Invalid community pool length')
  }
  let atom
  while (offset < bytes.length) {
    const end = field(10, bytes.length), denomEnd = field(10, end)
    const denom = bytes.toString('utf8', offset, denomEnd)
    offset = denomEnd
    const amountEnd = field(18, end), amount = bytes.toString('utf8', offset, amountEnd)
    if (amountEnd !== end || !/^\d{1,78}$/.test(amount)) throw new Error('Invalid community balance')
    if (denom === 'uatom') {
      if (atom !== undefined) throw new Error('Duplicate ATOM balance')
      atom = BigInt(amount)
    }
    offset = end
  }
  if (atom === undefined) throw new Error('Missing ATOM balance')
  return atom
}

/** Coins in the governance-controlled community pool have not been distributed. Keep bonded ATOM
 * and unbonding balances, which belong to holders. Both reads use the same committed Hub height. */
export function unlockedAtom(total, pool) {
  const [whole, fraction = ''] = total.split('.')
  const issued = BigInt(whole + fraction.padEnd(24, '0'))
  if (pool > issued) throw new Error('Community pool exceeds supply')
  return units(issued - pool, 24)
}
