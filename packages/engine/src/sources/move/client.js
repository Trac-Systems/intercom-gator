import { RateLimited } from '../../scheduler/index.js'
import { rateLimit } from '../bundle-adapter.js'
import { natural } from './identity.js'

const MIN = 60_000
export function fresh(at, now) {
  if (!natural(at) || at < now - 5 * MIN || at > now + 30_000) throw new Error('Stale Move ledger')
  return at
}
export class MoveClient {
  constructor(engine, chain) {
    Object.assign(this, { engine, chain, next: 0, peerNext: 0, refusals: 0 })
  }
  get endpoint() {
    const protocol = this.chain === 'sui' ? 'sui-graphql' : 'aptos-rest'
    return this.engine.bundle.chains.find(c => c.id === this.chain && c.family === this.chain)?.endpoints
      .find(e => e.protocol === protocol && e.verified?.ok !== false)
  }
  get peerDue() { return Math.max(this.next, this.peerNext) }

  async request(path, body, peer = false, headers) {
    const { clock, budget, profile, http } = this.engine, now = clock(), ep = this.endpoint
    if (!ep) throw new Error('Move endpoint unavailable')
    const due = peer ? this.peerDue : this.next
    if (now < due) throw new RateLimited(due)
    const interval = Math.ceil(MIN / Math.min(({ small: 2, normal: 4, large: 6 })[profile] ?? 4, budget.limit / 12))
    const oldPeerNext = this.peerNext
    this.next = now + interval
    if (peer) this.peerNext = now + 3 * interval
    try {
      const json = await http.getPublic(ep.url.replace(/\/$/, '') + path, rateLimit(ep.limits), 1, body, undefined, headers)
      this.refusals = 0
      return json
    } catch (error) {
      if (error instanceof RateLimited) {
        this.next = error.retryAt
        this.peerNext = oldPeerNext
      } else if ([403, 429].includes(error.status)) {
        this.next = clock() + Math.max((error.retryAfter ?? 0) * 1000, MIN * 2 ** Math.min(5, this.refusals++))
        const bucket = http.hosts.get(new URL(ep.url).origin)
        if (bucket) bucket.next = Math.max(bucket.next, this.next)
      }
      throw error
    }
  }
  async sui(operation, variables, peer) {
    const json = await this.request('', { query: operation, variables }, peer)
    if (json?.errors?.length || json?.data?.chainIdentifier !== '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S')
      throw new Error('Invalid Sui GraphQL response')
    const { checkpoint } = json.data
    if (!natural(checkpoint?.sequenceNumber)) throw new Error('Invalid Sui checkpoint')
    const at = fresh(Date.parse(checkpoint.timestamp), this.engine.clock())
    return { ...json.data, at }
  }
  async aptos(path, body, peer) {
    let version, at, cursor
    const data = await this.request(path, body, peer, h => {
      if (h.get('x-aptos-chain-id') !== '1') throw new Error('Unexpected Aptos chain')
      version = h.get('x-aptos-ledger-version')
      at = fresh(Math.floor(Number(h.get('x-aptos-ledger-timestampusec')) / 1000), this.engine.clock())
      if (!/^\d{1,16}$/.test(version) || !natural(Number(version))) throw new Error('Invalid Aptos version')
      const oldest = h.get('x-aptos-ledger-oldest-version')
      if (oldest && /^\d{1,16}$/.test(oldest) && natural(Number(oldest))) this.oldestVersion = Number(oldest)
      cursor = h.get('x-aptos-cursor')
    })
    return { data, version, at, cursor }
  }
}

/** Keep results only across budget deferrals within the same bounded logical read. */
export async function once(cache, key, read) {
  if (!cache.has(key)) cache.set(key, await read())
  return cache.get(key)
}
