import { MARKET_POLICY } from '../../../../store/src/markets.js'
import { RateLimited } from '../../scheduler/index.js'
import { decimal } from '../../obs/index.js'
import { AptosReader, thalaRatio } from './aptos.js'
import { MoveClient, fresh, once } from './client.js'
import { assetAddress, metadata, natural, objectId, rawRatio, STABLES, units, validPool } from './identity.js'
import { SuiReader } from './sui.js'

const MIN = 60_000, DAY = 24 * 60 * MIN
const FLOOR = MARKET_POLICY.minPoolLiquidityUsd
export class MoveSource {
  constructor(engine, chain, client) {
    Object.assign(this, { engine, chain, client, turn: 0, stateTurn: 0 })
    const db = engine.store.writer
    this.readCandidate = db.prepare('SELECT * FROM engine_move_candidates WHERE chain=? AND pool=?')
    this.readPool = db.prepare('SELECT * FROM pools WHERE chain=? AND pool=?')
    this.insert = db.prepare(`INSERT INTO engine_move_candidates
      (chain,pool,dex,kind,token0,token1,slot,firstSeen,block,tx,version,originBlock,priority,due,fromHint)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chain,pool) DO UPDATE SET
      token0=coalesce(token0,excluded.token0),token1=coalesce(token1,excluded.token1),slot=coalesce(excluded.slot,slot),
      firstSeen=min(firstSeen,excluded.firstSeen), block=coalesce(block,excluded.block),tx=coalesce(tx,excluded.tx),
      version=coalesce(version,excluded.version),priority=max(priority,excluded.priority),fromHint=min(fromHint,excluded.fromHint),
      due=CASE WHEN tx IS NULL AND excluded.tx IS NOT NULL THEN 0 ELSE due END
      WHERE dex=excluded.dex AND (token0 IS NULL OR excluded.token0 IS NULL OR token0=excluded.token0)
        AND (token1 IS NULL OR excluded.token1 IS NULL OR token1=excluded.token1)`)
    this.queue = db.prepare(`SELECT * FROM engine_move_candidates WHERE chain=? AND due<=? AND funded=?
      ORDER BY CASE WHEN due=0 THEN -priority ELSE 0 END,due,firstSeen DESC,pool LIMIT ?`)
    this.count = db.prepare('SELECT count(*) AS n FROM engine_move_candidates WHERE chain=? AND due=0')
    this.update = db.prepare('UPDATE engine_move_candidates SET due=?,funded=? WHERE chain=? AND pool=?')
    this.depth = db.prepare('UPDATE pools SET liquidity=? WHERE chain=? AND pool=?')
    this.assetPrice = db.prepare('SELECT priceReal,trust FROM prices WHERE asset=? AND priceReal>0 AND at>=?')
    this.trade = db.prepare('INSERT OR IGNORE INTO engine_move_swaps VALUES (?,?,?,?,?,?)')
    this.volume = db.prepare('SELECT sum(a) AS a,sum(b) AS b FROM engine_move_swaps WHERE chain=? AND pool=? AND at>? AND at<=?')
    this.expire = db.prepare('DELETE FROM engine_move_swaps WHERE chain=? AND at<=?')
    this.trimSwaps = db.prepare(`DELETE FROM engine_move_swaps WHERE chain=? AND (pool,event) IN
      (SELECT pool,event FROM engine_move_swaps WHERE chain=? ORDER BY at DESC LIMIT -1 OFFSET 8192)`)
    this.trim = db.prepare(`DELETE FROM engine_move_candidates WHERE chain=? AND (chain,pool) IN
      (SELECT chain,pool FROM engine_move_candidates WHERE chain=? AND funded=0 AND due>0
       ORDER BY firstSeen DESC LIMIT -1 OFFSET 768)`)
    this.probes = db.prepare(`SELECT * FROM engine_move_candidates WHERE chain=? AND funded=1 AND tx IS NULL AND originDue<=?
      ORDER BY originDue, pool LIMIT 2`)
    this.fundedIds = db.prepare(`SELECT pool FROM engine_move_candidates WHERE chain=? AND funded=1 AND dex IN ('hyperion','thalaswap')
      ORDER BY (pool<=?),pool LIMIT 2`)
    this.readOrigins = db.prepare(`SELECT pool FROM engine_move_candidates WHERE chain='aptos' AND dex IN ('hyperion','thalaswap')
      AND tx IS NULL AND version IS NULL AND originDue<=? ORDER BY originDue,funded DESC,priority DESC,slot DESC LIMIT 8`)
    this.setOrigin = db.prepare("UPDATE engine_move_candidates SET version=?,originBlock=?,originDue=? WHERE chain='aptos' AND pool=?")
    this.receipts = db.prepare(`SELECT * FROM engine_move_candidates WHERE chain='aptos' AND tx IS NULL AND version IS NOT NULL
      AND originDue<=? ORDER BY version DESC LIMIT 1`)
    this.originRetry = db.prepare("UPDATE engine_move_candidates SET originDue=? WHERE chain=? AND pool=?")
    this.reader = chain === 'sui' ? new SuiReader(this) : new AptosReader(this)
  }

  candidate(pool) { return this.readCandidate.get(this.chain, pool) }
  known(pool) { return this.readPool.get(this.chain, pool) }
  backlog() { return this.count.get(this.chain).n }
  origins() { return this.readOrigins.all(this.engine.clock()) }
  origin(pool, version, block) { this.setOrigin.run(version, block, version == null ? this.engine.clock() + DAY : 0, pool) }
  nextReceipt() { return this.receipts.get(this.engine.clock()) }
  originDone(pool, final) { this.originRetry.run(final ? Number.MAX_SAFE_INTEGER : this.engine.clock() + DAY, this.chain, pool) }
  cursor(k) { return this.engine.store.getSetting('engine-move/' + this.chain + '/' + k) ?? {} }
  saveCursor(k, value) { this.engine.store.setSetting('engine-move/' + this.chain + '/' + k, value) }
  info(token) { return this.engine.registry.assets.get(this.chain + ':' + assetAddress(this.chain, token)) }
  usd(token) {
    const p = this.assetPrice.get(this.chain + ':' + assetAddress(this.chain, token), this.engine.clock() - MARKET_POLICY.maxPriceAge)
    if (p) return p.trust === 'red' ? null : p.priceReal
    // Only the canonical USDC contract can bootstrap a floor before reference jobs run.
    return token === STABLES[this.chain][0] ? 1 : null
  }
  // The known side alone bounds the two-sided minimum; never screen an unknown unit as dollars.
  priority(p) {
    let largest = 0, nativeSize = 0
    for (const [token, raw] of [[p.token0,p.raw0],[p.token1,p.raw1]]) {
      const n = units(raw)
      if (n === 0) return -1
      const asset = this.info(token), usd = this.usd(token)
      if (asset?.address === 'native' && Number.isFinite(n)) nativeSize = n / 10 ** asset.decimals
      if (!usd || asset?.decimals == null || !Number.isFinite(n)) continue
      const dollars = n * usd / 10 ** asset.decimals
      if (2 * dollars < FLOOR) return -1
      largest = Math.max(largest, dollars)
    }
    return largest ? 3 + Math.min(6, Math.floor(Math.log10(largest))) : nativeSize > 0 ? 1 + Number(nativeSize >= 1000) : 0
  }
  needsMetadata(p) { return p?.active && this.priority(p) >= 0 && (this.usd(p.token0) || this.usd(p.token1)) }
  remember(p, peer = false) {
    const rank = p.priority ?? 0
    this.insert.run(this.chain, p.pool, p.dex, p.kind, p.token0 ?? null, p.token1 ?? null, p.slot ?? null, p.firstSeen,
      p.block ?? null, p.tx ?? null, p.version ?? null, p.originBlock ?? null, rank, rank < 0 ? this.engine.clock() + 360 * MIN : 0, Number(peer))
  }
  page(key, cursor, candidates, swaps = []) {
    const now = this.engine.clock()
    this.engine.store.transaction(() => {
      for (const p of candidates) this.remember(p)
      for (const t of swaps) {
        const a = units(t.a), b = units(t.b)
        if (a > 0 && b > 0 && natural(t.at) && t.at > now - DAY && t.at <= now && objectId(t.pool))
          this.trade.run(this.chain, t.pool, t.event, t.at, a, b)
      }
      this.expire.run(this.chain, now - DAY)
      this.trimSwaps.run(this.chain, this.chain)
      this.trim.run(this.chain, this.chain)
      this.saveCursor(key, cursor)
    })
  }

  async measure(pools, cache, peer = false, reporter) {
    const { engine, chain } = this, now = engine.clock()
    const snapshot = await this.reader.snapshots(pools, cache, peer)
    const at = fresh(snapshot.at, engine.clock()), out = [], discoveries = []
    let verified = true
    engine.store.transaction(() => {
      for (const [i, p] of pools.entries()) {
        const row = snapshot.rows[i], known = this.known(p.pool)
        const later = (delay, funded = 0) => this.update.run(now + delay, funded, chain, p.pool)
        if (!row || row.pool !== p.pool || row.dex !== p.dex ||
            (p.token0 && p.token0 !== row.token0) || (p.token1 && p.token1 !== row.token1)) {
          verified = row ? false : null
          if (!peer) later(DAY)
          continue
        }
        const discovery = { ...p, chain, token0: row.token0, token1: row.token1 }
        if (!validPool(discovery, true)) { later(DAY); continue }
        const info = [row.token0,row.token1].map(t => this.info(t) ?? metadata(snapshot.info.get(t), t))
        const [a,b] = [this.usd(row.token0),this.usd(row.token1)]
        const amounts = [units(row.raw0), units(row.raw1)]
        if (amounts.some(n => !Number.isFinite(n))) { later(30 * MIN); continue }
        const thin = !row.active || amounts.includes(0)
        if (!thin && (info.some(t => t?.decimals == null) || !(a || b))) {
          // A known reserve below the floor can demote a previously admitted market immediately.
          const bound = Math.min(...[a,b].map((usd,j) => usd && info[j]?.decimals != null ? 2 * amounts[j] * usd / 10 ** info[j].decimals : Infinity))
          if (known && bound < FLOOR) this.depth.run(bound, chain, p.pool)
          later((bound < FLOOR ? 360 : 15) * MIN)
          continue
        }
        const [d0,d1] = info.map(t => t?.decimals ?? 0)
        const r0 = amounts[0] / 10 ** d0, r1 = amounts[1] / 10 ** d1
        const price = thin ? 0 : row.sqrt != null ? rawRatio(row.sqrt, d0, d1) : row.thala ? thalaRatio(row.thala, r0, r1) :
          row.kind === 'clmm' ? NaN : r1 / r0
        if (!thin && !(Number.isFinite(price) && price > 0)) { later(30 * MIN); continue }
        const liquidity = thin ? 0 : 2 * Math.min(r0 * (a || price * b), r1 * (b || a / price))
        if (!Number.isFinite(liquidity) || liquidity < FLOOR) {
          if (known && Number.isFinite(liquidity)) this.depth.run(liquidity, chain, p.pool)
          later(30 * MIN)
          continue
        }
        discovery.liquidity = liquidity
        const market = engine.registry.pool(discovery, { token0: info[0], token1: info[1] }, !!reporter || !!p.fromHint)
        if (!market) { later(DAY); continue }
        this.remember(discovery, !!reporter || !!p.fromHint)
        later(2 * MIN, 1)
        if (!known || (!known.tx && p.tx)) discoveries.push(discovery)
        const vol = this.volume.get(chain, p.pool, at - DAY, at)
        const base = market.inverse ? (vol.b ?? 0) / 10 ** d1 : (vol.a ?? 0) / 10 ** d0
        out.push([market.id, decimal(market.inverse ? 1 / price : price), decimal(base), null, null, null, at])
      }
    })
    for (const p of discoveries) engine.discovery(p, !!reporter || !!p.fromHint, reporter)
    if (out.length) engine.publish(out)
    return verified
  }

  async state(pool, reads) {
    const now = this.engine.clock(), peer = !!pool, batch = this.chain === 'sui' ? 5 : 1
    const cached = peer ? (reads ?? new Map()) : (this.stateCache ??= new Map())
    let pools = cached.get('pools')
    if (!pools) {
      if (pool) pools = [this.candidate(pool)].filter(Boolean)
      else {
        const funded = this.queue.all(this.chain, now, 1, batch)
        const untried = this.queue.all(this.chain, now, 0, batch)
        pools = (this.stateTurn++ % 3 === 1 ? [...funded,...untried] : [...untried,...funded]).slice(0, batch)
      }
      if (!pools.length) return false
      cached.set('pools', pools)
    }
    try { await this.measure(pools, cached, peer) }
    catch (err) {
      if (err instanceof RateLimited) throw err
      if ([404,410].includes(err.status)) {
        for (const p of pools) this.update.run(now + DAY, p.funded, this.chain, p.pool)
      } else if (!peer) for (const p of pools) this.update.run(now + MIN, p.funded, this.chain, p.pool)
      cached.clear()
      throw err
    }
    cached.clear()
    return true
  }
  async verify(hint, cache) {
    const event = await once(cache, 'creation', () => this.reader.receipt(hint, cache))
    if (!event) return event
    return this.measure([{ ...hint, ...event, token0: hint.token0, token1: hint.token1 }], cache, true, hint.reporter)
  }
  async run() {
    const tasks = this.reader.tasks
    for (let i = 0; i < tasks.length; i++) {
      const turn = this.turn
      this.turn = (turn + 1) % tasks.length
      try { if (await tasks[turn]()) return }
      catch (error) { if (error instanceof RateLimited) this.turn = turn; throw error }
    }
  }
}
export function registerMove(engine) {
  const sources = new Map()
  for (const chain of ['sui','aptos']) {
    const client = new MoveClient(engine, chain)
    if (!client.endpoint) continue
    const source = new MoveSource(engine, chain, client)
    sources.set(chain, source)
    engine.registerJob({ id: chain + ':pools', marketChain: chain, interval: 5000,
      ready: () => !!client.endpoint && engine.clock() >= client.next, run: () => source.run(),
      spotCheck: (id, reads) => source.state(id.split(':')[2], reads) })
  }
  return sources
}
