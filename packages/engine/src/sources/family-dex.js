import { MARKET_POLICY } from '../../../store/src/markets.js'
import { RateLimited } from '../scheduler/index.js'
import { runDexTasks } from './dex-jobs.js'
import { rateLimit } from './bundle-adapter.js'
import { decimal } from '../obs/index.js'

const MINUTE = 60_000, DAY = 86_400_000

/**
 * Budgeted public reads for one non-EVM DEX family. Each dispatch charges the reader's own share (requests/minute by
 * profile, at most one twelfth of a lowered node budget), the shared host bucket (half the documented limit) and the
 * node budget. 403/429 pause the host with exponential backoff and honor a longer Retry-After. With several signed
 * endpoints, a failing endpoint yields to the next for a cooldown.
 */
export class FamilyClient {
  /** @param {any} engine @param {{ chain: string, protocol: string, shares: Record<string, number>, limits?: (e: any) => number, rotate?: boolean }} options */
  constructor(engine, { chain, protocol, shares, limits, rotate = false }) {
    this.engine = engine
    this.chain = chain
    this.protocol = protocol
    this.shares = shares
    this.limits = limits ?? (e => rateLimit(e.limits))
    this.next = 0
    this.refusals = 0
    this.down = new Map() // endpoint url -> retry time
    this.calls = 0
    this.rotate = rotate // spread reads over every healthy signed endpoint (separate host buckets)
    this.cursor = 0
  }
  get endpoints() {
    return this.engine.bundle.chains.find(c => c.id === this.chain)?.endpoints
      .filter(e => e.protocol === this.protocol && e.verified?.ok !== false) ?? []
  }
  get endpoint() {
    const now = this.engine.clock(), list = this.endpoints
    const healthy = list.filter(e => (this.down.get(e.url) ?? 0) <= now)
    if (this.rotate && healthy.length) return healthy[this.cursor % healthy.length]
    return healthy[0] ?? list[0]
  }
  get rpm() {
    const { budget, profile } = this.engine
    return Math.min(this.shares[profile] ?? this.shares.normal, budget.limit / 12)
  }
  /** One upstream request through the reader share. `url` may be absolute (another public host). */
  async request(path, body = null, { url, rpm } = {}) {
    const { http, clock } = this.engine
    const now = clock()
    const endpoint = url ? null : this.endpoint
    if (!url && !endpoint) throw new Error(this.chain + ' endpoint unavailable in active bundle')
    if (now < this.next) throw new RateLimited(this.next)
    this.next = now + Math.ceil(MINUTE / this.rpm)
    const target = url ?? endpoint.url + path
    if (!url) this.cursor++
    try {
      this.calls++
      const json = await http.getPublic(target, rpm ?? this.limits(endpoint), 1, body)
      this.refusals = Math.max(0, this.refusals - 1)
      return json
    } catch (error) {
      if (error instanceof RateLimited) this.next = error.retryAt // Nothing left the process.
      else if ([403, 429].includes(error.status) || error.status >= 500 || error.name === 'TimeoutError') {
        const refused = [403, 429].includes(error.status)
        const pause = Math.max((error.retryAfter ?? 0) * 1000, MINUTE * 2 ** Math.min(5, this.refusals++))
        const bucket = http.hosts.get(new URL(target).origin)
        if (bucket && refused) bucket.next = Math.max(bucket.next ?? 0, clock() + pause)
        if (endpoint && this.endpoints.length > 1) this.down.set(endpoint.url, clock() + pause)
        else if (refused) this.next = clock() + pause
      }
      throw error
    }
  }
}

/**
 * Shared candidate queue, USD depth and publication for TON and NEAR DEX readers. Pools use the `0x<64 hex>` market
 * key (`dex:<chain>:0x…`) so the v1 wire pattern accepts the market; `ref` keeps the venue's own pool reference.
 */
export class FamilyDex {
  /** @param {any} engine @param {string} chain @param {{ wrapped?: (a: string) => boolean, anchors?: Record<string, number> }} [options] */
  constructor(engine, chain, { anchors = {} } = {}) {
    this.engine = engine
    this.chain = chain
    this.anchors = anchors
    this.turn = 0
    this.settingsPrefix = 'engine-' + chain + '/'
    const db = engine.store.writer
    this.upsert = db.prepare(`INSERT INTO engine_family_candidates(chain,pool,dex,kind,ref,token0,token1,firstSeen,due,funded,stage,isNew,extra)
      VALUES (?,?,?,?,?,?,?,?,0,0,?,?,?) ON CONFLICT(chain,pool) DO UPDATE SET
      firstSeen=min(firstSeen,excluded.firstSeen), isNew=max(isNew,excluded.isNew),
      token0=CASE WHEN token0='' THEN excluded.token0 ELSE token0 END,
      token1=CASE WHEN token1='' THEN excluded.token1 ELSE token1 END,
      extra=CASE WHEN extra='{}' THEN excluded.extra ELSE extra END`)
    this.get = db.prepare('SELECT * FROM engine_family_candidates WHERE chain=? AND pool=?')
    // Seeds and directory rows (likely funded) alternate with fresh creations (often empty launches).
    this.pending = db.prepare(`SELECT * FROM engine_family_candidates WHERE chain=?1 AND stage=0 AND due<=?2
      ORDER BY isNew=?4 DESC,due,firstSeen DESC LIMIT ?3`)
    this.verifiedDue = db.prepare('SELECT * FROM engine_family_candidates WHERE chain=? AND stage=1 AND due<=? ORDER BY funded DESC,due,pool LIMIT ?')
    this.count = db.prepare('SELECT count(*) AS n FROM engine_family_candidates WHERE chain=? AND stage=0 AND due<=?')
    this.setStage = db.prepare('UPDATE engine_family_candidates SET stage=?,token0=?,token1=?,extra=?,due=? WHERE chain=? AND pool=?')
    this.setDue = db.prepare('UPDATE engine_family_candidates SET due=?,funded=? WHERE chain=? AND pool=?')
    this.setExtra = db.prepare('UPDATE engine_family_candidates SET extra=? WHERE chain=? AND pool=?')
    this.price = db.prepare('SELECT priceReal,trust FROM prices WHERE asset=? AND at>=? AND priceReal>0')
    this.known = db.prepare('SELECT * FROM pools WHERE chain=? AND pool=?')
    this.depth = db.prepare('UPDATE pools SET liquidity=? WHERE chain=? AND pool=?')
    this.trim = db.prepare(`DELETE FROM engine_family_candidates WHERE chain=?1 AND funded=0 AND pool IN (
      SELECT pool FROM engine_family_candidates WHERE chain=?1 AND funded=0 AND due>0 ORDER BY firstSeen DESC,pool LIMIT -1 OFFSET 4096)`)
  }
  remember(p) {
    this.upsert.run(this.chain, p.pool, p.dex, p.kind, p.ref, p.token0 ?? '', p.token1 ?? '', p.firstSeen,
      p.stage ?? 0, Number(!!p.isNew), JSON.stringify(p.extra ?? {}))
  }
  candidate(pool) {
    const row = this.get.get(this.chain, pool)
    return row && { ...row, extra: JSON.parse(row.extra) }
  }
  verified(p, token0, token1, extra = p.extra) {
    this.setStage.run(1, token0, token1, JSON.stringify(extra ?? {}), 0, this.chain, p.pool)
    return { ...p, token0, token1, extra, stage: 1 }
  }
  reject(p, minutes = 24 * 60) {
    this.setDue.run(this.engine.clock() + minutes * MINUTE, 0, this.chain, p.pool)
  }
  run() { return runDexTasks(this) }
  setting(key) { return this.engine.store.getSetting(this.settingsPrefix + key) }
  save(key, value) { this.engine.store.setSetting(this.settingsPrefix + key, value) }
  assetId(address) { return this.chain + ':' + address }
  /** USD per whole token, or null. Red prices do not value pools; stablecoin anchors cover a cold start. */
  usd(address) {
    const p = this.price.get(this.assetId(address), this.engine.clock() - MARKET_POLICY.maxPriceAge)
    if (p) return p.trust === 'red' ? null : p.priceReal
    return this.anchors[address] ?? null
  }
  info(address) {
    const asset = this.engine.registry.assets.get(this.assetId(address))
    return asset?.decimals != null ? asset : this.setting('meta/' + address)
  }
  decimals(address) { return this.info(address)?.decimals ?? null }
  /** Two-sided depth: both sides of a constant-product pool hold equal value at the pool price. */
  liquidity(p, state) {
    if (!state) return null
    if (state.empty) return 0
    const a = this.usd(p.token0), b = this.usd(p.token1)
    if (!a && !b) return null
    return 2 * Math.min(state.reserve0 * (a || state.price * b), state.reserve1 * (b || a / state.price))
  }
  /**
   * @param {Array<{ p: any, state?: { reserve0: number, reserve1: number, price: number, empty?: boolean }, info?: any, at: number }>} readings
   */
  measure(readings) {
    const { registry, store, clock } = this.engine
    const rows = [], discoveries = [], now = clock()
    store.transaction(() => {
      for (const { p, state, info, at } of readings) {
        const known = this.known.get(this.chain, p.pool)
        const liquidity = this.liquidity(p, state)
        if (!Number.isFinite(liquidity) || liquidity < MARKET_POLICY.minPoolLiquidityUsd) {
          if (known && Number.isFinite(liquidity)) this.depth.run(liquidity, this.chain, p.pool)
          const retry = liquidity == null ? 30 : now - p.firstSeen > DAY ? 360 : 30
          this.setDue.run(now + retry * MINUTE, 0, this.chain, p.pool)
          continue
        }
        const discovery = { chain: this.chain, pool: p.pool, dex: p.dex, kind: p.kind, token0: p.token0,
          token1: p.token1, block: null, tx: null, firstSeen: p.firstSeen, liquidity }
        const market = registry.pool(discovery, info ?? {})
        if (!market) {
          this.setDue.run(now + DAY, 0, this.chain, p.pool)
          continue
        }
        this.setDue.run(now + this.refresh(p), 1, this.chain, p.pool)
        if (!known && p.isNew) discoveries.push(discovery)
        else if (known) this.depth.run(liquidity, this.chain, p.pool)
        rows.push([market.id, decimal(market.inverse ? 1 / state.price : state.price), this.turnover(p, market), null, null, null, at])
      }
      this.trim.run(this.chain)
    })
    // Old pools found by a seed or a directory pass have no creation time; only fresh creations enter the New list.
    for (const d of discoveries) this.engine.discovery(d, false)
    if (rows.length) this.engine.publish(rows)
    return rows
  }
  refresh() { return 2 * MINUTE }
  /** Base-token turnover in the rolling window; '0' where the venue exposes no cheap swap counter. */
  turnover() { return '0' }
}

/** Constant-product state from integer reserves. */
export function reserveState(raw0, raw1, decimals0, decimals1) {
  if (decimals0 == null || decimals1 == null) return null
  const r0 = Number(BigInt(raw0)) / 10 ** decimals0, r1 = Number(BigInt(raw1)) / 10 ** decimals1
  if (!(r0 > 0) || !(r1 > 0)) return { empty: true, reserve0: 0, reserve1: 0, price: 0 }
  return { reserve0: r0, reserve1: r1, price: r1 / r0 }
}
