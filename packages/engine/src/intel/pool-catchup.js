import { randomBytes } from 'node:crypto'
import { RateLimited } from '../scheduler/index.js'

export const POOL_CHANNEL = 'gator/pools/1'
export const CATCHUP_JOB = 'discovery:pool-history'
const MINUTE = 60_000, WEEK = 7 * 86400_000, OFFLINE = 6 * 3600_000
const PAGE = 8, CAP = 5000, PEERS = 3, BODY_BYTES = 7168
const SESSION = 'engine:pool-catchup', ONLINE = 'engine:pool-catchup:last-online'
const bytes = message => Buffer.byteLength(JSON.stringify(message))
const idOk = id => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id)
const cursorOf = row => [row.at, row.chain, row.pool]
const cursorOk = c => Array.isArray(c) && c.length === 3 && Number.isSafeInteger(c[0]) && c[0] >= 0 &&
  typeof c[1] === 'string' && /^[a-z0-9_-]{1,32}$/.test(c[1]) && typeof c[2] === 'string' &&
  /^0x(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(c[2])
const earlier = (a, b) => a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))
const fresh = () => ({ until: null, count: 0, peers: [], page: null, done: false })

// Both ends use the same total order. CROSS JOIN keeps the bounded history index as the
// outer loop even on a heavily pruned store. Ties seek directly to the next pool.
export const PAGE_SQL = `SELECT h.at,p.chain,p.pool,p.dex,p.kind,p.token0,p.token1,p.block,p.tx
  FROM engine_pool_history h CROSS JOIN pools p USING(chain,pool)
  WHERE h.verified=1 AND h.at>=? AND (h.at,h.chain,h.pool)<(?,?,?)
  ORDER BY h.at DESC,h.chain DESC,h.pool DESC LIMIT ?`

export class PoolCatchup {
  constructor(engine) {
    this.engine = engine
    this.active = false
    this.membership = Promise.resolve()
    const { reader, writer } = engine.store
    this.select = reader.prepare(PAGE_SQL)
    this.available = reader.prepare('SELECT 1 FROM engine_pool_history WHERE verified=1 AND at BETWEEN ? AND ? LIMIT 1')
    this.unchecked = reader.prepare(`SELECT at,chain,pool FROM engine_pool_history WHERE verified=0
      AND at>=? AND (at,chain,pool)<(?,?,?) ORDER BY at DESC,chain DESC,pool DESC LIMIT 1`)
    this.legacy = reader.prepare(`SELECT p.* FROM engine_pool_history h CROSS JOIN pools p USING(chain,pool)
      WHERE h.verified=0 AND h.at BETWEEN ? AND ? ORDER BY h.at DESC,h.chain DESC,h.pool DESC LIMIT 1`)
    this.checked = writer.prepare('UPDATE engine_pool_history SET verified=? WHERE chain=? AND pool=? AND verified=0')
    this.expire = writer.prepare('DELETE FROM engine_pool_history WHERE verified IN (-1,0,1) AND at<?')
    this.served = new Map()
    this.nextRead = this.nextServe = this.nextOffer = this.nextLegacy = 0
    engine.scheduler.add({ id: CATCHUP_JOB, idleOnly: true, interval: 500,
      ready: () => this.active && !this.busy && (this.state.page !== null || !!this.oldRow || engine.names.historyDue()),
      run: () => this.run() })
  }

  // DHT discovery for the optional topic must never hold up the daemon. Serialize its
  // ownership across a slow join, stop and restart on the same transport.
  join(signal) {
    const { transport } = this.engine
    this.membership = this.membership.then(async () => {
      if (signal.aborted) return
      const existing = transport.channels?.().includes(POOL_CHANNEL)
      let joined
      try { joined = await transport.join(POOL_CHANNEL, { verifySignature: true, powDifficulty: 10, maxReceiveBytes: 8192 }) }
      catch { joined = false }
      if (joined !== false) this.ownsChannel = !existing
      if (signal.aborted) return
      if (joined !== false) this.start()
      else this.retryJoin = setTimeout(() => this.join(signal), 5 * MINUTE).unref()
    })
  }
  leave() {
    clearTimeout(this.retryJoin)
    this.stop()
    this.membership = this.membership.then(async () => {
      if (this.ownsChannel) {
        this.ownsChannel = false
        await this.engine.transport.leave(POOL_CHANNEL)
      }
    }).catch(() => {})
    return this.membership
  }
  start() {
    const { store } = this.engine
    this.state = store.getSetting(SESSION) ?? fresh()
    this.online = store.getSetting(ONLINE) ?? 0
    this.lastOffer = new Map()
    this.active = true
    this.timer = setInterval(() => this.tick(), 2000)
    this.timer.unref()
    this.tick()
  }
  stop() {
    clearInterval(this.timer)
    if (this.active) this.save()
    this.active = false
    this.waiting = this.work = this.oldRow = null
  }
  save() { this.engine.store.setSetting(SESSION, this.state) }
  send(t, fields = {}) { return this.engine.transport.send(POOL_CHANNEL, { t, v: 1, ...fields }) }

  tick() {
    const { clock, transport, store, book, hints } = this.engine
    if (!this.active || !transport.peerCount?.()) return
    const now = clock()
    if ((this.online && now - this.online >= OFFLINE) ||
        (!this.state.done && this.state.until !== null && now - this.state.until >= WEEK)) {
      this.state = fresh()
      this.lastOffer.clear()
      this.waiting = this.work = null
      this.save()
    }
    if (!this.online || now - this.online >= 5 * MINUTE) {
      this.online = now
      store.setSetting(ONLINE, now)
    }
    if (now >= this.nextOffer) {
      this.nextOffer = now + MINUTE
      if (this.available.get(now - WEEK, now)) this.send('offer')
    }
    if (!this.oldRow && now >= this.nextLegacy) {
      this.oldRow = this.legacy.get(now - WEEK, now)
      this.nextLegacy = now + (this.oldRow ? 2000 : MINUTE)
    }
    const state = this.state
    if (state.done || state.page) return
    if (this.waiting) {
      if (now < this.waiting.expires) return
      this.lastOffer.delete(this.waiting.key)
      this.waiting = null
    }
    const peers = state.peers.filter(p => !p.end && !book.muted(p.key) && this.lastOffer.has(p.key) &&
      now >= (p.retryAt ?? 0) && now - p.requested >= 6000)
    if (!peers.length) {
      if (state.peers.some(p => p.end) && state.peers.every(p => p.end ||
          (!this.lastOffer.has(p.key) && now - p.requested >= 2 * MINUTE)) &&
          (state.peers.length === PEERS || now - state.until >= 2 * MINUTE)) {
        state.done = true
        this.save()
      }
      return
    }
    // Rotate between sources with similar standing, even when their pages overlap.
    peers.sort((a, b) => hints.rank(b.key) - hints.rank(a.key) || a.requested - b.requested)
    const peer = peers[0]
    peer.requested = now
    const id = randomBytes(12).toString('hex')
    this.waiting = { key: peer.key, id, expires: now + 20_000 }
    this.send('get', { to: peer.key, id, until: state.until, before: peer.cursor })
  }

  receive({ from, message: m, ts }) {
    const { clock, transport, book } = this.engine
    if (!this.active || from === transport.publicKey || book.muted(from)) return
    const now = clock()
    if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > 2 * MINUTE) return
    if (m.t === 'offer') {
      const state = this.state
      if (state.done || Object.keys(m).length !== 2) return
      let peer = state.peers.find(p => p.key === from)
      if (!peer) {
        if (state.peers.length === PEERS) {
          // Reclaim a silent, unfinished source. A late reply cannot advance its replacement.
          const i = state.peers.findIndex(p => !p.end && p.key !== state.page?.key && p.key !== this.waiting?.key &&
            now - (this.lastOffer.get(p.key) ?? p.requested) >= 2 * MINUTE)
          if (i < 0) return
          this.lastOffer.delete(state.peers[i].key)
          state.peers.splice(i, 1)
        }
        peer = { key: from, cursor: null, end: false, requested: 0 }
        state.peers.push(peer)
        state.until ??= now
        this.save()
      }
      if (!peer.end) this.lastOffer.set(from, now)
      return
    }
    if (m.to !== transport.publicKey || !idOk(m.id)) return
    if (m.t === 'get') return this.serve(from, m, now)
    const wait = this.waiting
    if (m.t !== 'page' || !wait || wait.key !== from || wait.id !== m.id || now >= wait.expires ||
        !Array.isArray(m.rows) || m.rows.length > PAGE || typeof m.more !== 'boolean' ||
        bytes(m) > BODY_BYTES) return
    const state = this.state, peer = state.peers.find(p => p.key === from)
    let before = peer.cursor ?? [state.until + 1, '', '']
    for (const row of m.rows) {
      if (!row || typeof row !== 'object') return
      const cursor = cursorOf(row)
      if (!cursorOk(cursor) || cursor[0] < state.until - WEEK || !earlier(cursor, before)) return
      before = cursor
    }
    this.waiting = null
    // An upgraded peer may still be checking the next legacy creation. Do not step past
    // that record. Other peers remain eligible while this one is preparing its page.
    if (m.more && !m.rows.length) {
      peer.waitSince ??= now
      peer.retryAt = now + 15_000
      if (now - peer.waitSince >= 10 * MINUTE) peer.end = true
      this.save()
      return
    }
    delete peer.waitSince
    delete peer.retryAt
    state.page = { key: from, rows: m.rows.slice(0, CAP - state.count), more: m.more, offset: 0 }
    // Keep the one accepted page until the registry writes complete, including while offline.
    this.save()
    this.skipKnown()
  }

  serve(to, m, now) {
    if (now < this.nextServe || now < (this.served.get(to) ?? 0) || bytes(m) > 512 ||
        !Number.isSafeInteger(m.until) || m.until < now - WEEK || m.until > now + 2 * MINUTE ||
        !(m.before === null || (cursorOk(m.before) && m.before[0] <= m.until))) return
    // One reply per second globally and one per six seconds per identity bounds the work
    // and the map (including when keys rotate). Charge before the index seek and signing.
    for (const [key, until] of this.served) if (until <= now) this.served.delete(key)
    this.served.set(to, now + 6000)
    this.nextServe = now + 1000
    const before = m.before ?? [Math.min(m.until, now) + 1, '', '']
    const cutoff = Math.max(now, m.until) - WEEK
    const pending = this.unchecked.get(cutoff, ...before)
    let rows = this.select.all(cutoff, ...before, PAGE + 1)
    if (pending) {
      const frontier = cursorOf(pending)
      rows = rows.filter(row => earlier(frontier, cursorOf(row)))
    }
    const more = !!pending || rows.length > PAGE
    if (rows.length > PAGE) rows.pop()
    const response = { t: 'page', v: 1, to, id: m.id, rows, more }
    if (bytes(response) <= BODY_BYTES) this.engine.transport.send(POOL_CHANNEL, response)
  }

  skipKnown() {
    const { registry, hints, book } = this.engine
    const state = this.state, page = state.page
    while (page.offset < page.rows.length) {
      const row = page.rows[page.offset]
      if (!book.muted(page.key) && this.engine.evm.has(row.chain) &&
          !registry.markets.has('dex:' + row.chain + ':' + row.pool) && hints.candidate(row, page.key)) return
      page.offset++
    }
    const peer = state.peers.find(p => p.key === page.key)
    if (page.rows.length) peer.cursor = cursorOf(page.rows.at(-1))
    peer.end = !page.more
    state.count += page.rows.length
    state.done = state.count >= CAP
    state.page = null
    this.save()
  }

  // Each scheduler turn can dispatch one public RPC at most. Keep partial non-multicall
  // batches on the same record so an endpoint granting one call at a time makes progress.
  reads(cache) {
    const { rpc, budget, clock } = this.engine
    const signal = rpc.signal
    let dispatched = false
    const call = async (chain, method, params) => {
      const key = JSON.stringify([method, params])
      if (cache.has(key)) return cache.get(key)
      const now = clock()
      if (dispatched || now < this.nextRead) throw new RateLimited(Math.max(this.nextRead, now + 1))
      if (budget.used >= Math.floor(budget.limit * 0.75)) throw new RateLimited(now + 2000)
      this.nextRead = now + Math.max(500, Math.ceil(60_000 / Math.max(1, Math.floor(budget.limit / 4))))
      dispatched = true
      const value = await rpc.callWhenIdle(chain, method, params)
      signal?.throwIfAborted()
      cache.set(key, value)
      return value
    }
    return { call, async batch(chain, calls) {
      const values = []
      for (const { method, params } of calls) values.push(await call(chain, method, params))
      return values
    } }
  }

  async run() {
    if (!this.active || this.busy) return
    if (this.engine.names.historyDue() && this.engine.clock() >= this.nextRead) {
      this.busy = true
      try { await this.engine.names.readHistory(this.reads(new Map())) }
      finally { this.busy = false }
      return
    }
    if (this.state.page) this.skipKnown()
    const page = this.state.page, row = page?.rows[page.offset] ?? this.oldRow
    if (!row) return
    const { hints, evm, clock } = this.engine
    if (this.work?.row !== row) this.work = { row, cache: new Map(), reads: new Map(), failures: 0 }
    const work = this.work, rpc = this.reads(work.reads)
    this.busy = true
    try {
      if (page) {
        const hint = hints.candidate(row, page.key)
        const pool = await evm.get(row.chain).verifyPoolHint(hint, rpc, work.cache, {
          since: this.state.until - WEEK, wanted: () => this.active && this.state.page === page && !this.engine.book.muted(page.key),
        })
        if (this.state.page !== page || !this.active) return
        if (pool === false) hints.penalize(page.key)
        else if (pool) this.engine.discovery(pool, true, page.key)
      } else {
        const ok = await hints.hasCreationReceipt(row, rpc)
        if (this.active) this.checked.run(ok ? 1 : -1, row.chain, row.pool)
      }
    } catch (error) {
      if (error instanceof RateLimited || !this.active) throw error
      // Endpoint failures are inconclusive. Back off the whole lane and release this record
      // after three failures so a broken provider cannot pin every chain behind it.
      this.nextRead = clock() + 15_000 * 2 ** work.failures
      if (++work.failures < 3) throw new RateLimited(this.nextRead)
      if (!page) this.checked.run(-1, row.chain, row.pool)
    } finally { this.busy = false }
    this.work = null
    if (!page) this.oldRow = null
    else if (this.state.page === page) {
      page.offset++
      this.skipKnown()
    }
  }
}
