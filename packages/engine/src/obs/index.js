import { createHash } from 'node:crypto'
import { settleWithin } from '../grace.js'

/** @typedef {[string,string,string|number,string|number|null,string|number|null,string|number|null,number]} ObservationRow
 * [marketId, price, rolling base turnover, rolling USD turnover, bid, ask, source timestamp]. */
export const PX_POLICY = Object.freeze({
  verifySignature: true,
  powDifficulty: 8,
  powBitsPerKiB: 1,
  maxReceiveBytes: 16384,
})
export const NEW_POLICY = Object.freeze({ verifySignature: true, powDifficulty: 16, maxReceiveBytes: 8192 })
export const keyPattern = /^[0-9a-f]{64}$/
export const symbolPattern = /^[A-Z0-9][A-Z0-9._]{0,31}$/
const marketPattern =
  /^(?:cex:[a-z0-9][a-z0-9_-]{0,39}:[A-Z0-9][A-Z0-9._]{0,31}-[A-Z0-9][A-Z0-9._]{0,31}|dex:[a-z0-9][a-z0-9_-]{0,31}:(?:0x[0-9a-f]{40}|0x[0-9a-f]{64}|[1-9A-HJ-NP-Za-km-z]{32,44})|dex:bittensor:sn[1-9][0-9]{0,4})$/
const DAY = 86400_000
const FUTURE = 30_000
export const shard = (id) => createHash('sha256').update(id).digest()[0] % 16
export const channelFor = (id) => 'gator/px/' + shard(id)
const bytes = (value) => Buffer.byteLength(JSON.stringify(value))

/** Preserve upstream decimal strings. Expand finite numeric/scientific JSON to plain decimal. */
export function decimal(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const raw = String(value)
  if (raw.length > 80 || !/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw) || !Number.isFinite(Number(raw))) return null
  if (!/[eE]/.test(raw)) return raw
  const [mantissa, power] = raw.toLowerCase().split('e')
  const [whole, fraction = ''] = mantissa.split('.')
  const digits = whole + fraction
  const point = whole.length + Number(power)
  if (Math.abs(point) > 76) return null
  if (point <= 0) return '0.' + '0'.repeat(-point) + digits
  if (point >= digits.length) return digits.padEnd(point, '0')
  return digits.slice(0, point) + '.' + digits.slice(point)
}

function validTime(at, now) {
  return Number.isSafeInteger(at) && at > 0 && at <= now + FUTURE && at >= now - DAY
}
export function validRow(row, now) {
  if (!Array.isArray(row) || row.length !== 7) return false
  const [id, price, baseVol, quoteVol, bid, ask, at] = row
  const validNumber = (n) => decimal(n) !== null
  return (
    typeof id === 'string' &&
    id.length <= 128 &&
    marketPattern.test(id) &&
    typeof price === 'string' &&
    /^\d+(?:\.\d+)?$/.test(price) &&
    validNumber(price) &&
    Number(price) > 0 &&
    validNumber(baseVol) &&
    [quoteVol, bid, ask].every((n) => n === null || validNumber(n)) &&
    (bid === null || ask === null || Number(bid) <= Number(ask)) &&
    validTime(at, now)
  )
}

/** Reserve room for the signed Intercom envelope, including its proof of work. */
export function* batches(rows, digest, at, maxBytes = PX_POLICY.maxReceiveBytes - 1024) {
  const groups = new Map()
  const message = () => ({ t: 'obs', v: 1, b: digest, at, o: [] })
  for (const row of rows) {
    if (!validRow(row, at)) continue
    const channel = channelFor(row[0])
    let group = groups.get(channel)
    if (!group) groups.set(channel, (group = { msg: message(), size: bytes(message()) }))
    const size = bytes(row) + 1
    if (group.msg.o.length >= 200 || group.size + size > maxBytes) {
      yield [channel, group.msg]
      groups.set(channel, (group = { msg: message(), size: bytes(message()) }))
    }
    group.msg.o.push(row)
    group.size += size
  }
  for (const [channel, { msg }] of groups) yield [channel, msg]
}

/** A bounded per-key sliding row quota also applies to discovery messages. */
export class PeerQuota {
  constructor(clock, limit = 2400) {
    this.clock = clock
    this.limit = limit
    this.peers = new Map()
  }
  take(key, count) {
    const now = this.clock()
    let state = this.peers.get(key)
    if (!state) {
      if (this.peers.size >= 16_384) {
        for (const [id, peer] of this.peers) if (peer.at <= now - 60_000) this.peers.delete(id)
        if (this.peers.size >= 16_384) return false
      }
      this.peers.set(key, (state = { at: now, tokens: this.limit }))
    }
    state.tokens = Math.min(this.limit, state.tokens + (Math.max(0, now - state.at) * this.limit) / 60_000)
    state.at = now
    if (count > state.tokens) return false
    state.tokens -= count
    return true
  }
}

/** Rows a node puts on the wire per minute: below the receivers' PeerQuota (2,400), so every release accepts all of
 * them. Nodes used to broadcast every own row (50-83k a minute, owner node 11-20); receivers dropped >95% unread. */
export const WIRE_RATE = 2000
/** A price change that is news to peers. */
export const WIRE_MOVE = 0.001
/** Proof of work doubles per KiB of message: 2 KiB messages cost 512 hashes, a full 15 KiB message 65,536. */
export const WIRE_MESSAGE_BYTES = 2048
export const WIRE_FLUSH_MS = 10_000
const WIRE_MIN_FLUSH = 300
const WIRE_PENDING_CAP = 100_000
const WIRE_FORGET_MS = 2 * 3_600_000
/** Budget after the top tier: ranks 51-500, other ranked, unranked. A tier's unused share goes to the next. */
const WIRE_SHARES = [0.5, 0.3, 0.2]

/** Chooses which own rows go on the wire. A row is due when its market was never sent, its price moved more than
 * WIRE_MOVE since the last sent row, or half its coverage window passed (heartbeat, so peers keep counting this
 * node). Ranks 1-50 go first; within a tier moved rows go first, oldest waiting first, and heartbeats keep at least a
 * quarter of the tier's share. Only the newest row per market waits. */
export class WireBudget {
  constructor({ clock = Date.now, info = () => ({}), rate = WIRE_RATE } = {}) {
    Object.assign(this, { clock, info, rate })
    this.tokens = rate
    this.at = clock()
    this.sent = new Map() // market -> { price, at }, in send order
    this.queues = Array.from({ length: 8 }, () => new Map()) // [tier * 2 + heartbeat]: market -> row
    this.where = new Map() // market -> queue index
  }
  get pending() {
    return this.where.size
  }
  available(now) {
    return Math.min(this.rate, this.tokens + (Math.max(0, now - this.at) * this.rate) / 60_000)
  }
  offer(row, now) {
    const id = row[0]
    const { rank, window = 3_600_000 } = this.info(id) ?? {}
    const last = this.sent.get(id)
    const heartbeat = !!last && Math.abs(Number(row[1]) / last.price - 1) <= WIRE_MOVE
    const queued = this.where.get(id)
    if (heartbeat && now - last.at < window / 2) {
      if (queued !== undefined) this.dequeue(id, queued)
      return
    }
    const index = (rank > 0 ? (rank <= 50 ? 0 : rank <= 500 ? 1 : 2) : 3) * 2 + heartbeat
    if (queued === index) return void this.queues[index].set(id, row)
    if (queued !== undefined) this.dequeue(id, queued)
    else if (this.where.size >= WIRE_PENDING_CAP) return
    this.queues[index].set(id, row)
    this.where.set(id, index)
  }
  dequeue(id, index) {
    this.queues[index].delete(id)
    this.where.delete(id)
  }
  /** Due rows the bucket allows now; they count as sent. */
  take(now) {
    this.tokens = this.available(now)
    this.at = now
    for (const [id, last] of this.sent) {
      if (last.at >= now - WIRE_FORGET_MS) break
      this.sent.delete(id)
    }
    let room = Math.floor(this.tokens)
    const out = []
    const pull = (index, count) => {
      const queue = this.queues[index]
      for (const [id, row] of queue) {
        if (count-- <= 0) break
        this.dequeue(id, index)
        this.sent.delete(id)
        this.sent.set(id, { price: Number(row[1]), at: now })
        out.push(row)
      }
    }
    const tier = (t, share) => {
      const moved = this.queues[t * 2].size, beats = this.queues[t * 2 + 1].size
      const n = Math.min(share, moved + beats)
      const takeMoved = Math.min(moved, n - Math.min(beats, Math.ceil(n / 4)))
      pull(t * 2, takeMoved)
      pull(t * 2 + 1, n - takeMoved)
      return n
    }
    room -= tier(0, room)
    const shares = WIRE_SHARES.map((share) => Math.floor(room * share))
    let spare = room - shares.reduce((a, b) => a + b, 0)
    for (let t = 1; t <= 3; t++) spare += shares[t - 1] - tier(t, shares[t - 1])
    for (let t = 1; t <= 3 && spare > 0; t++) spare -= tier(t, spare)
    this.tokens -= out.length
    return out
  }
}

export class ObservationExchange {
  constructor({
    transport,
    digest,
    clock = Date.now,
    ingest,
    muted = () => false,
    accepts = () => true,
    canPublish = () => true,
    onUnknown,
    rowLimit,
    wireInfo,
    wireRate,
  }) {
    if (!/^[a-f0-9]{16}$/.test(digest)) throw new TypeError('Expected 16-hex bundle digest prefix')
    Object.assign(this, { transport, digest, clock, ingest, muted, accepts, canPublish, onUnknown })
    this.quota = new PeerQuota(clock, rowLimit)
    this.wire = new WireBudget({ clock, info: wireInfo, rate: wireRate })
    this.joined = []
    this.listener = (channel, env) => this.receive(channel, env)
  }
  async start() {
    if (this.started) return
    const existing = new Set(this.transport.channels?.() ?? [])
    this.transport.on('message', this.listener)
    try {
      // Join in parallel: each join announces on the DHT (1-5 s), so sixteen in a row delayed startup by minutes.
      const channels = Array.from({ length: 16 }, (_, i) => 'gator/px/' + i)
      const results = await Promise.allSettled(channels.map((channel) => this.transport.join(channel, PX_POLICY)))
      channels.forEach((channel, i) => {
        if (results[i].status === 'fulfilled' && results[i].value !== false && !existing.has(channel)) this.joined.push(channel)
      })
      const failed = results.findIndex((r) => r.status === 'rejected' || r.value === false)
      if (failed >= 0) throw results[failed].reason ?? new Error('Cannot join ' + channels[failed])
      this.started = true
      // Rows that waited for budget go out without a new publish.
      this.flusher = setInterval(() => {
        try {
          this.flush()
        } catch {}
      }, WIRE_FLUSH_MS)
      this.flusher.unref?.()
    } catch (err) {
      await this.stop()
      throw err
    }
  }
  async stop() {
    this.started = false
    clearInterval(this.flusher)
    this.transport.off('message', this.listener)
    await settleWithin(this.joined.splice(0).map((c) => this.transport.leave(c)))
  }
  /** Ingest own rows locally; the due ones go on the wire within the budget. Returns the rows broadcast. */
  publish(rows, localQuoteVolumes) {
    for (const [channel, msg] of batches(rows, this.digest, this.clock())) this.publishBatch(channel, msg, localQuoteVolumes)
    return this.flush()
  }
  /** publish, yielding to the event loop between ingest batches: a venue's whole ticker feed at once blocked the node
   * 0.4-0.85 s (owner node 11-20). The wire round runs once, after every row of the feed had its turn. */
  async publishPaced(rows, localQuoteVolumes, active = () => true) {
    let first = true
    for (const [channel, msg] of batches(rows, this.digest, this.clock())) {
      if (!first) await new Promise(resolve => setImmediate(resolve))
      first = false
      if (!active()) return 0
      this.publishBatch(channel, msg, localQuoteVolumes)
    }
    return this.flush()
  }
  /** Ingest a batch of own rows locally and offer the publishable ones to the wire budget. */
  publishBatch(channel, msg, localQuoteVolumes) {
    const accepted = msg.o.filter(this.accepts)
    if (!accepted.length) return
    this.ingest(this.transport.publicKey, accepted, true, localQuoteVolumes)
    const now = this.clock()
    for (const row of accepted) if (this.canPublish(row)) this.wire.offer(row, now)
  }
  /** Broadcast due rows when the budget has room for all of them or for a well-filled round of small messages;
   * returns the rows sent. */
  flush() {
    const now = this.clock()
    const pending = this.wire.pending
    if (!pending || this.wire.available(now) < Math.min(pending, WIRE_MIN_FLUSH)) return 0
    let sent = 0
    for (const [channel, msg] of batches(this.wire.take(now), this.digest, now, WIRE_MESSAGE_BYTES))
      if (this.transport.send(channel, msg)) sent += msg.o.length
    return sent
  }
  receive(channel, env) {
    if (
      typeof channel !== 'string' ||
      !channel.startsWith('gator/px/') ||
      env?.channel !== channel ||
      typeof env.from !== 'string' ||
      !keyPattern.test(env.from) ||
      env.from === this.transport.publicKey
    )
      return
    const msg = env.message,
      now = this.clock()
    if (
      msg?.t !== 'obs' ||
      msg.v !== 1 ||
      msg.b !== this.digest ||
      !validTime(msg.at, now) ||
      !Array.isArray(msg.o) ||
      !msg.o.length ||
      msg.o.length > 200 ||
      this.muted(env.from) ||
      bytes(env) > PX_POLICY.maxReceiveBytes ||
      !this.quota.take(env.from, msg.o.length)
    )
      return
    if (!msg.o.every((row) => validRow(row, now) && channelFor(row[0]) === channel)) return
    const accepted = [], unknown = []
    for (const row of msg.o) (this.accepts(row) ? accepted : unknown).push(row)
    if (unknown.length) this.onUnknown?.(env.from, unknown, msg.b)
    if (accepted.length) this.ingest(env.from, accepted, false)
  }
}
