import { fetchJson } from '../rpc/index.js'
import { EndpointBucket, RateLimited } from '../scheduler/index.js'
import { sourceState } from '../health/sources.js'
import { feedUrl, MAX_FEED_BYTES, verifiedPatchEnvelope } from './feed-format.js'

const MINUTE = 60_000
const SOURCE = 'bundle-updates'

function processSetting() {
  const value = process.env.GATOR_PATCH_FEED
  if (value === 'false') return false
  if (value === 'true') return true
  return value
}

function fetchFailure(error) {
  // fetchJson rejects a successful status early only when Content-Length exceeds its cap.
  if ((error.status >= 200 && error.status < 300) || error.message === 'Response exceeds byte limit') return 'size'
  if (error.status) return 'http-' + error.status
  if (error instanceof SyntaxError) return 'json'
  if (error.name === 'TimeoutError') return 'timeout'
  return 'fetch'
}

/** Verify and apply one cumulative feed document (`{ v: 1, release, envelopes }`): file version, this node's release
 * digest, then per envelope the root signature on `gator/ctl` and every check of a network receipt
 * (BundlePatches.accept: sequence, base, shape, URL policy, patch signature, schema, digest). Shared by the network
 * feed and the release's shipped snapshot. */
export function applyFeed(patches, feed) {
  if (feed?.v !== 1 || !Array.isArray(feed.envelopes)) return { result: 'rejected', reason: 'format' }
  if (feed.release !== patches.releaseDigest()) return { result: 'rejected', reason: 'release' }
  let applied = null, reason = null
  for (const wire of feed.envelopes) {
    if (wire?.message?.t !== 'patch') continue
    const env = verifiedPatchEnvelope(wire, patches.rootKey)
    if (!env) {
      reason ??= 'envelope'
      continue
    }
    if (patches.accept(env, why => { reason ??= why })) applied = patches.head
  }
  const outcome = reason ? { result: applied ? 'partial' : 'rejected', reason } :
    { result: applied ? 'applied' : 'unchanged', reason: null }
  return applied ? { ...outcome, appliedDigest: applied } : outcome
}

/** Poll the release's cumulative feed. All patch state changes go through BundlePatches.accept. */
export class PatchFeed {
  constructor(patches, setting = processSetting()) {
    this.patches = patches
    this.engine = patches.engine
    this.setting = setting
    this.state = { lastFetch: null, result: setting === false ? 'disabled' : 'pending', reason: null,
      appliedDigest: null, nextCheck: null }
  }

  start() {
    try { this.url = feedUrl(this.setting, this.patches.releaseDigest()) } catch (error) {
      Object.assign(this.state, { result: 'rejected', reason: error.message })
      return
    }
    if (!this.url) return
    this.signal = this.engine.http.signal
    this.schedule(MINUTE + Math.floor(Math.random() * 4 * MINUTE))
  }

  schedule(delay) {
    this.state.nextCheck = this.engine.clock() + delay
    this.timer = setTimeout(() => this.check(), delay)
    this.timer.unref()
  }

  stop() {
    clearTimeout(this.timer)
    this.state.nextCheck = null
    if (this.state.result === 'fetching') this.state.result = 'cancelled'
    this.signal = null
    const pending = this.pending
    this.pending = null
    return pending
  }

  check() {
    const signal = this.signal
    if (!signal || signal.aborted || this.pending) return this.pending
    clearTimeout(this.timer)
    this.state.nextCheck = null
    const checked = this.fetchOnce(signal).then(retryAt => {
      if (this.signal !== signal || signal.aborted) return
      const delay = retryAt == null ? (360 + (Math.random() - 0.5) * 60) * MINUTE :
        Math.max(1000, retryAt - this.engine.clock()) + Math.random() * 1000
      this.schedule(Math.ceil(delay))
    }).finally(() => {
      if (this.pending === checked) this.pending = null
    })
    this.pending = checked
    return checked
  }

  async fetchOnce(signal) {
    const { http, clock, budget, sourceStats } = this.engine
    const origin = new URL(this.url).origin
    if (!http.hosts.has(origin)) http.hosts.set(origin, new EndpointBucket(60, clock))
    const started = clock()
    try {
      http.hosts.get(origin).take(budget)
    } catch (error) {
      if (!(error instanceof RateLimited)) throw error
      Object.assign(this.state, { result: 'deferred', reason: 'budget' })
      return error.retryAt
    }
    Object.assign(this.state, { lastFetch: started, result: 'fetching', reason: null })
    let ok = false, status
    try {
      const timeout = http.timeout > 0 ? Math.min(http.timeout, 8000) : 8000
      const feed = await fetchJson(http.fetch, this.url, { signal }, { maxBytes: MAX_FEED_BYTES, timeout })
      if (this.signal !== signal || signal.aborted) return
      const outcome = this.apply(feed)
      Object.assign(this.state, outcome)
      ok = outcome.reason === null
    } catch (error) {
      if (this.signal !== signal || signal.aborted) return
      status = error.status
      if (status === 404) {
        Object.assign(this.state, { result: 'not-found', reason: null })
        ok = true
      } else {
        Object.assign(this.state, { result: 'error', reason: fetchFailure(error) })
      }
    } finally {
      if (this.signal === signal && !signal.aborted)
        sourceStats.record(SOURCE, { ok, at: started, latency: clock() - started, status })
    }
  }

  apply(feed) {
    return applyFeed(this.patches, feed)
  }

  addToSources(report) {
    const stats = this.engine.sourceStats.summary(SOURCE)
    const enabled = !!this.url && !!this.signal
    const state = enabled && !stats.requests1h && stats.lastSuccess === null ? 'standby' :
      sourceState(stats, { now: report.at, enabled })
    report.groups.find(g => g.id === 'data').items.push({
      id: SOURCE, kind: 'http', name: 'Bundle updates (GitHub)', host: 'raw.githubusercontent.com', state,
      requests1h: stats.requests1h, errorShare1h: stats.requests1h ? stats.errors1h / stats.requests1h : null,
      rateLimited1h: stats.limited1h, latencyMs: stats.latencyMs, lastSuccess: stats.lastSuccess,
      lastFailure: stats.lastFailure, nextRun: this.state.nextCheck,
    })
    report.counts[state]++
    return report
  }
}
