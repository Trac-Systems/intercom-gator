import { AsyncLocalStorage } from 'node:async_hooks'

export const BUDGETS = Object.freeze({ small: 60, normal: 240, large: 900 })
/** No job may hold a scheduler slot longer than this (real time; jobs may set deadlineMs). A request that never
 * settled kept exchange jobs "running" for 40+ minutes on a live node (11-19); with every slot held, due jobs such
 * as the price reference stopped and Tron USDT dropped out of the total market cap. */
export const JOB_DEADLINE_MS = 180_000

export class JobDeadline extends Error {
  constructor() { super('Job exceeded its deadline') }
}

/** Settle with the job's result, or reject at the deadline. The abandoned promise may still finish; its result is
 * ignored and it no longer holds a slot. */
export function withDeadline(promise, ms, onTimeout) {
  let timer
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => { onTimeout?.(); reject(new JobDeadline()) }, ms)
      timer.unref?.()
    }),
  ])
}
const WINDOWS = [60_000, 600_000, 3_600_000]
const TARGETS = [5, 3, 2]

/** Coverage counts distinct locally proven reporters plus this node in the target window. */
export function coverageTarget(rank, targets = TARGETS) {
  const tier = rank > 0 && rank <= 50 ? 0 : rank > 0 && rank <= 500 ? 1 : 2
  return { window: WINDOWS[tier], count: targets[tier], tier: tier + 1 }
}

export function seededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

export class RateLimited extends Error {
  constructor(retryAt) {
    super('Request budget unavailable')
    this.retryAt = retryAt
  }
}

/** Rolling profile limit covers every upstream request, including retries and history. */
export class RequestBudget {
  #accounting = new AsyncLocalStorage()
  constructor(profile = 'normal', requested, clock = Date.now) {
    this.clock = clock
    this.ceiling = BUDGETS[profile] ?? BUDGETS.normal
    this.limit = this.ceiling
    this.setLimit(requested)
    this.times = []
    this.dispatches = 0
  }
  setLimit(limit) {
    if (Number.isFinite(limit)) this.limit = Math.max(1, Math.min(this.ceiling, Math.floor(limit)))
  }
  get used() {
    const cutoff = this.clock() - 60_000
    while (this.times.length && this.times[0] <= cutoff) this.times.shift()
    return this.times.length
  }
  /** Count actual dispatches (including retries) from this operation without counting concurrent jobs. */
  trackRequests(counter, run) {
    return this.#accounting.run(counter, run)
  }
  take() {
    if (this.used >= this.limit) throw new RateLimited(this.times[0] + 60_000)
    this.times.push(this.clock())
    this.dispatches++
    const account = this.#accounting.getStore()
    if (account) account.requests++
  }
}

/** Smooth token bucket. Charge before dispatch, including for unsuccessful responses. */
export class EndpointBucket {
  constructor(requestsPerMinute = 12, clock = Date.now) {
    this.rate = Math.min(1e6, Number(requestsPerMinute) || 12) / 2
    if (!(this.rate > 0)) throw new RangeError('Invalid endpoint limit')
    this.next = 0
    this.charges = []
    this.cost = 0
    this.clock = clock
  }
  take(budget, cost = 1) {
    const now = this.clock()
    if (now < this.next) throw new RateLimited(this.next)
    const capacity = Math.max(1, Math.floor(this.rate))
    if (!Number.isFinite(cost) || cost <= 0 || cost > capacity)
      throw new RangeError('Request exceeds endpoint capacity')
    while (this.charges.length && this.charges[0].at <= now - 60000) this.cost -= this.charges.shift().cost
    if (this.cost + cost > capacity) {
      let available = capacity - this.cost
      for (const charge of this.charges) {
        available += charge.cost
        if (available >= cost) throw new RateLimited(charge.at + 60000)
      }
    }
    budget.take()
    this.charges.push({ at: now, cost })
    this.cost += cost
    this.next = now + Math.ceil((cost * 60_000) / this.rate)
  }
}

/** @param {object} options coverage(market) returns the current distinct reporter count. */
export class Scheduler {
  /** scoreTtl: reuse a market job's coverage score this long (ms); scoring every market of every job on each
   * 66 ms tick took 10% of a large node's CPU. 0 recomputes every turn. */
  constructor({ clock = Date.now, random = Math.random, coverage, targets = TARGETS, backgroundJobs, scoreTtl = 0 }) {
    Object.assign(this, { clock, random, coverage, scoreTtl })
    this.backgroundJobs = backgroundJobs == null ? null : new Set(backgroundJobs)
    this.setTargets(targets)
    this.jobs = new Map()
    this.spotChecks = new Map()
    this.nextSpot = 0
    this.turn = 0
  }
  setTargets(targets) {
    this.targets = TARGETS.map((fallback, i) =>
      Number.isInteger(targets?.[i]) ? Math.max(1, Math.min([10, 6, 4][i], targets[i])) : fallback
    )
  }
  add(job) {
    this.jobs.set(job.id, { ...job, failures: 0, next: 0, last: -Infinity })
  }
  requestSpotCheck(jobId, market) {
    if (!this.jobs.get(jobId)?.spotCheck || (this.backgroundJobs && !this.backgroundJobs.has(jobId))) return
    const now = this.clock()
    for (const [id, check] of this.spotChecks) if (check.expires <= now) this.spotChecks.delete(id)
    if (this.spotChecks.size < 32 && !this.spotChecks.has(market)) {
      this.spotChecks.set(market, { jobId, pending: true, expires: now + 300_000 })
    }
  }
  choose(allowIdle = true) {
    const now = this.clock()
    const candidates = []
    let idle
    // Every fourth turn goes to the longest-waiting ready job without markets (supply, history,
    // discovery): coverage scores of market jobs would otherwise starve them indefinitely.
    // During focus one turn in eight similarly rotates through ready market jobs, independent of scores.
    this.turn++
    const fairMarket = this.turn % 8 === 2 && this.focus?.active()
    if (this.turn % 4 === 0 || fairMarket) {
      let oldest = null
      for (const job of this.jobs.values()) {
        if (job.idleOnly) continue
        if (Boolean(job.markets) !== Boolean(fairMarket) || (this.backgroundJobs && !this.backgroundJobs.has(job.id))) continue
        if (job.next > now || job.ready?.() === false) continue
        if (!oldest || job.last < oldest.last || (job.last === oldest.last && job.id < oldest.id)) oldest = job
      }
      if (oldest) return oldest
    }
    for (const job of this.jobs.values()) {
      if (this.backgroundJobs && !this.backgroundJobs.has(job.id)) continue
      if (job.next > now || job.ready?.() === false) continue
      if (job.idleOnly) {
        if (allowIdle) idle ??= job
        continue
      }
      // Jobs without markets carry a cheap, possibly dynamic relevance: never cache it.
      if (!job.markets || !(this.scoreTtl > 0 && job.scored && now - job.scored.at < this.scoreTtl)) {
        const markets = job.markets?.() ?? []
        let score = 0
        let coverage = 0
        let focused = false
        for (const market of markets) {
          if (market.active === false) continue
          if (!focused && this.focus?.market(market.id, now)) focused = true
          const target = coverageTarget(market.rank, this.targets)
          const seen = this.coverage(market.id, target.window)
          coverage += seen
          score += Math.max(0, target.count - seen) * (market.relevance ?? 4 - target.tier)
        }
        if (!markets.length) score = job.relevance ?? 1
        if (focused || (job.marketChain && this.focus?.chain(job.marketChain, now))) score *= 2
        job.scored = { at: now, score, coverage: coverage / Math.max(1, markets.length) }
      }
      candidates.push({ job, score: job.scored.score, coverage: job.scored.coverage })
    }
    if (!candidates.length) return idle ?? null
    const explore = this.random() < 0.1
    let best = null
    let highest = 0
    for (const { job, score, coverage } of candidates) {
      // Unvisited jobs and lightly covered venues get more exploration time.
      const age = Math.min(4, (now - job.last) / 60_000)
      const weight = explore ? (1 + age) / (1 + coverage) : score
      const value = weight * (0.5 + this.random())
      if (value > highest) {
        highest = value
        best = job
      }
    }
    return best ?? idle ?? null
  }
  async runOne({ allowIdle = true } = {}) {
    const now = this.clock()
    if (now >= this.nextSpot) {
      for (const [market, check] of this.spotChecks) {
        if (check.expires <= now) { this.spotChecks.delete(market); continue }
        const job = this.jobs.get(check.jobId)
        if (!check.pending || !job || job.next > now || (this.backgroundJobs && !this.backgroundJobs.has(job.id))) continue
        check.pending = false
        this.nextSpot = now + 15_000
        try {
          await this.execute(job, () => job.spotCheck(market, check.reads ??= new Map()))
        } catch (error) {
          if (error instanceof RateLimited) check.pending = true
          throw error
        } finally {
          if (!check.pending) {
            check.reads = null
            check.expires = now + 60_000
          }
        }
        return job.id
      }
    }
    const job = this.choose(allowIdle)
    if (!job) return null
    await this.execute(job, job.run)
    return job.id
  }
  /** Coalesce identical explicit history requests and use the same source backoff as background jobs. */
  async demand(id, key, run) {
    if (!this.jobs.has(id)) this.add({ id, interval: 0, ready: () => false })
    const job = this.jobs.get(id)
    if (job.pending) {
      if (job.key === key) return job.pending
      await job.pending
      return this.demand(id, key, run)
    }
    if (this.clock() < job.next) throw new RateLimited(job.next)
    job.key = key
    job.pending = this.execute(job, run)
    try {
      const result = await job.pending
      if (!job.failures) this.jobs.delete(id)
      return result
    } finally {
      job.pending = null
    }
  }
  async execute(job, run) {
    job.next = Infinity
    job.last = this.clock()
    try {
      const result = await withDeadline(run(), job.deadlineMs ?? JOB_DEADLINE_MS, () => { job.lastDeadline = this.clock() })
      job.lastOk = this.clock()
      job.failures = Math.max(0, job.failures - 1)
      job.next = this.clock() + (job.interval ?? 1000) * 2 ** job.failures
      return result
    } catch (error) {
      if (error instanceof RateLimited) { job.next = error.retryAt; job.lastLimited = this.clock() }
      else {
        job.lastFailed = this.clock()
        job.failures = Math.min(8, job.failures + 1)
        job.next = this.clock() + 1000 * 2 ** job.failures
      }
      throw error
    }
  }
}
