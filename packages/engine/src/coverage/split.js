import { hash } from 'node:crypto'

// A 52-bit score is exactly representable as a JS number. The signing key breaks ties.
function score(market, reporter) {
  return parseInt(hash('sha256', market + '\0' + reporter).slice(0, 13), 16)
}

export class ReporterSlice {
  constructor(own, reporters) {
    this.own = own
    this.peers = [...new Set(reporters)].filter(key => key !== own).sort()
    this.size = 1 + this.peers.length
    this.split = this.size > 3
    this.copies = Math.min(this.size, this.size >= 32 ? 4 : 3)
    this.version = this.split ? hash('sha256', [own, ...this.peers].join('/')).slice(0, 16) : 'solo'
  }

  /** Null outside our top-k. Remaining reporters cannot affect the answer once k outrank us. */
  priority(market) {
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
    return { core, tail: owned.map(entry => entry.row), rest }
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
  const { turn = 0, common = 0, local = 0, other = 0 } = cursor
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
  const slice = take(tail, local, space - spare.length)
  const rows = head.concat(spare, slice)
  if (rows.length < limit && head.length < core.length)
    rows.push(...take(core, common + head.length, Math.min(core.length - head.length, limit - rows.length)))
  return { rows, next: { turn: turn + 1, common: common + rows.length - slice.length - spare.length,
    local: local + slice.length, other: other + scanned } }
}

/** Keep a bounded active trade set, rotating the tail each hour. Old per-pool block cursors remain valid. */
export function trackedPools({ core, tail }, limit, hour) {
  const head = take(core, 0, tail.length ? Math.min(limit - 1, Math.max(4, limit >> 2)) : limit)
  return head.concat(take(tail, hour * (limit - head.length), limit - head.length))
}
