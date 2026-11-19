import { decimal, symbolPattern } from '../obs/index.js'
import { RateLimited } from '../scheduler/index.js'
import { DAY } from './supply-api.js'
import { scaledSupply } from './supply-claims.js'

const sources = { binance: 'binance-products', coinbase: 'coinbase-assets' }
const quotes = ['USD', 'USDC', 'USDT']
const ttl = 2 * DAY
export const isReported = row => row?.method === 'exchange-reported'

function symbol(raw) {
  if (typeof raw !== 'string' || raw.length > 32) return null
  const upper = raw.toUpperCase()
  return symbolPattern.test(upper) ? upper : null
}

/** Keep only the fields needed to check a completed source snapshot again after a restart. */
function readPage(venue, data, at) {
  if (!Array.isArray(data?.data) || data.data.length > (venue === 'binance' ? 10_000 : 100))
    throw new Error('Invalid exchange supply list')
  const rows = []
  for (const row of data.data) {
    const binance = venue === 'binance'
    const value = decimal(binance ? row?.cs : row?.circulating_supply)
    if (!(scaledSupply(value) > 0n)) continue
    const base = symbol(binance ? row?.b : row?.symbol), quote = binance ? symbol(row?.q) : null
    if (base && (!binance || quote)) rows.push([base, quote, value])
  }
  return { at, rows }
}

function boundAsset(engine, venue, base, quote) {
  const { registry, book } = engine
  let bound
  for (const q of quote ? [quote] : quotes) {
    const key = 'cex:' + venue + ':' + base + '-' + q
    const id = registry.markets.get(key)?.base
    if (!registry.assets.has(id) || book.snapshots.get(id)?.why?.outliers?.includes(key) ||
        book.collisions?.get(id)?.detached?.some(d => d.key === venue + ':' + base)) continue
    if (bound && bound !== id) return null
    bound = id
  }
  return bound
}

/** Recheck both source snapshots against current bindings and local totals. Never register a market here. */
function checkedReadings(engine, pages, local, counts) {
  const byAsset = new Map(), aboveTotal = new Set()
  for (const [venue, snapshot] of Object.entries(pages)) {
    for (const { at, rows } of snapshot) {
      if (at + ttl <= engine.clock()) continue
      for (const [base, quote, value] of rows) {
        const id = boundAsset(engine, venue, base, quote)
        if (!id) { counts.unmapped++; continue }
        const asset = engine.registry.assets.get(id)
        const total = scaledSupply(decimal(local.get(id)?.total?.value ?? asset.totalSupply))
        if (total == null && asset.address !== 'native') continue
        const amount = scaledSupply(value)
        if (total != null && amount * 1000n > total * 1001n) { aboveTotal.add(venue + '/' + id); continue }
        let bounds = byAsset.get(id)
        if (!bounds) byAsset.set(id, bounds = { low: amount, high: amount, value, at, venues: new Set() })
        if (amount < bounds.low) Object.assign(bounds, { low: amount, value })
        if (amount > bounds.high) bounds.high = amount
        bounds.at = Math.min(bounds.at, at)
        bounds.venues.add(venue)
      }
    }
  }
  counts.rejectedAboveTotal = aboveTotal.size
  const results = new Map()
  for (const [id, { low, high, value, at, venues }] of byAsset) {
    if (high * 100n > low * 102n) { counts.disagreements++; continue }
    results.set(id, { value, source: [...venues].sort().join('+'), at, expiresAt: at + ttl,
      method: 'exchange-reported', estimate: true })
  }
  return results
}

/** One budgeted job. Retain the last complete snapshot per venue, and resume paging on budget deferral. */
export function registerReported(engine, { add, local, save, validity, claims }) {
  const { store, clock, scheduler } = engine
  const spec = venue => engine.bundle.apis.some(a => a.id === sources[venue]) &&
    engine.catalog.apis.find(a => a.id === sources[venue])
  const venues = Object.keys(sources).filter(spec)
  if (!venues.length) return () => null
  const key = 'engine-supply-reported'
  let snapshots = store.getSetting(key) ?? {}, pending, status = null
  const random = scheduler.random
  let next = clock() + (2 + random() * 3) * 60_000

  // Coinbase's search returns a different subset per ordering (default 185 assets, by rank 105; CTX is only in the
  // ranked one), so both listings are read, each up to 10 pages.
  const listings = { binance: [null], coinbase: [null, 'rank'] }
  async function read(venue, source, scan) {
    scan.listing ??= 0
    do {
      const url = new URL(source.url)
      const sort = listings[venue][scan.listing]
      if (sort) url.searchParams.set('sort', sort)
      if (scan.cursor) url.searchParams.set('starting_after', scan.cursor)
      const data = await engine.http.get(url.href, source.rpm)
      scan.pages.push(readPage(venue, data, clock()))
      scan.count = (scan.count ?? 0) + 1
      const cursor = venue === 'coinbase' && data.pagination?.next_starting_after
      if (!cursor || scan.count === 10) {
        if (++scan.listing >= listings[venue].length) return scan.pages
        Object.assign(scan, { cursor: null, count: 0, seen: new Set() })
        continue
      }
      if (typeof cursor !== 'string' || cursor.length > 512 || scan.seen.has(cursor))
        throw new Error('Invalid Coinbase supply cursor')
      scan.seen.add(cursor)
      scan.cursor = cursor
    } while (true)
  }

  add({ id: 'supply:reported', ready: () => clock() >= next, interval: 1000,
    run: async () => {
      pending ??= { completed: {}, failed: [], scans: {} }
      for (const venue of venues) {
        const source = spec(venue)
        if (!source || pending.completed[venue] || pending.failed.includes(venue)) continue
        let scan = pending.scans[venue]
        if (scan?.url !== source.url) pending.scans[venue] = scan = { url: source.url, pages: [], seen: new Set() }
        try {
          pending.completed[venue] = await read(venue, source, scan)
        } catch (error) {
          if (error instanceof RateLimited || engine.abort?.signal.aborted) throw error
          pending.failed.push(venue)
        }
      }
      const now = clock()
      const counts = { at: now, filled: 0, rejectedAboveTotal: 0, disagreements: 0, unmapped: 0,
        failedSources: [...pending.failed] }
      const fresh = {}
      for (const venue of venues) {
        if (spec(venue)) fresh[venue] = (pending.completed[venue] ?? snapshots[venue] ?? []).filter(p => p.at + ttl > now)
      }
      validity.expire()
      const results = checkedReadings(engine, fresh, local, counts)
      store.transaction(() => {
        for (const [id, record] of local)
          if (isReported(record.circulating) && !results.has(id)) validity.invalidate(id, isReported)
        for (const [id, result] of results) {
          const asset = engine.registry.assets.get(id), row = local.get(id)?.circulating
          // Measured figures win; total minus burn addresses is only an upper bound and gives way.
          if ((row && !isReported(row) && row.method !== 'total-minus-burn') ||
              (asset.supply != null && Number(row?.value) !== asset.supply)) continue
          if (claims.consensus(id, local.get(id)?.total?.value ?? decimal(asset.totalSupply))) {
            validity.invalidate(id, isReported)
            continue
          }
          save(id, result, false)
          counts.filled++
        }
        store.setSetting(key, fresh)
      })
      snapshots = fresh
      status = counts
      pending = null
      // A failed source (Coinbase answers 429 "slow_down" to bursts) is retried in about half an hour.
      next = now + (counts.failedSources.length ? 30 + random() * 10 : 6 * 60 + (random() - 0.5) * 60) * 60_000
    },
  })
  return () => status && { ...status, failedSources: [...status.failedSources] }
}
