import { multiRead } from '../evm-abi.js'
import { RateLimited } from '../../scheduler/index.js'
import { decodeText } from './text.js'

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
const selectors = ['0x06fdde03', '0x95d89b41', '0x313ce567', '0x18160ddd']
const isWord = raw => typeof raw === 'string' && /^0x[0-9a-f]{64}$/i.test(raw)

/** ABI string or the legacy single bytes32 word (MKR). Bound offsets and lengths before decoding. */
export function abiLabel(raw) {
  if (typeof raw !== 'string' || raw.length > 8322 || !/^0x(?:[0-9a-f]{64})+$/i.test(raw)) return null
  const bytes = Buffer.from(raw.slice(2), 'hex')
  if (bytes.length === 32) {
    let end = bytes.length
    while (end && !bytes[end - 1]) end--
    return decodeText(bytes.subarray(0, end))
  }
  if (bytes.length < 64 || BigInt(raw.slice(0, 66)) !== 32n) return null
  const size = Number(BigInt('0x' + raw.slice(66, 130)))
  if (size > 4096 || bytes.length !== 64 + 32 * Math.ceil(size / 32)) return null
  return decodeText(bytes.subarray(64, 64 + size))
}

export function abiDecimals(raw) {
  return isWord(raw) && BigInt(raw) <= 255n ? Number(BigInt(raw)) : null
}

/** A correctly decoded aggregate verifies the signed deployment on this chain, including zkSync's alternate
 * address. If the contract is absent or incompatible, resume single calls at the next available budget slot. */
export async function evmNames(chain, assets, rpc, reads, cooldown, now) {
  const valid = assets.map((asset, index) => ({ asset, index })).filter(({ asset }) => /^0x[0-9a-f]{40}$/i.test(asset.address))
  if (!valid.length) return assets.map(() => null)
  const calls = valid.flatMap(({ asset }) => selectors.map(data => ({ to: asset.address, data })))
  let values, processed = valid
  if (!reads.single && !(cooldown.get(chain.id) > now)) {
    try {
      values = await multiRead(rpc, { ...chain, multicall: chain.multicall ?? MULTICALL3 }, calls)
    } catch (error) {
      if (error instanceof RateLimited) throw error
      cooldown.set(chain.id, now + 15 * 60_000)
    }
  }
  if (!values) {
    // Commit the first token before taking another four single-call budget slots.
    processed = valid.slice(0, 1)
    values = reads.single ??= []
    while (values.length < selectors.length) {
      try { values.push(await rpc.call(chain.id, 'eth_call', [calls[values.length], 'latest'])) }
      catch (error) {
        if (error instanceof RateLimited) throw error
        values.push(null) // A reverting optional selector cannot hide successful fields.
      }
    }
  }
  const rows = Array(processed === valid ? assets.length : processed[0].index + 1).fill(null)
  for (const [i, { index }] of processed.entries()) {
    const [name, symbol, places, supply] = values.slice(4 * i, 4 * i + 4)
    const decimals = abiDecimals(places)
    rows[index] = { name: abiLabel(name), symbol: abiLabel(symbol), decimals, method: 'erc20',
      totalSupply: decimals !== null && decimals <= 77 && isWord(supply) ? Number(BigInt(supply)) / 10 ** decimals : null }
  }
  return rows
}
