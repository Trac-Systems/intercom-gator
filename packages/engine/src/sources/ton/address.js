// TON address forms: raw `0:<64 hex>` and user-friendly base64url (tag, workchain, hash, CRC16-XMODEM).
// Registry asset IDs use the mainnet bounceable spelling (`EQ…`), as in the signed token data.

function crc16(bytes) {
  let crc = 0
  for (const byte of bytes) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc
}

/** @param {string} value user-friendly or raw address @returns {{ wc: number, hash: string }|null} */
export function parseTon(value) {
  if (typeof value !== 'string') return null
  const raw = /^(-1|0):([0-9a-fA-F]{64})$/.exec(value)
  if (raw) return { wc: Number(raw[1]), hash: raw[2].toLowerCase() }
  if (!/^[A-Za-z0-9_-]{48}$/.test(value)) return null
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.length !== 36 || ![0x11, 0x51].includes(bytes[0])) return null
  if (crc16(bytes.subarray(0, 34)) !== bytes.readUInt16BE(34)) return null
  const wc = bytes.readInt8(1)
  if (wc !== 0 && wc !== -1) return null
  return { wc, hash: bytes.subarray(2, 34).toString('hex') }
}

/** Mainnet bounceable user-friendly spelling. */
export function friendly({ wc, hash }) {
  const bytes = Buffer.alloc(36)
  bytes[0] = 0x11
  bytes.writeInt8(wc, 1)
  Buffer.from(hash, 'hex').copy(bytes, 2)
  bytes.writeUInt16BE(crc16(bytes.subarray(0, 34)), 34)
  return bytes.toString('base64url')
}

/** Canonical jetton master / pool spelling, or null. Basechain only: DEX contracts live there. */
export function tonAddress(value) {
  const a = parseTon(value)
  return a && a.wc === 0 ? friendly(a) : null
}

/** Pool market key: `0x` + account hash (basechain), matching the v1 wire market pattern. */
export function poolKey(value) {
  const a = parseTon(value)
  return a && a.wc === 0 ? '0x' + a.hash : null
}

export function keyAddress(key) {
  return /^0x[0-9a-f]{64}$/.test(key) ? friendly({ wc: 0, hash: key.slice(2) }) : null
}

/** Bits of a toncenter v2 stack cell/slice entry (`["cell", { object: { data: { b64, len } } }]`). */
export function stackBits(entry) {
  const data = Array.isArray(entry) && ['cell', 'slice'].includes(entry[0]) ? entry[1]?.object?.data : null
  if (!data || typeof data.b64 !== 'string' || !Number.isInteger(data.len) || data.len < 0 || data.len > 1023) return null
  const bytes = Buffer.from(data.b64, 'base64')
  if (bytes.length * 8 < data.len) return null
  return Array.from({ length: data.len }, (_, i) => (bytes[i >> 3] >> (7 - (i & 7))) & 1)
}

const int = (bits, from, n) => bits.slice(from, from + n).reduce((v, b) => v * 2 + b, 0)
const hashOf = (bits, from) => Buffer.from(Array.from({ length: 32 }, (_, i) => int(bits, from + i * 8, 8))).toString('hex')

/** addr_std without anycast in a stack slice; addr_none is null. */
export function stackAddress(entry) {
  const bits = stackBits(entry)
  if (!bits || bits.length < 2) return null
  if (bits[0] === 0 && bits[1] === 0) return null
  if (bits.length < 267 || bits[0] !== 1 || bits[1] !== 0 || bits[2] !== 0) return null
  let wc = int(bits, 3, 8)
  if (wc > 127) wc -= 256
  return wc === 0 || wc === -1 ? friendly({ wc, hash: hashOf(bits, 11) }) : null
}

/** DeDust Asset: native `0000`, jetton `0001 wc hash`. Returns 'native', a master address, or null. */
export function stackAsset(entry) {
  const bits = stackBits(entry)
  if (!bits || bits.length < 4) return null
  const tag = int(bits, 0, 4)
  if (tag === 0) return 'native'
  if (tag !== 1 || bits.length < 268) return null
  let wc = int(bits, 4, 8)
  if (wc > 127) wc -= 256
  return wc === 0 ? friendly({ wc, hash: hashOf(bits, 12) }) : null
}

function addressBits({ wc, hash }, prefix) {
  const bits = [...prefix]
  for (let i = 7; i >= 0; i--) bits.push(((wc & 0xff) >> i) & 1)
  for (const byte of Buffer.from(hash, 'hex')) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1)
  return bits
}

/** A one-cell bag of cells (no refs) for a `tvm.Slice` get-method argument. */
export function sliceBoc(bits) {
  const full = bits.length >> 3, size = Math.ceil(bits.length / 8)
  const data = new Uint8Array(size)
  bits.forEach((b, i) => { if (b) data[i >> 3] |= 0x80 >> (i & 7) })
  if (bits.length % 8) data[bits.length >> 3] |= 0x80 >> (bits.length & 7) // completion tag
  const cell = [0, full + size, ...data]
  return Buffer.from([0xb5, 0xee, 0x9c, 0x72, 0x01, 0x01, 1, 1, 0, cell.length, 0, ...cell]).toString('base64')
}

export const addressSlice = address => ['tvm.Slice', sliceBoc(addressBits(parseTon(address), [1, 0, 0]))]
export const assetSlice = asset => ['tvm.Slice', asset === 'native' ? sliceBoc([0, 0, 0, 0]) :
  sliceBoc(addressBits(parseTon(asset), [0, 0, 0, 1]))]
