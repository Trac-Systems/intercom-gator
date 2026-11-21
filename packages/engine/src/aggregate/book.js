import { MARKET_POLICY } from '../../../store/src/markets.js'
import { multiplyPrice } from './decimal.js'
import { aggregateAssetsSteps, capSupply, marketMedian, totalCapCheck, weightedMedian } from './index.js'
import { decimal } from '../obs/index.js'
import { coverageTarget } from '../scheduler/index.js'
import { zeroTickerBook, marketHalts } from '../sources/cex.js'
import { marketUsdVolume, quoteRate } from './collisions.js'
import { volumeSuspects } from './volume-guard.js'

/** Largest spread between an asset's references that still makes one anchor (stablecoins: their 1% de-peg rule x2). */
export const REFERENCE_AGREEMENT = Object.freeze({ stable: 0.02, other: 0.1 })

const DAY = 86400_000
// change24h from the node's hourly history must agree with the venues' own 24 h move within this factor. History
// written while another listing set the price (INDEX at $0.0046 before Coinbase's $0.209; CTX at HTX's $0.54) would
// otherwise rank the asset first among gainers or losers.
const DAY_CHECK_FACTOR = 1.25
const DAY_TICK_MS = 2 * 3600_000
// History further than this from the venues' move for ten minutes was written under another listing: the asset's
// bars are dropped (at most once a day) so its chart and change7d lose the cliff; the seeder refills them from the
// current venues. The daily cap bounds a venue whose open is not a rolling 24 h one.
const HISTORY_BREAK_FACTOR = 1.4
const HISTORY_BREAK_MS = 600_000
const HISTORY_RESET_GAP_MS = DAY
export const PROVEN = 3
const COVERAGE_TTL_MS = 15_000
// A strike is one disagreement > 3% with a contemporaneous local read. A data mute needs a pattern: within the last
// hour at least MUTE_STRIKES disagreements that are at least MUTE_SHARE of the peer's checks. Lifetime strikes muted every
// honest peer of a 39k-market node within a day (volatile pairs) and cut the node off the network (11-20, v0.1.9).
const STRIKE_WINDOW_MS = 3_600_000
const MUTE_STRIKES = 5
const MUTE_SHARE = 0.5
const CHECK_LOG_CAP = 4096
// The in-memory latest rows are compared with engine_latest this often (a count and two modular sums, ~0.1 s on 179k
// rows); any drift (a rolled-back write, a writer the mirror does not know) reloads them from the table.
const LATEST_CHECK_MS = 60_000
const SUM_MOD = 1_000_003
// With reuse enabled (maxStaleMs > 0) a rebuild is reused for at least this many times its own duration, so rebuilds
// take at most ~1/(1+REBUILD_SPACING) of the main thread however large the book grows.
const REBUILD_SPACING = 4
// With reuse enabled a read never waits for a rebuild: it returns the last one and leaves the new one to the background,
// in slices of about SLICE_MS between which requests run (owner node 11-20: a 0.8-1 s rebuild every few seconds made a
// click wait up to 1.3 s). Once the last rebuild is older than this, the next background rebuild starts at once and runs
// in larger slices (STALE_SLICE_MS) so it finishes sooner. Reads used to rebuild synchronously here instead: on a node
// whose sliced rebuilds take longer than this, every such read froze the daemon for 8-10 s (owner node 11-21: hourly
// routine calls failed with "Daemon unavailable"). Only the first rebuild after start runs inside a read.
const READ_LIMIT_MS = 15_000
const SLICE_MS = 25
const STALE_SLICE_MS = 100
// A background rebuild waits at most this long for its spacing, so a long first (cold) rebuild cannot push the next one
// past READ_LIMIT_MS (bench 11-20: 15.6 s -> one read rebuilt at once, 578 ms).
const SPACING_CAP_MS = 5_000
const retaining = new WeakSet()

function retainComparisons(store) {
  if (retaining.has(store)) return
  retaining.add(store)
  // New receipts can match local evidence within 30s of the raw retention floor. The
  // last displayed check and all of its candidate peer prices retain the old 24h lifetime.
  store.onPrune((db, { now }) => {
    db.prepare('DELETE FROM engine_latest WHERE srcTs<?').run(now - DAY)
    db.prepare('DELETE FROM engine_last_spot WHERE srcTs<?').run(now - DAY)
    const cutoff = now - 2 * 3_600_000 - 30_000
    db.prepare(`DELETE FROM engine_spot_checks AS c WHERE c.srcTs<? AND NOT EXISTS (
      SELECT 1 FROM obs o JOIN engine_last_spot h ON h.market=o.market
      WHERE o.id=c.localId AND h.localId=c.localId AND h.reporter=c.reporter)`).run(cutoff)
    db.prepare(`DELETE FROM engine_checks WHERE obsId IN (
      SELECT o.id FROM engine_checks c JOIN obs o ON o.id=c.obsId
      LEFT JOIN engine_last_spot h ON h.market=o.market AND h.reporter=o.reporter
        AND h.srcTs BETWEEN o.srcTs-30000 AND coalesce(o.lastTs,o.srcTs)+30000
      WHERE coalesce(o.lastTs,o.srcTs)<? AND h.localId IS NULL)`).run(cutoff)
  })
}
const deviation = (price, local) => Math.abs(Number(price) / Number(local) - 1)

/** Charge accepted rows by local arrival. Each active key owns at least one of the global slots. */
class UnprovenIngest {
  batches = []
  keys = new Map()
  used = 0
  dropSeconds = new Array(3600)

  admit(key, requested, now) {
    let expired = 0
    for (const batch of this.batches) {
      if (batch.at > now - MARKET_POLICY.ingestWindow) break
      this.used -= batch.count
      const remaining = this.keys.get(batch.key) - batch.count
      if (remaining) this.keys.set(batch.key, remaining)
      else this.keys.delete(batch.key)
      expired++
    }
    if (expired) this.batches.splice(0, expired)
    const used = this.keys.get(key) ?? 0
    const count = Math.min(requested, MARKET_POLICY.unprovenPerKey - used, MARKET_POLICY.unprovenTotal - this.used)
    if (count) {
      this.keys.delete(key)
      this.keys.set(key, used + count)
      this.batches.push({ at: now, key, count })
      this.used += count
    }
    if (count < requested) {
      const second = Math.floor(now / 1000), slot = second % this.dropSeconds.length
      if (this.dropSeconds[slot]?.second !== second) this.dropSeconds[slot] = { second, count: 0 }
      this.dropSeconds[slot].count += requested - count
    }
    return count
  }

  dropped1h(now) {
    const cutoff = Math.floor(now / 1000) - this.dropSeconds.length
    return this.dropSeconds.reduce((sum, bucket) => sum + (bucket.second > cutoff ? bucket.count : 0), 0)
  }
}

export class MarketBook {
  constructor({ store, registry, ownKey, clock, followed, siblings = new Map(), onPrice = () => {}, onDisagreement = () => {} }) {
    // siblings (`priceSiblings`): a quote deployment without a price of its own borrows a signed sibling's as its USD rate.
    Object.assign(this, { store, registry, ownKey, clock, siblings, onPrice, onDisagreement })
    this.snapshots = new Map()
    /** @type {Map<string, import('./volume-guard.js').Suspect>} market → why its reported volume is not counted */
    this.volumeSuspects = new Map()
    this.marketPrices = new Map()
    this.halted = marketHalts(registry)
    this.dirty = true
    this.refreshed = -Infinity
    this.maxStaleMs = 0
    this.rebuildMs = 0
    this.unprovenIngest = new UnprovenIngest()
    store.trackMarketActivity(clock, store.onPrune)
    retainComparisons(store)
    const db = store.writer
    const hasFollows = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='follows'").get()
    const follows = hasFollows && db.prepare('SELECT 1 FROM follows WHERE key=?')
    this.followed = followed ?? (key => !!(follows && follows.get(key)))
    this.covered = new Map()
    this.updateLatest = db.prepare(`INSERT INTO engine_latest(market, reporter, srcTs, obsId)
      VALUES (?,?,?,?)
      ON CONFLICT(market,reporter) DO UPDATE SET srcTs=excluded.srcTs,obsId=excluded.obsId
      WHERE excluded.srcTs > engine_latest.srcTs`)
    // engine_latest joined to its observations, kept in memory as market → reporter → row. Re-reading all of it on every
    // rebuild was ~60% of a 1.1-1.7 s rebuild at 179k rows (owner node 11-20) and blocked every request meanwhile.
    // Every writer mirrors into it: ingest (after its transaction commits), the 24 h prune, a re-mapped market.
    this.latest = null
    this.latestChecked = -Infinity
    this.latestReloads = 0
    this.latestAll = db.prepare(`SELECT l.market,l.reporter,l.srcTs,l.obsId,o.price,o.bid,o.ask,o.baseVol24h,o.quoteVol24hUsd
      FROM engine_latest l JOIN obs o ON o.id=l.obsId ORDER BY l.obsId`)
    this.latestSums = db.prepare(`SELECT count(*) AS n,coalesce(sum(srcTs % ${SUM_MOD}),0) AS ts,
      coalesce(sum(obsId % ${SUM_MOD}),0) AS ids FROM engine_latest`)
    store.onPrune((_db, { now }) => this.forgetLatest(now - DAY))
    registry.latestCleared?.add((market) => this.latest?.delete(market))
    this.peers = db.prepare(`SELECT o.id,o.price,o.reporter,o.market,l.srcTs,o.ordinal,coalesce(o.seq,o.id) AS seq FROM engine_latest l JOIN obs o ON o.id=l.obsId
      WHERE l.market=? AND l.srcTs BETWEEN ? AND ? AND l.reporter<>?`)
    this.check = db.prepare(`INSERT INTO engine_checks VALUES (:id,mark_receipt(NULL,:ordinal))
      ON CONFLICT(obsId) DO UPDATE SET hits=mark_receipt(hits,:ordinal) WHERE NOT receipt_checked(hits,:ordinal)`)
    this.spot = db.prepare(`INSERT INTO engine_spot_checks(localId,reporter,hits,srcTs,price)
      VALUES (:localId,:reporter,mark_receipt(NULL,:ordinal),:srcTs,:price) ON CONFLICT(localId,reporter) DO UPDATE SET
      hits=mark_receipt(hits,:ordinal),price=CASE WHEN excluded.srcTs>srcTs THEN excluded.price ELSE price END,
      srcTs=max(srcTs,excluded.srcTs) WHERE NOT receipt_checked(hits,:ordinal)`)
    this.firstStrike = db.prepare(`UPDATE engine_spot_checks SET struck=mark_receipt(struck,:ordinal)
      WHERE localId=:localId AND reporter=:reporter AND NOT receipt_checked(struck,:ordinal)`)
    this.lastSpot = db.prepare(`INSERT INTO engine_last_spot VALUES (?,?,?,?,?) ON CONFLICT(market) DO UPDATE SET
      localId=excluded.localId,reporter=excluded.reporter,srcTs=excluded.srcTs,seq=excluded.seq
      WHERE (excluded.srcTs,excluded.seq)>(srcTs,seq)
        OR ((excluded.srcTs,excluded.seq)=(srcTs,seq) AND excluded.reporter<reporter)`)
    this.lastOwn = db.prepare(`SELECT o.price,l.srcTs FROM engine_latest l JOIN obs o ON o.id=l.obsId
      WHERE l.market=? AND l.reporter=?`)
    this.reputation = db.prepare('SELECT * FROM reporters WHERE key=?')
    this.standing = db.prepare('SELECT agreements FROM engine_standing WHERE reporter=?')
    this.agree = db.prepare(`INSERT INTO engine_standing VALUES (?,1,?,?) ON CONFLICT(reporter) DO UPDATE
      SET agreements=min(agreements+1,?),checkedAt=excluded.checkedAt,lastObs=excluded.lastObs
      WHERE excluded.checkedAt>=checkedAt+60000 AND excluded.lastObs<>lastObs`)
    this.resetStanding = db.prepare('UPDATE engine_standing SET agreements=0,checkedAt=? WHERE reporter=?')
    // Strikes after an expired mute start again at 1; :mute is the new mute's end or 0.
    this.recordStrike = db.prepare(`INSERT INTO reporters(key,strikes,mutedUntil) VALUES (:key,1,:mute)
      ON CONFLICT(key) DO UPDATE SET strikes=CASE WHEN mutedUntil>0 AND mutedUntil<=:now THEN 1 ELSE min(strikes+1,1000) END,
      mutedUntil=CASE WHEN :mute>0 THEN :mute WHEN mutedUntil<=:now THEN 0 ELSE mutedUntil END`)
    // An agreeing check takes one strike back.
    this.forgive = db.prepare('UPDATE reporters SET strikes=strikes-1 WHERE key=? AND strikes>0')
    // A single disagreement costs one step of standing; a mute resets it.
    this.loseStanding = db.prepare('UPDATE engine_standing SET agreements=max(agreements-1,0),checkedAt=? WHERE reporter=?')
    this.checkLog = new Map()
    this.dropHistory = db.prepare('DELETE FROM candles WHERE asset=?')
    this.historyBreaks = new Map()
    this.historyResets = new Map()
    this.history = db.prepare(`SELECT CASE WHEN lastTs<=? THEN close ELSE open END AS close FROM candles
      WHERE asset=? AND tf=? AND firstTs<=? AND ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT 1`)
    this.referenceRows = db.prepare('SELECT * FROM engine_references WHERE at>=? ORDER BY asset,provider')
    this.persistedPrices = db.prepare(`SELECT p.*,s.staleSince FROM prices p
      LEFT JOIN store_market_list s ON s.asset=p.asset`)
    this.dropNewerPrice = db.prepare('DELETE FROM prices WHERE asset=? AND at>?')
    this.dropPrice = db.prepare('DELETE FROM prices WHERE asset=?')
    this.rebuilding = null
    this.rebuildTimer = null
    this.rebuildError = null
    this.stopped = false
    this.sliceMs = SLICE_MS
    this.poolDepths = db.prepare(`SELECT m.base,m.quote,p.liquidity FROM pools p
      JOIN markets m ON m.id='dex:'||p.chain||':'||p.pool WHERE p.liquidity IS NOT NULL`)
  }
  coverage(id, window) {
    if (this.halted.has(id)) return 0
    const now = this.clock()
    let cache = this.covered.get(window)
    // Coverage steers the scheduler; windows are minutes long. Recounting every second cost ~15% of a busy node's
    // main thread (profile 11-19 15:40).
    if (!cache || now - cache.at >= COVERAGE_TTL_MS) {
      const eligible = new Map()
      cache = { at: now, eligible, stale: new Set(), markets: this.countCoverage(now - window, now, eligible) }
      this.covered.set(window, cache)
    } else if (cache.stale.delete(id)) {
      const n = this.countMarket(id, now - window, now, cache.eligible)
      if (n) cache.markets.set(id, n)
      else cache.markets.delete(id)
    }
    return cache.markets.get(id) ?? 0
  }
  /** Rows per market since `since` from unmuted, weighted reporters that are this node or proven; a local-only market
   * counts this node's own row. Counted from the in-memory latest rows: the engine_latest query took ~70 ms and every
   * ingest clears the cache (11-20 profile: 37 recounts in 20 s, 13% of the main thread). */
  countCoverage(since, now, eligible = new Map()) {
    if (!this.latest) this.checkLatest(now)
    const counted = new Map()
    for (const market of this.latest.keys()) {
      const n = this.countMarket(market, since, now, eligible)
      if (n) counted.set(market, n)
    }
    return counted
  }
  countMarket(market, since, now, eligible) {
    let n = 0, own = 0
    for (const [reporter, row] of this.latest.get(market) ?? []) {
      if (row.srcTs < since) continue
      let ok = eligible.get(reporter)
      if (ok === undefined) {
        const r = this.reputation.get(reporter)
        ok = (r?.mutedUntil ?? 0) <= now && (r?.weight ?? 1) > 0 &&
          (reporter === this.ownKey || (this.standing.get(reporter)?.agreements ?? 0) >= PROVEN)
        eligible.set(reporter, ok)
      }
      if (!ok) continue
      n++
      if (reporter === this.ownKey) own = 1
    }
    return n && this.localOnly(market) ? own : n
  }
  /** A reporter's standing moved: counts that left it out are recounted (a strike clears the cache outright). */
  standingChanged(reporter) {
    for (const cache of this.covered.values()) {
      if (cache.eligible.get(reporter) === false) {
        this.covered.clear()
        return
      }
    }
  }
  /** After an ingest: only the markets it changed are re-counted, when next asked (a full recount waits for the cache
   * TTL). Clearing the whole cache on every ingest re-counted all 39k markets about twice a second. */
  updateCoverage(markets) {
    for (const cache of this.covered.values()) for (const id of markets) cache.stale.add(id)
  }
  /** This node's own fresh read of a USD- or stablecoin-quoted CEX market: the venue's last / 24 h open. */
  dayRatio(market, now) {
    if (market.exchange === 'subtensor') {
      // A subnet pool's 24 h move in TAO times TAO's own 24 h move gives its move in USD.
      const tick = this.subnetTicks?.get(market.id), tao = this.snapshots.get('bittensor:native')?.change24h
      return tick?.ratio > 0 && now - tick.at <= DAY_TICK_MS && Number.isFinite(tao) ? tick.ratio * (1 + tao / 100) : null
    }
    if (market.kind !== 'cex' || !(market.quote === 'fiat:USD' || this.registry.assets.get(market.quote)?.stable)) return null
    const tick = this.registry.venues.get(market.exchange)?.lastTickers?.get(market.id)
    return tick?.dayRatio > 0 && now - tick.at <= DAY_TICK_MS ? tick.dayRatio : null
  }
  muted(key) {
    return (this.reputation.get(key)?.mutedUntil ?? 0) > this.clock()
  }
  localOnly(id) {
    const market = this.registry.markets.get(id)
    return market?.kind === 'cex' && this.registry.venues.get(market.exchange)?.publishMarketData === false
  }
  isProven(key) {
    return (this.standing.get(key)?.agreements ?? 0) >= PROVEN && !this.muted(key)
  }
  hintStanding(key) {
    return (this.standing.get(key)?.agreements ?? 0) + (this.followed(key) ? 0.25 : 0) -
      (this.reputation.get(key)?.strikes ?? 0)
  }
  requestCheck(market, row, local) {
    const { window } = coverageTarget(this.registry.marketRank(this.registry.markets.get(market)))
    if (Math.min(row.srcTs, local.srcTs) >= this.clock() - window) this.onDisagreement(market)
  }
  compare(market, row, local) {
    if (!row || !local || this.muted(row.reporter)) return
    const now = this.clock()
    const difference = deviation(row.price, local.price)
    const fresh = Math.abs(now - local.srcTs) <= 30_000
    if (difference > 0.03 + 1e-12) this.requestCheck(market, row, local)
    const unchecked = this.check.run({ id: row.id, ordinal: row.ordinal }).changes
    const spot = { localId: local.id, reporter: row.reporter, ordinal: local.ordinal }
    const newSpot = this.spot.run({ ...spot, srcTs: local.srcTs, price: local.price }).changes
    if (newSpot) this.lastSpot.run(market, local.id, row.reporter, local.srcTs, local.seq)
    if (difference > 0.03 + 1e-12) {
      if (!unchecked || !this.firstStrike.run(spot).changes) return
      const mute = this.noteCheck(row.reporter, true, now)
      this.recordStrike.run({ key: row.reporter, mute: mute ? now + DAY : 0, now })
      if (mute) this.resetStanding.run(now, row.reporter)
      else this.loseStanding.run(now, row.reporter)
      this.covered.clear()
    } else if (newSpot) {
      this.noteCheck(row.reporter, false, now)
      this.forgive.run(row.reporter)
      // Only an observation already on file before our independent read can earn credit.
      if (fresh && row.seq < local.seq && difference <= 0.01 + 1e-12 &&
          this.agree.run(row.reporter, now, row.seq, PROVEN).changes) this.standingChanged(row.reporter)
    }
  }
  /** Record one check of a peer in its rolling hour; true when its disagreements now call for a data mute. */
  noteCheck(reporter, bad, now) {
    let log = this.checkLog.get(reporter)
    if (!log) this.checkLog.set(reporter, log = { at: [], bad: [], strikes: 0 })
    log.at.push(now)
    log.bad.push(bad)
    if (bad) log.strikes++
    while (log.at.length && (log.at[0] < now - STRIKE_WINDOW_MS || log.at.length > CHECK_LOG_CAP)) {
      log.at.shift()
      if (log.bad.shift()) log.strikes--
    }
    return bad && log.strikes >= MUTE_STRIKES && log.strikes >= MUTE_SHARE * log.at.length
  }
  ingest(reporter, wireRows, own, localQuoteVolumes) {
    const now = this.clock()
    if (this.muted(reporter)) return
    if (reporter !== this.ownKey && !this.isProven(reporter)) {
      const count = this.unprovenIngest.admit(reporter, wireRows.length, now)
      if (!count) return
      if (count < wireRows.length) wireRows = wireRows.slice(0, count)
    }
    if (!own || this.halted.size) wireRows = wireRows.filter(([id, , , , bid, ask]) => {
      const market = this.registry.markets.get(id)
      return !this.halted.has(id) && !(market?.kind === 'cex' &&
        zeroTickerBook(this.registry.venues.get(market.exchange), bid, ask))
    })
    if (!wireRows.length) return
    this.store.maintainObservations(now)
    const rows = wireRows.map(row => {
      const [market, price, baseVol, quoteVol, bid, ask, srcTs] = row
      const quote = this.registry.markets.get(market).quote
      const fx = this.snapshots.get(quote)
      const turnover = localQuoteVolumes?.get(row)
      const rate =
        quote === 'fiat:USD'
          ? 1
          : fx && !fx.why.stale && fx.why.fresh && Math.abs(srcTs - fx.at) <= 30000
            ? fx.price
            : null
      return {
        market,
        price,
        srcTs,
        at: now,
        reporter,
        baseVol24h: decimal(baseVol),
        quoteVol24hUsd: decimal(quoteVol) ?? (turnover != null && fx?.why.fresh &&
          (fx.why.provenSources > 0 || fx.why.referenceProviders?.length)
          ? multiplyPrice(turnover, fx.priceText ?? fx.price) : null),
        bid: decimal(bid),
        ask: decimal(ask),
        priceUsd: rate === 1 ? price : rate ? multiplyPrice(price, fx.priceText ?? rate) : null,
      }
    })
    const latest = []
    this.store.transaction(() => {
      const activity = new Map()
      const accepted = this.store.insertObservations(rows, row => {
        const { market, srcTs } = row
        if (this.updateLatest.run(market, reporter, srcTs, row.id).changes) latest.push(row)
        const { base, quote } = this.registry.markets.get(market)
        for (const id of [base, quote]) {
          if (this.registry.assets.has(id)) activity.set(id, Math.max(srcTs, activity.get(id) ?? 0))
        }
        // Match actual source times. Repeated envelopes and spot checks of the same remote
        // observation cannot accumulate strikes. A later local read also checks earlier peers.
        const min = srcTs - 30_000,
          max = srcTs + 30_000
        if (own) {
          for (const peer of this.peers.all(market, min, max, this.ownKey)) this.compare(market, peer, row)
        } else {
          const local = this.store.nearestObservation(market, this.ownKey, srcTs, 30_000, true)
          const peer = row
          if (local) this.compare(market, peer, local)
          else {
            const latest = this.lastOwn.get(market, this.ownKey)
            if (latest && peer && deviation(peer.price, latest.price) > 0.03 + 1e-12)
              this.requestCheck(market, peer, latest)
          }
        }
      })
      if (!accepted) return
      for (const [id, at] of activity) this.store.recordMarketActivity(id, at)
      this.dirty = true
    })
    for (const row of latest) this.setLatest(reporter, row)
    if (latest.length) this.updateCoverage(new Set(latest.map(row => row.market)))
  }
  setLatest(reporter, row) {
    if (!this.latest) return
    let rows = this.latest.get(row.market)
    if (!rows) this.latest.set(row.market, rows = new Map())
    rows.set(reporter, { srcTs: row.srcTs, obsId: row.id, price: row.price, bid: row.bid, ask: row.ask,
      baseVol24h: row.baseVol24h, quoteVol24hUsd: row.quoteVol24hUsd })
  }
  /** Mirror of the prune hook's `DELETE FROM engine_latest WHERE srcTs<?`. */
  forgetLatest(cutoff) {
    if (!this.latest) return
    for (const [market, rows] of this.latest) {
      for (const [reporter, row] of rows) if (row.srcTs < cutoff) rows.delete(reporter)
      if (!rows.size) this.latest.delete(market)
    }
  }
  /** Load the latest rows once; afterwards compare checksums every LATEST_CHECK_MS and reload on any drift. */
  checkLatest(now) {
    this.latestChecked = now
    if (this.latest) {
      const table = this.latestSums.get()
      let n = 0, ts = 0, ids = 0
      for (const rows of this.latest.values()) {
        for (const row of rows.values()) { n++; ts += row.srcTs % SUM_MOD; ids += row.obsId % SUM_MOD }
      }
      if (Number(table.n) === n && Number(table.ts) === ts && Number(table.ids) === ids) return
      this.latestReloads++
    }
    const latest = new Map()
    for (const { market, reporter, ...row } of this.latestAll.iterate()) {
      let rows = latest.get(market)
      if (!rows) latest.set(market, rows = new Map())
      rows.set(reporter, row)
    }
    this.latest = latest
  }
  classify(snapshots, now, priorStale, depthRows = this.poolDepths.all(), prices = this.marketPrices) {
    const depths = new Map(), dexAssets = new Set(), tradedOnDex = new Set(), supportedCex = new Set()
    const supported = new Set(), zeroTurnover = new Map(), lastMarketExpiry = new Map()
    for (const { base, quote, liquidity } of depthRows) {
      for (const id of [base, quote]) depths.set(id, Math.max(depths.get(id) ?? 0, liquidity))
    }
    for (const m of this.registry.markets.values()) {
      if (m.kind === 'dex') { dexAssets.add(m.base); dexAssets.add(m.quote) }
    }
    for (const m of prices.values()) {
      lastMarketExpiry.set(m.base, Math.max(lastMarketExpiry.get(m.base) ?? 0, m.at + 3 * m.window))
      if (!m.provenAgents.length || now - m.at > Math.min(3 * m.window, MARKET_POLICY.maxPriceAge)) continue
      if (m.kind === 'cex') {
        supportedCex.add(m.base)
        supportedCex.add(m.quote)
      } else if (m.kind === 'dex' && (m.baseVolume > 0 || m.usdVolume > 0)) {
        tradedOnDex.add(m.base)
        tradedOnDex.add(m.quote)
      }
      const fx = snapshots.get(m.quote)
      if (m.quote !== 'fiat:USD' && !(fx && !fx.why.stale && now - fx.at <= MARKET_POLICY.maxPriceAge &&
          (fx.why.provenSources || fx.why.referenceProviders?.length))) continue
      supported.add(m.base)
      // The aggregate's fresh-source count expires at one target window. A supported quote
      // with zero measured turnover can still establish the price until that market goes stale.
      if (!(m.usdVolume ?? m.baseVolume) && !(fx?.why.spreadPct > 3)) {
        const usd = m.price * (fx?.price ?? 1)
        const range = zeroTurnover.get(m.base) ?? [usd, usd]
        zeroTurnover.set(m.base, [Math.min(range[0], usd), Math.max(range[1], usd)])
      }
    }
    for (const p of snapshots.values()) {
      p.staleSince = null
      const range = zeroTurnover.get(p.asset)
      const confirmed = p.why.provenSources > 0 || p.why.referenceProviders?.length > 0 ||
        (supported.has(p.asset) && (p.why.provenVolume24h > 0 || p.why.suspectVolume24h > 0)) ||
        (!p.why.fresh && range && p.price >= range[0] * (1 - 1e-12) && p.price <= range[1] * (1 + 1e-12))
      if (p.why.stale || now - p.at > MARKET_POLICY.maxPriceAge) {
        p.visibility = 'stale'
        p.staleSince = Math.min(priorStale.get(p.asset) ?? now, p.at + MARKET_POLICY.maxPriceAge,
          lastMarketExpiry.get(p.asset) ?? now)
      } else if (!confirmed) {
        p.visibility = 'unconfirmed'
      } else if (dexAssets.has(p.asset) && !supportedCex.has(p.asset) &&
          (!(p.volume24h > 0 || tradedOnDex.has(p.asset)) ||
            (depths.has(p.asset) && depths.get(p.asset) < MARKET_POLICY.minPoolLiquidityUsd))) {
        p.visibility = 'dust'
      } else {
        p.visibility = 'live'
      }
    }
  }
  /** Volume plausibility (volume-guard.js) on the current market medians, valued at the previous rebuild's rates. */
  guardVolumes(prices = this.marketPrices) {
    const snapshots = this.snapshots
    const rows = []
    for (const p of prices.values()) {
      const evidence = p.kind === 'cex' ? this.registry.venues.get(p.exchange)?.volumeEvidence?.get(p.id) : null
      const rate = evidence?.book ? quoteRate(snapshots, p.quote) : null
      rows.push({ id: p.id, kind: p.kind, exchange: p.exchange ?? null, base: p.base, quote: p.quote,
        volume: marketUsdVolume(p, snapshots), stock: evidence?.stock === true,
        stable: !!this.registry.assets.get(p.base)?.stable, bookUsd: rate ? evidence.book * rate : null })
    }
    return volumeSuspects(rows, { capUsd: this.guardCap ?? (id => snapshots.get(id)?.marketCap ?? null) })
  }
  refresh() {
    const now = this.clock()
    for (const venue of this.registry.venues.values()) venue.contracts?.expire(now)
    const halted = this.haltRevision !== this.registry.haltRevision
    // New observations mark the book dirty many times a second on a busy node. With reuse enabled (maxStaleMs > 0, the
    // app) a read returns the last rebuild while it is younger than READ_LIMIT_MS and leaves a due rebuild to the
    // background; maxStaleMs 0 (tests) rebuilds at once. Freshness counts from the END of a rebuild: counted from its
    // start, a rebuild longer than the 1 s clean window was stale on arrival (11-20: USDT page 68 s, ~50 rebuilds).
    if (this.maxStaleMs > 0 && !this.rebuildError && this.refreshed > -Infinity) {
      // A changed halt set (venue reads flip halts constantly with ~80 venues) starts a background rebuild at once; it
      // used to force a synchronous rebuild into the read (owner node 11-20: 0.8-1.3 s requests). So does a rebuild
      // older than READ_LIMIT_MS: the read still answers from the last one instead of freezing the daemon.
      const age = now - this.refreshed
      if (halted || age >= READ_LIMIT_MS) this.scheduleRebuild(true)
      else if (age >= (this.dirty ? this.maxStaleMs : 1000)) this.scheduleRebuild()
      return this.snapshots
    }
    if (!halted && now - this.refreshed < (this.dirty ? this.maxStaleMs : 1000)) return this.snapshots
    return this.rebuildNow(now)
  }
  /** A background rebuild, spaced so rebuilds take at most ~1/(1+REBUILD_SPACING) of the main thread. */
  scheduleRebuild(soon = false) {
    if (this.rebuilding || this.stopped || (this.rebuildTimer && !soon)) return
    clearTimeout(this.rebuildTimer)
    const wait = soon ? 0 : Math.min(SPACING_CAP_MS, Math.max(0, this.refreshed + REBUILD_SPACING * this.rebuildMs - this.clock()))
    this.rebuildTimer = setTimeout(() => { this.rebuildTimer = null; this.rebuildSliced() }, wait)
    this.rebuildTimer.unref?.()
  }
  /** Run one rebuild in slices of about SLICE_MS, yielding to the event loop in between. Shared state (medians,
   * snapshots, ranks, splits, stored prices) changes only in the last slice, so a read never sees half a rebuild.
   * A synchronous rebuild meanwhile supersedes it; an error makes the next read rebuild at once and report it. */
  rebuildSliced() {
    if (this.rebuilding || this.stopped) return
    const token = this.rebuilding = { steps: this.rebuildSteps(this.clock(), true) }
    const step = () => {
      if (this.rebuilding !== token || this.stopped) return
      try {
        if (token.steps.next().done) this.rebuilding = null
        else setImmediate(step)
      } catch (error) {
        this.rebuilding = null
        this.rebuildError = error
      }
    }
    step()
  }
  rebuildNow(now) {
    // A sliced rebuild in progress is finished first: it may have swapped its snapshots and still owe their writes.
    const pending = this.rebuilding
    this.rebuilding = null
    if (pending) while (!pending.steps.next().done);
    const steps = this.rebuildSteps(now, false)
    for (;;) {
      const { done, value } = steps.next()
      if (done) {
        this.rebuildError = null
        return value
      }
    }
  }
  stop() {
    this.stopped = true
    this.rebuilding = null
    clearTimeout(this.rebuildTimer)
    this.rebuildTimer = null
  }
  *rebuildSteps(now, sliced) {
    let busy = 0, mark = performance.now()
    // A rebuild that starts after the last one went stale takes larger slices, so readers get fresh prices sooner.
    const sliceMs = now - this.refreshed >= READ_LIMIT_MS && this.refreshed > -Infinity
      ? Math.max(this.sliceMs, STALE_SLICE_MS) : this.sliceMs
    const late = () => sliced && performance.now() - mark > sliceMs
    // Ingests during a sliced rebuild mark the book dirty again for the next one.
    if (sliced) this.dirty = false
    this.haltRevision = this.registry.haltRevision
    const referencePrices = this.registry.referencePrices(now)
    const review = this.registry.reviewSplits(now, referencePrices)
    const grouped = new Map()
    const followed = new Map()
    const observed = new Set(), haltedBases = new Set()
    if (!this.latest || now - this.latestChecked >= LATEST_CHECK_MS) this.checkLatest(now)
    const standing = new Map()
    for (const [id, rows] of this.latest) {
      const market = this.registry.markets.get(id)
      if (!market) continue
      if (late()) { busy += performance.now() - mark; yield; mark = performance.now() }
      for (const [reporter, l] of rows) {
        let s = standing.get(reporter)
        if (!s) {
          const r = this.reputation.get(reporter)
          standing.set(reporter, s = { weight: r?.weight ?? 1, strikes: r?.strikes ?? 0,
            agreements: this.standing.get(reporter)?.agreements ?? 0, mutedUntil: r?.mutedUntil ?? 0 })
        }
        if (this.halted.has(id) || (market.kind === 'cex' &&
            zeroTickerBook(this.registry.venues.get(market.exchange), l.bid, l.ask))) {
          if (s.mutedUntil <= now && s.weight > 0 &&
              (reporter === this.ownKey || (s.agreements >= PROVEN && !this.localOnly(id))))
            haltedBases.add(market.base)
          continue
        }
        observed.add(market.base)
        if (s.mutedUntil > now || s.weight <= 0) continue
        if (!grouped.has(id)) grouped.set(id, [])
        if (!followed.has(reporter)) followed.set(reporter, this.followed(reporter))
        const own = reporter === this.ownKey
        grouped.get(id).push({ market: id, reporter, srcTs: l.srcTs, price: l.price, bid: l.bid, ask: l.ask,
          baseVol24h: l.baseVol24h, quoteVol24hUsd: l.quoteVol24hUsd,
          weight: s.weight * ((followed.get(reporter) ? 1.25 : 1) / (1 + s.strikes)), strikes: s.strikes,
          agreements: s.agreements, mutedUntil: s.mutedUntil, own,
          proven: own || (s.agreements >= PROVEN && !this.localOnly(id)) })
      }
    }
    const prices = new Map()
    for (const [id, rows] of grouped) {
      if (late()) { busy += performance.now() - mark; yield; mark = performance.now() }
      const market = this.registry.markets.get(id)
      if (!market) continue
      const median = marketMedian({ ...market, rank: this.registry.marketRank(market) }, rows, now)
      if (median) prices.set(id, median)
    }
    if (late()) { busy += performance.now() - mark; yield; mark = performance.now() }
    const references = new Map()
    for (const ref of this.referenceRows.all(now - (this.referenceValidity ?? 600_000))) {
      if (!references.has(ref.asset)) references.set(ref.asset, [])
      references.get(ref.asset).push(ref)
    }
    const anchors = new Map()
    for (const [asset, refs] of references) {
      const token = this.registry.assets.get(asset),
        at = Math.min(...refs.map((r) => r.at))
      // References that disagree say nothing: their median is neither, and an anchor is a conversion rate for every
      // market quoted in the asset (11-20: DexScreener USDT $7.63 vs llama $0.999 made USDT $4.31 and turned BTC red).
      // The asset then resolves from its own markets like any other.
      const low = Math.min(...refs.map((r) => r.price)), high = Math.max(...refs.map((r) => r.price))
      if (high > low * (token?.stable ? 1 + REFERENCE_AGREEMENT.stable : 1 + REFERENCE_AGREEMENT.other)) continue
      const price = weightedMedian(refs.map((r) => ({ value: r.price, weight: 1 })))
      anchors.set(asset, {
        asset,
        at,
        price,
        volume24h: null,
        // A reference price carries no volume, so a total-based cap is not shown from it.
        marketCap: totalCapCheck(token, price * (capSupply(token) ?? NaN), null),
        fdv: token?.totalSupply == null ? null : token.totalSupply * price,
        agents: 0,
        exchanges: 0,
        trust: 'yellow',
        why: {
          agents: 0,
          provenAgents: 0,
          provenSources: 0,
          provenVolume24h: 0,
          exchanges: 0,
          pools: 0,
          independentSources: 0,
          ageMs: now - at,
          fresh: true,
          stale: false,
          spreadPct: null,
          depegs: [],
          referenceProviders: refs.map((r) => r.provider),
        },
      })
    }
    const collisions = new Map()
    const suspects = this.guardVolumes(prices)
    if (late()) { busy += performance.now() - mark; yield; mark = performance.now() }
    const aggregate = aggregateAssetsSteps(this.registry.assets, prices.values(), now, anchors,
      { pinned: m => this.registry.mapped(m), collisions, referencePrices, dayRatio: m => this.dayRatio(m, now),
        lenders: this.siblings, suspects })
    let next
    for (;;) {
      const { done, value } = aggregate.next()
      if (done) { next = value; break }
      if (late()) { busy += performance.now() - mark; yield; mark = performance.now() }
    }
    // Candle lookups for the change figures read only history written by earlier rebuilds: done before the last slice.
    const changes = [['change1h', 3600000, '1m', 120000], ['change24h', DAY, '1h', 7200000],
      ['change7d', 7 * DAY, '1h', 7200000]]
    const history = asset => changes.map(([, offset, frame, tolerance]) => {
      const cutoff = now - offset
      const width = frame === '1m' ? 60000 : 3600000
      const ts = Math.floor(cutoff / width) * width
      return this.history.get(cutoff, asset, frame, cutoff, ts - tolerance, ts) ?? null
    })
    const looked = new Map()
    for (const asset of next.keys()) {
      if (late()) { busy += performance.now() - mark; yield; mark = performance.now() }
      looked.set(asset, history(asset))
    }
    // Reads for the last slices (prices persisted by earlier rebuilds, pool depths).
    const persisted = this.persistedPrices.all(), depthRows = this.poolDepths.all()
    if (late()) { busy += performance.now() - mark; yield; mark = performance.now() }
    // Retain a last-known value after raw-history pruning. If raw evidence still exists
    // but is now ineligible (mute, missing FX), remove its cached valuation on restart too.
    const retired = []
    for (const row of persisted) {
      if (next.has(row.asset)) continue
      // A remaining fiat-only market may still trade without a live USD conversion.
      if (observed.has(row.asset) && !haltedBases.has(row.asset)) {
        retired.push(row.asset)
        continue
      }
      next.set(row.asset, {
        ...row,
        price: +row.price,
        priceText: row.price,
        trust: 'red',
        agents: 0,
        exchanges: 0,
        why: {
          agents: 0,
          provenAgents: 0,
          provenSources: 0,
          provenVolume24h: 0,
          exchanges: 0,
          pools: 0,
          independentSources: 0,
          fresh: false,
          stale: true,
          ageMs: Math.max(0, now - row.at),
          spreadPct: null,
          depegs: [],
        },
      })
    }
    // Change figures, history breaks and candle samples: this rebuild's own objects and book-private state only.
    const samples = [], drops = []
    for (const result of next.values()) {
      if (late()) { busy += performance.now() - mark; yield; mark = performance.now() }
      const day = result.dayRatio
      delete result.dayRatio
      const old = looked.get(result.asset) ?? history(result.asset)
      changes.forEach(([field], i) => {
        result[field] = old[i] && +old[i].close > 0 ? (result.price / +old[i].close - 1) * 100 : null
      })
      const off = day > 0 && result.change24h != null ? Math.abs(Math.log((1 + result.change24h / 100) / day)) : 0
      if (off > Math.log(HISTORY_BREAK_FACTOR) && !(this.historyResets.get(result.asset) > now - HISTORY_RESET_GAP_MS)) {
        const since = this.historyBreaks.get(result.asset) ?? now
        this.historyBreaks.set(result.asset, since)
        if (now - since >= HISTORY_BREAK_MS) {
          drops.push(result.asset)
          this.historyBreaks.delete(result.asset)
          this.historyResets.set(result.asset, now)
        }
      } else this.historyBreaks.delete(result.asset)
      if (day > 0 && (result.change24h == null ||
          Math.abs(Math.log((1 + result.change24h / 100) / day)) > Math.log(DAY_CHECK_FACTOR))) {
        // The history disagrees with the venues (or is missing): their move stands; the 7 d figure rests on the
        // same history, so it is withheld until it agrees again.
        if (result.change24h != null) result.change7d = null
        result.change24h = (day - 1) * 100
      }
      result.trending = Math.log1p(result.volume24h) * (1 + Math.abs(result.change24h ?? 0) / 100)
      const previous = this.snapshots.get(result.asset)
      // Candles chart the aggregated price only, never raw quotes (a dead pair would draw false wicks).
      const sample = result.priceText ?? decimal(result.price)
      if (
        sample != null &&
        result.trust !== 'red' &&
        !result.why?.stale &&
        result.at <= now &&
        (!previous || result.at !== previous.at || result.priceText !== previous.priceText)
      )
        samples.push({ asset: result.asset, price: sample, at: result.at })
    }
    // Visibility depends on the medians' base and quote, which applySplits can rebind: classified ahead of the last
    // slice unless a split is pending (rare), then after it as before.
    const splitting = this.registry.splitsPending(collisions, review)
    const priorStale = new Map(persisted.filter(p => p.staleSince != null).map(p => [p.asset, p.staleSince]))
    if (!splitting) this.classify(next, now, priorStale, depthRows, prices)
    if (late()) { busy += performance.now() - mark; yield; mark = performance.now() }
    // The last slice: everything shared changes together.
    this.marketPrices = prices
    this.volumeSuspects = suspects
    this.registry.applySplits(collisions, this.marketPrices, now, review)
    this.collisions = collisions
    if (splitting) this.classify(next, now, priorStale, depthRows, prices)
    this.registry.rankMarkets(next, this.marketPrices, now, this.volumeSuspects)
    // Stored prices are collected here and written after the swap (next slice).
    const changed = [], writes = []
    for (const result of next.values()) {
      const previous = this.snapshots.get(result.asset)
      if (
        !previous ||
        result.visibility !== previous.visibility ||
        result.staleSince !== previous.staleSince ||
        result.price !== previous.price ||
        result.priceText !== previous.priceText ||
        result.trust !== previous.trust ||
        result.at !== previous.at ||
        result.marketCap !== previous.marketCap ||
        result.fdv !== previous.fdv ||
        result.exchanges !== previous.exchanges ||
        result.agents !== previous.agents ||
        result.volume24h !== previous.volume24h ||
        result.change24h !== previous.change24h ||
        result.change1h !== previous.change1h ||
        result.change7d !== previous.change7d
      ) {
        const price = result.priceText ?? decimal(result.price)
        if (price == null) continue
        writes.push({ asset: result.asset, at: result.at, row: { ...result, price } })
        changed.push(result)
      }
    }
    this.snapshots = next
    this.refreshed = this.clock()
    if (!sliced) this.dirty = false
    if (late()) { busy += performance.now() - mark; yield; mark = performance.now() }
    // A synchronous rebuild that supersedes this one finishes it first (rebuildNow), so these writes are never lost.
    // Background rebuilds write in transactions of about one slice each: a live node changes thousands of prices and
    // candles per rebuild (owner node 11-20: one 0.4-0.7 s write). Each row stays whole; a sync rebuild writes once.
    const ops = []
    for (const asset of drops) ops.push(() => this.dropHistory.run(asset))
    // A mute or source expiry can make the newest eligible source timestamp move backwards.
    for (const { asset, at, row } of writes) ops.push(() => { this.dropNewerPrice.run(asset, at); this.store.upsertPrice(row) })
    for (let i = 0; i < samples.length; i += 200) {
      const chunk = samples.slice(i, i + 200)
      ops.push(() => this.store.recordPrices(chunk))
    }
    for (const id of retired) ops.push(() => this.dropPrice.run(id))
    for (let i = 0; i < ops.length;) {
      this.store.transaction(() => {
        while (i < ops.length) {
          ops[i++]()
          if (late()) break
        }
      })
      if (i < ops.length) { busy += performance.now() - mark; yield; mark = performance.now() }
    }
    this.rebuildMs = busy + performance.now() - mark
    for (const result of changed) this.onPrice(result)
    return next
  }
}
