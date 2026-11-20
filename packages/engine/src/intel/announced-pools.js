import { multiRead, STATE_KINDS } from '../sources/evm-abi.js'

const HOUR = 3_600_000, DAY = 24 * HOUR
/** Receivers of `gator/new` pool records and catch-up rows (DESIGN §5.3 "Agent-added tokens").
 * A pool verified from a peer's record is measured once through public endpoints. It stays priced
 * (refreshed every state period) while its measured depth is at least the added-token floor, the same rule the
 * adding node used. At most `perChain` such pools per chain are kept, deepest first. Shallower, empty or
 * unpriced pools are measured again after 1 h and 6 h. They are dropped after 24 h below the floor and keep
 * their registered identity. */
export const ANNOUNCED_LIMITS = Object.freeze({ minDepthUsd: 100, perChain: 64, batch: 16, recheck: [HOUR, 6 * HOUR],
  forgetAfter: DAY })

export function registerAnnouncedPools(engine) {
  const { store, clock, evm, registry } = engine
  const db = store.writer
  const enqueue = db.prepare(`INSERT INTO engine_announced_pools(chain,pool,since,checkAt,checks) VALUES (?,?,?,?,0)
    ON CONFLICT(chain,pool) DO NOTHING`)
  const due = store.reader.prepare(`SELECT p.*,k.spacing,k.stable,a.since,a.checks,a.depth AS measured,a.belowSince
    FROM engine_announced_pools a JOIN pools p USING(chain,pool)
    JOIN engine_market_data d ON d.market='dex:'||p.chain||':'||p.pool
    LEFT JOIN engine_pool_parameters k USING(chain,pool)
    WHERE a.chain=? AND a.checkAt<=? AND d.fromHint=1 ORDER BY a.checkAt,a.pool LIMIT ?`)
  const nextChain = store.reader.prepare('SELECT chain FROM engine_announced_pools WHERE checkAt<=? ORDER BY checkAt,chain LIMIT 1')
  const deeper = db.prepare(`SELECT count(*) AS n FROM engine_announced_pools
    WHERE chain=? AND pool<>? AND belowSince IS NULL AND (depth>? OR (depth=? AND pool<?))`)
  const retireExcess = db.prepare(`UPDATE engine_announced_pools SET belowSince=?,checkAt=? WHERE chain=? AND pool IN (
    SELECT pool FROM engine_announced_pools WHERE chain=? AND belowSince IS NULL AND depth>=?
    ORDER BY depth DESC,pool LIMIT -1 OFFSET ?)`)
  const retireLocal = db.prepare(`DELETE FROM engine_announced_pools WHERE chain=? AND pool IN (
    SELECT a.pool FROM engine_announced_pools a WHERE a.chain=? AND a.checkAt<=? AND NOT EXISTS (
      SELECT 1 FROM engine_market_data d WHERE d.market='dex:'||a.chain||':'||a.pool AND d.fromHint=1)
    ORDER BY a.checkAt,a.pool LIMIT ?)`)
  const save = db.prepare('UPDATE engine_announced_pools SET checkAt=?,checks=checks+1,depth=?,belowSince=? WHERE chain=? AND pool=?')
  const drop = db.prepare('DELETE FROM engine_announced_pools WHERE chain=? AND pool=?')
  const saveDepth = db.prepare('UPDATE pools SET liquidity=? WHERE chain=? AND pool=?')

  // Live hints and catch-up rows both end in a local discovery with peer origin.
  engine.on('discovery', (msg, firstSeen, fromHint) => {
    if (!fromHint || msg?.t !== 'pool' || !evm.has(msg.chain) || !STATE_KINDS.includes(msg.kind)) return
    if (registry.markets.get('dex:' + msg.chain + ':' + msg.pool)?.fromHint !== 1) return
    enqueue.run(msg.chain, msg.pool, clock(), clock())
  })

  async function measure(chain, rpc = engine.rpc.publicOnly) {
    const source = evm.get(chain), now = clock()
    if (!source) return 0
    // Independent enumeration can promote a verified hint while it waits for its state turn.
    retireLocal.run(chain, chain, now, ANNOUNCED_LIMITS.batch)
    const rows = due.all(chain, now, ANNOUNCED_LIMITS.batch)
    const pools = rows.map(p => ({ ...p, manager: source.chain.deployments.find(d => d.kind === p.kind && d.name === p.dex)?.address }))
    const readable = pools.filter(p => p.kind !== 'v4' || p.manager)
    const states = readable.length ? await source.snapshots(readable, calls => multiRead(rpc, source.chain, calls)) : []
    const published = []
    store.transaction(() => {
      for (const p of pools) {
        const i = readable.indexOf(p), state = i < 0 ? null : states[i]
        const market = registry.markets.get('dex:' + chain + ':' + p.pool)
        if (state && (state.empty || state.liquidity != null)) saveDepth.run(state.empty ? 0 : state.liquidity, chain, p.pool)
        const depth = state && !state.empty ? state.liquidity : state?.empty ? 0 : null
        const kept = market && depth != null && depth >= ANNOUNCED_LIMITS.minDepthUsd &&
          deeper.get(chain, p.pool, depth, depth, p.pool).n < ANNOUNCED_LIMITS.perChain
        if (kept) {
          published.push(source.stateRow(market, state.price, now))
          save.run(now + source.limits.period, depth, null, chain, p.pool)
          continue
        }
        const below = p.belowSince ?? (p.checks ? now : p.since)
        if (!market || now - below >= ANNOUNCED_LIMITS.forgetAfter) { drop.run(chain, p.pool); continue }
        const step = ANNOUNCED_LIMITS.recheck[Math.min(p.checks, ANNOUNCED_LIMITS.recheck.length - 1)]
        save.run(Math.min(below + ANNOUNCED_LIMITS.forgetAfter, now + step), depth, below, chain, p.pool)
      }
      if (published.length) retireExcess.run(now, now + HOUR, chain, chain, ANNOUNCED_LIMITS.minDepthUsd, ANNOUNCED_LIMITS.perChain)
    })
    if (published.length) engine.publish(published)
    return pools.length
  }

  engine.registerJob({ id: 'discovery:announced-state', interval: 15_000, relevance: 0.5,
    ready: () => !!nextChain.get(clock()),
    async run() {
      const row = nextChain.get(clock())
      if (row) await measure(row.chain)
    } })

  return { measure, limits: ANNOUNCED_LIMITS }
}
