import { createHash } from 'node:crypto'
import { decodeText, labels } from './text.js'

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'

function publicKey(address) {
  if (typeof address !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return null
  let n = 0n
  for (const c of address) n = n * 58n + BigInt(alphabet.indexOf(c))
  const bytes = Buffer.alloc(32)
  for (let i = 31; i >= 0; i--) { bytes[i] = Number(n & 255n); n >>= 8n }
  return !n && base58(bytes) === address ? bytes : null
}

function base58(bytes) {
  let n = BigInt('0x' + bytes.toString('hex')), digits = ''
  while (n) { digits = alphabet[Number(n % 58n)] + digits; n /= 58n }
  let leading = 0
  while (bytes[leading] === 0) leading++
  return '1'.repeat(leading) + digits
}

const prime = 2n ** 255n - 19n
const d = 37095705934669439343138083508754565189542113879843219016388785533085940283555n
function power(base, exponent) {
  let result = 1n
  while (exponent) {
    if (exponent & 1n) result = result * base % prime
    base = base * base % prime
    exponent >>= 1n
  }
  return result
}

// Solana PDAs must be off the Edwards25519 curve. A compressed y admits an x when
// (y²-1)/(d*y²+1) is a square. The Legendre symbol of a nonzero denominator equals its inverse's.
function onCurve(hash) {
  const encoded = BigInt('0x' + Buffer.from(hash).reverse().toString('hex'))
  const y = encoded & ((1n << 255n) - 1n)
  const square = y * y % prime
  const numerator = (square + prime - 1n) % prime, denominator = (d * square + 1n) % prime
  if (denominator === 0n) return false
  return numerator === 0n || power(numerator * denominator % prime, (prime - 1n) / 2n) === 1n
}

const program = publicKey(METAPLEX)
export function metadataPda(mint) {
  const key = publicKey(mint)
  if (!key) return null
  const seeds = createHash('sha256').update('metadata').update(program).update(key)
  for (let bump = 255; bump >= 0; bump--) {
    const hash = seeds.copy().update(Buffer.from([bump])).update(program).update('ProgramDerivedAddress').digest()
    if (!onCurve(hash)) return base58(hash)
  }
  return null
}

function accountBytes(account) {
  const [text, encoding] = Array.isArray(account?.data) ? account.data : []
  if (account?.executable !== false || encoding !== 'base64' || typeof text !== 'string' || text.length > 90_000) return null
  const bytes = Buffer.from(text, 'base64')
  return bytes.toString('base64') === text ? bytes : null
}

function strings(bytes, offset) {
  function next() {
    if (offset + 4 > bytes.length) return null
    const size = bytes.readUInt32LE(offset)
    offset += 4
    if (size > 4096 || offset + size > bytes.length) return null
    offset += size
    return decodeText(bytes.subarray(offset - size, offset))
  }
  return { name: next(), symbol: next() }
}

function inlineMetadata(bytes, key) {
  let start = 166
  while (start + 4 <= bytes.length) {
    const type = bytes.readUInt16LE(start), size = bytes.readUInt16LE(start + 2)
    start += 4
    if (start + size > bytes.length || (type === 0 && !size)) return null
    const field = bytes.subarray(start, start + size)
    if (type === 19) return field.subarray(32, 64).equals(key) ? strings(field, 64) : null
    start += size
  }
  return null
}

function mintName(address, mint, metadata, block) {
  const bytes = accountBytes(mint), key = publicKey(address), extended = mint?.owner === TOKEN_2022
  if (!bytes || !key || (!extended && mint.owner !== TOKEN) || bytes[45] !== 1 ||
      !(bytes.length === 82 || (extended && bytes[165] === 1))) return null
  const decimals = bytes[44]
  const inline = extended && labels(inlineMetadata(bytes, key), address)
  if (inline) return { ...inline, decimals, method: 'spl-token-2022', block }
  const pda = metadata?.owner === METAPLEX && accountBytes(metadata)
  if (pda && pda[0] === 4 && pda.subarray(33, 65).equals(key)) {
    const fields = labels(strings(pda, 65), address)
    if (fields) return { ...fields, decimals, method: 'metaplex', block }
  }
  return { decimals }
}

/** Mints and their PDAs share a single finalized RPC snapshot. Invalid addresses cannot poison a batch. */
export async function solanaNames(chain, assets, rpc) {
  const keys = [], indexes = []
  for (const { address } of assets) {
    const pda = metadataPda(address)
    indexes.push(pda ? keys.length : -1)
    if (pda) keys.push(address, pda)
  }
  if (!keys.length) return assets.map(() => null)
  const result = await rpc.call(chain.id, 'getMultipleAccounts', [keys, {
    commitment: 'finalized', encoding: 'base64', dataSlice: { offset: 0, length: 65_536 },
  }])
  const block = result?.context?.slot
  if (!Number.isSafeInteger(block) || block < 0 || !Array.isArray(result.value) || result.value.length !== keys.length)
    throw new Error('Invalid Solana metadata accounts')
  return indexes.map((i, n) => i < 0 ? null : mintName(assets[n].address, result.value[i], result.value[i + 1], block))
}
