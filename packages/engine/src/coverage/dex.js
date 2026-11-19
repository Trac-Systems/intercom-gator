import { ReporterSlice, nextPoolPage, trackedPools } from './split.js'
import { STATE_KINDS } from '../sources/evm-abi.js'
import { PROVEN } from '../aggregate/book.js'
import { RateLimited } from '../scheduler/index.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Scheduling inputs are registered markets and local reporter standing. No network messages or RPCs for membership. */
export class DexCoverage {
  constructor(engine) {
    this.engine = engine
    const db = engine.store.reader
    this.reporters = db.prepare(`SELECT s.reporter FROM engine_standing s JOIN store_reporters_seen r USING(reporter)
      LEFT JOIN reporters p ON p.key=s.reporter WHERE s.agreements>=? AND r.at>=?
      AND coalesce(p.weight,1)>0 AND coalesce(p.mutedUntil,0)<=? ORDER BY s.reporter`)
    this.known = db.prepare(`SELECT 1 FROM pools p JOIN engine_market_data d
      ON d.market='dex:'||p.chain||':'||p.pool WHERE p.chain=? LIMIT 1`)
    this.pools = db.prepare(`SELECT p.*,m.id,m.base,m.quote,d.fromHint,k.spacing,k.stable,
      (m.base IN (SELECT asset FROM watchlist UNION SELECT asset FROM portfolio)
        OR m.quote IN (SELECT asset FROM watchlist UNION SELECT asset FROM portfolio)) AS pinned
      FROM pools p JOIN markets m ON m.id='dex:'||p.chain||':'||p.pool JOIN engine_market_data d ON d.market=m.id
      LEFT JOIN assets a ON a.id=m.base LEFT JOIN engine_pool_parameters k USING(chain,pool)
      WHERE p.chain=? ORDER BY (coalesce(a.rank,999999)<=50) DESC,coalesce(p.liquidity,0) DESC,m.id`)
    this.nextHint = db.prepare(`SELECT m.id,m.chain,m.exchange FROM engine_market_data d JOIN markets m ON m.id=d.market
      WHERE d.market>? AND d.market<'dex;' AND d.fromHint=1 ORDER BY d.market LIMIT 1`)
    this.scan = db.prepare('SELECT block AS scanned,polled FROM engine_pool_scans WHERE chain=? AND pool=?')
    this.plans = new Map()
    this.checkAt = -Infinity
  }

  members() {
    const now = this.engine.clock()
    if (now >= this.checkAt) {
      const members = this.reporters.all(PROVEN, now - 30 * MINUTE, now).map(r => r.reporter)
      this.slice = new ReporterSlice(this.engine.transport.publicKey, members)
      this.checkAt = now + MINUTE
    }
    return this.slice
  }

  /** Small networks keep all existing priorities. Use a spare scheduler slot for verified remote discoveries. */
  installBacklogJob() {
    const { scheduler, store, budget } = this.engine
    const cursor = 'dex-coverage/idle'
    scheduler.add({ id: 'dex:backlog', idleOnly: true, interval: MINUTE,
      ready: () => !this.members().split && budget.used < budget.limit / 2,
      run: async () => {
        const last = store.getSetting(cursor) ?? 'dex:'
        const row = this.nextHint.get(last) ?? this.nextHint.get('dex:')
        if (!row) return
        try {
          const evm = this.engine.evm.get(row.chain)
          if (evm) await evm.spotCheck(row.id, evm.rpc.publicOnly)
          else if (scheduler.jobs.has('sol:' + row.exchange))
            await this.engine.solanaReaders.get(row.exchange)?.spotCheck(row.id)
        } catch (error) {
          if (!(error instanceof RateLimited)) store.setSetting(cursor, row.id)
          throw error
        }
        store.setSetting(cursor, row.id)
      },
    })
  }

  /** Keep one plan per chain/reader. A membership change invalidates it at the next read. */
  plan(chain, lane, accepts) {
    const roster = this.members(), key = chain + '/' + lane, now = this.engine.clock()
    let cached = this.plans.get(key)
    if (!cached || cached.version !== roster.version || cached.until <= now) {
      const pools = this.pools.all(chain).filter(accepts)
      const pinned = row => row.pinned || this.engine.scheduler.focus?.market(row.id, now)
      const plan = roster.partition(pools, row => row.id, 4, pinned)
      this.plans.set(key, cached = { plan, until: now + 2 * MINUTE, version: roster.version })
    }
    return cached.plan
  }

  trades(source) {
    if (!this.members().split) return null
    const chain = source.chain.id
    const plan = this.plan(chain, 'trades', p => source.chain.deployments.some(d => d.name === p.dex && d.kind === p.kind))
    const hour = Math.floor(this.engine.clock() / HOUR)
    return trackedPools(plan, source.limits.tracked, hour).map(p => ({ ...p, ...this.scan.get(chain, p.pool) }))
  }

  /** Advance only after completion. Retry the same selection on a budget deferral and rotate past broken pools. */
  async readPage(chain, lane, accepts, limit, read) {
    const plan = this.plan(chain, lane, accepts), { store, book } = this.engine
    const key = 'dex-coverage/' + chain + '/' + lane
    const { rows, next } = nextPoolPage(plan, limit, store.getSetting(key) ?? {}, p => book.coverage(p.id, HOUR) > 0)
    try {
      if (rows.length) await read(rows)
    } catch (error) {
      if (!(error instanceof RateLimited)) store.setSetting(key, next)
      throw error
    }
    store.setSetting(key, next)
    return rows.length
  }

  state(source, limit) {
    return this.readPage(source.chain.id, 'state', p => STATE_KINDS.includes(p.kind), limit,
      rows => source.readPoolState(rows, rows.some(p => p.fromHint) ? source.rpc.publicOnly : source.rpc))
  }
}
