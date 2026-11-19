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
   *   fetch?: typeof globalThis.fetch, timeout?: number }} options
   */
  constructor({ store, http, budget, clock = Date.now, bundle, profile = 'normal', fetch = globalThis.fetch, timeout }) {
    Object.assign(this, { store, http, budget, clock, fetch, timeout })
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
    for (const row of store.reader.prepare(
      'SELECT l.ref,l.url,l.sha,l.failures,l.nextRetry,i.ext FROM engine_logos l LEFT JOIN engine_logo_images i ON i.sha=l.sha'
    ).iterate()) {
      this.entries.set(row.ref, { url: row.url, sha: row.ext ? row.sha : null, ext: row.ext ?? null,
        failures: row.failures, nextRetry: row.nextRetry })
    }
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
   * Storage pressure (store.fitBudget): drop up to 32 images, those reached only through a chain template first, then
   * the oldest. Their references wait a day before the next fetch, so eviction cannot turn into a refetch loop.
   */
  evict(db, now = this.clock()) {
    const held = [...this.entries].filter(([, e]) => e.sha)
    if (!held.length) return 0
    const ages = new Map(db.prepare('SELECT sha,at FROM engine_logo_images').all().map(r => [r.sha, r.at]))
    held.sort(([a, x], [b, y]) => Number(this.signed.has(a)) - Number(this.signed.has(b)) ||
      (ages.get(x.sha) ?? 0) - (ages.get(y.sha) ?? 0))
    const shas = [...new Set(held.map(([, e]) => e.sha))].slice(0, 32)
    const dropImage = db.prepare('DELETE FROM engine_logo_images WHERE sha=?')
    const release = db.prepare("UPDATE engine_logos SET sha=NULL,nextRetry=?,reason='evicted' WHERE sha=?")
    for (const sha of shas) {
      dropImage.run(sha)
      release.run(now + DAY, sha)
    }
    const gone = new Set(shas)
    for (const entry of this.entries.values()) {
      if (gone.has(entry.sha)) Object.assign(entry, { sha: null, ext: null, nextRetry: now + DAY })
    }
    return shas.length
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
 * Run the logo job on an Engine. It paces itself instead of joining the scheduler's background rotation (about a
 * hundred jobs share one oldest-first turn there, which left logos minutes apart). It is still low priority: one request
 * per tick, at most ~5% of the request budget, nothing while the budget is more than half used, and every request goes
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
    if (engine.active && allowed() && engine.budget.used < engine.budget.limit / 2) {
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
