import { RateLimited } from '../scheduler/index.js'
import { bridgeCurrency } from './rates.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const SEED_DAYS = 8
/** Every other live asset needs only the bar 24 h back (change24h); two days cover it until local bars take over. */
const TAIL_DAYS = 2
export const SEED_ASSETS = Object.freeze({ small: 30, normal: 100, large: 300 })
/** Imports in flight at once in the paced loop, per profile. */
export const SEED_PARALLEL = Object.freeze({ small: 1, normal: 2, large: 4 })
/** History may use this share of the profile's request budget in any rolling minute. Beyond SEED_FLOOR it starts
 * nothing while the whole node uses more than half of the budget, so market jobs keep their room; below the floor
 * it competes with them (a small or normal node's market jobs can fill the budget on their own). */
export const SEED_SHARE = 0.4
export const SEED_FLOOR = 0.15
/** Backoff after an import that produced no venue bars: minutes, never "the next hour". */
export const SEED_RETRY = Object.freeze([60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000])
const TICK_MS = 500
const TAIL_LIMIT = 3000

/** Hourly history from venue OHLC so 24 h / 7 d changes, movers and charts work on a fresh node and across
 * downtime. The top-ranked assets (per profile) get eight days; every other live asset with a candle-capable CEX
 * market gets two days, enough for the bar 24 h back. Quote assets (USDT, USDC, BTC, ...) go first: their local
 * bars convert the other assets' venue history. Only hours without a local bar are written: local bars come from
 * the aggregated price and always win. A covered asset costs no request and is re-checked once per UTC hour.
 *
 * A paced loop of its own runs the imports (about a hundred background jobs share the scheduler's turn, which left
 * the seed minutes apart); the `history:seed` scheduler job is the fallback when a test restricts background jobs. */
export function registerHistorySeed(engine, { count = SEED_ASSETS[engine.profile] ?? SEED_ASSETS.normal } = {}) {
  const { store, clock } = engine
  const covered = store.reader.prepare("SELECT count(*) AS n FROM candles WHERE asset=? AND tf='1h' AND ts>=? AND ts<?")
  const near = store.reader.prepare("SELECT 1 AS hit FROM candles WHERE asset=? AND tf='1h' AND ts>=? AND ts<=? LIMIT 1")
  const insert = store.writer.prepare(`INSERT INTO candles(asset,tf,ts,open,high,low,close,samples,firstTs,firstId,lastTs,lastId)
    VALUES (?,'1h',?,?,?,?,?,1,?,0,?,0) ON CONFLICT(asset,tf,ts) DO NOTHING`)
  /** id -> { hour: UTC hour checked or imported, failures, retryAt } */
  const state = new Map()
  const running = new Set()
  const paced = !!engine.scheduler && !engine.scheduler.backgroundJobs
  const stats = { imports: 0, failures: 0, deferred: 0, written: 0 }
  let ranked = { at: -Infinity, ids: [], top: new Set(), quotes: new Set(), fiat: new Set(), capable: null }

  const hourStart = () => clock() - (clock() % HOUR)
  function refresh() {
    if (clock() - ranked.at < 60_000) return ranked
    const registry = engine.registry
    let capable = null
    const quotes = new Set()
    const fiatMarkets = [], fiatBridges = new Map()
    if (registry?.markets) {
      capable = new Set()
      for (const m of registry.markets.values()) {
        if (m.kind !== 'cex' || !m.symbol || registry.venues.get(m.exchange)?.candles?.intervals?.['1h'] == null) continue
        capable.add(m.base)
        if (m.quote !== 'fiat:USD') quotes.add(m.quote)
        // A stablecoin traded against local fiat supplies the USD leg of the inverse hourly rate.
        if (m.quote.startsWith('fiat:') && m.quote !== 'fiat:USD' && registry.assets?.get(m.base)?.stable)
          quotes.add(m.base)
        if (registry.active?.get(m.id) && !registry.halted?.has(m.id)) {
          const fiat = bridgeCurrency(m, registry.assets)
          if (fiat) {
            if (!fiatBridges.has(fiat)) fiatBridges.set(fiat, new Set())
            fiatBridges.get(fiat).add(m.id)
          }
          if (m.quote !== 'fiat:USD' && m.quote.startsWith('fiat:') && registry.assets?.has(m.base))
            fiatMarkets.push(m)
        }
      }
    }
    const all = store.listMarkets({ limit: Math.max(count, TAIL_LIMIT) }).map((row) => row.id)
    const top = new Set(all.slice(0, count))
    // DEX-only assets have no venue history: they chart from local bars only.
    const ids = all.filter((id) => !capable || capable.has(id))
    const live = new Set(ids)
    const first = [...quotes].filter((id) => live.has(id))
    // A genuine local-fiat listing can lack a current USD price after its frozen USD listings
    // disappear. It can still chart from historical USD evidence. Serve ranked assets first.
    const fiatOnly = new Set(), fiat = new Set()
    for (const m of fiatMarkets) {
      const bridges = fiatBridges.get(m.quote)
      if (!bridges || (bridges.size === 1 && bridges.has(m.id))) continue
      fiat.add(m.base)
      if (!live.has(m.base) && ids.length + fiatOnly.size < TAIL_LIMIT) fiatOnly.add(m.base)
    }
    // A quote's own bars convert eight days of the top assets' history, whatever its rank.
    for (const id of first) top.add(id)
    ranked = {
      at: clock(),
      ids: [...first, ...ids.filter((id) => !quotes.has(id)), ...fiatOnly],
      top,
      quotes: new Set(first),
      fiat,
      capable,
    }
    return ranked
  }
  /** The window book.js reads for change24h: a 1 h bar within two hours before the cutoff. */
  function has24h(id) {
    const ts = Math.floor((clock() - DAY) / HOUR) * HOUR
    return !!near.get(id, ts - 2 * HOUR, ts)
  }
  /** Missing hours: eight days for a top asset, the change24h bar for the rest. */
  function missing(id, hour) {
    return ranked.top.has(id) ? covered.get(id, hour - SEED_DAYS * DAY, hour).n < SEED_DAYS * 24 - 2 : !has24h(id)
  }
  function wanted(id, hour) {
    if (running.has(id)) return false
    const s = state.get(id)
    if (s && (s.retryAt > clock() || s.hour === hour)) return false
    if (missing(id, hour)) return true
    state.set(id, { hour, failures: s?.failures ?? 0, retryAt: 0 })
    return false
  }
  function due() {
    const { ids, quotes } = refresh()
    const hour = hourStart()
    // Venue bars in a stablecoin or BTC quote convert only through the quote's own local bars.
    const quoteBusy = [...running].some((id) => quotes.has(id))
    for (const id of ids) {
      if (quoteBusy && !quotes.has(id)) return undefined
      if (wanted(id, hour)) return id
    }
    return undefined
  }

  async function importOne(id) {
    const hour = hourStart()
    const days = ranked.top.has(id) ? SEED_DAYS : TAIL_DAYS
    const prev = state.get(id)
    running.add(id)
    stats.imports++
    let bars
    try {
      bars = await engine.candles(id, { tf: '1h', from: hour - days * DAY, to: hour, limit: days * 24, wait: 30_000, attempts: 4 })
    } catch (error) {
      if (error instanceof RateLimited) {
        // Every venue was throttled (or the budget was spent): nothing was sent, so this is no failure.
        stats.deferred++
        state.set(id, { hour: null, failures: prev?.failures ?? 0, retryAt: Math.max(clock() + 2000, error.retryAt) })
      } else fail(id, prev)
      throw error
    } finally {
      running.delete(id)
    }
    let written = 0
    store.transaction(() => {
      for (const bar of bars) {
        if (!bar.source) continue
        written += insert.run(id, bar.ts, bar.open, bar.high, bar.low, bar.close, bar.ts, bar.ts + HOUR - 1).changes
      }
    })
    stats.written += written
    if (written) engine.book.dirty = true
    // Venue bars (even if all hours were already local) settle the hour; none at all (no convertible quote yet,
    // dead or failing venues) retries in minutes.
    // A thin USD market may have supplied a few bars while the fiat bridge was throttled.
    // Retry those partial imports on the bounded backoff until the change24h hour is covered.
    const retryFiat = ranked.fiat.has(id) && !has24h(id)
    if ((!retryFiat && bars.some((bar) => bar.source)) || !missing(id, hour))
      state.set(id, { hour, failures: 0, retryAt: 0 })
    else fail(id, prev)
    return written
  }
  function fail(id, prev) {
    const failures = (prev?.failures ?? 0) + 1
    stats.failures++
    state.set(id, { hour: null, failures, retryAt: clock() + SEED_RETRY[Math.min(failures, SEED_RETRY.length) - 1] })
  }

  /** Up to `perRun` due assets in sequence (the scheduler fallback and tests). */
  async function run(perRun = 4) {
    let written = 0,
      lastError
    for (let i = 0; i < perRun; i++) {
      const id = due()
      if (!id) break
      try {
        written += await importOne(id)
      } catch (error) {
        lastError = error
      }
    }
    if (!written && lastError) throw lastError
    return written
  }

  const samples = []
  function room() {
    const { budget } = engine
    if (!budget) return true
    const now = clock(),
      sent = engine.history?.requests ?? 0
    samples.push([now, sent])
    while (samples.length > 1 && samples[0][0] <= now - 60_000) samples.shift()
    const mine = sent - samples[0][1]
    if (mine >= Math.max(2, budget.limit * SEED_SHARE) || budget.used >= budget.limit) return false
    return budget.used < budget.limit / 2 || mine < Math.max(1, budget.limit * SEED_FLOOR)
  }
  function pump() {
    if (!engine.active) return
    const parallel = SEED_PARALLEL[engine.profile] ?? SEED_PARALLEL.normal
    while (running.size < parallel && room()) {
      const id = due()
      if (!id) break
      importOne(id).catch(() => {})
    }
  }
  if (paced) {
    const arm = () => setTimeout(tick, TICK_MS).unref?.()
    const tick = () => {
      try {
        pump()
      } catch {}
      if (engine.active || !engine.abort?.signal.aborted) arm()
    }
    arm()
  }

  // Up to ten assets per run, each with up to three venue requests: allow more than the default job deadline.
  engine.registerJob({ id: 'history:seed', interval: 2000, relevance: 2, deadlineMs: 600_000,
    ready: () => !paced && due() !== undefined, run })
  return { due, run, pump, stats, state }
}
