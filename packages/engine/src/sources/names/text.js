const utf8 = new TextDecoder('utf-8', { fatal: true })

/** Strict UTF-8 for length-delimited contract fields. @param {Uint8Array} bytes @returns {string|null} */
export function decodeText(bytes) {
  try { return utf8.decode(bytes) } catch { return null }
}

/** @param {unknown} raw @param {number} limit @param {string} [address] @returns {string|null} */
export function cleanLabel(raw, limit, address) {
  if (typeof raw !== 'string' || raw.length > 4096) return null
  const text = raw.normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu, '').trim()
  if (!text || text === address || (typeof address === 'string' && /^0x/i.test(address) && text.toLowerCase() === address.toLowerCase())) return null
  return Array.from(text).slice(0, limit).join('').trimEnd() || null
}

export const validDecimals = n => Number.isInteger(n) && n >= 0 && n <= 255

/** Both display labels must identify the asset. Decimals are independently measured. */
export function labels(row, address) {
  const name = cleanLabel(row?.name, 64, address), symbol = cleanLabel(row?.symbol, 16, address)
  return name && symbol ? { name, symbol } : null
}
