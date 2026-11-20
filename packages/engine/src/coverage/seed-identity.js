import { MARKET_POLICY } from '../../../store/src/markets.js'
import { address, field, multiRead, STATE_KINDS, ZERO } from '../sources/evm-abi.js'
import { seedProbesFor } from '../sources/evm.js'

const permitted = new WeakMap()
const asAddress = token => token === 'native' ? ZERO : token

/** Only a pair the independent signed-bundle seeder could generate may use a receipt-less identity hint. */
export function seedPair(source, hint) {
  if (!STATE_KINDS.includes(hint.kind)) return false
  let tokens = permitted.get(source)
  if (!tokens) {
    tokens = new Set(source.registry.catalog.assets.filter(a => a.chain === source.chain.id && address(a.address))
      .map(a => a.address))
    for (const quote of source.quotes.keys()) tokens.add(quote)
    permitted.set(source, tokens)
  }
  const a = asAddress(hint.token0), b = asAddress(hint.token1)
  const native = a === ZERO && hint.kind === 'v4' && hint.token0 === 'native'
  return a < b && (native || tokens.has(a)) && tokens.has(b) &&
    (native || source.quotes.has(a) || source.quotes.has(b))
}

/** A receipt-less announcement is only a lookup key. Reconstruct the public factory mapping or V4 key
 * at one block and run the ordinary funded-state decoder before registering the identity. */
export async function verifySeedIdentity(source, hint, rpc, cache) {
  if (!seedPair(source, hint)) return false
  const probes = seedProbesFor(source, hint)
  if (!probes.length) return false
  if (!cache.has('block')) {
    const head = await rpc.call(hint.chain, 'eth_blockNumber', [])
    if (!/^0x[\da-f]+$/i.test(head) || !Number.isSafeInteger(Number(head))) return null
    cache.set('block', head)
  }
  const read = async calls => {
    const key = JSON.stringify(calls)
    if (!cache.has(key)) cache.set(key, await multiRead(rpc, source.chain, calls, cache.get('block')))
    return cache.get(key)
  }
  const values = await read(probes.map(p => p.call))
  const match = probes.find((p, i) => p.kind === 'v4'
    ? BigInt.asUintN(160, field(values[i], 0) ?? 0n) !== 0n : address(values[i]) === hint.pool)
  if (!match) return values.some(v => v == null) ? null : false
  if (match.kind === 'v4') match.slot0 = values[probes.indexOf(match)]
  const candidate = { ...match, chain: hint.chain, pool: hint.pool, firstSeen: source.clock() }
  const [state] = await source.snapshots([candidate], read)
  if (!(state?.liquidity >= MARKET_POLICY.minPoolLiquidityUsd)) return null
  candidate.liquidity = state.liquidity
  return source.store.transaction(() => {
    // A local creation may have completed while the public reads were in flight.
    if (source.registry.markets.has('dex:' + hint.chain + ':' + hint.pool)) return true
    const market = source.registry.pool(candidate, { token0: source.metadata(hint.token0),
      token1: source.metadata(hint.token1) }, true)
    if (!market) return false
    source.saveParameters(candidate)
    return true
  })
}

/** Hold at most one valid, already-proven quote per unknown market while its independent identity check runs. */
export class PendingDexQuotes {
  rows = new Map()
  constructor(engine) { this.engine = engine }
  remember(reporter, rows, digest) {
    const { book, clock } = this.engine
    if (!book.isProven(reporter)) return
    for (const row of rows) {
      if (!row[0].startsWith('dex:')) continue
      const previous = this.rows.get(row[0])
      if (previous?.row[6] >= row[6]) continue
      this.rows.delete(row[0])
      if (this.rows.size >= 128) this.rows.delete(this.rows.keys().next().value)
      this.rows.set(row[0], { reporter, row, digest, expires: clock() + 300_000 })
    }
  }
  flush(market) {
    const { book, clock, obs, registry } = this.engine
    const rows = market ? [[market, this.rows.get(market)]] : this.rows
    for (const [id, q] of rows) {
      if (!q) continue
      if (q.expires > clock() && q.digest === obs?.digest) {
        if (!registry.markets.has(id)) continue
        if (book.isProven(q.reporter)) book.ingest(q.reporter, [q.row], false)
      }
      this.rows.delete(id)
    }
  }
}
