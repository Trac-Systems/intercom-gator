import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { EndpointBucket, RateLimited, RequestBudget } from '../scheduler/index.js'
import { classifyRpcError, LONG_REFUSALS, SHAPE_REFUSALS } from '../sources/rpc-errors.js'

/** A JSON-RPC error's message plus a string `data` (Pocket puts the reason there: "node under capacity pressure"). */
const rpcMessage = (error) => String(error.message ?? '') + (typeof error.data === 'string' ? ' ' + error.data.slice(0, 300) : '')

/** Read at most `limit` bytes of an error body for classification, then drop the rest. */
async function errorDetail(response, limit = 4096) {
  try {
    const chunks = []
    let bytes = 0
    for await (const chunk of response.body ?? []) {
      chunks.push(chunk)
      bytes += chunk.length
      if (bytes >= limit) break
    }
    await response.body?.cancel().catch(() => {})
    const text = Buffer.concat(chunks).toString('utf8').slice(0, limit)
    try {
      const json = JSON.parse(text)
      const error = Array.isArray(json) ? json[0]?.error : json?.error
      if (error && typeof error === 'object') return { code: error.code, message: rpcMessage(error) }
      if (typeof error === 'string') return { message: error }
    } catch {}
    return { message: text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300) }
  } catch {
    return {}
  }
}

/** Stream the response with a decoded-byte cap (also applies to compressed HTTP). */
export async function fetchJson(fetcher, url, init = {}, { timeout = 8000, maxBytes = 8 << 20 } = {}) {
  const timeoutSignal = AbortSignal.timeout(timeout)
  const signal = init.signal ? AbortSignal.any([timeoutSignal, init.signal]) : timeoutSignal
  const response = await fetcher(url, { ...init, signal, redirect: 'error' })
  if (!response.ok) {
    // The status and the provider's error (kept in memory only) let rotation and source health tell rate limits,
    // refused request shapes, keyed or blocked endpoints apart.
    const detail = await errorDetail(response)
    throw Object.assign(new Error('Upstream rejected request (HTTP ' + response.status + ')'), {
      status: response.status,
      code: detail.code,
      detail: detail.message,
      retryAfter: Number(response.headers.get('retry-after')) || null,
    })
  }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel()
    throw Object.assign(new Error('Response exceeds byte limit'), { status: response.status })
  }
  const chunks = []
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > maxBytes) throw new Error('Response exceeds byte limit')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** A JSON-RPC error answer, or a transport failure, with its classified kind. */
export class RpcError extends Error {
  constructor(message, { kind = 'error', status, limit } = {}) {
    super(message)
    Object.assign(this, { kind, status, limit })
  }
}

/** Classify any failure of one request (HTTP refusal, JSON-RPC error row, timeout, network). */
export function errorKind(error) {
  if (error instanceof RpcError) return { kind: error.kind, limit: error.limit }
  return classifyRpcError({
    status: error?.status,
    code: error?.code,
    message: error?.detail ?? error?.cause?.code ?? error?.message,
    name: error?.name,
  })
}

const LEARNED_METHOD_MS = 30 * 60_000
const LONG_COOLDOWN_MS = 30 * 60_000
const LAGGING_PAUSE_MS = 2000
const blockSpan = (filter) => Number(filter?.toBlock) - Number(filter?.fromBlock) + 1

export class RpcClient {
  /** endpoints maps chain IDs to normalized endpoint records. */
  constructor({
    endpoints = {},
    userEndpoints = {},
    aliases = {},
    budget = new RequestBudget(),
    clock = Date.now,
    fetch = globalThis.fetch,
    sleep = delay,
    timeout = 8000,
    retries = 2,
    recordHealth = () => {},
    loadHealth = () => null,
    signal,
  }) {
    Object.assign(this, { budget, clock, fetch, sleep, timeout, recordHealth, signal, aliases })
    this.retries = Math.max(0, Math.min(5, Math.trunc(retries)))
    // Both views share endpoint buckets, cooldowns, the profile budget and abort signal.
    this.publicOnly = {
      call: (chain, method, params) => this.call(chain, method, params, true),
      batch: (chain, calls) => this.batch(chain, calls, true),
    }
    this.chains = new Map()
    this.buckets = new Map()
    this.serial = 0
    const users = new Map()
    for (const [key, list] of Object.entries(userEndpoints)) {
      const chain = aliases[key] ?? key
      users.set(chain, [...(users.get(chain) ?? []), ...list])
    }
    for (const chain of new Set([...Object.keys(endpoints), ...users.keys()])) {
      const byUrl = new Map()
      for (const [user, list] of [
        [true, users.get(chain)],
        [false, endpoints[chain]],
      ]) {
        for (const item of list ?? []) {
          const e = typeof item === 'string' ? { url: item } : item
          if (!e.url || !/^https?:$/.test(new URL(e.url).protocol)) continue
          let bucket = this.buckets.get(e.url)
          if (!bucket) this.buckets.set(e.url, (bucket = new EndpointBucket(e.rpm, clock)))
          else if (e.rpm > 0) bucket.rate = Math.min(bucket.rate, e.rpm / 2)
          if (byUrl.has(e.url)) {
            const known = byUrl.get(e.url)
            if (e.logs === false) known.logs = false
            if (e.range > 0) known.range = Math.min(known.range ?? Infinity, e.range)
            continue
          }
          const id = createHash('sha256').update(e.url).digest('hex').slice(0, 16)
          const health = loadHealth(id)
          byUrl.set(e.url, {
            ...e,
            user,
            bucket,
            id,
            failures: health?.failures ?? 0,
            cooldown: health?.retryAt ?? 0,
            // Learned at runtime from the endpoint's own refusals (see sources/rpc-errors.js).
            maxAddresses: null,
            maxInputs: new Map(),
            refusedMethods: new Map(),
            lastError: null,
          })
        }
      }
      this.chains.set(chain, [...byUrl.values()])
    }
  }
  call(chain, method, params = [], publicOnly = false) {
    return this.request(chain, [{ method, params }], false, false, publicOnly).then((values) => values[0])
  }
  /** A single public dispatch. Yield the scheduler slot on a busy endpoint or a refusal. */
  callWhenIdle(chain, method, params) {
    return this.request(chain, [{ method, params }], false, false, true, true).then(values => values[0])
  }
  async batch(chain, calls, publicOnly = false) {
    if (!Array.isArray(calls) || calls.length > 200) throw new RangeError('Invalid batch size')
    const endpoints = this.chains.get(this.aliases[chain] ?? String(chain)) ?? []
    const capable = endpoints.filter((e) => e.batch === true && !(publicOnly && e.user))
    const max = capable.length
      ? Math.max(
          1,
          Math.min(
            200,
            ...capable.map((e) => Math.min(e.maxBatch ?? 20, Math.max(1, Math.floor(e.bucket.rate / 60))))
          )
        )
      : 1
    const results = []
    for (let i = 0; i < calls.length; i += max) {
      const chunk = calls.slice(i, i + max)
      results.push(...(await this.request(chain, chunk, chunk.length > 1, true, publicOnly)))
    }
    return results
  }
  async acquire(endpoints, cost, wait, idleOnly) {
    const availableAt = e => Math.max(e.cooldown, e.bucket.next, idleOnly ? e.bucket.nextIdle ?? 0 : 0)
    for (;;) {
      this.signal?.throwIfAborted()
      const now = this.clock()
      const available = endpoints
        .filter((e) => availableAt(e) <= now)
        .sort((a, b) => Number(b.user) - Number(a.user) || a.failures - b.failures)
      try {
        if (!available.length)
          throw new RateLimited(Math.min(...endpoints.map(availableAt)))
        const bucket = available[0].bucket
        bucket.take(this.budget, cost)
        // A lightly provisioned public endpoint can be much tighter than the profile budget.
        if (idleOnly) bucket.nextIdle = now + 4 * (bucket.next - now)
        return available[0]
      } catch (err) {
        if (idleOnly || !(err instanceof RateLimited) || (!wait && err.retryAt - now > 2000)) throw err
        await this.sleep(Math.max(1, err.retryAt - now), undefined, { signal: this.signal })
      }
    }
  }
  /** Can this endpoint serve every call as sent? Bundle capabilities plus what it refused earlier. */
  eligible(e, calls, batch, publicOnly, now = this.clock()) {
    if ((publicOnly && e.user) || (batch && e.batch !== true)) return false
    return calls.every((c) => {
      if ((e.refusedMethods.get(c.method) ?? 0) > now) return false
      const inputs = e.maxInputs.get(c.method)
      if (inputs && Array.isArray(c.params?.[0]) && c.params[0].length > inputs) return false
      if (c.method !== 'eth_getLogs') return true
      const filter = c.params?.[0]
      if (e.logs === false) return false
      if (e.range && blockSpan(filter) > e.range) return false
      return !(e.maxAddresses && Array.isArray(filter?.address) && filter.address.length > e.maxAddresses)
    })
  }
  /** Remember a refused request shape so rotation stops sending it there; the endpoint stays healthy. */
  learn(e, calls, { kind, limit }) {
    const logs = calls.find((c) => c.method === 'eth_getLogs')
    const filter = logs?.params?.[0]
    if (kind === 'range' && logs) {
      const asked = blockSpan(filter)
      const cap = limit > 0 ? limit : Number.isFinite(asked) ? Math.floor(asked / 2) : 0
      if (cap >= 1) e.range = Math.min(e.range || Infinity, cap, Number.isFinite(asked) ? asked - 1 : Infinity)
      else e.logs = false
    } else if (kind === 'inputs' && calls.length === 1 && Array.isArray(calls[0].params?.[0])) {
      const asked = calls[0].params[0].length
      e.maxInputs.set(calls[0].method, Math.max(1, Math.min(limit > 0 ? limit : Math.floor(asked / 2), asked - 1)))
    } else if (kind === 'addresses' && logs && Array.isArray(filter?.address)) {
      const cap = limit > 0 ? limit : Math.floor(filter.address.length / 2)
      e.maxAddresses = Math.max(1, Math.min(cap, filter.address.length - 1))
    } else {
      for (const c of calls) e.refusedMethods.set(c.method, this.clock() + LEARNED_METHOD_MS)
    }
  }
  async request(chain, calls, batch, wait, publicOnly, idleOnly = false) {
    const all = this.chains.get(this.aliases[chain] ?? String(chain)) ?? []
    const body = calls.map(({ method, params = [] }) => ({ jsonrpc: '2.0', id: ++this.serial, method, params }))
    let lastError
    const tried = new Set()
    for (let attempt = 0; attempt <= this.retries; ) {
      const endpoints = all.filter((e) => this.eligible(e, calls, batch, publicOnly))
      if (!endpoints.length) {
        if (lastError) throw lastError
        throw new Error('No eligible RPC endpoint for ' + chain)
      }
      const e = await this.acquire(endpoints, body.length, wait, idleOnly)
      tried.add(e)
      const started = this.clock()
      try {
        const json = await fetchJson(
          this.fetch,
          e.url,
          {
            method: 'POST',
            signal: this.signal,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(batch ? body : body[0]),
          },
          { timeout: this.timeout }
        )
        const replies = batch ? json : [json]
        if (!Array.isArray(replies) || replies.length !== body.length) throw new Error('Incomplete RPC response')
        const map = new Map(replies.map((row) => [row?.id, row]))
        const results = body.map(({ id }) => {
          const row = map.get(id) ?? (!batch && replies[0]?.error ? replies[0] : undefined)
          if (row?.error && typeof row.error === 'object') {
            const { kind, limit } = classifyRpcError({ code: row.error.code, message: rpcMessage(row.error) })
            throw new RpcError('RPC error for ' + chain, { kind, limit })
          }
          if (row?.jsonrpc !== '2.0' || !Object.hasOwn(row, 'result')) throw new RpcError('Invalid RPC result')
          return row.result
        })
        e.failures = Math.max(0, e.failures - 1)
        e.lastError = null
        this.recordHealth({ chain, id: e.id, ok: true, latency: this.clock() - started, at: started })
        return results
      } catch (error) {
        if (this.signal?.aborted) throw error
        const { kind, limit } = errorKind(error)
        const latency = this.clock() - started
        if (kind === 'reverted') {
          // The endpoint answered: the call itself reverts everywhere. No penalty, no retry elsewhere.
          this.recordHealth({ chain, id: e.id, ok: true, latency, at: started })
          throw error instanceof RpcError ? error : new RpcError('RPC call reverted', { kind })
        }
        const now = this.clock()
        e.lastError = { kind, at: now }
        const status = kind === 'rate-limited' || kind === 'quota' ? 429 : error?.status
        this.recordHealth({ chain, id: e.id, ok: false, latency, at: started, status, kind })
        lastError = new RpcError('RPC request failed for ' + chain, { kind, status: error?.status, limit })
        if (SHAPE_REFUSALS.has(kind)) {
          // Ask the next endpoint at once; this one still serves every other request.
          this.learn(e, calls, { kind, limit })
          if (idleOnly) throw lastError
          continue
        }
        if (kind === 'lagging') {
          // A few blocks behind a faster endpoint is not a fault: ask another endpoint, come back in a moment.
          e.cooldown = Math.max(e.cooldown, now + LAGGING_PAUSE_MS)
          if (idleOnly) throw lastError
          // Two lagging dataseeds must not use up the attempts while a caught-up endpoint was never asked.
          if (!endpoints.some((x) => !tried.has(x))) attempt++
          continue
        }
        e.failures = Math.min(8, e.failures + 1)
        let cooldown = 250 * 2 ** e.failures
        if (LONG_REFUSALS.has(kind)) {
          e.failures = 8
          cooldown = LONG_COOLDOWN_MS
        } else if (kind === 'rate-limited') {
          cooldown = Math.max(cooldown, 1000 * (error?.retryAfter || 15))
        }
        e.cooldown = now + cooldown
        if (idleOnly) throw lastError
        attempt++
        if (attempt <= this.retries) await this.sleep(50 * 2 ** (attempt - 1), undefined, { signal: this.signal })
      }
    }
    throw lastError
  }
}
