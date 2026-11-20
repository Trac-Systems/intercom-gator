// What the node depends on (Settings → Sources, GET /api/v1/sources): every upstream with its state, last success,
// error share and requests in the last hour. Built from the RPC/HTTP outcome counters and scheduler job records.
// Only host names leave this module: never paths, query strings, credentials or a user's full endpoint URL.

const MIN = 60_000, HOUR = 3_600_000
export const SLOW_MS = 3000

/** Per-source outcomes in one-minute buckets over the last hour (memory only). */
export class SourceStats {
  constructor(clock = Date.now) {
    this.clock = clock
    this.sources = new Map()
  }
  record(id, { ok, latency = 0, at = this.clock(), status, kind } = {}) {
    let s = this.sources.get(id)
    if (!s) this.sources.set(id, (s = { buckets: new Map(), lastSuccess: null, lastFailure: null, lastLimited: null, lastError: null }))
    const minute = Math.floor(at / MIN)
    const b = s.buckets.get(minute) ?? { n: 0, errors: 0, limited: 0, latency: 0, slow: 0 }
    b.n++
    // A node a few blocks behind (kind 'lagging') answered correctly that it has not reached the block yet: not an
    // error of the source.
    const lagging = !ok && kind === 'lagging'
    if (!ok && !lagging) b.errors++
    if (status === 429) { b.limited++; s.lastLimited = at }
    if (Number.isFinite(latency)) { b.latency += latency; if (latency > SLOW_MS) b.slow++ }
    s.buckets.set(minute, b)
    if (ok) s.lastSuccess = Math.max(s.lastSuccess ?? 0, at)
    else if (!lagging) {
      s.lastFailure = Math.max(s.lastFailure ?? 0, at)
      // Why it failed, as a fixed kind (sources/rpc-errors.js); never the provider's message.
      s.lastError = typeof kind === 'string' ? kind : status === 429 ? 'rate-limited' : status ? 'http-' + status : 'error'
    }
    for (const k of s.buckets.keys()) if (k <= minute - 60) s.buckets.delete(k)
  }
  /** Totals for the last hour, plus the last-10-minute rate-limit count. */
  summary(id) {
    const s = this.sources.get(id), now = Math.floor(this.clock() / MIN)
    const out = { requests1h: 0, errors1h: 0, limited1h: 0, limited10m: 0, latencyMs: null, slow1h: 0,
      lastSuccess: s?.lastSuccess ?? null, lastFailure: s?.lastFailure ?? null, lastError: s?.lastError ?? null }
    if (!s) return out
    let latency = 0
    for (const [k, b] of s.buckets) {
      if (k <= now - 60) continue
      out.requests1h += b.n; out.errors1h += b.errors; out.limited1h += b.limited; out.slow1h += b.slow
      latency += b.latency
      if (k > now - 10) out.limited10m += b.limited
    }
    out.latencyMs = out.requests1h ? Math.round(latency / out.requests1h) : null
    return out
  }
}

/** Combine counters into one state: off / failing / rate-limited / slow / ok (the report adds standby). */
export function sourceState(sum, { failures = 0, cooldown = 0, lagSeconds = null, slowLag = 600, now = Date.now(), enabled = true } = {}) {
  if (!enabled) return 'off'
  if (sum.limited10m > 0) return 'rate-limited'
  const share = sum.requests1h ? sum.errors1h / sum.requests1h : 0
  if ((sum.requests1h >= 3 && share >= 0.5) || failures >= 3 || (cooldown > now && failures >= 2)) return 'failing'
  if (!sum.requests1h && !sum.lastSuccess) return 'off'
  if ((sum.latencyMs ?? 0) > SLOW_MS || share >= 0.2 || (lagSeconds != null && lagSeconds > slowLag)) return 'slow'
  return 'ok'
}

/** What an endpoint does not serve: signed bundle capabilities plus refusals learned at runtime. */
function refusals(e, now) {
  const methods = [...(e.refusedMethods ?? new Map())].filter(([, until]) => until > now).map(([m]) => m)
  const out = {
    ...(e.logs === false || methods.includes('eth_getLogs') ? { getLogs: true } : {}),
    ...(e.logs !== false && e.range > 0 ? { maxBlockRange: e.range } : {}),
    ...(e.maxAddresses > 0 ? { maxAddresses: e.maxAddresses } : {}),
    ...(e.maxInputs?.size ? { maxInputs: Object.fromEntries(e.maxInputs) } : {}),
    ...(methods.filter((m) => m !== 'eth_getLogs').length ? { methods: methods.filter((m) => m !== 'eth_getLogs') } : {}),
  }
  return Object.keys(out).length ? out : null
}
const host = (url) => { try { return new URL(url).hostname } catch { return null } }
const origin = (url) => { try { return new URL(url).origin } catch { return null } }

function item(base, sum, extra = {}) {
  const share = sum.requests1h ? sum.errors1h / sum.requests1h : null
  // lastError: the kind of the latest failure (key, blocked, rate-limited, quota, range, method, timeout, ...), shown
  // only while it is newer than the latest success, so every failing row carries its reason.
  const lastError = sum.lastError && (sum.lastFailure ?? 0) > (sum.lastSuccess ?? 0) ? sum.lastError : null
  return { ...base, requests1h: sum.requests1h, errorShare1h: share == null ? null : Math.round(share * 1000) / 1000,
    rateLimited1h: sum.limited1h, latencyMs: sum.latencyMs, lastSuccess: sum.lastSuccess, lastFailure: sum.lastFailure,
    lastError, ...extra }
}
/** Has this process ever called the source? Sources lists only upstreams the node reads. */
const called = (sum) => sum.requests1h > 0 || sum.lastSuccess != null || sum.lastFailure != null
function merge(...sums) {
  const out = { requests1h: 0, errors1h: 0, limited1h: 0, limited10m: 0, slow1h: 0, latencyMs: null, lastSuccess: null, lastFailure: null,
    lastError: null }
  let latency = 0
  for (const s of sums) {
    out.requests1h += s.requests1h; out.errors1h += s.errors1h; out.limited1h += s.limited1h; out.limited10m += s.limited10m
    out.slow1h += s.slow1h; latency += (s.latencyMs ?? 0) * s.requests1h
    if (s.lastSuccess != null) out.lastSuccess = Math.max(out.lastSuccess ?? 0, s.lastSuccess)
    if (s.lastFailure != null && s.lastFailure >= (out.lastFailure ?? 0)) { out.lastFailure = s.lastFailure; out.lastError = s.lastError ?? null }
  }
  out.latencyMs = out.requests1h ? Math.round(latency / out.requests1h) : null
  return out
}
function jobInfo(job, now) {
  if (!job) return {}
  return { lastRun: Number.isFinite(job.last) ? job.last : null, lastOk: job.lastOk ?? null, failures: job.failures ?? 0,
    nextRun: Number.isFinite(job.next) ? job.next : null, budgetWait: job.lastLimited > now - 10 * MIN }
}

/** The full report for the API. `engine` is a started or stopped Engine. */
export function sourcesReport(engine) {
  const now = engine.clock(), stats = engine.sourceStats, jobs = engine.scheduler.jobs
  const allowed = (id) => !engine.scheduler.backgroundJobs || engine.scheduler.backgroundJobs.has(id)
  const httpSum = (url) => stats.summary('http:' + origin(url))
  const used = new Set()
  const groups = []

  const cex = []
  for (const venue of engine.catalog.exchanges) {
    const urls = [venue.ticker?.url, venue.format?.catalog?.url, venue.candles?.url, ...(venue.derivatives ?? []).map((d) => d.url)]
      .filter(Boolean)
    const origins = [...new Set(urls.map(origin).filter(Boolean))]
    origins.forEach((o) => used.add(o))
    const sum = merge(...origins.map((o) => stats.summary('http:' + o)))
    const job = jobs.get('cex:' + venue.id), info = jobInfo(job, now)
    const enabled = !!venue.ticker && allowed('cex:' + venue.id)
    if (!enabled) continue
    cex.push(item({ id: 'cex:' + venue.id, kind: 'cex', name: venue.name ?? venue.id, host: host(urls[0]) },
      sum, { ...info, state: sourceState(sum, { failures: info.failures, enabled, now }) }))
  }
  groups.push({ id: 'cex', label: 'Exchange APIs', items: cex })

  const rpc = []
  for (const [chain, endpoints] of engine.rpc.chains) {
    const name = engine.registry?.chains.get(chain)?.name ?? chain
    const sums = endpoints.map((e) => stats.summary('rpc:' + e.id))
    // A chain no job has read in this process (no scanner, no supply or name reads yet) is not listed; the user's
    // own endpoints always are.
    const read = sums.some(called)
    endpoints.forEach((e, i) => {
      const sum = sums[i]
      if (!read && !e.user) return
      rpc.push(item({ id: 'rpc:' + e.id, kind: 'rpc', name, chain, host: host(e.url), yours: !!e.user }, sum,
        { failures: e.failures, cooldownUntil: e.cooldown > now ? e.cooldown : null, refuses: refusals(e, now),
          state: sourceState(sum, { failures: e.failures, cooldown: e.cooldown, now }) }))
    })
  }
  // A spare endpoint is idle while another endpoint of its chain answers: standby, not off.
  const serving = new Set(rpc.filter((i) => i.requests1h > 0).map((i) => i.chain))
  for (const i of rpc) if (i.state === 'off' && serving.has(i.chain)) i.state = 'standby'
  groups.push({ id: 'rpc', label: 'Chain RPC endpoints', items: rpc })

  const scanners = []
  const gaps = (chain) => {
    const rows = engine.store.reader.prepare("SELECT key,value FROM settings WHERE key LIKE ?").all('engine-gap/' + chain + '/%')
    let last = null
    for (const r of rows) {
      let v
      try { v = JSON.parse(r.value) } catch { continue }
      if (v && (!last || v.at > last.at)) last = { lane: r.key.split('/').pop(), from: v.from, to: v.to, at: v.at, count: v.count }
    }
    return last
  }
  for (const [chain, source] of engine.evm) {
    const cursor = engine.store.reader.prepare('SELECT block FROM engine_heads WHERE chain=?').get(chain)?.block ?? null
    const head = source.latest?.tip ?? null
    const lagBlocks = head != null && cursor != null ? Math.max(0, head - cursor) : null
    const lagSeconds = lagBlocks == null ? null : Math.round(lagBlocks * (source.chain.blockTime ?? 0) / 1000)
    const ids = ['logs', 'trades', 'state'].map((k) => 'evm:' + chain + ':' + k)
    const js = ids.map((id) => jobs.get(id)).filter(Boolean)
    const failures = Math.max(0, ...js.map((j) => j.failures ?? 0))
    const lastOk = Math.max(0, ...js.map((j) => j.lastOk ?? 0)) || null
    const sum = merge(...(engine.rpc.chains.get(chain) ?? []).map((e) => stats.summary('rpc:' + e.id)))
    if (!ids.some(allowed)) continue
    scanners.push(item({ id: 'evm:' + chain, kind: 'evm-scanner', name: source.chain.name ?? chain, chain, host: null }, sum,
      { lagBlocks, lagSeconds, lastGap: gaps(chain), lastOk, failures,
        state: sourceState({ ...sum, lastSuccess: lastOk ?? sum.lastSuccess }, { failures, lagSeconds, now, enabled: ids.some(allowed) }) }))
  }
  const tron = engine.tron?.client.endpoint
  if (tron && allowed('tron:sunswap')) {
    const sum = httpSum(tron.url), info = jobInfo(jobs.get('tron:sunswap'), now)
    used.add(origin(tron.url))
    scanners.push(item({ id: 'tron:sunswap', kind: 'tron-scanner', name: 'SunSwap', chain: 'tron', host: host(tron.url) },
      sum, { ...info, state: sourceState(sum, { failures: info.failures, now }) }))
  }
  for (const [chain, source] of engine.move ?? []) {
    const id = chain + ':pools', endpoint = source.client.endpoint
    if (!allowed(id) || !endpoint) continue
    const sum = httpSum(endpoint.url), info = jobInfo(jobs.get(id), now)
    used.add(origin(endpoint.url))
    scanners.push(item({ id, kind: chain + '-scanner', name: chain === 'sui' ? 'Sui pools' : 'Aptos pools',
      chain, host: host(endpoint.url) }, sum, { ...info, state: sourceState(sum, { failures: info.failures, now }) }))
  }
  for (const [id, job] of jobs) {
    if (!id.startsWith('sol:')) continue
    const api = engine.catalog.apis.find((a) => a.id === id.slice(4))
    const sum = api ? httpSum(api.url) : merge()
    if (api) used.add(origin(api.url))
    const info = jobInfo(job, now)
    if (!allowed(id)) continue
    scanners.push(item({ id, kind: 'solana-scanner', name: api?.name ?? id.slice(4), chain: 'solana', host: api ? host(api.url) : null },
      sum, { ...info, state: sourceState(sum, { failures: info.failures, now, enabled: allowed(id) }) }))
  }
  groups.push({ id: 'scanners', label: 'Chain scanners', items: scanners })

  const nft = []
  for (const s of engine.nftsEnabled ? engine.nfts?.sources ?? [] : []) {
    const st = s.status(), job = jobs.get('nft:' + s.id + ':sales'), info = jobInfo(job, now)
    const sum = { ...stats.summary('job:nft:' + s.id), requests1h: st.requests1h }
    nft.push(item({ id: 'nft:' + s.id, kind: 'nft-scanner', name: st.chainName + ' NFT sales', chain: s.id, host: null }, sum,
      { ...info, lagBlocks: st.lagBlocks, lagSeconds: st.lagSeconds, lastGap: st.lastGap, salesSeen: st.salesSeen,
        marketplaces: st.marketplaces, lastSuccess: st.lastScan,
        state: sourceState({ ...sum, lastSuccess: st.lastScan }, { failures: info.failures, lagSeconds: st.lagSeconds, now,
          enabled: allowed('nft:' + s.id + ':sales') }) }))
  }
  if (engine.nftsEnabled) groups.push({ id: 'nft', label: 'NFT sales', items: nft })

  const data = []
  for (const api of engine.catalog.apis) {
    const o = origin(api.url)
    if (used.has(o)) continue
    used.add(o)
    const sum = stats.summary('http:' + o)
    // A signed API no reader has called in this process is not a source of this node (yet).
    if (!called(sum)) continue
    data.push(item({ id: 'api:' + api.id, kind: 'api', name: api.name ?? api.id, host: host(api.url) }, sum,
      { state: sourceState(sum, { now }) }))
  }
  // Any other upstream this process reached (supply issuers, metadata registries) by host.
  for (const id of stats.sources.keys()) {
    if (!id.startsWith('http:') || used.has(id.slice(5))) continue
    const sum = stats.summary(id), name = host(id.slice(5))
    data.push(item({ id: 'http:' + name, kind: 'http', name, host: name }, sum,
      { state: sourceState(sum, { now }) }))
  }
  const other = [...jobs.keys()].filter((id) => /^(supply|names|history|api:|meta:|intel|fear)/.test(id))
  groups.push({ id: 'data', label: 'Supply, metadata and other APIs', items: data,
    jobs: other.map((id) => ({ id, ...jobInfo(jobs.get(id), now) })) })

  const counts = { ok: 0, slow: 0, failing: 0, 'rate-limited': 0, standby: 0, off: 0 }
  for (const g of groups) for (const i of g.items) counts[i.state]++
  return { at: now, budget: { limit: engine.budget.limit, used1m: engine.budget.used }, counts, groups }
}
