import { decodeEvent, multiRead, ZERO } from './evm-abi.js'
import { resolveCurveCreations } from './curve.js'
import { RateLimited } from '../scheduler/index.js'
import { creationReceipt, hintFactory } from './tron/events.js'
import { solanaPair } from './solana.js'

const CAPACITY = 128
const MINUTE = 60_000
const solAddress = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)
const evmToken = value => typeof value === 'string' && (value === 'native' || /^0x[0-9a-f]{40}$/i.test(value))

/** Bounded discovery work. Admission uses the sender's standing on this node.
 * A missing receipt or a conflicting identity lowers that sender's future priority.
 * Endpoint failures do not count against the sender. */
export class PoolHints {
  constructor({ book, clock, evm, registry, rpc, http, catalog, onConfirmed }) {
    Object.assign(this, { book, clock, evm, registry, rpc, http, catalog, onConfirmed })
    this.pending = new Map()
    this.penalties = new Map()
  }
  get size() {
    return this.pending.size
  }
  rank(reporter) {
    const penalty = this.penalties.get(reporter)
    const faults = penalty && penalty.expires > this.clock() ? penalty.count : 0
    return this.book.hintStanding(reporter) - 4 * faults
  }
  candidate(msg, reporter) {
    const { chain, dex, kind, block } = msg
    let { pool, token0, token1, tx } = msg
    if (typeof dex !== 'string' || dex.length > 96 || typeof kind !== 'string' || kind.length > 64) return
    if (this.evm.has(chain)) {
      if (!this.evm.get(chain).chain.deployments.some(d => d.name === dex && d.kind === kind)) return
      if (typeof tx !== 'string' || !/^0x[0-9a-f]{64}$/i.test(tx) || typeof pool !== 'string' ||
          !/^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(pool) || ![token0, token1].every(evmToken) ||
          !Number.isSafeInteger(block) || block < 0) return
      pool = pool.toLowerCase()
      token0 = token0.toLowerCase()
      token1 = token1.toLowerCase()
      tx = tx.toLowerCase()
    } else if (chain === 'tron' && this.tron) {
      if (!hintFactory(msg)) return
    } else if (this.registry.chains.get(chain)?.family !== 'solana' || !['raydium', 'orca', 'meteora'].includes(dex) ||
               ![pool, token0, token1].every(solAddress)) return
    if (token0 === token1 || this.registry.markets.has('dex:' + chain + ':' + pool)) return
    const key = chain + ':' + pool
    const priority = this.rank(reporter)
    return { key, chain, pool, token0, token1, dex, kind, tx, block, reporter, priority,
      expires: this.clock() + 5 * MINUTE }
  }
  receive(msg, reporter) {
    const hint = this.candidate(msg, reporter)
    if (!hint) return
    const { key, priority } = hint
    const previous = this.pending.get(key)
    if (previous && priority <= previous.priority) return
    if (!previous && this.pending.size >= CAPACITY) {
      let weakest
      for (const entry of this.pending.values())
        if (!weakest || entry.priority < weakest.priority) weakest = entry
      if (weakest.priority > priority) return
      this.pending.delete(weakest.key)
    }
    this.pending.set(key, hint)
  }
  penalize(reporter) {
    const previous = this.penalties.get(reporter), now = this.clock()
    const count = Math.min(8, 1 + (previous && previous.expires > now ? previous.count : 0))
    this.penalties.delete(reporter)
    if (this.penalties.size >= 4096) this.penalties.delete(this.penalties.keys().next().value)
    this.penalties.set(reporter, { count, expires: now + 60 * MINUTE })
    const priority = this.rank(reporter)
    for (const entry of this.pending.values()) if (entry.reporter === reporter) entry.priority = priority
  }
  /** Older registry rows can carry a swap receipt used to identify a pool. Only a matching
   * factory creation or manager Initialize is eligible for periodic re-announcement. */
  async hasCreationReceipt(row, rpc = this.rpc) {
    const { chain, pool, tx, block } = row
    if (chain === 'tron' && this.tron) return !!creationReceipt(row, await this.tron.client.receipt(tx))
    const source = this.evm.get(chain)
    if (!source) return false
    const receipt = await rpc.call(chain, 'eth_getTransactionReceipt', [tx])
    if (receipt?.status !== '0x1' || receipt.transactionHash?.toLowerCase() !== tx ||
        Number(receipt.blockNumber) !== block || !/^0x[0-9a-f]{64}$/i.test(receipt.blockHash) ||
        !Array.isArray(receipt.logs) || receipt.logs.length > 1024) return false
    const events = []
    for (const log of receipt.logs) {
      const event = source.chain.events[log?.topics?.[0]]
      if (!event || typeof log.address !== 'string' || log.transactionHash?.toLowerCase() !== tx || log.blockHash !== receipt.blockHash ||
          Number(log.blockNumber) !== block) continue
      const deployment = source.deployment(log.address?.toLowerCase(), event)
      if (deployment?.name !== row.dex || deployment.kind !== row.kind) continue
      const swap = decodeEvent(log, event)
      if (swap?.type === 'curve-deployment' || (swap?.type === 'pool' && swap.pool === pool))
        events.push({ swap, event, log })
    }
    if (!events.length) return false
    await resolveCurveCreations(events, block, (calls, at) => multiRead(rpc, source.chain, calls, '0x' + at.toString(16)))
    const currency = address => address === ZERO ? 'native' : address
    return events.some(({ swap }) => swap.type === 'pool' && swap.pool === pool &&
      currency(swap.token0) === row.token0 && currency(swap.token1) === row.token1)
  }
  async solana(hint) {
    const api = this.catalog.apis.find(a => a.id === 'dexscreener')
    if (!api) return null
    const pair = await solanaPair(api, this.http, hint)
    if (!pair) return false
    // The directory verifies the identity; it supplies no creation transaction to announce.
    return !!this.registerSolanaPair(hint, pair)
  }
  registerSolanaPair(hint, pair) {
    const info = new Map([pair.baseToken, pair.quoteToken].map(t => [t.address, t]))
    const { chain, pool, dex, token0, token1 } = hint
    const discovery = { chain, pool, dex, token0, token1, kind: 'pool', firstSeen: this.clock() }
    return this.registry.pool(discovery, { token0: info.get(token0), token1: info.get(token1) }, true)
  }
  async verifyNext() {
    if (this.busy) return
    let best
    for (const hint of this.pending.values()) {
      if (hint.expires <= this.clock() || this.book.muted(hint.reporter) || this.registry.markets.has('dex:' + hint.key)) {
        this.pending.delete(hint.key)
        continue
      }
      hint.priority = this.rank(hint.reporter)
      if (!best || hint.priority > best.priority) best = hint
    }
    if (!best) { this.work = null; return }
    this.busy = true
    if (this.work?.hint !== best) this.work = { hint: best, cache: new Map() }
    let retry = false
    try {
      if (best.chain === 'tron' && this.tron) {
        if (await this.tron.verify(best, this.work.cache) === false) this.penalize(best.reporter)
        return
      }
      const source = this.evm.get(best.chain)
      const result = source ? await source.verifyPoolHint(best, this.rpc, this.work.cache) : await this.solana(best)
      if (result === false) this.penalize(best.reporter)
      else if (source && result) this.onConfirmed(result)
    } catch (error) {
      retry = error instanceof RateLimited
      throw error
    } finally {
      if (!retry || this.pending.get(best.key) !== best) {
        if (this.pending.get(best.key) === best) this.pending.delete(best.key)
        this.work = null
      }
      this.busy = false
    }
  }
}
