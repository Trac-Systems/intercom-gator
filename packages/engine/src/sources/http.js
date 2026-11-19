import { EndpointBucket } from '../scheduler/index.js'
import { errorKind, fetchJson } from '../rpc/index.js'

/** A single rate bucket for ticker, candle and reference requests sharing an upstream host. */
export class HttpSources {
  constructor({ budget, clock, fetch = globalThis.fetch, timeout, signal }) {
    Object.assign(this, { budget, clock, fetch, timeout, signal })
    this.hosts = new Map()
  }
  get(url, rpm, cost, body, timeout) {
    return this.getPublic(url, rpm, cost, body, timeout)
  }
  // Mirrors wrap get(). Peer-triggered work uses the original signed bundle URL. `timeout` (ms) can only shorten
  // the configured one (venue history uses a hard cap).
  async getPublic(url, rpm, cost = 1, body = null, timeout) {
    const origin = new URL(url).origin
    let bucket = this.hosts.get(origin)
    if (!bucket) this.hosts.set(origin, (bucket = new EndpointBucket(rpm, this.clock)))
    bucket.rate = Math.min(bucket.rate, rpm / 2)
    bucket.take(this.budget, cost)
    const init = { signal: this.signal }
    if (body != null)
      Object.assign(init, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const limit = Math.min(...[this.timeout, timeout].filter((n) => Number.isFinite(n) && n > 0).map(Math.ceil))
    const started = this.clock()
    try {
      const result = await fetchJson(this.fetch, url, init, { timeout: Number.isFinite(limit) ? limit : undefined })
      this.record?.({ origin, ok: true, latency: this.clock() - started, at: started })
      return result
    } catch (error) {
      if (!this.signal?.aborted) {
        const { kind } = errorKind(error)
        this.record?.({ origin, ok: false, latency: this.clock() - started, at: started,
          status: kind === 'rate-limited' || kind === 'quota' ? 429 : error?.status, kind })
      }
      throw error
    }
  }
}

export function formatUrl(template, params) {
  return template.replace(/\{([\w]+)\}/g, (_, key) => {
    if (params[key] == null) throw new Error('Missing endpoint template value ' + key)
    return encodeURIComponent(params[key])
  })
}

/** Fill a signed POST body template. A value that is exactly "{name}" takes the parameter as is (numbers stay
 * numbers: Hyperliquid's candleSnapshot rejects "startTime":"1795..." with HTTP 422); other strings substitute text. */
export function fillBody(template, params) {
  if (typeof template === 'string') {
    const whole = template.match(/^\{(\w+)\}$/)
    if (whole) {
      if (params[whole[1]] == null) throw new Error('Missing endpoint template value ' + whole[1])
      return params[whole[1]]
    }
    return template.replace(/\{(\w+)\}/g, (_, key) => {
      if (params[key] == null) throw new Error('Missing endpoint template value ' + key)
      return String(params[key])
    })
  }
  if (Array.isArray(template)) return template.map((v) => fillBody(v, params))
  if (template && typeof template === 'object')
    return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, fillBody(v, params)]))
  return template
}
