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
export function* batches(rows, digest, at) {
  const groups = new Map()
  const message = () => ({ t: 'obs', v: 1, b: digest, at, o: [] })
  for (const row of rows) {
    if (!validRow(row, at)) continue
    const channel = channelFor(row[0])
    let group = groups.get(channel)
    if (!group) groups.set(channel, (group = { msg: message(), size: bytes(message()) }))
    const size = bytes(row) + 1
    if (group.msg.o.length >= 200 || group.size + size > PX_POLICY.maxReceiveBytes - 1024) {
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

export class ObservationExchange {
  constructor({
    transport,
    digest,
    clock = Date.now,
    ingest,
    muted = () => false,
    accepts = () => true,
    canPublish = () => true,
    rowLimit,
  }) {
    if (!/^[a-f0-9]{16}$/.test(digest)) throw new TypeError('Expected 16-hex bundle digest prefix')
    Object.assign(this, { transport, digest, clock, ingest, muted, accepts, canPublish })
    this.quota = new PeerQuota(clock, rowLimit)
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
    } catch (err) {
      await this.stop()
      throw err
    }
  }
  async stop() {
    this.started = false
    this.transport.off('message', this.listener)
    await settleWithin(this.joined.splice(0).map((c) => this.transport.leave(c)))
  }
  publish(rows, localQuoteVolumes) {
    let sent = 0
    for (const [channel, msg] of batches(rows, this.digest, this.clock())) {
      const accepted = msg.o.filter(this.accepts)
      if (!accepted.length) continue
      this.ingest(this.transport.publicKey, accepted, true, localQuoteVolumes)
      msg.o = accepted.filter(this.canPublish)
      if (msg.o.length && this.transport.send(channel, msg)) sent += msg.o.length
    }
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
    const accepted = msg.o.filter(this.accepts)
    if (accepted.length) this.ingest(env.from, accepted, false)
  }
}
