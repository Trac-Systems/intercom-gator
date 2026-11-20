import { REF, nearToken, refKey, USDC, USDT } from './identity.js'
import { decimal } from '../../obs/index.js'
import { registerDexJob } from '../dex-jobs.js'
import { labels, validDecimals } from '../names/text.js'
import { FamilyClient, FamilyDex, reserveState } from '../family-dex.js'

export { REF, WNEAR, USDC, USDT, nearToken, refKey, refId } from './identity.js'

const MINUTE = 60_000, HOUR = 3_600_000
const PAGE = 250, BATCH = 48
// The signed NEAR endpoints publish no keyless limit; each host bucket uses the engine default (6/min per host) and
// the reader rotates over the three signed hosts.
const SHARES = { small: 4, normal: 10, large: 15 }
const ANSWERS = new Set(['CONTRACT_EXECUTION_ERROR', 'UNKNOWN_ACCOUNT', 'NO_CONTRACT_CODE', 'INVALID_ACCOUNT'])

/** NEAR JSON-RPC view calls at the final block. */
export class NearClient extends FamilyClient {
  constructor(engine) { super(engine, { chain: 'near', protocol: 'near-jsonrpc', shares: SHARES, rotate: true }) }
  async view(account_id, method_name, args = {}) {
    const body = { jsonrpc: '2.0', id: 'gator', method: 'query', params: { request_type: 'call_function', finality: 'final',
      account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }
    const json = await this.request('', body)
    const r = json?.result
    if (json?.error || !Array.isArray(r?.result)) {
      const error = new Error('NEAR view failed: ' + method_name)
      // A contract that panics (missing method, bad args) or a missing account is an answer, not an endpoint failure.
      if (r?.error || ANSWERS.has(json?.error?.cause?.name)) error.answer = true
      throw error
    }
    return { block: r.block_height, value: JSON.parse(Buffer.from(r.result).toString('utf8')) }
  }
}

/** Constant-product state of a two-token Ref pool, in pool token order. */
export function refState(pool, decimals) {
  if (pool?.pool_kind !== 'SIMPLE_POOL' || pool.token_account_ids?.length !== 2 || pool.amounts?.length !== 2) return null
  if (!pool.amounts.every(a => typeof a === 'string' && /^\d{1,60}$/.test(a))) return null
  return reserveState(pool.amounts[0], pool.amounts[1], decimals[0], decimals[1])
}

export function ftInfo(value, address) {
  const decimals = value?.decimals
  if (!validDecimals(decimals) || decimals > 32) return null
  return { ...(labels({ name: value.name, symbol: value.symbol }, address) ?? {}), decimals }
}

/** Ref Finance v2 classic pools through one budgeted job: directory paging, metadata and batched state. */
export class NearSource extends FamilyDex {
  constructor(engine, client = new NearClient(engine)) {
    super(engine, 'near', { anchors: { [USDT]: 1, [USDC]: 1 } })
    this.client = client
    this.tasks = [() => this.state(), () => this.pages(), () => this.meta(), () => this.pages(), () => this.volumes()]
    this.volumeDue = engine.store.writer.prepare(`SELECT * FROM engine_family_candidates WHERE chain='near' AND funded=1
      ORDER BY coalesce(json_extract(extra,'$.volAt'),0), pool LIMIT 1`)
    this.needMeta = engine.store.writer.prepare(`SELECT token0, token1 FROM engine_family_candidates WHERE chain='near' AND stage=1 AND due<=?
      ORDER BY due LIMIT 64`)
  }
  /**
   * Directory pass over `get_pools`: a durable index pages the whole list every six hours, then polls the tail so a
   * pool created after the pass is checked within minutes. Pools whose priced side shows $10k of depth are queued.
   */
  async pages() {
    const now = this.engine.clock()
    const cursor = this.setting('pages') ?? { index: 0, tail: null }
    if (cursor.wait > now) return false
    const full = cursor.tail == null || cursor.next <= now
    const from = full ? cursor.index : cursor.tail
    // Pools against wNEAR need NEAR's USD price. A pass that started without it repeats once a price exists.
    const native = (from === 0 && full ? true : cursor.native ?? true) && this.usd('native') != null
    const { value } = await this.client.view(REF, 'get_pools', { from_index: from, limit: PAGE })
    if (!Array.isArray(value) || value.length > PAGE) throw new Error('Invalid Ref pool page')
    this.engine.store.transaction(() => {
      value.forEach((pool, i) => this.consider(from + i, pool, now, !full || (cursor.tail != null && from + i >= cursor.tail)))
      const end = from + value.length
      if (!full) this.save('pages', { ...cursor, tail: end, wait: now + 2 * MINUTE })
      else if (value.length === PAGE) this.save('pages', { ...cursor, index: end, native })
      // Pass complete: the tail starts at the current pool count; the next full pass refreshes depth for old pools.
      else this.save('pages', { index: 0, tail: Math.max(end, cursor.tail ?? 0), next: now + (native ? 6 * HOUR : 2 * MINUTE),
        wait: now + 2 * MINUTE })
    })
    return true
  }
  consider(id, pool, now, isNew) {
    if (pool?.pool_kind !== 'SIMPLE_POOL' || pool.token_account_ids?.length !== 2) return
    const [token0, token1] = pool.token_account_ids.map(nearToken)
    if (!token0 || !token1 || token0 === token1) return
    const p = { pool: refKey(id), ref: String(id), dex: 'ref-finance', kind: 'v2', token0, token1 }
    const decimals = [this.decimals(token0), this.decimals(token1)]
    // A side with known decimals and a USD price measures depth before any metadata read.
    const values = [token0, token1].map((t, i) => {
      const usd = this.usd(t)
      return usd && decimals[i] != null && /^\d{1,60}$/.test(pool.amounts?.[i] ?? '') ?
        Number(BigInt(pool.amounts[i])) / 10 ** decimals[i] * usd : null
    }).filter(v => v != null)
    if (!values.length || 2 * Math.max(...values) < 10_000) return
    this.remember({ ...p, firstSeen: now, stage: 1, isNew })
  }
  async meta() {
    const now = this.engine.clock()
    const missing = this.needMeta.all(now).flatMap(r => [r.token0, r.token1])
      .find(t => t && this.decimals(t) == null && !(this.setting('meta-fail/' + t) > now))
    if (!missing) return false
    let info = null
    try { info = ftInfo((await this.client.view(missing, 'ft_metadata')).value, missing) }
    catch (error) { if (!error.answer) throw error }
    if (info) this.save('meta/' + missing, info)
    else this.save('meta-fail/' + missing, now + 24 * HOUR)
    return true
  }
  async state(pool) {
    const now = this.engine.clock()
    const rows = (pool ? [this.candidate(pool)].filter(Boolean) : this.verifiedDue.all('near', now, BATCH * 2)
      .map(r => ({ ...r, extra: JSON.parse(r.extra) })))
      .filter(r => this.decimals(r.token0) != null && this.decimals(r.token1) != null).slice(0, BATCH)
    if (!rows.length) return false
    const { value } = await this.client.view(REF, 'get_pool_by_ids', { pool_ids: rows.map(r => Number(r.ref)) })
    if (!Array.isArray(value) || value.length !== rows.length) throw new Error('Invalid Ref pool batch')
    const at = this.engine.clock()
    this.measure(rows.map((p, i) => {
      const ids = value[i]?.token_account_ids?.map(nearToken)
      // The contract's own token list must still match the queued identity.
      if (ids?.[0] !== p.token0 || ids?.[1] !== p.token1) return { p, at }
      const info = { token0: this.info(p.token0), token1: this.info(p.token1) }
      return { p, at, info, state: refState(value[i], [info.token0.decimals, info.token1.decimals]) }
    }))
    return true
  }
  /**
   * Ref keeps cumulative swap amounts keyed by the input token (`get_pool_volumes`: entry i = token i paid in and the
   * other token paid out, since creation). Base turnover = growth of the base token's `input` plus the quote's
   * `output`. Samples at least 15 minutes apart are kept for 24 hours; a younger window (fresh node or pool) is a
   * lower bound, as with partial EVM swap windows.
   */
  async volumes() {
    const now = this.engine.clock()
    const row = this.volumeDue.get()
    const p = row && { ...row, extra: JSON.parse(row.extra) }
    if (!p || (p.extra.volAt ?? 0) > now - 15 * MINUTE) return false
    const { value } = await this.client.view(REF, 'get_pool_volumes', { pool_id: Number(p.ref) })
    const cum = Array.isArray(value) && value.length === 2 && value.every(v => /^\d{1,60}$/.test(v?.input ?? '') &&
      /^\d{1,60}$/.test(v?.output ?? '')) ? value.flatMap(v => [String(BigInt(v.input)), String(BigInt(v.output))]) : null
    const fresh = this.candidate(p.pool)
    if (!fresh) return true
    const samples = (fresh.extra.vol ?? []).filter(s => s[0] >= now - 24 * HOUR)
    // A counter that moved backwards is not this pool's history (contract change): restart the window.
    if (cum && samples.length && cum.some((c, i) => BigInt(c) < BigInt(samples.at(-1)[i + 1]))) samples.length = 0
    if (cum) samples.push([now, ...cum])
    this.setExtra.run(JSON.stringify({ ...fresh.extra, vol: samples.slice(-160), volAt: now }), 'near', p.pool)
    return true
  }
  turnover(p, market) {
    const samples = this.candidate(p.pool)?.extra.vol ?? []
    if (samples.length < 2) return '0'
    const side = market.inverse ? 1 : 0, token = side ? p.token1 : p.token0, places = this.decimals(token)
    // Sample layout: [at, in0, out0, in1, out1]; base paid in + base paid out (recorded under the other token).
    const total = s => BigInt(s[1 + 2 * side]) + BigInt(s[2 + 2 * (1 - side)])
    const diff = total(samples.at(-1)) - total(samples[0])
    return places == null || diff <= 0n ? '0' : decimal(Number(diff) / 10 ** places)
  }
}

export function registerNear(engine) {
  const client = new NearClient(engine)
  if (!client.endpoint) return null
  return registerDexJob('near', new NearSource(engine, client))
}
