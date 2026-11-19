import { NEW_POLICY, PeerQuota, keyPattern } from '../obs/index.js'
import { DAY } from './supply-api.js'

const channel = 'gator/meta'
const maxAssets = 512, maxReporters = 16
const validNumber = n => typeof n === 'string' && /^\d{1,78}(?:\.\d{1,77})?$/.test(n)
const totalMethods = new Set(['near-block-total', 'xrpl-ledger-total', 'cosmos-bank-supply', 'aptos-coin-supply', 'sui-coin-total'])

// All admitted quantities have at most 77 fractional digits. Compare the 0.5% boundary exactly.
export function scaledSupply(value) {
  if (!validNumber(value)) return null
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole + fraction.padEnd(77, '0'))
}

/** Supply hints live only in this bounded cache. Recheck standing, age and quorum on every display read. */
export class SupplyClaims {
  constructor(engine, onHint) {
    this.engine = engine
    this.onHint = onHint
    this.hints = new Map()
    this.quota = new PeerQuota(engine.clock, 60)
    this.receive = this.receive.bind(this)
  }
  async listen() {
    const { active, abort, transport, joined } = this.engine
    if (!active || this.attached) return
    if (!transport.channels().includes(channel)) {
      if (!(await transport.join(channel, NEW_POLICY))) throw new Error('Could not join supply channel')
      joined.push(channel)
    }
    abort.signal.throwIfAborted()
    transport.on('message', this.receive)
    this.attached = true
    abort.signal.addEventListener('abort', () => {
      transport.off('message', this.receive)
      this.attached = false
      this.hints.clear()
    }, { once: true })
  }
  receive(topic, env) {
    const { transport, book, clock, registry } = this.engine, m = env?.message, now = clock()
    if (topic !== channel || env?.channel !== topic || m?.t !== 'claim' || m.v !== 1 || m.kind !== 'supply' ||
        typeof env.from !== 'string' || !keyPattern.test(env.from) || env.from === transport.publicKey || !registry.assets.has(m.asset) ||
        !validNumber(m.value) || typeof m.method !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(m.method) ||
        totalMethods.has(m.method) || m.method === 'peer-agreement' || m.method === 'exchange-reported' ||
        (m.quantity !== undefined && m.quantity !== 'circulating') ||
        (m.block !== undefined && !(Number.isSafeInteger(m.block) && m.block >= 0)) ||
        (m.source !== undefined && (typeof m.source !== 'string' || !/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(m.source))) ||
        (m.estimate !== undefined && typeof m.estimate !== 'boolean') || m.proof !== undefined ||
        !Number.isSafeInteger(env.ts) || !Number.isSafeInteger(m.at) || m.at <= 0 || m.at > now ||
        env.ts < now - DAY || env.ts > now + 30_000 || m.at > env.ts + 30_000 || now - m.at > this.ttl(m) ||
        Buffer.byteLength(JSON.stringify(m)) > NEW_POLICY.maxReceiveBytes || !this.quota.take(env.from, 1) ||
        !book.isProven(env.from)) return
    let reports = this.hints.get(m.asset)
    if (!reports) {
      if (this.hints.size >= maxAssets) this.hints.delete(this.hints.keys().next().value)
      this.hints.set(m.asset, reports = new Map())
    }
    if ((reports.get(env.from)?.at ?? -1) >= m.at) return
    for (const [key, row] of reports) if (now - row.at > this.ttl(row)) reports.delete(key)
    if (!reports.has(env.from) && reports.size >= maxReporters) return
    reports.set(env.from, { value: m.value, at: m.at, method: m.method, reporter: env.from,
      ...(m.source && { source: m.source }), ...(m.block !== undefined && { block: m.block }) })
    this.onHint?.(m.asset)
  }
  ttl(row) {
    return row.method === 'chain-circulating' ? 4 * DAY : DAY
  }
  consensus(id, total) {
    const now = this.engine.clock(), ceiling = scaledSupply(total)
    const rows = [...(this.hints.get(id)?.values() ?? [])]
      .filter(r => now - r.at <= this.ttl(r) && this.engine.book.isProven(r.reporter))
      .map(report => ({ report, amount: scaledSupply(report.value) }))
      .filter(r => ceiling === null || r.amount <= ceiling)
      .sort((a, b) => a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0)
    // Select a unique largest cluster whose extremes agree within 0.5% of its lower value.
    // Conflicting quorums of the same size cannot decide the display.
    let best = [], tied = false
    for (let start = 0; start < rows.length; start++) {
      let end = start + 1
      while (end < rows.length && rows[end].amount * 200n <= rows[start].amount * 201n) end++
      const count = end - start
      if (count > best.length) { best = rows.slice(start, end); tied = false }
      else if (count === best.length) tied = true
    }
    if (tied || best.length < 2) return null
    // Choose a reported median to preserve the original decimal precision.
    return { value: best[Math.floor((best.length - 1) / 2)].report.value, method: 'peer-agreement', source: channel,
      at: Math.min(...best.map(r => r.report.at)), estimate: true, reporters: best.map(r => ({ ...r.report })) }
  }
  send(id, record, quantity) {
    const { transport, active } = this.engine
    if (!active || !this.attached) return
    const { value, method, source, at, estimate, block } = record
    transport.send(channel, { t: 'claim', v: 1, asset: id, kind: 'supply', value, quantity, method, source, at,
      ...(estimate && { estimate }), ...(block !== undefined && { block }) })
  }
}
