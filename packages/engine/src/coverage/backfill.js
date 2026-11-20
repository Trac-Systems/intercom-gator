import { RateLimited } from '../scheduler/index.js'
import { address, multiRead, word, ZERO } from '../sources/evm-abi.js'
import { logWindow } from '../sources/bundle-adapter.js'
import { HISTORY_FLOOR, MAX_SPAN, historyFactories, historyRanges, indexPage, logPage, hex, quantity } from './factory-history.js'

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR
const SEARCH = Object.freeze({ length: 1, window: 0, wholeHistory: -1, needHead: -2 })
export const BACKFILL_JOB = 'discovery:factory-history'
export const HISTORY_SHARE = 0.05
export const HISTORY_CAP = { small: 4000, normal: 16_000, large: 48_000 }
export const FORWARD_CAP = { small: 8, normal: 32, large: 64 }

/** Charged inside the endpoint bucket, immediately before each real public dispatch. A denied
 * request consumes neither bucket. Other source jobs share the parent budget and always take priority. */
export class HistoryBudget {
  constructor(budget, clock) {
    Object.assign(this, { budget, clock })
    this.times = []
  }
  retryAt() {
    const now = this.clock(), { budget, times } = this
    // For a user limit below 20/min, a fractional request gets one slot over several minutes.
    const window = Math.max(1,Math.ceil(1/(budget.limit*HISTORY_SHARE))) * MINUTE
    while (times.length && times[0] <= now - window) times.shift()
    const limit = Math.max(1,Math.floor(budget.limit * HISTORY_SHARE))
    if (times.length >= limit) return times[times.length - limit] + window
    if (budget.used >= Math.max(1,Math.floor(budget.limit / 2))) return budget.times[0] + MINUTE
    return 0
  }
  take() {
    const retry = this.retryAt()
    if (retry) throw new RateLimited(retry)
    this.budget.take()
    this.times.push(this.clock())
  }
}

export class FactoryBackfill {
  constructor(engine) {
    const { store, clock, profile } = engine
    this.engine = engine
    this.clock = clock
    this.budget = new HistoryBudget(engine.budget, clock)
    const call = (chain, method, params) => engine.rpc.callWhenIdle(chain, method, params, this.budget)
    this.rpc = { call, async batch(chain, calls) {
      const result = []
      for (const { method, params } of calls) result.push(await call(chain, method, params))
      return result
    } }
    const db = store.writer
    this.progress = db.prepare('SELECT * FROM engine_history_ranges WHERE chain=? AND factory=? AND mode=?')
    this.mark = db.prepare('INSERT OR REPLACE INTO engine_history_ranges VALUES (?,?,?,?,?,?,?,?)')
    this.keep = db.prepare(`INSERT OR IGNORE INTO engine_history_pools
      (chain,pool,factory,idx,block,tx,lo,hi,bisect,span,nextShare) VALUES (?,?,?,?,?,?,0,?,1,?,?)`)
    this.count = db.prepare('SELECT count(*) AS n FROM engine_history_pools')
    this.liveBytes = db.prepare(`SELECT (page_count-freelist_count)*page_size AS bytes
      FROM pragma_page_count, pragma_freelist_count, pragma_page_size`)
    this.byteLimit = store.limits.storeBudgetMB * 1024 ** 2
    this.capacity = HISTORY_CAP[profile] ?? HISTORY_CAP.normal
    this.forwardCapacity = FORWARD_CAP[profile] ?? FORWARD_CAP.normal
    this.forwardCount = db.prepare('SELECT count(*) AS n FROM engine_history_forward')
    this.forward = db.prepare(`INSERT OR IGNORE INTO engine_history_forward
      (chain,pool,factory,idx,block,tx,token0,token1,kind,dex,firstSeen,lo,hi,bisect,span,nextShare)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,1,?,?)`)
    this.forwardRow = db.prepare('SELECT *,1 AS forwardOnly FROM engine_history_forward WHERE nextShare<=? ORDER BY nextShare,chain,pool LIMIT 1')
    this.forwarded = db.prepare('DELETE FROM engine_history_forward WHERE chain=? AND pool=?')
    this.countRemote = db.prepare('SELECT count(*) AS n FROM engine_history_received')
    this.retainRemote = db.prepare('INSERT OR IGNORE INTO engine_history_received VALUES (?,?)')
    for (const source of engine.evm.values()) source.historyRetention = this
    this.sendRow = db.prepare(`SELECT p.chain,p.pool,p.firstSeen,p.token0,p.token1,p.kind,p.dex,
      h.factory,h.idx,h.block,h.tx,h.lo,h.hi,h.bisect,h.span FROM engine_history_pools h
      CROSS JOIN pools p USING(chain,pool) WHERE h.nextShare<=? ORDER BY h.nextShare,h.chain,h.pool LIMIT 1`)
    this.outboxes = ['engine_history_pools','engine_history_forward'].map(table=>({
      evidence: db.prepare('UPDATE '+table+' SET block=?,tx=? WHERE chain=? AND pool=?'),
      search: db.prepare('UPDATE '+table+' SET lo=?,hi=?,bisect=?,span=?,nextShare=? WHERE chain=? AND pool=?'),
      snooze: db.prepare('UPDATE '+table+' SET nextShare=? WHERE chain=? AND pool=?'),
    }))
    this.nextSend = store.getSetting('engine-history/next-send') ?? 0
    const depths = new Map(db.prepare('SELECT chain,max(liquidity) AS depth FROM pools GROUP BY chain').all().map(r => [r.chain,r.depth]))
    this.tasks = [...engine.evm.values()].sort((a,b) => (depths.get(b.chain.id) ?? 0) - (depths.get(a.chain.id) ?? 0) ||
      b.chain.quotes.length - a.chain.quotes.length).flatMap(source => historyFactories(source).map(factory => {
      const key = 'engine-history/' + source.chain.id + '/' + factory.address
      return { source, factory, key, bounds: store.getSetting(key), wake: 0, last: -Infinity }
    }))
    this.turn = 0
    this.recent = new Map()
    this.capWake = this.shareWake = 0
    engine.scheduler.add({ id: BACKFILL_JOB, idleOnly: true, interval: 500, ready: () => this.ready(), run: () => this.run() })
  }

  canRetainRemote() {
    return this.countRemote.get().n < Math.floor(this.capacity / 2) && this.liveBytes.get().bytes < this.byteLimit * 0.9
  }

  connected() { return (this.engine.transport.peerCount?.() ?? 0) > 0 }

  workLifetime() {
    // A user may allow just one public request per minute (one historical read per 20 minutes).
    // A complete page needs several such turns even with Multicall3.
    return Math.max(10 * MINUTE,8 * MINUTE / (this.engine.budget.limit * HISTORY_SHARE))
  }

  nextRow(now) {
    if (!this.connected()) return null
    // Give queued forwards two of every three outbox turns, while keeping ordinary proofs moving.
    if (this.turn % 3 !== 0) return this.forwardRow.get(now) ?? this.sendRow.get(now)
    return this.sendRow.get(now) ?? this.forwardRow.get(now)
  }

  ready() {
    if (this.busy || !this.tasks.length || this.budget.retryAt()) return false
    const now = this.clock()
    return (now >= this.capWake && this.tasks.some(t => t.wake <= now)) ||
      (now >= this.shareWake && !!this.nextRow(now)) || this.engine.names.factoryDue()
  }

  unusedTurn() {
    const { scheduler } = this.engine, job = scheduler.jobs.get(BACKFILL_JOB)
    if (scheduler.backgroundJobs && !scheduler.backgroundJobs.has(job.id) || job.next > this.clock() || !this.ready()) return
    return scheduler.execute(job, job.run)
  }

  /** A live signed announcement suppresses our copy only if all independently resolved fields match. */
  heard(msg, signer) {
    if (!this.engine.book.isProven(signer) || !this.engine.evm.has(msg.chain) ||
        !/^0x(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(msg.pool) || !/^0x[a-f0-9]{64}$/.test(msg.tx)) return
    const key = msg.chain + ':' + msg.pool
    this.recent.delete(key)
    if (this.recent.size >= 1024) this.recent.delete(this.recent.keys().next().value)
    this.recent.set(key, { fields: [msg.dex, msg.kind, msg.token0, msg.token1, msg.block, msg.tx], at: this.clock() })
  }

  async run() {
    if (!this.ready()) return
    this.busy = true
    try {
      const now = this.clock()
      const tasks = now >= this.capWake ? this.tasks.filter(t => t.wake <= now) : []
      // Finish partial pages first. Rotate completed pages, including after a failed provider.
      tasks.sort((a,b) => Number(!!a.plan?.ranges[0]?.revisit) - Number(!!b.plan?.ranges[0]?.revisit) ||
        Number(!!(b.work || b.firstPage)) - Number(!!(a.work || a.firstPage)) || a.last - b.last)
      const task = tasks[0]
      this.turn++
      if (this.turn % 8 === 2 && this.engine.names.factoryDue())
        return await this.engine.names.readFactory(this.rpc)
      if ((!task || this.turn % 4 === 0) && now >= (this.shareWake ?? 0)) {
        const row = this.nextRow(now)
        if (row) return await this.shareStep(row)
        this.shareWake = now + 10_000
      }
      if (!task) return
      task.last = now
      try {
        await this.step(task)
      } catch (error) {
        if (error instanceof RateLimited) {
          task.wake = error.retryAt
          return
        }
        task.work = null
        task.wake = now + MINUTE
        throw error
      }
    } finally { this.busy = false }
  }

  async head(task) {
    const source = task.source, latest = source.latest
    if (latest?.ts != null && this.clock() - latest.at < 15_000) return latest
    const result = await this.rpc.call(source.chain.id, 'eth_getBlockByNumber', ['latest', false])
    const tip = quantity(result?.number), ts = quantity(result?.timestamp)
    if (tip === null || ts === null) throw new Error('Invalid factory history head')
    return { tip, ts, at: this.clock() }
  }

  async read(chain, calls, block, cache) {
    const out = [], size = chain.multicall ? 128 : 1
    for (let i = 0; i < calls.length; i += size) {
      const part = calls.slice(i, i + size), key = JSON.stringify([block, part])
      if (!cache.has(key)) cache.set(key, await multiRead(this.rpc, chain, part, hex(block)))
      out.push(...cache.get(key))
    }
    return out
  }

  /** A committed range may extend at the next bounds refresh. Its existing prefix is still complete. */
  async bounds(task) {
    const { source, factory } = task, chain = source.chain
    if (!task.work || task.work.range || this.clock() - task.work.at > this.workLifetime())
      task.work = { at: this.clock(), cache: new Map() }
    const work = task.work
    const head = work.head ??= await this.head(task)
    let mode = 'logs', end = Math.max(0, head.tip - 64) + 1
    if (factory.array) {
      const [length, first] = await this.read(chain, [
        { to: factory.address, data: factory.array[0] }, { to: factory.address, data: factory.array[1] + word(0) },
      ], end - 1, work.cache)
      const n = quantity(length), id = address(first)
      if (n === 0 || n !== null && id && id !== ZERO) { mode = 'index'; end = n }
    }
    // Finish the snapshot already assigned to this node. On a fast chain, continually moving
    // the newest log range to the front can otherwise prevent a solo reader from reaching older blocks.
    const previous = task.bounds
    if (mode === 'logs' && previous?.mode === mode && previous.end < end &&
        this.plan(task).ranges.some(r => !r.revisit && r.next < r.end)) end = previous.end
    task.bounds = { mode, end, at: this.clock() }
    this.engine.store.setSetting(task.key, task.bounds)
    task.plan = task.work = null
    task.firstPage = true
  }

  plan(task) {
    const { source, factory, bounds } = task, chain = source.chain.id
    const roster = this.engine.dexCoverage.members()
    if (task.plan?.layout === roster.version) return task.plan
    const cursors = new Map(this.progress.all(chain, factory.address, bounds.mode).map(row => [row.start, row]))
    const ranges = historyRanges(chain, factory.address, bounds.mode, bounds.end)
      .filter(r => !roster.split || roster.priority(r.key) !== null)
    if (roster.split) ranges.sort((a,b) => roster.priority(b.key) - roster.priority(a.key) || a.start - b.start)
    const pending = [], revisit = []
    for (const r of ranges) {
      const c = cursors.get(r.start)
      if (!c || c.next < r.end) pending.push(Object.assign(r, { next: c?.next ?? r.start, after: c?.afterIdx ?? -1, span: c?.span ?? MAX_SPAN }))
      else if (c.checkedAt <= this.clock() - 30 * DAY)
        revisit.push(Object.assign(r, { next: r.start, after: -1, span: c.span, revisit: true }))
    }
    return task.plan = { layout: roster.version, ranges: pending.concat(revisit) }
  }

  async step(task) {
    if (!task.bounds || this.clock() - task.bounds.at >= 6 * HOUR) return this.bounds(task)
    const plan = this.plan(task), range = plan.ranges[0]
    if (!range) {
      task.work = null
      task.firstPage = false
      task.wake = Math.min(task.bounds.at + 6 * HOUR, this.clock() + MINUTE)
      return
    }
    if (this.liveBytes.get().bytes >= this.byteLimit * 0.9 ||
        (this.count.get().n >= this.capacity && (!this.connected() || this.forwardCount.get().n >= this.forwardCapacity))) {
      this.capWake = this.clock() + MINUTE
      return
    }
    await this.page(task, range)
    if (range.next >= range.end) plan.ranges.shift()
  }

  /** One atomic index/log page. The ephemeral cache only avoids duplicate successful RPCs across denials.
   * Restart re-reads this page at current state and never advances its on-disk cursor early. */
  async page(task, range) {
    const { source, factory, bounds } = task, { store } = this.engine
    const chain = source.chain.id, now = this.clock()
    if (task.work?.range !== range || now - task.work.at > this.workLifetime())
      task.work = { range, at: now, cache: new Map() }
    const work = task.work
    const read = calls => this.read(source.chain, calls, work.head?.tip, work.cache)
    let page
    if (bounds.mode === 'logs') {
      page = work.logs ??= await logPage({ source, factory, rpc: this.rpc, from: range.next, end: range.end,
        span: range.span, after: range.after })
      if (page.retrySpan) {
        this.mark.run(chain, factory.address, bounds.mode, range.start, range.next, range.after, page.retrySpan, now)
        range.span = page.retrySpan
        task.work = null
        return
      }
    }
    if (!page || page.pools.length) work.head ??= await this.head(task)
    page ??= await indexPage(source, factory, range.next, range.end, read)
    const pools = page.pools
    const decimals = await source.readDecimals(pools, work.head?.tip, read)
    // Index membership and token identities can take several low-budget turns. Re-pin the
    // funded-state batch after those reads so the observation uses its own block timestamp.
    const pricingHead = pools.length && now - work.head.at > 10 * MINUTE
      ? (work.pricingHead ??= await this.head(task)) : work.head
    const stateRead = calls => this.read(source.chain,calls,pricingHead?.tip,work.cache)
    const states = await source.snapshots(pools, stateRead, decimals)
    if (this.liveBytes.get().bytes >= this.byteLimit * 0.9) {
      this.capWake = this.clock() + MINUTE
      return
    }
    const rows = []
    let capacity = this.capacity - this.count.get().n
    let forwards = this.connected() ? this.forwardCapacity - this.forwardCount.get().n : 0
    let { next, after } = page
    store.transaction(() => {
      for (const [i, p] of pools.entries()) {
        const state = states[i]
        if (!(state?.liquidity >= HISTORY_FLOOR)) continue
        const id = 'dex:' + chain + ':' + p.pool, known = source.registry.markets.get(id)
        const old = known && source.poolInfo.get(chain,p.pool)
        if (!known && capacity <= 0) {
          if (forwards > 0) {
            // A full node can still introduce this pool to other readers. The queued identity and
            // cursor commit together. The receiver runs its ordinary independent verification.
            forwards -= Number(this.forward.run(chain,p.pool,factory.address,p.index??null,p.block??null,p.tx??null,
              p.token0,p.token1,p.kind,p.dex,now,work.head.tip,MAX_SPAN,now).changes)
            continue
          }
          next = p.index ?? p.block
          after = p.index == null ? p.idx - 1 : -1
          this.capWake = now + MINUTE
          break
        }
        const info = a => ({ ...source.metadata(a), decimals: decimals.get(a) ?? source.metadata(a)?.decimals })
        const record = { ...p, firstSeen: now, liquidity: state.liquidity }
        const market = source.registry.pool(record, { token0: info(p.token0), token1: info(p.token1) })
        if (!market) continue
        source.saveParameters(record)
        rows.push(source.stateRow(market, state.price, pricingHead.ts * 1000))
        // A locally seeded state-only identity can still gain its first shareable creation.
        if (capacity > 0 && (!known || !old?.tx || (!known.fromHint && p.tx && old.tx !== p.tx))) {
          capacity -= Number(this.keep.run(chain, p.pool, factory.address, p.index ?? null,
            p.block ?? null, p.tx ?? null, work.head.tip, MAX_SPAN, now).changes)
          if (p.tx) this.outboxes[0].evidence.run(p.block,p.tx,chain,p.pool)
        }
        if (known) continue
        this.engine.names.enqueueFactory(market.base)
        this.engine.names.enqueueFactory(market.quote)
      }
      this.mark.run(chain, factory.address, bounds.mode, range.start, next, after, page.span ?? range.span, now)
    })
    Object.assign(range, { next, after, span: page.span ?? range.span })
    task.work = null
    task.firstPage = false
    source.publish(rows)
    return { pools, states, admitted: rows.length }
  }

  /** Locate an enumerated pair's creation cheaply by bisecting the factory's historical array length, then
   * use the add-token search's currency-filtered log window. Non-archive RPCs can walk the range. */
  async shareStep(row) {
    const now = this.clock(), { engine } = this
    const { evidence,search,snooze } = this.outboxes[row.forwardOnly ? 1 : 0]
    if (!this.connected()) { snooze.run(now + MINUTE,row.chain,row.pool); return }
    const task = this.tasks.find(t => t.source.chain.id === row.chain && t.factory.address === row.factory)
    if (!task) { snooze.run(now + DAY, row.chain, row.pool); return }
    const { factory, source } = task
    const save = (lo, hi, bisect, span) => search.run(lo, hi, bisect, span, now, row.chain, row.pool)
    try {
      if (!row.tx) {
        // A provider can return an empty or stale historical length instead of rejecting an
        // archive read. If the narrowed interval was empty, exhaust the whole signed factory
        // history once. Fetching the head is its own resumable budget turn.
        if (row.bisect === SEARCH.needHead) {
          const head = await this.head(task)
          return save(0,head.tip,SEARCH.wholeHistory,MAX_SPAN)
        }
        if (row.bisect === SEARCH.length && row.hi - row.lo > MAX_SPAN) {
          const mid = row.lo + Math.floor((row.hi - row.lo) / 2)
          try {
            const raw = await this.rpc.call(row.chain, 'eth_call', [{ to: factory.address, data: factory.array[0] }, hex(mid)])
            const length = raw === '0x' ? 0 : quantity(raw)
            if (length === null) throw new Error('Invalid historical factory length')
            return length <= row.idx ? save(mid + 1, row.hi, SEARCH.length, row.span) : save(row.lo, mid, SEARCH.length, row.span)
          } catch (error) {
            if (error instanceof RateLimited) throw error
            return save(row.lo, row.hi, SEARCH.window, row.span)
          }
        }
        const span = Math.min(row.span, logWindow(source.rpc.chains.get(row.chain).filter(e => !e.user)))
        const from = Math.max(row.lo, row.hi - span + 1)
        const walking = row.bisect === SEARCH.wholeHistory ? SEARCH.wholeHistory : SEARCH.window
        const result = await logPage({ source, factory, rpc: this.rpc, from, end: row.hi + 1, span,
          matchPool: row.pool, topics: [factory.topics, '0x' + word(row.token0), '0x' + word(row.token1)] })
        if (result.retrySpan) return save(row.lo, row.hi, walking, result.retrySpan)
        const event = result.pools.find(p => p.pool === row.pool && p.token0 === row.token0 && p.token1 === row.token1)
        if (event) { evidence.run(event.block,event.tx,row.chain,row.pool); return }
        if (result.next <= row.hi) return save(row.lo, row.hi, walking, Math.max(1, Math.floor((row.hi - from + 1) / 2)))
        if (from > row.lo) return save(row.lo, from - 1, walking, result.span)
        // Keep the retry delay when even the whole range failed to yield a canonical creation.
        return search.run(0,0,SEARCH.needHead,MAX_SPAN,now+(walking===SEARCH.wholeHistory ? DAY : 0),row.chain,row.pool)
      }
      const fields = [row.dex, row.kind, row.token0, row.token1, row.block, row.tx]
      const seen = this.recent.get(row.chain + ':' + row.pool)
      if (seen && seen.at > now - HOUR && fields.every((v,i) => v === seen.fields[i])) {
        if (row.forwardOnly) this.forwarded.run(row.chain,row.pool)
        else snooze.run(seen.at + HOUR, row.chain, row.pool)
        return
      }
      if (now < this.nextSend) { snooze.run(this.nextSend, row.chain, row.pool); return }
      if (!(await engine.hints.hasCreationReceipt(row, this.rpc))) {
        snooze.run(now + DAY, row.chain, row.pool)
        return
      }
      if (!this.connected()) { snooze.run(this.clock() + MINUTE,row.chain,row.pool); return }
      this.nextSend = this.clock() + MINUTE
      engine.store.transaction(() => {
        engine.store.setSetting('engine-history/next-send', this.nextSend)
        if (!row.forwardOnly) engine.store.upsertPool(row)
      })
      const { chain, pool, token0, token1, kind, dex, block, tx } = row
      const message = { t: 'pool', v: 1, chain, pool, token0, token1, kind, dex, block, tx }
      const sent = engine.transport.send('gator/new', message)
      if (sent && row.forwardOnly) this.forwarded.run(chain,pool)
      else snooze.run(this.clock() + (sent ? DAY : MINUTE), chain, pool)
      if (sent && !row.forwardOnly) engine.emit('discovery', message, row.firstSeen, false)
    } catch (error) {
      snooze.run(error instanceof RateLimited ? error.retryAt : now + MINUTE, row.chain, row.pool)
      if (!(error instanceof RateLimited)) throw error
    }
  }
}
