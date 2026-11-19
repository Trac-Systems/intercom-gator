// NFT collections measured locally from marketplace sale logs (DESIGN §5.3 jobs `nft:<chain>:sales`).
// Address-filtered eth_getLogs per chain (never chain-wide), a durable cursor per chain, gap records when the node
// falls too far behind, and on-chain name()/symbol() reads. No paid APIs, nothing published on the wire.
import { multiRead, address } from '../sources/evm-abi.js'
import { abiLabel } from '../sources/names/evm.js'
import { RateLimited } from '../scheduler/index.js'
import { TOPICS } from './decode.js'
import { salesFromLogs, washFlag, saleFloor } from './sales.js'

export { decodeSale, PROTOCOLS, TOPICS } from './decode.js'
export { salesFromLogs, washFlag, saleFloor, percentile, FLOOR } from './sales.js'

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000
/** Sales per collection in 24 h that list an unseeded collection. */
export const MIN_SALES = 3
/** Per profile: scan interval, catch-up requests per run, look-back on first start, max backlog before a gap. */
export const NFT_LIMITS = Object.freeze({
  small: { interval: 120_000, catchUp: 2, backfill: HOUR, backlog: 2 * HOUR, names: 16 },
  normal: { interval: 60_000, catchUp: 3, backfill: HOUR, backlog: 3 * HOUR, names: 32 },
  large: { interval: 30_000, catchUp: 4, backfill: 2 * HOUR, backlog: 6 * HOUR, names: 64 },
})
const SPAN_MS = 10 * MIN
const KEEP = 8 * DAY
const hex = (n) => '0x' + n.toString(16)
const uint = (v) => (/^0x[\da-f]+$/i.test(v ?? '') && Number.isSafeInteger(Number(v)) ? Number(v) : null)

/** Read the signed NFT section of the effective bundle (`dex.nft`), validated by @gator/bundle. */
export function nftConfig(bundle) {
  const nft = bundle?.dex?.nft
  if (!nft) return { marketplaces: [], currencies: [], collections: [], sources: [] }
  return nft
}

/** A rolling one-hour request counter in one-minute buckets. */
class Rolling {
  constructor(clock) { this.clock = clock; this.buckets = new Map() }
  add(n = 1) {
    const minute = Math.floor(this.clock() / MIN)
    this.buckets.set(minute, (this.buckets.get(minute) ?? 0) + n)
    for (const k of this.buckets.keys()) if (k <= minute - 60) this.buckets.delete(k)
  }
  get hour() {
    const minute = Math.floor(this.clock() / MIN)
    let n = 0
    for (const [k, v] of this.buckets) if (k > minute - 60) n += v
    return n
  }
}

/** One chain's sale scanner. `evm` (optional) shares its cached chain head with the DEX scanner. */
export class NftSource {
  constructor({ chain, store, rpc, clock = Date.now, marketplaces, currencies, evm, profile = 'normal', prices }) {
    Object.assign(this, { chain, store, rpc, clock, evm, prices })
    this.limits = NFT_LIMITS[profile] ?? NFT_LIMITS.normal
    this.marketplaces = new Map(marketplaces.map((m) => [m.address, { name: m.name, protocol: m.protocol }]))
    this.currencies = new Map([['native', { symbol: 'ETH', decimals: 18, unit: 'ETH' }],
      ...currencies.map((c) => [c.address, { symbol: c.symbol, decimals: c.decimals, unit: c.unit }])])
    this.filter = { address: [...this.marketplaces.keys()],
      topics: [[...new Set(marketplaces.flatMap((m) => TOPICS[m.protocol] ?? []))]] }
    const blockMs = chain.blockTime > 0 ? chain.blockTime : 12_000
    this.blockMs = blockMs
    const ranges = (chain.endpoints ?? []).filter((e) => e.logs !== false && e.range > 0).map((e) => e.range)
    this.maxSpan = Math.max(1, Math.min(2000, ...ranges, Math.ceil(SPAN_MS / blockMs)))
    this.span = this.maxSpan
    this.requests = new Rolling(clock)
    this.stats = { sales: 0, skipped: { bundle: 0, currency: 0, malformed: 0 }, since: null, lastScan: null,
      lastError: null, lastErrorAt: null, head: null, cursor: null }
    const db = store.writer
    this.cursorRow = db.prepare('SELECT block FROM engine_nft_scans WHERE chain=?')
    this.saveCursor = db.prepare('INSERT OR REPLACE INTO engine_nft_scans VALUES (?,?)')
    this.addCollection = db.prepare(`INSERT INTO engine_nft_collections(chain,address,firstSeen) VALUES (?,?,?)
      ON CONFLICT DO NOTHING`)
    this.previous = db.prepare(`SELECT at,seller,buyer,fees FROM engine_nft_sales WHERE chain=? AND collection=?
      AND tokenId=? AND at>=? ORDER BY at DESC LIMIT 8`)
    this.addSale = db.prepare(`INSERT OR IGNORE INTO engine_nft_sales(chain,tx,collection,tokenId,idx,block,at,qty,standard,
      marketplace,currency,priceEth,priceUsd,unitEth,seller,buyer,fees,bundle,flag) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    this.nameQueue = db.prepare(`SELECT c.address FROM engine_nft_collections c WHERE c.chain=? AND
      (c.nameAt IS NULL OR (c.name IS NULL AND c.nameAt < ? - 3600000 * min(24, 1 << c.nameFailures))) AND
      (c.seeded=1 OR (SELECT count(*) FROM engine_nft_sales s WHERE s.chain=c.chain AND s.collection=c.address
        AND s.at>=? AND s.flag IS NULL) >= ?) ORDER BY c.seeded DESC, c.address LIMIT ?`)
    this.saveName = db.prepare(`UPDATE engine_nft_collections SET name=coalesce(?,name),symbol=coalesce(?,symbol),nameAt=?,
      nameFailures=CASE WHEN ? IS NULL THEN nameFailures+1 ELSE 0 END WHERE chain=? AND address=?`)
    this.prune = db.prepare('DELETE FROM engine_nft_sales WHERE chain=? AND at<?')
    this.prunedAt = 0
  }
  get id() { return this.chain.id }
  async head() {
    if (this.evm?.chainHead) return this.evm.chainHead()
    if (this.latest && this.clock() - this.latest.at < 15_000) return this.latest
    this.requests.add()
    const header = await this.rpc.call(this.chain.id, 'eth_getBlockByNumber', ['latest', false])
    const tip = uint(header?.number)
    if (tip == null) throw new Error('Invalid chain head')
    this.latest = { block: Math.max(0, tip - 2), tip, ts: uint(header.timestamp), at: this.clock() }
    return this.latest
  }
  gap(from, to) {
    const key = 'engine-gap/' + this.chain.id + '/nft-sales'
    const count = (this.store.getSetting(key)?.count ?? 0) + 1
    this.store.setSetting(key, { from, to, count, at: this.clock() })
  }
  lastGap() { return this.store.getSetting('engine-gap/' + this.chain.id + '/nft-sales') ?? null }
  timeOf(head) {
    return (log) => {
      const ts = uint(log.blockTimestamp)
      if (ts != null && ts > 1e9) return ts * 1000
      const block = uint(log.blockNumber)
      const tipMs = head.ts != null ? head.ts * 1000 : this.clock()
      return Math.round(tipMs - (head.tip - block) * this.blockMs)
    }
  }
  /** Scan the next block range(s). Up to `catchUp` ranges per run while behind. */
  async scan() {
    for (let i = 0; i < this.limits.catchUp; i++) {
      const behind = await this.scanOnce()
      if (!behind) break
    }
  }
  async scanOnce() {
    const chain = this.chain.id, head = await this.head()
    this.stats.head = head.tip
    const blocks = (ms) => Math.max(1, Math.ceil(ms / this.blockMs))
    const last = this.cursorRow.get(chain)?.block
    let next = last == null ? head.block - blocks(this.limits.backfill) + 1 : last + 1
    if (next > head.block) return false
    this.stats.since ??= this.clock()
    const backlog = blocks(this.limits.backfill > this.limits.backlog ? this.limits.backfill : this.limits.backlog)
    let skipped = null
    if (head.block - next + 1 > backlog) {
      skipped = [next, head.block - backlog]
      next = head.block - backlog + 1
    }
    const to = Math.min(head.block, next + this.span - 1)
    let logs
    try {
      this.requests.add()
      logs = await this.rpc.call(chain, 'eth_getLogs', [{ ...this.filter, fromBlock: hex(next), toBlock: hex(to) }])
      if (!Array.isArray(logs)) throw new Error('Invalid log result')
    } catch (error) {
      if (!(error instanceof RateLimited)) {
        this.span = Math.max(1, Math.floor(this.span / 2))
        this.stats.lastError = 'Log request failed'
        this.stats.lastErrorAt = this.clock()
      }
      throw error
    }
    const inRange = logs.filter((l) => { const b = uint(l?.blockNumber); return b != null && b >= next && b <= to && !l.removed })
    const { sales, skipped: why } = salesFromLogs(inRange, { chain, marketplaces: this.marketplaces,
      currencies: this.currencies, timeOf: this.timeOf(head), ethUsd: (at) => this.prices.ethUsd(chain, at) })
    const now = this.clock()
    this.store.transaction(() => {
      if (skipped) this.gap(...skipped)
      for (const s of sales) {
        this.addCollection.run(chain, s.collection, now)
        const flag = washFlag(s, this.previous.all(chain, s.collection, s.tokenId, s.at - DAY))
        const added = this.addSale.run(chain, s.tx, s.collection, s.tokenId, s.idx, s.block, s.at, s.qty, s.standard,
          s.marketplace, s.currency, s.priceEth, s.priceUsd, s.unitEth, s.seller, s.buyer, s.fees, s.bundle, flag).changes
        this.stats.sales += added
      }
      this.saveCursor.run(chain, to)
      if (now - this.prunedAt > HOUR) { this.prune.run(chain, now - KEEP); this.prunedAt = now }
    })
    for (const k of Object.keys(why)) this.stats.skipped[k] += why[k]
    Object.assign(this.stats, { lastScan: now, cursor: to })
    this.span = Math.min(this.maxSpan, this.span + Math.ceil(this.span / 10))
    this.prices.changed()
    return to < head.block
  }
  needsNames() {
    return !!this.nameQueue.get(this.chain.id, this.clock(), this.clock() - DAY, MIN_SALES, 1)
  }
  /** name()/symbol() for listed collections, one multicall per run. */
  async names() {
    const now = this.clock()
    const rows = this.nameQueue.all(this.chain.id, now, now - DAY, MIN_SALES, this.limits.names)
    if (!rows.length) return
    const calls = rows.flatMap((r) => [{ to: r.address, data: '0x06fdde03' }, { to: r.address, data: '0x95d89b41' }])
    this.requests.add(this.chain.multicall ? 1 : calls.length)
    const values = await multiRead(this.rpc, this.chain, calls)
    const clean = (v) => { const t = abiLabel(v)?.replace(/[\u0000-\u001f\u007f]/g, '').trim(); return t ? t.slice(0, 80) : null }
    this.store.transaction(() => {
      rows.forEach((r, i) => {
        const name = clean(values[2 * i]), symbol = clean(values[2 * i + 1])
        this.saveName.run(name, symbol, now, name, this.chain.id, r.address)
      })
    })
    this.prices.changed()
  }
  status() {
    const head = this.stats.head, cursor = this.cursorRow.get(this.chain.id)?.block ?? null
    return {
      chain: this.chain.id, chainName: this.chain.name,
      marketplaces: [...new Set([...this.marketplaces.values()].map((m) => m.name))],
      head, cursor, lagBlocks: head != null && cursor != null ? Math.max(0, head - cursor) : null,
      lagSeconds: head != null && cursor != null ? Math.round(Math.max(0, head - cursor) * this.blockMs / 1000) : null,
      lastGap: this.lastGap(), salesSeen: this.stats.sales, skipped: { ...this.stats.skipped },
      requests1h: this.requests.hour, since: this.stats.since, lastScan: this.stats.lastScan,
      lastError: this.stats.lastError, lastErrorAt: this.stats.lastErrorAt, span: this.span,
    }
  }
}

/** ETH/USD at a sale time from this node's own book: the 1 min candle, then the hour, then the live price. */
export class EthPrice {
  constructor(store, clock) {
    this.clock = clock
    this.version = 0
    const r = store.reader
    this.candle = r.prepare(`SELECT close FROM candles WHERE asset=? AND tf=? AND ts<=? AND ts>=? ORDER BY ts DESC LIMIT 1`)
    this.live = r.prepare(`SELECT priceReal,at FROM prices WHERE asset=? AND priceReal>0 AND trust<>'red'`)
  }
  ethUsd(chain, at) {
    for (const asset of [chain + ':native', 'ethereum:native']) {
      const minute = this.candle.get(asset, '1m', at, at - 5 * MIN)
      if (+minute?.close > 0) return +minute.close
      const hour = this.candle.get(asset, '1h', at, at - 2 * HOUR)
      if (+hour?.close > 0) return +hour.close
      const live = this.live.get(asset)
      if (live && Math.abs(live.at - at) <= HOUR) return live.priceReal
    }
    return null
  }
  changed() { this.version++ }
}

/** Collection lists and pages from local sales. Cached for 15 s; any scan invalidates. */
export class NftCollections {
  constructor({ store, clock, chains, sources }) {
    Object.assign(this, { store, clock, chains, sources })
    const r = store.reader
    this.listQuery = r.prepare(`SELECT c.chain,c.address,c.name,c.symbol,c.seeded,c.firstSeen,
      count(s.tx) AS sales24h, sum(s.priceEth) AS volumeEth, sum(s.priceUsd) AS volumeUsd,
      sum(CASE WHEN s.priceUsd IS NULL THEN s.priceEth END) AS unpricedEth
      FROM engine_nft_collections c LEFT JOIN engine_nft_sales s ON s.chain=c.chain AND s.collection=c.address
        AND s.at>=? AND s.flag IS NULL
      GROUP BY c.chain,c.address HAVING c.seeded=1 OR count(s.tx)>=?`)
    this.recent = r.prepare(`SELECT * FROM engine_nft_sales WHERE chain=? AND collection=? AND at>=?
      ORDER BY at DESC, idx DESC LIMIT 2000`)
    this.washCount = r.prepare(`SELECT count(*) AS n FROM engine_nft_sales WHERE chain=? AND collection=? AND at>=?
      AND flag IS NOT NULL`)
    this.one = r.prepare('SELECT * FROM engine_nft_collections WHERE chain=? AND address=?')
    this.totals = r.prepare(`SELECT count(*) AS sales, count(DISTINCT chain||collection) AS collections,
      sum(flag IS NOT NULL) AS flagged FROM engine_nft_sales WHERE at>=?`)
    this.cache = null
  }
  version() { return this.sources.reduce((n, s) => n + s.prices.version, 0) }
  row(c, now, ethUsd) {
    const sales = this.recent.all(c.chain, c.address, now - 2 * DAY - 7 * DAY)
    const floor = saleFloor(sales, now), before = saleFloor(sales, now - DAY)
    const last = sales.find((s) => !s.flag) ?? null
    const chainName = this.chains.get(c.chain)?.name ?? c.chain
    // Sales without a USD price at sale time (no ETH price in the book then) use the current ETH price.
    const volumeUsd = c.unpricedEth > 0 ? (ethUsd ? (c.volumeUsd ?? 0) + c.unpricedEth * ethUsd : null) : (c.volumeUsd ?? 0)
    return {
      id: c.chain + ':' + c.address, kind: 'nft', chain: c.chain, chainName, address: c.address,
      name: c.name ?? null, symbol: c.symbol ?? null, seeded: !!c.seeded,
      floor: floor?.eth ?? null, floorUsd: floor ? (ethUsd ? floor.eth * ethUsd : floor.usd) : null,
      floorCurrency: 'ETH', floorKind: 'sale', floorSales: floor?.sales ?? 0,
      change24h: floor && before ? (floor.eth / before.eth - 1) * 100 : null,
      volume24h: c.sales24h ? volumeUsd : 0,
      volume24hEth: c.volumeEth ?? 0, sales24h: c.sales24h, washSales24h: this.washCount.get(c.chain, c.address, now - DAY).n,
      lastSale: last && { at: last.at, priceEth: last.priceEth, priceUsd: last.priceUsd, marketplace: last.marketplace,
        tokenId: last.tokenId, tx: last.tx },
    }
  }
  list({ chain, limit = 100, offset = 0 } = {}) {
    const now = this.clock()
    if (!this.cache || now - this.cache.at > 15_000 || this.cache.version !== this.version()) {
      const ethUsd = this.sources[0]?.prices.ethUsd('ethereum', now) ?? null
      const rows = this.listQuery.all(now - DAY, MIN_SALES).map((c) => this.row(c, now, ethUsd))
      rows.sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0) || b.volume24hEth - a.volume24hEth ||
        b.sales24h - a.sales24h || Number(b.seeded) - Number(a.seeded) || a.id.localeCompare(b.id))
      this.cache = { at: now, version: this.version(), rows }
    }
    const rows = chain ? this.cache.rows.filter((r) => r.chain === chain) : this.cache.rows
    return { items: rows.slice(offset, offset + limit), total: rows.length }
  }
  detail(id, { limit = 50 } = {}) {
    const [chain, raw] = String(id).split(':')
    const addr = address(raw)
    const c = addr && this.one.get(chain, addr)
    if (!c) return null
    const now = this.clock()
    const listed = this.list({ limit: 1e6 }).items.find((r) => r.id === chain + ':' + addr)
    const ethUsd = this.sources[0]?.prices.ethUsd('ethereum', now) ?? null
    const base = listed ?? this.row({ ...c, sales24h: 0, volumeEth: 0, volumeUsd: 0, unpricedEth: 0 }, now, ethUsd)
    const sales = this.recent.all(chain, addr, now - 7 * DAY).slice(0, limit).map((s) => ({
      at: s.at, tokenId: s.tokenId, qty: s.qty, priceEth: s.priceEth, priceUsd: s.priceUsd, currency: s.currency,
      marketplace: s.marketplace, seller: s.seller, buyer: s.buyer, tx: s.tx, block: s.block, flag: s.flag, bundle: s.bundle,
    }))
    return { ...base, listed: !!listed, firstSeen: c.firstSeen, sales }
  }
  status() {
    const now = this.clock(), t = this.totals.get(now - DAY)
    return { minSales: MIN_SALES, floor: 'p10 of unflagged sales in 24 h (or the last 20 within 7 d), at least 3 sales',
      sales24h: t.sales, flagged24h: t.flagged ?? 0, collectionsWithSales24h: t.collections,
      chains: this.sources.map((s) => s.status()) }
  }
}

/** Install `nft:<chain>:sales` and `nft:<chain>:names` jobs for every chain the bundle lists marketplaces on. */
export function registerNftJobs(engine, { enabled = true } = {}) {
  const config = enabled ? nftConfig(engine.bundle) : nftConfig(null)
  const { store, clock, scheduler } = engine
  const prices = new EthPrice(store, clock)
  const chains = new Map(engine.catalog.chains.map((c) => [c.id, c]))
  const sources = []
  const seed = store.writer.prepare(`INSERT INTO engine_nft_collections(chain,address,name,seeded,source,firstSeen)
    VALUES (?,?,?,1,?,?) ON CONFLICT(chain,address) DO UPDATE SET seeded=1,source=excluded.source,
    name=coalesce(name,excluded.name)`)
  const unseed = store.writer.prepare('UPDATE engine_nft_collections SET seeded=0 WHERE seeded=1')
  store.transaction(() => {
    unseed.run()
    for (const c of config.collections ?? []) if (chains.has(c.chain)) seed.run(c.chain, c.address, c.name, c.source, clock())
  })
  for (const chain of chains.values()) {
    const marketplaces = (config.marketplaces ?? []).filter((m) => m.chain === chain.id && TOPICS[m.protocol])
    if (chain.family !== 'evm' || !marketplaces.length) continue
    const currencies = (config.currencies ?? []).filter((c) => c.chain === chain.id)
    const source = new NftSource({ chain, store, rpc: engine.rpc, clock, marketplaces, currencies,
      evm: engine.evm.get(chain.id), profile: engine.profile, prices })
    sources.push(source)
    scheduler.add({ id: 'nft:' + chain.id + ':sales', interval: source.limits.interval, relevance: 0.6,
      run: () => source.scan() })
    scheduler.add({ id: 'nft:' + chain.id + ':names', interval: 60_000, relevance: 0.3,
      ready: () => source.needsNames(), run: () => source.names() })
  }
  const collections = new NftCollections({ store, clock, chains, sources })
  // On a busy node every job without markets waits for every fourth scheduler turn, oldest first; with ~180 such
  // jobs a scan can wait many minutes. Run an overdue scan through the scheduler's own runner: same request budget,
  // endpoint buckets and backoff, never twice at once (execute() parks `next` while it runs).
  const ids = sources.flatMap((s) => ['nft:' + s.id + ':sales', 'nft:' + s.id + ':names'])
  collections.start = () => {
    clearInterval(collections.timer)
    collections.timer = setInterval(() => {
      if (!engine.active) return
      for (const id of ids) {
        const job = scheduler.jobs.get(id), now = clock()
        if (!job || job.next > now || now - job.last < 2 * job.interval || job.ready?.() === false) continue
        scheduler.execute(job, job.run).catch(() => {})
      }
    }, 15_000)
    collections.timer.unref?.()
  }
  collections.stop = () => clearInterval(collections.timer)
  return collections
}
