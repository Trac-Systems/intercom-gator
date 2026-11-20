import { MARKET_POLICY } from '../../../store/src/markets.js'
import { multiplyPrice } from './decimal.js'
import { aggregateAssets, capSupply, marketMedian, totalCapCheck, weightedMedian } from './index.js'
import { decimal } from '../obs/index.js'
import { coverageTarget } from '../scheduler/index.js'
import { zeroTickerBook, marketHalts } from '../sources/cex.js'

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
  constructor({ store, registry, ownKey, clock, followed, onPrice = () => {}, onDisagreement = () => {} }) {
    Object.assign(this, { store, registry, ownKey, clock, onPrice, onDisagreement })
    this.snapshots = new Map()
    this.marketPrices = new Map()
    this.halted = marketHalts(registry)
    this.dirty = true
    this.refreshed = -Infinity
    this.maxStaleMs = 0
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
    this.latestRows = db.prepare(`SELECT l.market,l.reporter,l.srcTs,o.price,o.bid,o.ask,o.baseVol24h,o.quoteVol24hUsd,coalesce(r.weight,1) AS weight, coalesce(r.strikes,0) AS strikes,
      coalesce(s.agreements,0) AS agreements, coalesce(r.mutedUntil,0) AS mutedUntil
      FROM engine_latest l JOIN obs o ON o.id=l.obsId LEFT JOIN reporters r ON r.key=l.reporter
      LEFT JOIN engine_standing s ON s.reporter=l.reporter`)
    this.count =
      db.prepare(`SELECT market,count(*) AS n,max(l.reporter=?) AS own FROM engine_latest l LEFT JOIN reporters r ON r.key=l.reporter
      LEFT JOIN engine_standing s ON s.reporter=l.reporter
      WHERE srcTs>=? AND coalesce(r.mutedUntil,0)<=? AND coalesce(r.weight,1)>0
        AND (l.reporter=? OR s.agreements>=?) GROUP BY market`)
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
    this.recordStrike = db.prepare(`INSERT INTO reporters(key,strikes,mutedUntil) VALUES (?,1,0)
      ON CONFLICT(key) DO UPDATE SET strikes=CASE WHEN mutedUntil>0 THEN 1 ELSE strikes+1 END,
      mutedUntil=CASE WHEN mutedUntil=0 AND strikes+1>=5 THEN ? ELSE 0 END`)
    this.dropHistory = db.prepare('DELETE FROM candles WHERE asset=?')
    this.historyBreaks = new Map()
    this.historyResets = new Map()
    this.history = db.prepare(`SELECT CASE WHEN lastTs<=? THEN close ELSE open END AS close FROM candles
      WHERE asset=? AND tf=? AND firstTs<=? AND ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT 1`)
    this.referenceRows = db.prepare('SELECT * FROM engine_references WHERE at>=? ORDER BY asset,provider')
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
      const rows = this.count.all(this.ownKey, now - window, now, this.ownKey, PROVEN)
      cache = { at: now, markets: new Map(rows.map(r => [r.market, this.localOnly(r.market) ? r.own : r.n])) }
      this.covered.set(window, cache)
    }
    return cache.markets.get(id) ?? 0
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
      this.recordStrike.run(row.reporter, now + DAY)
      this.resetStanding.run(now, row.reporter)
    } else if (newSpot && fresh && row.seq < local.seq && difference <= 0.01 + 1e-12) {
      // Only an observation already on file before our independent read can earn credit.
      this.agree.run(row.reporter, now, row.seq, PROVEN)
    }
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
    this.store.transaction(() => {
      const activity = new Map()
      const accepted = this.store.insertObservations(rows, row => {
        const { market, srcTs } = row
        this.updateLatest.run(market, reporter, srcTs, row.id)
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
      this.covered.clear()
    })
  }
  classify(snapshots, now, priorStale) {
    const depths = new Map(), dexAssets = new Set(), tradedOnDex = new Set(), supportedCex = new Set()
    const supported = new Set(), zeroTurnover = new Map(), lastMarketExpiry = new Map()
    for (const { base, quote, liquidity } of this.poolDepths.iterate()) {
      for (const id of [base, quote]) depths.set(id, Math.max(depths.get(id) ?? 0, liquidity))
    }
    for (const m of this.registry.markets.values()) {
      if (m.kind === 'dex') { dexAssets.add(m.base); dexAssets.add(m.quote) }
    }
    for (const m of this.marketPrices.values()) {
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
        (supported.has(p.asset) && p.why.provenVolume24h > 0) ||
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
  refresh() {
    const now = this.clock()
    for (const venue of this.registry.venues.values()) venue.contracts?.expire(now)
    // New observations mark the book dirty many times a second on a busy node. A read may use a rebuild up to
    // maxStaleMs old instead of rebuilding (~0.4 s) inside every request; 0 rebuilds at once.
    if (this.haltRevision === this.registry.haltRevision &&
        now - this.refreshed < (this.dirty ? this.maxStaleMs : 1000)) return this.snapshots
    this.haltRevision = this.registry.haltRevision
    const referencePrices = this.registry.referencePrices(now)
    const review = this.registry.reviewSplits(now, referencePrices)
    const grouped = new Map()
    const followed = new Map()
    const observed = new Set(), haltedBases = new Set()
    for (const r of this.latestRows.iterate()) {
      const market = this.registry.markets.get(r.market)
      if (!market) continue
      if (this.halted.has(r.market) || (market.kind === 'cex' &&
          zeroTickerBook(this.registry.venues.get(market.exchange), r.bid, r.ask))) {
        if (r.mutedUntil <= now && r.weight > 0 &&
            (r.reporter === this.ownKey || (r.agreements >= PROVEN && !this.localOnly(r.market))))
          haltedBases.add(market.base)
        continue
      }
      observed.add(market.base)
      if (r.mutedUntil > now || r.weight <= 0) continue
      if (!grouped.has(r.market)) grouped.set(r.market, [])
      if (!followed.has(r.reporter)) followed.set(r.reporter, this.followed(r.reporter))
      r.weight *= (followed.get(r.reporter) ? 1.25 : 1) / (1 + r.strikes)
      r.own = r.reporter === this.ownKey
      r.proven = r.own || (r.agreements >= PROVEN && !this.localOnly(r.market))
      grouped.get(r.market).push(r)
    }
    this.marketPrices.clear()
    for (const [id, rows] of grouped) {
      const market = this.registry.markets.get(id)
      if (!market) continue
      const median = marketMedian({ ...market, rank: this.registry.marketRank(market) }, rows, now)
      if (median) this.marketPrices.set(id, median)
    }
    const references = new Map()
    for (const ref of this.referenceRows.all(now - (this.referenceValidity ?? 600_000))) {
      if (!references.has(ref.asset)) references.set(ref.asset, [])
      references.get(ref.asset).push(ref)
    }
    const anchors = new Map()
    for (const [asset, refs] of references) {
      const price = weightedMedian(refs.map((r) => ({ value: r.price, weight: 1 })))
      const token = this.registry.assets.get(asset),
        at = Math.min(...refs.map((r) => r.at))
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
    const next = aggregateAssets(this.registry.assets, this.marketPrices.values(), now, anchors,
      { pinned: m => this.registry.mapped(m), collisions, referencePrices, dayRatio: m => this.dayRatio(m, now) })
    this.registry.applySplits(collisions, this.marketPrices, now, review)
    this.collisions = collisions
    // Retain a last-known value after raw-history pruning. If raw evidence still exists
    // but is now ineligible (mute, missing FX), remove its cached valuation on restart too.
    const persisted = this.store.writer.prepare(`SELECT p.*,s.staleSince FROM prices p
      LEFT JOIN store_market_list s ON s.asset=p.asset`).all()
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
    this.classify(next, now, new Map(persisted.filter(p => p.staleSince != null).map(p => [p.asset, p.staleSince])))
    this.registry.rankMarkets(next, this.marketPrices, now)
    const changed = []
    this.store.transaction(() => {
      const samples = []
      for (const result of next.values()) {
        const day = result.dayRatio
        delete result.dayRatio
        for (const [field, offset, frame, tolerance] of [
          ['change1h', 3600000, '1m', 120000],
          ['change24h', DAY, '1h', 7200000],
          ['change7d', 7 * DAY, '1h', 7200000],
        ]) {
          const cutoff = now - offset
          const width = frame === '1m' ? 60000 : 3600000
          const ts = Math.floor(cutoff / width) * width
          const old = this.history.get(cutoff, result.asset, frame, cutoff, ts - tolerance, ts)
          result[field] = old && +old.close > 0 ? (result.price / +old.close - 1) * 100 : null
        }
        const off = day > 0 && result.change24h != null ? Math.abs(Math.log((1 + result.change24h / 100) / day)) : 0
        if (off > Math.log(HISTORY_BREAK_FACTOR) && !(this.historyResets.get(result.asset) > now - HISTORY_RESET_GAP_MS)) {
          const since = this.historyBreaks.get(result.asset) ?? now
          this.historyBreaks.set(result.asset, since)
          if (now - since >= HISTORY_BREAK_MS) {
            this.dropHistory.run(result.asset)
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
          // A mute or source expiry can make the newest eligible source timestamp move backwards.
          this.store.writer.prepare('DELETE FROM prices WHERE asset=? AND at>?').run(result.asset, result.at)
          this.store.upsertPrice({ ...result, price })
          changed.push(result)
        }
      }
      if (samples.length) this.store.recordPrices(samples)
      for (const id of retired) this.store.writer.prepare('DELETE FROM prices WHERE asset=?').run(id)
    })
    this.snapshots = next
    this.refreshed = now
    this.dirty = false
    for (const result of changed) this.onPrice(result)
    return next
  }
}
