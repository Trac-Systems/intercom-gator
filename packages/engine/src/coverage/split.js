import { hash } from 'node:crypto'

// A 52-bit score is exactly representable as a JS number. The signing key breaks ties.
function score(market, reporter) {
  return parseInt(hash('sha256', market + '\0' + reporter).slice(0, 13), 16)
}

export { score as reporterScore }

export class ReporterSlice {
  constructor(own, reporters) {
    this.scores = new Map()
    this.own = own
    this.peers = [...new Set(reporters)].filter(key => key !== own).sort()
    this.size = 1 + this.peers.length
    this.split = this.size > 3
    this.copies = Math.min(this.size, this.size >= 32 ? 4 : 3)
    this.version = this.split ? hash('sha256', [own, ...this.peers].join('/')).slice(0, 16) : 'solo'
  }

  /** Null outside our top-k. Remaining reporters cannot affect the answer once k outrank us. */
  priority(market) {
    if (this.scores.has(market)) return this.scores.get(market)
    const priority = this.#rank(market)
    // Bound the memo even when a large directory keeps discovering pools.
    if (this.scores.size >= 16_384) this.scores.clear()
    this.scores.set(market, priority)
    return priority
  }

  #rank(market) {
    const mine = score(market, this.own)
    let ahead = 0
    for (const key of this.peers) {
      const theirs = score(market, key)
      if (theirs > mine || (theirs === mine && key < this.own)) {
        if (++ahead === this.copies) return null
      }
    }
    return mine
  }

  /** Before a pool has an address, its canonical currency pair is the assignment key. Recheck a small
   * rotating sample of other pairs for mixed-version networks and nodes with different inventories. */
  seedPairs(chain, pairs, now) {
    const { core, tail, rest } = this.partition(pairs, p => ['seed', chain, ...p].join(':'), 1)
    const count = Math.ceil(Math.max(1, tail.length) / 16)
    const epoch = Math.floor(now / (6 * 3_600_000))
    return core.concat(tail, take(rest, score(chain, this.own) % Math.max(1, rest.length) + epoch * count, count))
  }

  /** Input is in local relevance order. Core/pins overlap. Start the tail with our strongest assignments. */
  partition(rows, id, coreCount, pinned = () => false) {
    const core = [], owned = [], rest = []
    for (const [index, row] of rows.entries()) {
      if (index < coreCount || pinned(row)) core.push(row)
      else {
        const market = id(row), priority = this.priority(market)
        if (priority === null) rest.push(row)
        else owned.push({ row, priority, market })
      }
    }
    owned.sort((a, b) => b.priority - a.priority || (a.market < b.market ? -1 : a.market > b.market ? 1 : 0))
    // Seek after the last processed priority even if that pool left our slice. An index modulo
    // the new list length can jump to an unrelated page on every small membership change.
    const after = market => {
      if (!market) return 0
      const priority = score(market, this.own)
      let lo = 0, hi = owned.length
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2), item = owned[mid]
        if (item.priority > priority || (item.priority === priority && item.market <= market)) lo = mid + 1
        else hi = mid
      }
      return lo
    }
    return { core, tail: owned.map(entry => entry.row), rest, id, after }
  }
}

function take(rows, offset, limit) {
  const start = rows.length ? offset % rows.length : 0
  const end = start + Math.min(rows.length, limit)
  return rows.slice(start, end).concat(rows.slice(0, Math.max(0, end - rows.length)))
}

/** One bounded read. For one-pool endpoints one in four turns revisits the common core.
 * Off-slice repair gives mixed-version or asymmetric networks a way to cover abandoned assignments. */
export function nextPoolPage(plan, limit, cursor = {}, covered = () => false) {
  const { core, tail, rest } = plan
  const { turn = 0, common = 0, other = 0 } = cursor
  const repair = (turn % 16 === 15 || !tail.length) && rest.length
  const coreSlots = !tail.length && !repair ? limit : limit === 1 ? Number(turn % 4 === 0) : Math.max(1, Math.floor(limit / 4))
  const head = take(core, common, coreSlots)
  const space = limit - head.length
  // Bound coverage checks even when all other owners are healthy.
  const candidates = repair ? take(rest, other, space * 4) : []
  const spare = []
  let scanned = 0
  for (const row of candidates) {
    scanned++
    if (!covered(row)) spare.push(row)
    if (spare.length === space) break
  }
  const slice = take(tail, plan.after(cursor.last), space - spare.length)
  const rows = head.concat(spare, slice)
  if (rows.length < limit && head.length < core.length)
    rows.push(...take(core, common + head.length, Math.min(core.length - head.length, limit - rows.length)))
  return { rows, next: { turn: turn + 1, common: common + rows.length - slice.length - spare.length,
    last: slice.length ? plan.id(slice.at(-1)) : cursor.last ?? null, other: other + scanned } }
}

/** Keep a bounded active trade set, rotating the tail each hour. Old per-pool block cursors remain valid. */
export function trackedPools({ core, tail, id }, limit, hour, own) {
  const head = core.slice(0, tail.length ? limit - 1 : limit)
  // Hourly priorities depend only on the pool, hour and signer. Joining peers can only
  // vacate individual slots in our set; the retained pools keep their relative order.
  const salt = 'trade/' + hour + '/' + own
  const selected = tail.map(row => ({ row, priority: score(id(row), salt) }))
    .sort((a, b) => b.priority - a.priority)
  return head.concat(selected.slice(0, limit - head.length).map(p => p.row))
}
