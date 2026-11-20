import { createHash } from 'node:crypto'
import { EndpointBucket, RateLimited } from '../scheduler/index.js'
import { keccak256 } from '../intel/keccak.js'
import { ImageRejected, LOGO_LIMITS, LOGO_TYPES, inspectImage } from './image.js'

export { inspectImage, ImageRejected, LOGO_LIMITS, LOGO_TYPES }

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Logos are pre-fetched for this many top-ranked assets, per machine profile (bundle chains and exchanges always). */
export const PREWARM = Object.freeze({ small: 100, normal: 500, large: 2000 })
/** Share of the request budget the logo job may use; the job is also the scheduler's lowest-relevance work. */
const BUDGET_SHARE = 0.05
const HOST_RPM = 120
const DEMAND_CAP = 512
const SHA = /^[0-9a-f]{64}$/
const DERIVED_CAP = 5000
const MiB = 1024 ** 2
/**
 * Byte bound of the stored logo images per machine profile (about 5% of the store ceiling; a typical logo is ~16 KiB).
 * Images are evicted only while the logo store itself is over this bound, never to chase a whole-database target.
 */
export const LOGO_STORE_BYTES = Object.freeze({ small: 80 * MiB, normal: 200 * MiB, large: 480 * MiB })

/** EIP-55 mixed-case checksum of a lowercase 0x address (logo repositories key EVM tokens by it). */
export function checksumAddress(address) {
  const hex = address.slice(2)
  const hash = keccak256(hex).slice(2)
  let out = '0x'
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? hex[i].toUpperCase() : hex[i]
  return out
}

/**
 * Logo references from the effective bundle: `asset:<id>`, `chain:<id>` and `exchange:<id>` → signed https URL.
 * Token records carry `logo`; chain records carry `logo`; exchange marks live in `tokens.exchangeLogos`.
 * @param {any} bundle
 * @returns {Map<string, string>}
 */
export function logoRefs(bundle) {
  const refs = new Map()
  for (const t of bundle?.tokens?.tokens ?? []) if (typeof t.logo === 'string') refs.set('asset:' + t.id, t.logo)
  for (const c of bundle?.chains ?? []) if (typeof c.logo === 'string') refs.set('chain:' + c.id, c.logo)
  for (const e of bundle?.tokens?.exchangeLogos ?? []) if (typeof e.logo === 'string') refs.set('exchange:' + e.id, e.logo)
  return refs
}

/** Retry schedule for a failed reference. Missing or rejected files wait much longer than network trouble. */
export function retryDelay(failures, permanent) {
  const n = Math.max(0, failures - 1)
  return permanent ? Math.min(7 * DAY, HOUR * 4 ** n) : Math.min(DAY, 10 * MINUTE * 2 ** n)
}

/** Stream at most `maxBytes` of a response body; redirects are refused (the signed URL is the exact location). */
export async function fetchImageBytes(fetcher, url, { signal, timeout = 8000, maxBytes = LOGO_LIMITS.maxBytes } = {}) {
  const timeoutSignal = AbortSignal.timeout(timeout)
  const response = await fetcher(url, {
    signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal,
    redirect: 'error',
    headers: { accept: 'image/png,image/webp,image/jpeg' },
  })
  if (!response.ok) {
    await response.body?.cancel()
    const error = response.status >= 500 || response.status === 429 ? new Error('HTTP ' + response.status)
      : new ImageRejected('HTTP ' + response.status)
    throw error
  }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel()
    throw new ImageRejected('larger than ' + maxBytes + ' bytes')
  }
  const chunks = []
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > maxBytes) throw new ImageRejected('larger than ' + maxBytes + ' bytes')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Token, chain and exchange logos: fetched from the signed bundle references the first time a row that needs one is
 * served (plus a pre-warm of the top-ranked assets), checked, stored by SHA-256 in the database and served locally.
 * `url()` never waits for the network: it answers from memory and queues the reference.
 */
export class Logos {
  /**
   * @param {{ store: any, http: any, budget: any, clock?: () => number, bundle: any, profile?: string,
   *   fetch?: typeof globalThis.fetch, timeout?: number, maxBytes?: number }} options
   */
  constructor({ store, http, budget, clock = Date.now, bundle, profile = 'normal', fetch = globalThis.fetch, timeout,
    maxBytes = LOGO_STORE_BYTES[profile] ?? LOGO_STORE_BYTES.normal }) {
    Object.assign(this, { store, http, budget, clock, fetch, timeout, maxBytes })
    this.refs = logoRefs(bundle)
    this.signed = new Set(this.refs.keys())
    // A chain may carry a signed per-token template for tokens outside the bundle (discovered pools); only EVM and
    // Solana addresses are substituted, and failures are negative-cached like any other reference.
    this.templates = new Map()
    for (const c of bundle?.chains ?? []) {
      if (typeof c.tokenLogo === 'string' && ['evm', 'solana'].includes(c.family))
        this.templates.set(c.id, { template: c.tokenLogo, evm: c.family === 'evm' })
    }
    this.derived = 0
    this.prewarmCount = PREWARM[profile] ?? PREWARM.normal
    this.demanded = new Set()
    this.entries = new Map()
    this.idleUntil = 0
    this.prewarmAt = -Infinity
    this.prewarmList = []
    // v0.1.0 emptied the logo store under whole-database pressure and parked each released reference for a day
    // (reason 'evicted'; current eviction records 'logo cap'). Those references are due again at startup; the job's
    // request-budget share and per-host buckets pace the refetch. Rewritten rows end up in the past, so this is one-time.
    const now = clock(), repaired = []
    for (const row of store.reader.prepare(`SELECT l.ref,l.url,l.sha,l.failures,l.nextRetry,l.reason,i.ext
      FROM engine_logos l LEFT JOIN engine_logo_images i ON i.sha=l.sha`).iterate()) {
      const parked = row.reason === 'evicted' && !row.ext && row.nextRetry > now
      if (parked) repaired.push(row.ref)
      this.entries.set(row.ref, { url: row.url, sha: row.ext ? row.sha : null, ext: row.ext ?? null,
        failures: row.failures, nextRetry: parked ? now : row.nextRetry })
    }
    if (repaired.length) {
      const due = store.writer.prepare("UPDATE engine_logos SET nextRetry=? WHERE ref=? AND reason='evicted'")
      store.transaction(() => { for (const ref of repaired) due.run(now, ref) })
    }
    this.repaired = repaired.length
    this.saveEntry = store.writer.prepare(`INSERT INTO engine_logos(ref,url,sha,failures,nextRetry,lastAttempt,reason)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(ref) DO UPDATE SET url=excluded.url,sha=excluded.sha,failures=excluded.failures,
      nextRetry=excluded.nextRetry,lastAttempt=excluded.lastAttempt,reason=excluded.reason`)
    this.saveImage = store.writer.prepare(`INSERT INTO engine_logo_images(sha,ext,width,height,bytes,at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(sha) DO NOTHING`)
    this.dropOrphan = store.writer.prepare(
      'DELETE FROM engine_logo_images WHERE sha=? AND NOT EXISTS (SELECT 1 FROM engine_logos WHERE sha=?)')
    this.readImage = store.reader.prepare('SELECT ext,bytes FROM engine_logo_images WHERE sha=?')
    this.ranked = store.reader.prepare('SELECT id FROM assets WHERE rank IS NOT NULL ORDER BY rank,id LIMIT ?')
    this.unregisterEvict = store.onEvict?.((db, { now }) => this.evict(db, now))
  }

  /**
   * Storage pressure (store.fitBudget). Logos are tiny and on every list screen, so whole-database pressure never
   * drops them: only the logo store's own excess over `maxBytes` is evicted, otherwise this returns 0.
   */
  evict(db, now = this.clock()) {
    return this.trim(db, now)
  }

  /** Bytes of stored logo images. */
  storedBytes(db = this.store.writer) {
    return db.prepare('SELECT coalesce(sum(length(bytes)),0) AS n FROM engine_logo_images').get().n
  }

  /**
   * While the logo store exceeds `maxBytes`, drop images reached only through a chain template (or no reference)
   * first, then the oldest, and only as many as needed. Released references wait a day before the next fetch, so the
   * bound cannot turn into a refetch loop. Returns the number of images dropped.
   */
  trim(db, now = this.clock()) {
    let excess = this.storedBytes(db) - this.maxBytes
    if (excess <= 0) return 0
    const signed = new Set()
    for (const [ref, e] of this.entries) if (e.sha && this.signed.has(ref)) signed.add(e.sha)
    const images = db.prepare('SELECT sha,length(bytes) AS size FROM engine_logo_images ORDER BY at,sha').all()
      .sort((a, b) => Number(signed.has(a.sha)) - Number(signed.has(b.sha)))
    const dropImage = db.prepare('DELETE FROM engine_logo_images WHERE sha=?')
    const release = db.prepare("UPDATE engine_logos SET sha=NULL,nextRetry=?,reason='logo cap' WHERE sha=?")
    const gone = new Set()
    for (const { sha, size } of images) {
      if (excess <= 0) break
      dropImage.run(sha)
      release.run(now + DAY, sha)
      gone.add(sha)
      excess -= size
    }
    for (const entry of this.entries.values()) {
      if (gone.has(entry.sha)) Object.assign(entry, { sha: null, ext: null, nextRetry: now + DAY })
    }
    return gone.size
  }

  /** The signed source URL for a reference: explicit bundle reference first, then the chain's token template. */
  resolve(ref) {
    const known = this.refs.get(ref)
    if (known !== undefined) return known
    if (!ref.startsWith('asset:')) return null
    const id = ref.slice(6)
    const split = id.indexOf(':')
    const template = this.templates.get(id.slice(0, split))
    let address = id.slice(split + 1)
    if (!template || split < 1) return null
    if (template.evm) {
      if (!/^0x[0-9a-f]{40}$/.test(address)) return null
      address = checksumAddress(address)
    } else if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return null
    const url = template.template.replace('{address}', address)
    if (this.derived < DERIVED_CAP) {
      this.derived++
      this.refs.set(ref, url)
    }
    return url
  }

  /** Local image path for a token (`asset`), `chain` or `exchange`, or null. Queues a fetch when one is missing. */
  url(kind, id) {
    const ref = kind + ':' + id
    const source = this.resolve(ref)
    if (!source) return null
    const entry = this.entries.get(ref)
    if (entry?.sha && entry.url === source) return '/img/' + entry.sha + '.' + entry.ext
    this.demand(ref)
    return null
  }
  asset(id) { return typeof id === 'string' ? this.url('asset', id) : null }
  chain(id) { return typeof id === 'string' ? this.url('chain', id) : null }
  exchange(id) { return typeof id === 'string' ? this.url('exchange', id) : null }

  demand(ref) {
    if (this.demanded.has(ref) || !this.due(ref, this.clock())) return
    if (this.demanded.size >= DEMAND_CAP) this.demanded.delete(this.demanded.values().next().value)
    this.demanded.add(ref)
    this.idleUntil = 0
  }

  /** True while a reference has no current image and is not cooling down after a failure. */
  due(ref, now) {
    const source = this.resolve(ref)
    if (!source) return false
    const entry = this.entries.get(ref)
    if (!entry || entry.url !== source) return true
    return !entry.sha && entry.nextRetry <= now
  }

  prewarm(now) {
    if (now - this.prewarmAt >= 10 * MINUTE) {
      this.prewarmAt = now
      const fixed = [...this.refs.keys()].filter(ref => !ref.startsWith('asset:'))
      const assets = this.ranked.all(this.prewarmCount).map(r => 'asset:' + r.id).filter(ref => this.resolve(ref))
      // Chains and exchanges are few and on every list screen; natives and top assets follow by rank.
      this.prewarmList = [...fixed, ...assets]
    }
    return this.prewarmList
  }

  /** The next reference to fetch: on-screen demand first, then the pre-warm list. */
  next() {
    const now = this.clock()
    for (const ref of this.demanded) {
      if (this.due(ref, now)) return ref
      this.demanded.delete(ref)
    }
    if (now < this.idleUntil) return null
    for (const ref of this.prewarm(now)) if (this.due(ref, now)) return ref
    this.idleUntil = now + MINUTE
    return null
  }

  hasWork() {
    return this.next() !== null
  }

  /** Charge the shared request budget and a per-host bucket, exactly like the other HTTP sources. */
  take(url) {
    const origin = new URL(url).origin
    const hosts = this.http?.hosts ?? (this.hosts ??= new Map())
    let bucket = hosts.get(origin)
    if (!bucket) hosts.set(origin, (bucket = new EndpointBucket(HOST_RPM, this.clock)))
    bucket.take(this.budget, 1)
  }

  /** Scheduler job body: fetch, check and store one logo. Rate limits propagate; other failures are cached. */
  async fetchNext() {
    const ref = this.next()
    if (!ref) return null
    const url = this.resolve(ref)
    this.take(url)
    const now = this.clock()
    try {
      const bytes = await fetchImageBytes(this.fetch, url, { signal: this.http?.signal, timeout: this.timeout })
      const info = inspectImage(bytes)
      this.keep(ref, url, { ...info, bytes, sha: createHash('sha256').update(bytes).digest('hex') }, now)
      return ref
    } catch (error) {
      if (error instanceof RateLimited || this.http?.signal?.aborted) throw error
      this.fail(ref, url, error, now)
      return ref
    } finally {
      this.demanded.delete(ref)
    }
  }

  keep(ref, url, image, now) {
    const previous = this.entries.get(ref)?.sha
    this.store.transaction(() => {
      this.saveImage.run(image.sha, image.ext, image.width, image.height, image.bytes, now)
      this.saveEntry.run(ref, url, image.sha, 0, 0, now, null)
      if (previous && previous !== image.sha) this.dropOrphan.run(previous, previous)
    })
    this.entries.set(ref, { url, sha: image.sha, ext: image.ext, failures: 0, nextRetry: 0 })
    if (this.storedBytes() > this.maxBytes) this.store.transaction(() => this.trim(this.store.writer, now))
  }

  fail(ref, url, error, now) {
    const prior = this.entries.get(ref)
    const failures = Math.min(16, (prior?.url === url ? prior.failures : 0) + 1)
    const permanent = error instanceof ImageRejected
    const nextRetry = now + retryDelay(failures, permanent)
    const reason = permanent ? error.message : 'network error'
    const previous = prior?.sha
    this.store.transaction(() => {
      this.saveEntry.run(ref, url, null, failures, nextRetry, now, reason)
      if (previous) this.dropOrphan.run(previous, previous)
    })
    this.entries.set(ref, { url, sha: null, ext: null, failures, nextRetry })
  }

  /** Stored bytes for `/img/<sha>.<ext>`, or null. */
  image(sha, ext) {
    if (!SHA.test(sha) || !Object.hasOwn(LOGO_TYPES, ext)) return null
    const row = this.readImage.get(sha)
    if (!row || row.ext !== ext) return null
    return { type: LOGO_TYPES[ext], bytes: Buffer.from(row.bytes) }
  }

  /** Coverage counters for diagnostics and the report: references, stored images and cooling-down failures. */
  stats() {
    let stored = 0, failed = 0
    for (const [ref, source] of this.refs) {
      const e = this.entries.get(ref)
      if (e?.url !== source) continue
      if (e.sha) stored++
      else if (e.failures) failed++
    }
    return { refs: this.refs.size, stored, failed, queued: this.demanded.size }
  }
}

/**
 * Whether the logo job may fetch now. Logos are tiny and capped at ~5% of the budget, so they yield to market work only
 * when the budget is nearly spent: logos on screen up to 90% use, the background refill up to 80%. (The former 50% gate
 * starved the refill on busy nodes: a v0.1.0 node upgraded to v0.1.1 sat near 55% and refetched ~1 logo a minute.)
 */
export function logoGate(budget, demanded) {
  return budget.used < budget.limit * (demanded ? 0.9 : 0.8)
}

/**
 * Run the logo job on an Engine. It paces itself instead of joining the scheduler's background rotation (about a
 * hundred jobs share one oldest-first turn there, which left logos minutes apart). It is still low priority: one request
 * per tick, at most ~5% of the request budget, nothing once the budget is nearly spent (`logoGate`), and every request goes
 * through the shared budget and the per-host buckets. It runs only while the engine is active and, when the engine is
 * restricted to named background jobs (tests), only if `logos` is one of them.
 */
export function registerLogos(engine) {
  const logos = new Logos({ store: engine.store, http: engine.http, budget: engine.budget, clock: engine.clock,
    bundle: engine.bundle, profile: engine.profile, fetch: engine.rpcConfig.fetch, timeout: engine.rpcConfig.timeout })
  const share = () => Math.max(1500, Math.ceil(MINUTE / Math.max(1, Math.floor(engine.budget.limit * BUDGET_SHARE))))
  const allowed = () => !engine.scheduler.backgroundJobs || engine.scheduler.backgroundJobs.has('logos')
  let timer = null
  const tick = async () => {
    let wait = share()
    if (engine.active && allowed() && logoGate(engine.budget, logos.demanded.size > 0)) {
      try {
        await logos.fetchNext()
      } catch (error) {
        if (error instanceof RateLimited) wait = Math.max(wait, error.retryAt - engine.clock())
      }
      if (logos.demanded.size) wait = Math.ceil(wait / 2)
    }
    if (timer) arm(Math.min(wait, 10 * MINUTE))
  }
  const arm = (ms) => {
    timer = setTimeout(tick, ms)
    timer.unref?.()
  }
  logos.start = () => { if (!timer) arm(share()) }
  logos.stop = () => { clearTimeout(timer); timer = null }
  logos.start()
  return logos
}
