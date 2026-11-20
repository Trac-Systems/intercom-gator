import { MARKET_POLICY } from '../../../../store/src/markets.js'
import { registerDexJob, runDexTasks } from '../dex-jobs.js'
import { decimal } from '../../obs/index.js'
import { TronClient } from './client.js'
import { FACTORIES, USDT, WTRX } from './deployments.js'
import { creationReceipt, eventPath, parsePage } from './events.js'
import { lookup, lookupAddress, seedPlan, snapshots } from './state.js'

const MINUTE = 60_000, DAY = 86_400_000
const SETTING = 'engine-tron/'
const BATCH = 6

/** Factory lookup, event windows and funded pool state all use one scheduler slot and request share. */
export class TronSource {
  constructor(engine, client = new TronClient(engine)) {
    this.engine = engine
    this.client = client
    this.plan = seedPlan(engine.catalog.assets)
    this.turn = 0
    this.stateBatch = BATCH
    this.tasks = [
      () => this.seed(), () => this.state(), () => this.events(FACTORIES[0]), () => this.events(FACTORIES[1]),
      () => this.events(FACTORIES[1], true), () => this.events(FACTORIES[0], true),
    ]
    const db = engine.store.writer
    this.remember = db.prepare(`INSERT INTO engine_tron_candidates(pool,dex,kind,token0,token1,fee,block,tx,firstSeen,due,fromHint)
      VALUES (?,?,?,?,?,?,?,?,?,0,?) ON CONFLICT(pool) DO UPDATE SET
      due=CASE WHEN tx IS NULL AND excluded.tx IS NOT NULL THEN 0 ELSE due END,
      block=coalesce(block,excluded.block),tx=coalesce(tx,excluded.tx),
      firstSeen=min(firstSeen,excluded.firstSeen),fromHint=min(fromHint,excluded.fromHint)
      WHERE dex=excluded.dex AND token0=excluded.token0 AND token1=excluded.token1 AND fee=excluded.fee`)
    this.due = db.prepare('SELECT * FROM engine_tron_candidates WHERE due<=? ORDER BY due,pool LIMIT ?')
    this.fundedDue = db.prepare('SELECT * FROM engine_tron_candidates WHERE funded=1 AND due<=? ORDER BY due,pool LIMIT ?')
    this.backlog = db.prepare('SELECT count(*) AS n FROM engine_tron_candidates WHERE due=0')
    this.candidate = db.prepare('SELECT * FROM engine_tron_candidates WHERE pool=?')
    this.update = db.prepare('UPDATE engine_tron_candidates SET due=?, funded=? WHERE pool=?')
    this.price = db.prepare('SELECT priceReal,trust FROM prices WHERE asset=? AND at>=? AND priceReal>0')
    this.pool = db.prepare("SELECT * FROM pools WHERE chain='tron' AND pool=?")
    this.depth = db.prepare("UPDATE pools SET liquidity=? WHERE chain='tron' AND pool=?")
    this.trim = db.prepare(`DELETE FROM engine_tron_candidates WHERE funded=0 AND pool IN (
      SELECT pool FROM engine_tron_candidates WHERE funded=0 AND due>0 ORDER BY firstSeen DESC,pool LIMIT -1 OFFSET 512)`)
  }
  rememberPool(p, fromHint = false) {
    this.remember.run(p.pool, p.dex, p.kind, p.token0, p.token1, p.fee, p.block ?? null, p.tx ?? null,
      p.firstSeen, Number(fromHint))
  }
  async seed() {
    const { clock, store } = this.engine
    const cursor = store.getSetting(SETTING + 'seed') ?? { index: 0 }
    if (cursor.next > clock()) return false
    const batch = this.plan.slice(cursor.index, cursor.index + 20)
    const { values } = await this.client.aggregate(batch.map(lookup))
    const matches = batch.map((p, i) => ({ ...p, pool: lookupAddress(values[i]), firstSeen: clock() }))
    const nextIndex = cursor.index + batch.length
    store.transaction(() => {
      for (const p of matches) if (p.pool) this.rememberPool(p)
      // A complete pass includes every zero address; don't probe absent pairs again for six hours.
      store.setSetting(SETTING + 'seed', nextIndex < this.plan.length ? { index: nextIndex } :
        { index: 0, next: clock() + 6 * 3600_000 })
    })
    return true
  }
  async events(factory, history = false) {
    const { clock, store } = this.engine, now = clock()
    const key = SETTING + factory.dex + (history ? '/history' : '')
    const recent = now - 7 * DAY
    const cursor = store.getSetting(key) ?? { from: history ? 0 : recent }
    if (cursor.next > now || this.backlog.get().n >= (history ? 12 : 64)) return false
    const window = { ...cursor, until: cursor.until ?? (history ? recent : now - 90_000) }
    if (window.from > window.until) return false
    let json
    try { json = await this.client.request(eventPath(factory, window)) }
    catch (error) {
      // The index may expire a fingerprint. Replay its fixed time window; inserts are idempotent.
      if (error.status === 400 && cursor.fingerprint) store.setSetting(key, { from: cursor.resumeFrom ?? window.from, until: window.until })
      throw error
    }
    const { pools, fingerprint } = parsePage(factory, json, window)
    store.transaction(() => {
      for (const p of pools) this.rememberPool(p)
      this.trim.run()
      if (fingerprint) {
        store.setSetting(key, { from: window.from, until: window.until, fingerprint,
          resumeFrom: pools.at(-1)?.firstSeen ?? window.from, next: history ? now + 3 * MINUTE : now })
      } else store.setSetting(key, history ? { from: 0, next: now + 7 * DAY } :
        { from: window.until - MINUTE, next: now + 3 * MINUTE })
    })
    return true
  }
  usd(address) {
    const id = 'tron:' + (address === WTRX ? 'native' : address)
    const p = this.price.get(id, this.engine.clock() - MARKET_POLICY.maxPriceAge)
    if (p) return p.trust === 'red' ? null : p.priceReal
    return address === USDT ? 1 : null
  }
  async measure(pools, fromHint = false, peer = fromHint) {
    const { registry, store, clock } = this.engine
    const readings = await snapshots(pools, this.client, registry, peer)
    const rows = [], discoveries = [], now = clock()
    store.transaction(() => {
      for (const [i, p] of pools.entries()) {
        const { state, at, info } = readings[i]
        const known = this.pool.get(p.pool)
        let liquidity = null
        if (state?.empty) liquidity = 0
        else if (state) {
          const a = this.usd(p.token0), b = this.usd(p.token1)
          if (a || b) liquidity = 2 * Math.min(state.reserve0 * (a || state.price * b), state.reserve1 * (b || a / state.price))
        }
        if (!Number.isFinite(liquidity) || liquidity < MARKET_POLICY.minPoolLiquidityUsd) {
          if (known && Number.isFinite(liquidity)) this.depth.run(liquidity, p.pool)
          // A just-created pair may be funded later. A missing conversion can become available sooner.
          const retry = liquidity == null ? 15 : now - p.firstSeen > DAY ? 360 : 30
          this.update.run(now + retry * MINUTE, 0, p.pool)
          continue
        }
        const discovery = { ...p, chain: 'tron', liquidity }
        const market = registry.pool(discovery, info, fromHint || !!p.fromHint)
        if (!market) {
          this.update.run(now + DAY, 0, p.pool)
          continue
        }
        if (fromHint) this.rememberPool(p, true)
        this.update.run(now + 2 * MINUTE, 1, p.pool)
        if (!known || (!known.tx && p.tx)) discoveries.push(discovery)
        rows.push([market.id, decimal(market.inverse ? 1 / state.price : state.price), '0', null, null, null, at])
      }
    })
    for (const p of discoveries) this.engine.discovery(p, fromHint || !!p.fromHint, fromHint ? p.reporter : undefined)
    if (rows.length) this.engine.publish(rows)
    return rows.length
  }
  async state(pool) {
    const now = this.engine.clock(), batch = this.stateBatch
    const next = pool ? [this.candidate.get(pool)].filter(Boolean) : [
      ...this.fundedDue.all(now, Math.floor(batch / 2)), ...this.due.all(now, batch),
    ]
    const pools = [...new Map(next.map(p => [p.pool, p])).values()].slice(0, batch)
    if (!pools.length) return false
    try {
      await this.measure(pools, false, !!pool)
      if (!pool) this.stateBatch = Math.min(BATCH, batch + 1)
    } catch (error) {
      // An expensive TRC-20 can exhaust the aggregate's energy even with allowFailure. Isolate
      // that candidate on subsequent turns, then yield its place to the other pools.
      if (!pool && error.message === 'TRON constant call failed') {
        this.stateBatch = Math.max(1, Math.floor(pools.length / 2))
        if (pools.length === 1) this.update.run(now + 30 * MINUTE, pools[0].funded, pools[0].pool)
      }
      throw error
    }
    return true
  }
  async verify(hint, cache) {
    if (!cache.has('creation')) {
      const receipt = await this.client.receipt(hint.tx)
      if (!receipt?.id) return null // Public node has not indexed the transaction.
      const event = creationReceipt(hint, receipt)
      if (!event) return false
      cache.set('creation', event)
    }
    // Honest creation hints for unfunded or already drained pools do not incur a penalty.
    await this.measure([{ ...hint, ...cache.get('creation') }], true)
    return true
  }
  run() { return runDexTasks(this) }
}

export function registerTron(engine) {
  const client = new TronClient(engine)
  if (!client.endpoint) return null
  return registerDexJob('tron', new TronSource(engine, client))
}
