import { decodeText } from './text.js'

function varint(value) {
  const bytes = []
  while (value >= 128) { bytes.push(value % 128 + 128); value = Math.floor(value / 128) }
  return [...bytes, value]
}

export function denomMetadataPath(denom) {
  if (!/^[A-Za-z][A-Za-z0-9/:._-]{1,127}$/.test(denom)) throw new Error('Invalid bank denom')
  const data = Buffer.from([10, ...varint(denom.length), ...Buffer.from(denom)]).toString('hex')
  return '/abci_query?path=%22%2Fcosmos.bank.v1beta1.Query%2FDenomMetadata%22&data=0x' + data
}

// Only varints and length-delimited fields occur in QueryDenomMetadataResponse, Metadata and DenomUnit.
function fields(bytes) {
  let pos = 0
  function readInt() {
    let value = 0
    for (let i = 0; i < 5 && pos < bytes.length; i++) {
      const byte = bytes[pos++]
      value += (byte & 127) * 128 ** i
      if (byte < 128) return value
    }
    throw new Error('Invalid bank metadata varint')
  }
  const result = new Map()
  while (pos < bytes.length) {
    const tag = readInt(), wire = tag % 8, field = Math.floor(tag / 8)
    if (!field || (wire !== 0 && wire !== 2)) throw new Error('Invalid bank metadata field')
    let value = readInt()
    if (wire === 2) {
      const end = pos + value
      if (end > bytes.length) throw new Error('Truncated bank metadata')
      value = bytes.subarray(pos, end)
      pos = end
    }
    if (!result.has(field)) result.set(field, [])
    result.get(field).push(value)
  }
  return result
}

export function bankName(payload, denom) {
  const reply = payload?.result?.response, raw = reply?.value
  if (reply?.code !== 0 || typeof raw !== 'string' || raw.length > 48_000) return null
  const bytes = Buffer.from(raw, 'base64')
  if (bytes.toString('base64') !== raw) return null
  const metadata = fields(fields(bytes).get(1)?.[0] ?? [])
  const text = (record, key) => decodeText(record.get(key)?.[0] ?? [])
  if (text(metadata, 3) !== denom) return null
  const display = text(metadata, 4), units = (metadata.get(2) ?? []).map(fields)
  const unit = units.find(u => text(u, 1) === display)
  return { name: text(metadata, 5), symbol: text(metadata, 6), decimals: unit ? (unit.get(2)?.[0] ?? 0) : null,
    method: 'cosmos-bank' }
}
