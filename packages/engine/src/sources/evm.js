import { address, decodeEvent, field, multiRead, poolStateCalls, poolStateValue, STATE_KINDS,
  swapValue, v4PoolId, v4StateCall, word, ZERO } from './evm-abi.js'
import { resolveCurveCreations, identifyCurvePools } from './curve.js'
import { MARKET_POLICY } from '../../../store/src/markets.js'
import { decimal } from '../obs/index.js'
import { logWindow } from './bundle-adapter.js'
import { RateLimited } from '../scheduler/index.js'

// One address/ID chunk per trade job. Reserve queue capacity for factory discoveries.
const LIMITS = {
  small: { tracked: 32, chunk: 8, seed: 24, tokens: 100, blocks: 2, period: 300_000 },
  normal: { tracked: 128, chunk: 16, seed: 64, tokens: 300, blocks: 4, period: 90_000 },
  large: { tracked: 256, chunk: 32, seed: 96, tokens: 300, blocks: 8, period: 45_000 },
}
const USD_QUOTE = /^(?:USDC(?:\.E)?|USDBC|USDT0?|USD₮0|DAI|USDG|USDB|BUSD|CUSD)$/i
const DAY = 86400_000
const hex = (n) => '0x' + n.toString(16)
const token = (addr) => (addr === ZERO ? 'native' : addr)
const uint = (value) => (/^0x[\da-f]+$/i.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null)
async function readOnce(cache, key, load) {
  if (!cache.has(key)) cache.set(key, await load())
  return cache.get(key)
}

// Fees belong to each V3 factory. V4 allows arbitrary keys; these are its common no-hook conventions.
function variants(d) {
  switch (d.kind) {
    case 'v2': return [['0xe6a43905']]
    case 'v3':
    case 'pancake-v3': return (d.feeTiersPpm ?? []).map(fee => ['0x1698ee82', fee])
    case 'velodrome-v2': return [0, 1].map(stable => ['0x79bc57d5', stable])
    case 'solidly-v1': return [0, 1].map(stable => ['0x6801cc30', stable])
    case 'slipstream': return [1, 50, 100, 200, 2000].map(spacing => ['0x28af8d0b', spacing])
    case 'v4': return [[100, 1], [500, 10], [3000, 60], [10000, 200]]
    default: return []
  }
}

/** Plan currency pairs and deployment methods separately so each job builds only one page of calldata. */
function seedPlan(source) {
  const { chain, registry } = source
  const max = source.limits.tokens
  const native = registry.assets.get(chain.id + ':native')
  const wrappedSymbol = native && 'W' + native.symbol.toUpperCase()
  function quoteOrder(q) {
    if (wrappedSymbol && q.symbol?.toUpperCase() === wrappedSymbol) return 0
    if (q.symbol === 'USDC') return 1
    return USD_QUOTE.test(q.symbol) ? 2 : 3
  }
  const quotes = [...source.quotes.values()]
    .sort((a, b) => quoteOrder(a) - quoteOrder(b) || a.address.localeCompare(b.address)).map(q => q.address)
  const assets = registry.catalog.assets.filter(a => a.id.startsWith(chain.id + ':') && address(a.address))
    .map(a => registry.assets.get(a.id) ?? a)
    .filter(a => !a.rank || a.rank <= max)
    .sort((a,b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.address.localeCompare(b.address))
  // Also cover signed quote deployments on chains whose token list contains only the native currency.
  const currencies = [...new Set([...quotes, ...assets.slice(0, max).map(a => a.address)])]
  const pairs = new Map()
  const nativePairs = chain.deployments.some(d => d.kind === 'v4') && native
  const counterparts = nativePairs ? [...quotes, ZERO] : quotes
  for (const a of currencies) {
    for (const b of counterparts) {
      if (a === b) continue
      const pair = [a, b].sort()
      pairs.set(pair.join(':'), pair)
    }
  }
  const methods = chain.deployments.flatMap(d => variants(d).map(args => ({ d, args })))
  return { pairs: [...pairs.values()], methods }
}

function probe(pair, method) {
  const [a, b] = pair, { d, args } = method
  if (a === ZERO && d.kind !== 'v4') return null
  const key = [d.address, a, b, ...args].join(':')
  const candidate = { key, dex: d.name, kind: d.kind, token0: token(a), token1: token(b), manager: d.address }
  if (d.kind === 'v4') {
    candidate.spacing = args[1]
    candidate.pool = v4PoolId(a, b, ...args)
    candidate.call = v4StateCall(d.address, candidate.pool)
  } else {
    if (['velodrome-v2', 'solidly-v1'].includes(d.kind)) candidate.stable = args[1] === 1
    candidate.call = { to: d.address, data: args[0] + word(a) + word(b) + (args.length > 1 ? word(args[1]) : '') }
  }
  return candidate
}

/** A successful log scan advances a durable cursor atomically with its decode queue. */
export class EvmSource {
  constructor({ chain, store, rpc, registry, publish, discover, profile = store.profile, dex, clock = Date.now }) {
    Object.assign(this, { chain, store, rpc, registry, publish, discover, clock })
    this.limits = LIMITS[profile] ?? LIMITS.normal
    this.definition = dex?.evm.find(d => d.chain === chain.id)
    // The catalog omits Sync and factory fee tiers. Read both from the same effective signed bundle.
    const syncs = (dex?.events ?? []).filter(e => e.signature.startsWith('Sync('))
    this.chain = { ...chain, events: { ...chain.events }, deployments: chain.deployments.map(d => {
      const raw = this.definition?.deployments.find(v => v.address.toLowerCase() === d.address)
      const ids = dex?.kinds.find(k => k.id === d.kind)?.events ?? []
      const extra = syncs.filter(e => ids.includes(e.id))
      return { ...d, feeTiersPpm: raw ? raw.feeTiersPpm : d.feeTiersPpm, topics: [...d.topics, ...extra.map(e => e.topic0)] }
    }) }
    for (const e of syncs) if (this.chain.deployments.some(d => d.topics.includes(e.topic0)))
      this.chain.events[e.topic0] = { topic: e.topic0, emitter: 'pool', signature: e.signature, topicCount: 1, dataWords: 2 }
    const db = store.writer
    this.cursor = db.prepare('SELECT block FROM engine_heads WHERE chain=?')
    this.advance = db.prepare('INSERT OR REPLACE INTO engine_heads VALUES (?,?)')
    this.enqueue = db.prepare('INSERT OR IGNORE INTO engine_logs(chain,block,idx,log) VALUES (?,?,?,?)')
    this.creation = db.prepare('INSERT OR IGNORE INTO engine_logs VALUES (?,?,?,?,1)')
    this.queue = db.prepare(`SELECT * FROM engine_logs WHERE chain=? AND block=(
      SELECT block FROM engine_logs WHERE chain=? ORDER BY creation DESC,block LIMIT 1) ORDER BY idx`)
    this.laneSize = db.prepare('SELECT count(*) AS n FROM engine_logs WHERE chain=? AND creation=?')
    this.trackCursor = db.prepare('INSERT OR REPLACE INTO engine_pool_scans VALUES (?,?,?,?)')
    this.tracked = db.prepare(`WITH candidates AS (
      SELECT p.*,s.block AS scanned,s.polled,
        (m.base IN (SELECT asset FROM watchlist UNION SELECT asset FROM portfolio)
          OR m.quote IN (SELECT asset FROM watchlist UNION SELECT asset FROM portfolio)) AS pinned,
        EXISTS (SELECT 1 FROM asset_markets a JOIN markets c ON c.id=a.market
          WHERE a.asset=m.base AND c.kind='cex') AS listed,
        (SELECT sum(t.baseVolume) FROM engine_trades t WHERE t.market=m.id AND t.at>=?) * px.priceReal AS turnoverUsd
      FROM pools p JOIN markets m ON m.id='dex:'||p.chain||':'||p.pool
      JOIN engine_market_data d ON d.market=m.id LEFT JOIN engine_pool_scans s USING(chain,pool)
      LEFT JOIN prices px ON px.asset=m.base AND px.at>=? AND px.trust<>'red'
      WHERE p.chain=? AND d.fromHint=0)
      SELECT * FROM candidates ORDER BY pinned DESC,
        max(coalesce(liquidity,0),coalesce(turnoverUsd,0)) * (1 + listed) DESC, listed DESC, pool LIMIT ?`)
    this.pending = db.prepare('SELECT 1 FROM engine_logs WHERE chain=? LIMIT 1')
    this.localPool = db.prepare(`SELECT 1 FROM pools p JOIN engine_market_data d
      ON d.market='dex:'||p.chain||':'||p.pool WHERE p.chain=? AND d.fromHint=0 LIMIT 1`)
    this.queueSize = db.prepare('SELECT count(*) AS n FROM engine_logs WHERE chain=?')
    this.done = db.prepare('DELETE FROM engine_logs WHERE chain=? AND block=? AND idx=?')
    this.poolInfo = db.prepare(`SELECT p.*,k.stable,k.spacing FROM pools p JOIN engine_market_data d
      ON d.market='dex:'||p.chain||':'||p.pool LEFT JOIN engine_pool_parameters k USING(chain,pool)
      WHERE p.chain=? AND p.pool=?`)
    this.saveParams = db.prepare('INSERT OR REPLACE INTO engine_pool_parameters VALUES (?,?,?,?)')
    this.saveCreation = db.prepare('INSERT OR REPLACE INTO engine_pool_history(chain,pool,at,verified) VALUES (?,?,?,1)')
    this.addTrade = db.prepare('INSERT OR IGNORE INTO engine_trades VALUES (?,?,?,?,?)')
    this.volume = db.prepare(
      'SELECT coalesce(sum(baseVolume),0) AS v FROM engine_trades WHERE market=? AND at BETWEEN ? AND ?'
    )
    this.purge = db.prepare('DELETE FROM engine_trades WHERE at<?')
    this.unknown = db.prepare(`INSERT INTO engine_v4_lookup VALUES (?,?,?,?,?,?) ON CONFLICT(chain,pool)
      DO UPDATE SET lastSeen=excluded.lastSeen,log=excluded.log`)
    this.lookup = db.prepare(
      'SELECT * FROM engine_v4_lookup WHERE chain=? AND nextBlock>=0 ORDER BY nextBlock DESC,pool LIMIT 1'
    )
    this.forget = db.prepare('DELETE FROM engine_v4_lookup WHERE chain=? AND pool=?')
    this.lookupRange = Math.min(200000, logWindow(chain.endpoints ?? []))
    // The old 128-block ceiling was sized for chain-wide swaps. An address-filtered creation
    // query can cover a whole polling period even on subsecond chains, within the endpoint limit.
    const periodBlocks = chain.blockTime > 0 ? Math.ceil(2 * this.limits.period / chain.blockTime) : chain.range
    this.creationWindow = Math.min(this.lookupRange, 4096, Math.max(chain.range, periodBlocks))
    this.span = this.creationWindow
    this.tradeSpan = chain.range
    this.tradeChunk = this.limits.chunk
    this.pendingHeads = new Map()
    this.work = new Map()
    this.knownTopics = Object.keys(this.chain.events)
    const creationTopics = Object.values(this.chain.events)
      .filter(e => e.emitter === 'factory' || e.signature.startsWith('Initialize(')).map(e => e.topic)
    this.creators = [...new Set(this.chain.deployments.filter(d => d.topics.some(t => creationTopics.includes(t)))
      .map(d => d.address))]
    this.creatorChunk = 16
    this.creationFilter = { address: this.creators, topics: [creationTopics] }
    this.quotes = new Map((this.definition?.quoteTokens ?? chain.quotes.map(address =>
      registry?.assets.get(chain.id + ':' + address) ?? { address })).map(q => [q.address.toLowerCase(), { ...q, address: q.address.toLowerCase() }]))
    this.seedCursor = 'engine-seed/' + chain.id
    this.seedWake = store.getSetting(this.seedCursor)?.wake ?? 0
    this.seedMemo = db.prepare('SELECT retryAt FROM engine_seed_attempts WHERE chain=? AND probe=?')
    this.cacheSeed = db.prepare('INSERT OR REPLACE INTO engine_seed_attempts VALUES (?,?,?)')
    this.expireSeed = db.prepare('DELETE FROM engine_seed_attempts WHERE chain=? AND retryAt<=?')
    this.assetPrice = db.prepare('SELECT priceReal,trust FROM prices WHERE asset=? AND at>=? AND priceReal>0')
    this.saveDepth = db.prepare('UPDATE pools SET liquidity=? WHERE chain=? AND pool=?')
    this.refreshAt = 0
    this.nextPool = 0
    this.adoptQueue()
  }
  adoptQueue() {
    const chain = this.chain.id, db = this.store.writer
    const legacy = db.prepare('SELECT block,idx,log FROM engine_logs WHERE chain=? AND creation=-1 ORDER BY block DESC,idx DESC')
    if (!this.laneSize.get(chain, -1).n) return
    const keep = db.prepare('UPDATE engine_logs SET creation=? WHERE chain=? AND block=? AND idx=?')
    this.store.transaction(() => {
      const remaining = [3072, 1024]
      let oldest, newest
      for (const row of legacy.all(chain)) {
        const log = JSON.parse(row.log), event = this.chain.events[log.topics?.[0]]
        const swap = event && decodeEvent(log, event)
        const creation = this.creationFilter.topics[0].includes(event?.topic)
        const known = creation ? swap && this.deployment(swap.emitter, event) : swap && this.poolInfo.get(chain, swap.pool)
        const lane = Number(creation)
        if (known && remaining[lane] > 0) {
          keep.run(lane, chain, row.block, row.idx)
          remaining[lane]--
        } else {
          newest ??= row.block
          oldest = row.block
          this.done.run(chain, row.block, row.idx)
        }
      }
      if (oldest != null) this.gap('legacy-untracked-or-overflow', oldest, newest)
    })
  }
  async chainHead() {
    if (this.latest && this.clock() - this.latest.at < 15_000) return this.latest
    if (this.readingHead) return this.readingHead
    this.readingHead = this.rpc.call(this.chain.id, 'eth_getBlockByNumber', ['latest', false]).then(header => {
      const block = uint(header?.number)
      if (block == null) throw new Error('Invalid chain head')
      const fee = uint(header.baseFeePerGas)
      if (fee != null) this.store.setSetting('engine-fee/' + this.chain.id, {
        chain: this.chain.name, at: this.clock(), kind: 'baseFee', value: decimal(fee / 1e9) + ' gwei',
      })
      this.latest = { block: Math.max(0, block - 2), tip: block, ts: uint(header.timestamp), at: this.clock() }
      return this.latest
    })
    try { return await this.readingHead } finally { this.readingHead = null }
  }
  async creationLogs(filter) {
    // Only advance the chain cursor after every address partition has succeeded. If the
    // budget runs out between calls, reuse the completed partitions for this exact range.
    const key = [filter.fromBlock, filter.toBlock, this.creatorChunk].join('/')
    if (this.partitions?.key !== key) this.partitions = { key, cache: new Map() }
    const logs = []
    for (let i = 0; i < this.creators.length; i += this.creatorChunk) {
      const address = this.creators.slice(i, i + this.creatorChunk)
      const part = await readOnce(this.partitions.cache, i, () => this.rpc.call(this.chain.id, 'eth_getLogs', [{ ...filter, address }]))
      if (!Array.isArray(part)) { this.partitions = null; throw new Error('Invalid creation logs') }
      for (const log of part) logs.push(log)
    }
    this.partitions = null
    return logs
  }
  gap(lane, from, to) {
    const key = 'engine-gap/' + this.chain.id + '/' + lane
    const count = (this.store.getSetting(key)?.count ?? 0) + 1
    this.store.setSetting(key, { from, to, count, at: this.clock() })
  }
  async scan(last, filter, creation, accept, advance) {
    const chain = this.chain.id, lane = creation ? 'creation' : 'trades'
    const span = creation ? 'span' : 'tradeSpan'
    const window = creation ? this.creationWindow : this.chain.range
    // A single slow endpoint may grant only one call per minute. Keep the sampled height
    // for its next grant so header requests cannot consume every available token.
    const previousHead = this.pendingHeads.get(lane)
    const sample = previousHead && this.clock() < previousHead.expires ? previousHead :
      { block: (await this.chainHead()).block, expires: this.clock() + 600_000 }
    const head = sample.block
    this.pendingHeads.delete(lane)
    const next = last == null ? head : last + 1
    if (next > head) return
    const from = head - next >= 2 * window ? head - this[span] + 1 : next
    const to = Math.min(head, from + this[span] - 1)
    let logs
    try {
      const query = { ...filter, fromBlock: hex(from), toBlock: hex(to) }
      logs = creation ? await this.creationLogs(query) : await this.rpc.call(chain, 'eth_getLogs', [query])
    } catch (e) {
      // A healthy endpoint may have just spent its token on the header and all fallback
      // endpoints may fail. Give that healthy endpoint a chance to answer the log request.
      this.pendingHeads.set(lane, sample)
      if (!(e instanceof RateLimited)) {
        if (creation && from === to) {
          this.partitions = null
          this.creatorChunk = Math.max(1, Math.floor(Math.min(this.creators.length, this.creatorChunk) / 2))
        } else if (!creation && from === to) this.tradeChunk = Math.max(1, Math.floor(this.tradeChunk / 2))
        this[span] = Math.max(1, Math.floor(this[span] / 2))
      }
      throw e
    }
    if (!Array.isArray(logs)) throw new Error('Invalid log result')
    this.store.transaction(() => {
      if (next < from) this.gap(lane, next, from - 1)
      const capacity = creation ? 1024 : 3072
      const insert = creation ? this.creation : this.enqueue
      let remaining = Math.max(0, capacity - this.laneSize.get(chain, Number(creation)).n)
      let missed = null
      for (const log of logs) {
        const block = uint(log?.blockNumber), idx = uint(log?.logIndex)
        if (block == null || block < from || block > to || idx == null || !/^0x[0-9a-f]{64}$/i.test(log.transactionHash))
          continue
        const event = this.chain.events[log.topics?.[0]]
        if (!event || !filter.topics[0].includes(event.topic)) continue
        const decoded = decodeEvent(log, event)
        if (!decoded || !accept(decoded, event, block)) continue
        if (remaining > 0) remaining -= insert.run(chain, block, idx, JSON.stringify(log)).changes
        else missed = Math.min(missed ?? block, block)
      }
      if (missed != null) this.gap(lane + '-overflow', missed, to)
      advance(to)
    })
    this[span] = Math.min(window, this[span] + 1)
  }
  async logs() {
    if (!this.creators.length) return
    const chain = this.chain.id
    await this.scan(this.cursor.get(chain)?.block, this.creationFilter, true,
      (decoded, event) => !!this.deployment(decoded.emitter, event), to => this.advance.run(chain, to))
  }
  async trades() {
    const chain = this.chain.id
    const tracked = this.tracked.all(this.clock() - DAY, this.clock() - MARKET_POLICY.maxPriceAge, chain, this.limits.tracked)
    // Keep priority order among equally overdue pools, and visit the least recently polled group first.
    tracked.sort((a, b) => (a.polled ?? -1) - (b.polled ?? -1))
    const group = [], topics = new Set()
    let emitter
    for (const p of tracked) {
      const d = this.chain.deployments.find(d => d.name === p.dex && d.kind === p.kind)
      if (!d) continue
      const singleton = p.pool.length === 66 ? d.address : null
      if (group.length && emitter !== singleton) continue
      emitter = singleton
      group.push({ ...p, topics: d.topics })
      for (const t of d.topics) if (!this.creationFilter.topics[0].includes(t)) topics.add(t)
      if (group.length === this.tradeChunk) break
    }
    if (!group.length || !topics.size) return
    const selected = new Map(group.map(p => [p.pool, p]))
    const ids = [...selected.keys()]
    const filter = { address: emitter ?? ids, topics: emitter ? [[...topics], ids] : [[...topics]] }
    const previous = group.map(p => p.scanned).filter(n => n != null)
    await this.scan(previous.length ? Math.min(...previous) : null, filter, false,
      (s, e, b) => selected.get(s.pool)?.topics.includes(e.topic) && (selected.get(s.pool).scanned ?? -1) < b &&
        (emitter ? s.emitter === emitter : e.emitter === 'pool'), to => {
        for (const p of group) this.trackCursor.run(chain, p.pool, Math.max(to, p.scanned ?? 0), this.clock())
      })
  }
  deployment(emitter, event) {
    return this.chain.deployments.find((d) => d.address === emitter.toLowerCase() && d.topics.includes(event.topic))
  }
  async memo(key, fn) {
    return readOnce(this.work, key, fn)
  }
  async read(calls, block) {
    const values = []
    for (let i = 0; i < calls.length; i += 128) {
      const chunk = calls.slice(i, i + 128)
      values.push(
        ...(await this.memo(JSON.stringify([block, chunk]), () =>
          multiRead(this.rpc, this.chain, chunk, hex(block))
        ))
      )
    }
    return values
  }
  async identify(events, block, read = this.read.bind(this)) {
    const unknown = new Map()
    for (const { swap, event } of events) {
      if (event.emitter === 'pool' && !this.poolInfo.get(this.chain.id, swap.pool)) unknown.set(swap.pool, event)
    }
    const curve = [], pairs = []
    for (const [pool, event] of unknown) {
      if (event.signature.startsWith('TokenExchange(')) curve.push(pool)
      else pairs.push([pool, event])
    }
    const curvePools = await identifyCurvePools(curve, this.chain.deployments, block, read)
    if (!pairs.length) return curvePools
    const selectors = ['0x0dfe1681', '0xd21220a7', '0xc45a0155', '0xddca3f43', '0x22be3de1']
    if (this.chain.deployments.some(d => d.kind === 'slipstream')) selectors.push('0xd0c93a7c') // tickSpacing()
    const headers = await read(
      pairs.flatMap(([to]) =>
        selectors.map((data) => ({ to, data }))
      ),
      block
    )
    const candidates = []
    for (const [i, [pool, event]] of pairs.entries()) {
      const [a, b, f, fee, stable, spacing] = headers.slice(i * selectors.length, (i + 1) * selectors.length)
      const token0 = address(a),
        token1 = address(b),
        factory = address(f)
      if (!token0 || !token1 || !factory || token0 === token1) continue
      const d = this.deployment(factory, event)
      if (!d) continue
      const args = word(token0) + word(token1)
      let data = '0xe6a43905' + args
      if (d.kind.includes('v3')) {
        if (uint(fee) == null) continue
        data = '0x1698ee82' + args + word(fee)
      } else if (d.kind === 'slipstream') {
        if (!(uint(spacing) > 0 && uint(spacing) <= 0x7fffff)) continue
        data = '0x28af8d0b' + args + word(spacing) // getPool(address,address,int24)
      } else if (d.kind === 'velodrome-v2' || d.kind === 'solidly-v1') {
        if (![0, 1].includes(uint(stable))) continue
        data = (d.kind === 'solidly-v1' ? '0x6801cc30' : '0x79bc57d5') + args + word(stable)
      }
      candidates.push({ pool, token0, token1, dex: d.name, kind: d.kind, call: { to: factory, data } })
    }
    // A pool claiming a known factory is insufficient. Check the factory's reverse mapping.
    const verified = await read(
      candidates.map((p) => p.call),
      block
    )
    return curvePools.concat(candidates.filter((p, i) => address(verified[i]) === p.pool))
  }
  async vaultPairs(events, block, read = this.read.bind(this)) {
    const calls = new Map()
    for (const { swap, event } of events)
      if (swap.pair && this.deployment(swap.emitter, event) && !this.poolInfo.get(this.chain.id, swap.pool)) {
        calls.set(swap.pool, { to: swap.emitter, data: '0xf94d4668' + word(swap.pool) })
      }
    const result = await read([...calls.values()], block)
    const pairs = new Map()
    for (const [i, id] of [...calls.keys()].entries()) {
      const data = result[i]
      const offset = Number(field(data, 0)) / 32
      if (!Number.isSafeInteger(offset) || offset < 3) continue
      const size = Number(field(data, offset))
      if (!Number.isSafeInteger(size) || size < 2 || size > 64) continue
      const tokens = Array.from({ length: size }, (_, j) => {
        const v = field(data, offset + 1 + j)
        return v == null ? null : address('0x' + word(v))
      })
      if (tokens.some((t) => !t)) continue
      // One wire market per pool. Pick its same two tokens on every peer, even for a multi-token vault.
      const ordered = tokens.sort(
        (a, b) =>
          Number(this.chain.quotes.includes(b)) - Number(this.chain.quotes.includes(a)) || a.localeCompare(b)
      )
      pairs.set(id, ordered.slice(0, 2).sort())
    }
    return pairs
  }
  async resolvePools(valid, block, at, read) {
    const chain = this.chain.id
    await resolveCurveCreations(valid, block, read)
    const vaults = await this.vaultPairs(valid, block, read)
    const pools = new Map()
    for (const { swap, event, log } of valid) {
      if (!swap.pool) continue
      const existing = pools.get(swap.pool) ?? this.poolInfo.get(chain, swap.pool)
      const d = this.deployment(swap.emitter, event)
      if (existing) {
        if (swap.type === 'pool' && d && existing.dex === d.name && existing.kind === d.kind) {
          pools.set(swap.pool, { ...existing, block, tx: log.transactionHash, firstSeen: Math.min(existing.firstSeen, at),
            spacing: swap.spacing ?? existing.spacing, stable: swap.stable ?? existing.stable })
        } else pools.set(swap.pool, existing)
      } else if (d && (swap.type === 'pool' || vaults.has(swap.pool))) {
        const [token0, token1] = vaults.get(swap.pool) ?? [swap.token0, swap.token1]
        pools.set(swap.pool, {
          chain,
          pool: swap.pool,
          dex: d.name,
          kind: d.kind,
          token0: token(token0),
          token1: token(token1),
          spacing: swap.spacing, stable: swap.stable,
          block,
          tx: log.transactionHash,
          firstSeen: at,
        })
      }
    }
    for (const p of await this.identify(
      valid.filter((e) => !pools.has(e.swap.pool)),
      block, read
    )) {
      const tx = valid.find((e) => e.swap.pool === p.pool).log.transactionHash
      pools.set(p.pool, {
        chain,
        pool: p.pool,
        dex: p.dex,
        kind: p.kind,
        token0: p.token0,
        token1: p.token1,
        block,
        tx,
        firstSeen: at,
      })
    }
    return pools
  }
  async readDecimals(pools, block, read) {
    const chain = this.chain.id
    const missing = new Set()
    for (const p of pools.values())
      for (const to of [p.token0, p.token1]) {
        if (to !== 'native' && this.registry.assets.get(chain + ':' + to)?.decimals == null) missing.add(to)
      }
    const decimals = new Map()
    const targets = [...missing]
    const values = await read(
      targets.map((to) => ({ to, data: '0x313ce567' })),
      block
    )
    for (const [i, to] of targets.entries()) {
      const d = uint(values[i])
      if (d != null && d <= 77) decimals.set(to, d)
    }
    return decimals
  }
  /** Resolve the claimed pool from a canonical receipt with the public-only client.
   * Reuse completed reads when a later step hits an endpoint or profile rate limit. */
  async verifyPoolHint(hint, rpc, cache, history) {
    const { chain, tx } = hint
    const once = (key, load) => readOnce(cache, key, load)
    const receipt = await once('receipt', () => rpc.call(chain, 'eth_getTransactionReceipt', [tx]))
    if (receipt === null || receipt?.status === '0x0') return false
    if (receipt?.transactionHash?.toLowerCase() !== tx || !Array.isArray(receipt.logs) ||
        !/^0x[0-9a-f]{64}$/i.test(receipt.blockHash) || uint(receipt.blockNumber) == null)
      throw new Error('Invalid hint receipt')
    if (receipt.logs.length > 1024) return null
    const block = uint(receipt.blockNumber)
    if (block !== hint.block) return false
    const events = []
    for (const log of receipt.logs) {
      const event = this.chain.events[log?.topics?.[0]]
      if (!event || log.transactionHash?.toLowerCase() !== tx || log.blockHash !== receipt.blockHash ||
          uint(log.blockNumber) !== block) continue
      const swap = decodeEvent(log, event)
      if (!swap || (event.emitter !== 'pool' && !this.deployment(swap.emitter, event))) continue
      if (history && swap.type !== 'pool' && swap.type !== 'curve-deployment') continue
      if (swap.pool === hint.pool || swap.type === 'curve-deployment') events.push({ log, event, swap })
    }
    if (!events.length) return false
    const header = await once('header', () => rpc.call(chain, 'eth_getBlockByNumber', [hex(block), false]))
    if (uint(header?.number) !== block || uint(header?.timestamp) == null || header.hash !== receipt.blockHash)
      return null
    const at = uint(header.timestamp) * 1000
    if (history && (receipt.status !== '0x1' || at < history.since || at > this.clock() + 120_000)) return null
    const read = (calls, at) => once(JSON.stringify([at, calls]), () => multiRead(rpc, this.chain, calls, hex(at)))
    const pools = await this.resolvePools(events, block, at, read)
    const pool = pools.get(hint.pool)
    if (!pool) return null
    if (pool.token0 !== hint.token0 || pool.token1 !== hint.token1 ||
        pool.dex !== hint.dex || pool.kind !== hint.kind) return false
    const creation = receipt.status === '0x1' && events.some(e => this.matchesCreation(e, pool, header.hash))
    if (history && !creation) return false
    const decimals = await this.readDecimals([pool], block, read)
    // A live receipt or independent scan can finish during these public reads.
    if (history && (!history.wanted() || this.registry.markets.has('dex:' + chain + ':' + hint.pool))) return null
    const registered = this.store.transaction(() => {
      const market = this.registry.pool(pool, {
        token0: { decimals: decimals.get(pool.token0) }, token1: { decimals: decimals.get(pool.token1) },
      }, true)
      if (market) {
        this.saveParameters(pool)
        if (creation) this.saveCreation.run(chain, pool.pool, at)
        history?.onRegistered(pool)
      }
      return market
    })
    return registered ? pool : false
  }
  matchesCreation({ swap, log, event }, pool, hash) {
    if (swap.type !== 'pool' || swap.pool !== pool.pool || log.transactionHash !== pool.tx ||
        !/^0x[0-9a-f]{64}$/i.test(hash) || log.blockHash !== hash) return false
    const deployment = this.deployment(swap.emitter, event)
    return deployment?.name === pool.dex && deployment.kind === pool.kind &&
      token(swap.token0) === pool.token0 && token(swap.token1) === pool.token1
  }
  stateReady() {
    return !!this.pending.get(this.chain.id) || (this.refreshAt <= this.clock() && !!this.localPool.get(this.chain.id))
  }
  async scheduledState() {
    if (!this.pending.get(this.chain.id)) return this.refreshState()
    for (let i = 0; i < this.limits.blocks; i++) {
      await this.state()
      if (!this.pending.get(this.chain.id)) break
    }
  }
  async state() {
    const chain = this.chain.id,
      queued = this.queue.all(chain, chain)
    if (!queued.length) return this.refreshState()
    const block = queued[0].block
    if (this.decodeBlock !== block) this.work.clear()
    this.decodeBlock = block
    const batch = queued
    const events = batch.map((r) => {
      const log = JSON.parse(r.log),
        event = this.chain.events[log.topics[0]]
      return { ...r, log, event, swap: event && decodeEvent(log, event) }
    })
    const header = await this.memo('header' + block, () =>
      this.rpc.call(chain, 'eth_getBlockByNumber', [hex(block), false])
    )
    const ts = uint(header?.timestamp)
    if (ts == null || uint(header.number) !== block) {
      this.work.delete('header' + block)
      throw new Error('Invalid block header')
    }
    const at = ts * 1000
    const valid = events.filter((e) => e.swap && (!e.log.blockHash || e.log.blockHash === header.hash))
    const read = this.read.bind(this)
    const pools = await this.resolvePools(valid, block, at, read)
    const creations = new Set()
    for (const entry of valid) {
      if (entry.swap.type !== 'pool') continue
      const pool = pools.get(entry.swap.pool)
      if (pool && this.matchesCreation(entry, pool, header.hash)) creations.add(pool.pool)
    }
    const decimals = await this.readDecimals(pools, block, read)
    const discoveries = [],
      rows = new Map()
    this.store.transaction(() => {
      for (const { swap, event, log } of valid) {
        if (swap.type === 'swap' && event.emitter === 'manager' && !pools.has(swap.pool)) {
          this.unknown.run(chain, swap.pool, swap.emitter, block, this.clock(), JSON.stringify(log))
        }
      }
      for (const p of pools.values()) {
        const old = this.poolInfo.get(chain, p.pool)
        const market = this.registry.pool(p, {
          token0: { decimals: decimals.get(p.token0) },
          token1: { decimals: decimals.get(p.token1) },
        })
        if (market && p.block === block && creations.has(p.pool)) this.saveCreation.run(chain, p.pool, at)
        if (!old || p.block === block) this.saveParameters(p)
        if (!old || (p.tx && !old.tx)) discoveries.push(p)
      }
      this.purge.run(this.clock() - DAY)
      for (const { swap, idx } of valid) {
        if (!['swap', 'sync'].includes(swap.type) || at < this.clock() - DAY) continue
        const p = pools.get(swap.pool),
          market = this.registry.markets.get('dex:' + chain + ':' + swap.pool)
        if (!p || !market || (swap.type === 'sync' && p.kind !== 'v2' && p.stable == null)) continue
        const amount = swapValue(
          swap,
          p,
          this.registry.assets.get(chain + ':' + p.token0)?.decimals,
          this.registry.assets.get(chain + ':' + p.token1)?.decimals,
          market.inverse
        )
        if (!amount) continue
        if (swap.type === 'swap') this.addTrade.run(market.id, block, idx, at, amount.baseVolume)
        rows.set(market.id, [market.id, decimal(amount.price), 0, null, null, null, at])
      }
      for (const row of rows.values()) row[2] = decimal(this.volume.get(row[0], at - DAY, at).v)
    })
    for (const p of discoveries) this.discover(p)
    this.publish([...rows.values()])
    // Ingest before acknowledging the decode queue. A crash can replay work; both obs and volume deduplicate.
    this.store.transaction(() => {
      for (const r of batch) this.done.run(chain, block, r.idx)
    })
    this.work.clear()
  }
  /** V4 pool IDs hash the currencies. Resolve older pools through indexed Initialize logs,
   * preserving progress when a provider imposes a maximum block span. */
  async lookupV4() {
    const chain = this.chain.id,
      item = this.lookup.get(chain)
    if (!item) return
    const event = Object.values(this.chain.events).find(
      (e) => e.emitter === 'manager' && e.signature.startsWith('Initialize(')
    )
    if (!event || this.clock() - item.lastSeen > DAY) {
      this.forget.run(chain, item.pool)
      return
    }
    const from = Math.max(0, item.nextBlock - this.lookupRange + 1)
    let matches
    try {
      matches = await this.rpc.call(chain, 'eth_getLogs', [
        {
          address: item.manager,
          topics: [event.topic, item.pool],
          fromBlock: hex(from),
          toBlock: hex(item.nextBlock),
        },
      ])
    } catch (error) {
      if (!(error instanceof RateLimited)) this.lookupRange = Math.max(1, Math.floor(this.lookupRange / 2))
      throw error
    }
    if (!Array.isArray(matches)) throw new Error('Invalid Initialize log result')
    const initialization = matches.find(
      (log) =>
        log.address?.toLowerCase() === item.manager &&
        log.topics?.[0] === event.topic &&
        decodeEvent(log, event)?.pool === item.pool &&
        uint(log.blockNumber) != null &&
        Number(log.blockNumber) >= from &&
        Number(log.blockNumber) <= item.nextBlock &&
        uint(log.logIndex) != null &&
        /^0x[0-9a-f]{64}$/i.test(log.transactionHash)
    )
    this.store.transaction(() => {
      if (initialization || this.poolInfo.get(chain, item.pool)) {
        for (const log of [initialization, JSON.parse(item.log)].filter(Boolean)) {
          this.enqueue.run(chain, uint(log.blockNumber), uint(log.logIndex), JSON.stringify(log))
        }
        this.forget.run(chain, item.pool)
      } else {
        this.store.writer
          .prepare('UPDATE engine_v4_lookup SET nextBlock=? WHERE chain=? AND pool=?')
          .run(from - 1, chain, item.pool)
      }
    })
  }
  saveParameters(p) {
    if (p.spacing != null || p.stable != null)
      this.saveParams.run(p.chain, p.pool, p.stable == null ? null : Number(p.stable), p.spacing ?? null)
  }
  metadata(addr) {
    const asset = this.registry.assets.get(this.chain.id + ':' + addr)
    return asset?.decimals == null ? this.quotes.get(addr) ?? asset : asset
  }
  usd(addr) {
    const id = this.chain.id + ':'
    const cutoff = this.clock() - MARKET_POLICY.maxPriceAge
    const own = this.assetPrice.get(id + addr, cutoff)
    if (own) return own.trust === 'red' ? null : own.priceReal
    const quote = this.quotes.get(addr)
    if (quote && USD_QUOTE.test(quote.symbol)) return 1
    const native = this.registry.assets.get(id + 'native')
    if (native && quote?.symbol?.toUpperCase() === 'W' + native.symbol.toUpperCase())
      return this.usd('native')
    return null
  }
  async snapshots(pools, read) {
    const groups = pools.map(poolStateCalls)
    const values = await read(groups.flat())
    let offset = 0
    return pools.map((p, i) => {
      const part = values.slice(offset, offset + groups[i].length)
      offset += groups[i].length
      if (p.slot0) part.unshift(p.slot0)
      const state = poolStateValue(p, part, [p.token0, p.token1].map(a => this.metadata(a)?.decimals))
      if (!state || state.empty) return state
      const usd0 = this.usd(p.token0), usd1 = this.usd(p.token1)
      let depth = null
      if (usd0 || usd1) {
        const a = state.reserve0 * (usd0 || state.price * usd1), b = state.reserve1 * (usd1 || usd0 / state.price)
        depth = p.kind === 'v4' ? a + b : 2 * Math.min(a, b)
      }
      return { price: state.price, liquidity: Number.isFinite(depth) ? depth : null }
    })
  }
  stateRow(m, price, at) {
    return [m.id, decimal(m.inverse ? 1 / price : price), decimal(this.volume.get(m.id, at - DAY, at).v),
      null, null, null, at]
  }
  nextProbes() {
    this.plan ??= seedPlan(this)
    const { pairs, methods } = this.plan
    const total = pairs.length * methods.length
    const saved = this.store.getSetting(this.seedCursor) ?? {}
    let pos = saved.next < total ? saved.next : 0
    const batch = [], now = this.clock(), limit = this.chain.multicall ? this.limits.seed : 1
    // Keep CPU/SQLite work bounded too, including when a rank change leaves a cached page in front of us.
    let visited = 0
    if (!total) this.seedWake = Infinity
    if (this.seedWake > now) return null
    while (pos < total && batch.length < limit && visited++ < limit * 16) {
      const pair = pairs[Math.floor(pos / methods.length)], method = methods[pos++ % methods.length]
      const p = probe(pair, method)
      if (p && !(this.seedMemo.get(this.chain.id, p.key)?.retryAt > now)) batch.push(p)
    }
    return { batch, next: pos % total, end: pos === total }
  }
  async seed() {
    const chain = this.chain.id, now = this.clock()
    // A later budget denial must not force another successful factory lookup at a different block.
    if (!this.seedWork || now - this.seedWork.started > MARKET_POLICY.maxPriceAge) {
      const page = this.nextProbes()
      if (!page) return
      this.seedWork = { ...page, started: now, cache: new Map() }
    }
    const work = this.seedWork
    const { batch } = work
    const rows = [], retry = new Map()
    if (batch.length) {
      work.header ??= await this.chainHead()
      const { tip, ts } = work.header
      if (ts == null) { this.latest = null; this.seedWork = null; throw new Error('Invalid seed block timestamp') }
      const at = ts * 1000
      const read = async calls => {
        const out = []
        for (let i = 0; i < calls.length; i += 128) {
          const chunk = calls.slice(i, i + 128)
          try {
            out.push(...await readOnce(work.cache, JSON.stringify(chunk), () => multiRead(this.rpc, this.chain, chunk, hex(tip))))
          } catch (error) {
            // Providers may no longer serve state at this block. Resample on a transport/chain
            // error, but keep the exact page and completed reads on local budget exhaustion.
            if (!(error instanceof RateLimited)) { this.seedWork = null; this.latest = null }
            throw error
          }
        }
        return out
      }
      const lookups = await read(batch.map(p => p.call)), found = []
      for (const [i, candidate] of batch.entries()) {
        const result = lookups[i]
        if (candidate.kind === 'v4') {
          if (!BigInt.asUintN(160, field(result, 0) ?? 0n)) continue
          candidate.slot0 = result
        } else {
          const id = address(result)
          if (!id || id === ZERO) continue
          candidate.pool = id
        }
        found.push(candidate)
      }
      const states = await this.snapshots(found, read)
      this.store.transaction(() => {
        for (const [i, candidate] of found.entries()) {
          const state = states[i]
          if (!state || (!state.empty && state.liquidity == null)) retry.set(candidate.key, 15 * 60_000)
          if (!state || state.empty || !(state.liquidity >= MARKET_POLICY.minPoolLiquidityUsd)) continue
          const p = { ...candidate, chain, liquidity: state.liquidity, firstSeen: now }
          const market = this.registry.pool(p, { token0: this.metadata(p.token0), token1: this.metadata(p.token1) })
          if (market) {
            this.saveParameters(p)
            rows.push(this.stateRow(market, state.price, at))
          }
        }
      })
      // There is no creation transaction for a state discovery. Publish the price, never a fabricated pool hint.
      if (rows.length) this.publish(rows)
    }
    this.store.transaction(() => {
      for (const p of batch) this.cacheSeed.run(chain, p.key, now + (retry.get(p.key) ?? 6 * 3600_000))
      let wake = 0
      if (work.end) {
        if (!this.expireSeed.run(chain, now).changes) wake = this.store.writer.prepare('SELECT min(retryAt) AS at FROM engine_seed_attempts WHERE chain=?').get(chain).at ?? 0
        this.plan = null // refresh ranked membership at the next pass
      }
      this.store.setSetting(this.seedCursor, { next: work.next, wake })
      this.seedWake = wake
    })
    this.seedWork = null
  }
  async refreshState() {
    if (this.refreshAt > this.clock()) return
    const limit = this.chain.multicall ? this.limits.chunk : 1
    const pools = this.store.reader.prepare(`SELECT p.*,k.spacing,k.stable FROM pools p JOIN engine_market_data d
      ON d.market='dex:'||p.chain||':'||p.pool LEFT JOIN engine_pool_parameters k USING(chain,pool)
      WHERE p.chain=? AND d.fromHint=0 AND p.kind IN
      ('v2','v3','v4','pancake-v3','slipstream','velodrome-v2','solidly-v1') ORDER BY p.pool LIMIT ? OFFSET ?`)
      .all(this.chain.id, limit, this.nextPool)
    if (pools.length) await this.readPoolState(pools, this.rpc)
    this.nextPool = pools.length < limit ? 0 : this.nextPool + pools.length
    this.refreshAt = this.clock() + this.limits.period
  }
  async spotCheck(market, rpc, reads = new Map()) {
    const [, chain, id] = market.split(':')
    const pool = this.poolInfo.get(chain, id)
    if (!pool) return
    if (STATE_KINDS.includes(pool.kind)) return this.readPoolState([pool], rpc)
    // Other pools (including singleton managers) report prices through swap events.
    // Read the most recent range allowed by the bundle for this specific pool.
    const head = uint(await readOnce(reads, 'head', () => rpc.call(chain, 'eth_blockNumber', [])))
    if (head == null) return
    const deployment = this.chain.deployments.find(d => d.name === pool.dex && d.kind === pool.kind)
    const singleton = id.length === 66
    if (singleton && !deployment) return
    const logs = await readOnce(reads, 'logs', () => rpc.call(chain, 'eth_getLogs', [{
      address: singleton ? deployment.address : id,
      topics: singleton ? [this.knownTopics, id] : [this.knownTopics],
      fromBlock: hex(Math.max(0, head - Math.min(this.span, 8) + 1)), toBlock: hex(head),
    }]))
    if (!Array.isArray(logs)) return
    const m = this.registry.markets.get(market)
    for (let i = logs.length - 1; i >= 0; i--) {
      const log = logs[i]
      const event = this.chain.events[log?.topics?.[0]], block = uint(log?.blockNumber)
      if (!event || block == null || block > head) continue
      const swap = decodeEvent(log, event)
      if (swap?.type !== 'swap' || swap.pool !== id || (singleton && swap.emitter !== deployment.address)) continue
      const value = swapValue(swap, pool, this.registry.assets.get(chain + ':' + pool.token0)?.decimals,
        this.registry.assets.get(chain + ':' + pool.token1)?.decimals, m.inverse)
      if (!value) continue
      const header = await rpc.call(chain, 'eth_getBlockByNumber', [hex(block), false])
      const ts = uint(header?.timestamp)
      if (ts == null || uint(header.number) !== block || header.hash !== log.blockHash) return
      const at = ts * 1000
      this.publish([[market, decimal(value.price), decimal(this.volume.get(market, at - DAY, at).v), null, null, null, at]])
      return
    }
  }
  async readPoolState(pools, rpc) {
    const at = this.clock(), rows = []
    pools = pools.map(p => ({ ...p, manager: this.chain.deployments.find(d => d.kind === p.kind && d.name === p.dex)?.address }))
      .filter(p => p.kind !== 'v4' || p.manager)
    const states = await this.snapshots(pools, calls => multiRead(rpc, this.chain, calls))
    for (const [i, p] of pools.entries()) {
      const state = states[i], m = this.registry.markets.get('dex:' + p.chain + ':' + p.pool)
      if (!state || !m) continue
      if (state.empty || state.liquidity != null)
        this.saveDepth.run(state.empty ? 0 : state.liquidity, p.chain, p.pool)
      if (!state.empty) rows.push(this.stateRow(m, state.price, at))
    }
    this.publish(rows)
  }
}
