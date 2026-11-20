import { RateLimited } from '../../scheduler/index.js'
import { rateLimit } from '../bundle-adapter.js'
import { encodeAggregate, decodeAggregate, field } from '../evm-abi.js'
import { abiAddress } from './address.js'
import { MULTICALL } from './deployments.js'

const MINUTE = 60_000
const SHARES = { small: 2, normal: 4, large: 6 }

/** Public solidified reads and indexed events share a single host bucket with other engine HTTP sources. */
export class TronClient {
  constructor(engine) {
    this.engine = engine
    this.next = 0
    this.refusals = 0
  }
  get endpoint() {
    // This signed host implements both the v1 index and SolidityNode APIs. Other tron-http
    // endpoints in the release only have a successful getnowblock probe.
    return this.engine.bundle.chains.find(c => c.id === 'tron' && c.family === 'tron')?.endpoints.find(e =>
      e.protocol === 'tron-http' && e.url === 'https://api.trongrid.io' && e.verified?.ok !== false)
  }
  async request(path, body) {
    const { http, clock, budget, profile } = this.engine
    const now = clock(), endpoint = this.endpoint
    if (!endpoint) throw new Error('TronGrid unavailable in active bundle')
    if (now < this.next) throw new RateLimited(this.next)
    const rpm = Math.min(SHARES[profile] ?? 4, budget.limit / 12)
    this.next = now + Math.ceil(MINUTE / rpm)
    try {
      const json = await http.getPublic(endpoint.url + path, rateLimit(endpoint.limits), 1, body)
      this.refusals = Math.max(0, this.refusals - 1)
      return json
    } catch (error) {
      if (error instanceof RateLimited) this.next = error.retryAt // No request left the process.
      if ([403, 429].includes(error.status)) {
        const pause = Math.max((error.retryAfter ?? 0) * 1000, MINUTE * 2 ** Math.min(5, this.refusals++))
        this.next = clock() + pause
        const bucket = http.hosts.get(new URL(endpoint.url).origin)
        if (bucket) bucket.next = Math.max(bucket.next, this.next)
      }
      throw error
    }
  }
  async aggregate(calls) {
    const timestamp = { to: abiAddress(MULTICALL), data: '0x0f28c97d' } // getCurrentBlockTimestamp()
    const parameter = encodeAggregate([timestamp, ...calls]).slice(10)
    const body = { owner_address: MULTICALL, contract_address: MULTICALL,
      function_selector: 'aggregate3((address,bool,bytes)[])', parameter, visible: true }
    const json = await this.request('/walletsolidity/triggerconstantcontract', body)
    if (json?.result?.result !== true) throw new Error('TRON constant call failed')
    const [rawTime, ...values] = decodeAggregate('0x' + json.constant_result?.[0], calls.length + 1)
    const at = Number(field(rawTime, 0)) * 1000, age = this.engine.clock() - at
    if (!Number.isSafeInteger(at) || age < -30_000 || age > 300_000) throw new Error('Stale TRON state')
    return { at, values }
  }
  receipt(tx) {
    return this.request('/walletsolidity/gettransactioninfobyid', { value: tx })
  }
}
