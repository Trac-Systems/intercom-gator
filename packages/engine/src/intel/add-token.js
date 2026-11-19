import { address as evmAddress, decodeEvent, field, multiRead, poolStateCalls, v4StateCall, word, ZERO } from '../sources/evm-abi.js'
import { probe, variants } from '../sources/evm.js'
import { abiDecimals, abiLabel } from '../sources/names/evm.js'
import { cleanLabel } from '../sources/names/text.js'
import { MARKET_POLICY } from '../../../store/src/markets.js'
import { RateLimited } from '../scheduler/index.js'

const HOUR = 3_600_000, DAY = 24 * HOUR
/** Per-node limits for local adds (owner and agents together). Each add costs a bounded number of reads. */
export const ADD_LIMITS = Object.freeze({ perHour: 12, perDay: 60, inlineSearchCalls: 24, firstSpan: 1_000_000, maxSpan: 4_000_000,
  // An explicitly added token is registered down to this measured depth (the dust rules still hide it from ranked
  // lists); the ordinary $10k seed floor decides which of its pools the node keeps re-announcing.
  minDepthUsd: 100 })
const TOKEN = /^0x[0-9a-f]{40}$/i, POOL = /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const isWord = raw => typeof raw === 'string' && /^0x[0-9a-f]{64}$/i.test(raw)
const hex = n => '0x' + n.toString(16)
const uint = v => (typeof v === 'string' && /^0x[\da-f]+$/i.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null)
const currency = a => (a === ZERO ? 'native' : a)
const raw = a => (a === 'native' ? ZERO : a)

/** An interactive add waits for endpoint/budget slots (bounded) instead of failing on the first busy bucket. */
export function patientRpc(rpc, clock, sleep, limitMs = 45_000) {
  const start = clock()
  const retry = async (fn) => {
    for (;;) {
      try { return await fn() } catch (error) {
        if (!(error instanceof RateLimited) || error.retryAt - start > limitMs) throw error
        await sleep(Math.max(50, Math.min(5000, error.retryAt - clock())))
      }
    }
  }
  return { call: (chain, method, params) => retry(() => rpc.call(chain, method, params)),
    batch: (chain, calls) => retry(() => rpc.batch(chain, calls)), chains: rpc.chains }
}

export class AddTokenError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details }
}

/** Local "add a token by contract address" for the owner and agents (DESIGN §5.3 "Agent-added tokens").
 * Everything is verified on-chain through the engine's RPC client and profile budget; pools are found by the
 * seeder's deterministic probes for this one token, registered through the ordinary registry path and shared as
 * ordinary `gator/new` `pool` records once their creation transaction is found. */
export function registerAddTokens(engine) {
  const { store, registry, clock, catalog } = engine
  const db = store.writer
  const saveToken = db.prepare(`INSERT INTO engine_added_tokens(asset,chain,address,addedAt,addedBy,symbol,name,decimals)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(asset) DO UPDATE SET symbol=excluded.symbol,name=excluded.name,decimals=excluded.decimals`)
  const listTokens = store.reader.prepare('SELECT * FROM engine_added_tokens ORDER BY addedAt DESC,asset LIMIT ?')
  const savePool = db.prepare(`INSERT INTO engine_added_pools(chain,pool,asset,dex,kind,token0,token1,state,nextBlock,span,
    block,tx,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chain,pool) DO UPDATE SET
    asset=excluded.asset,dex=coalesce(excluded.dex,dex),kind=coalesce(excluded.kind,kind),
    token0=coalesce(excluded.token0,token0),token1=coalesce(excluded.token1,token1),
    state=CASE WHEN engine_added_pools.state='found' THEN 'found' ELSE excluded.state END,updatedAt=excluded.updatedAt`)
  const poolsOf = store.reader.prepare('SELECT * FROM engine_added_pools WHERE asset=? ORDER BY chain,pool')
  const poolRow = store.reader.prepare('SELECT * FROM engine_added_pools WHERE chain=? AND pool=?')
  const nextSearch = store.reader.prepare(`SELECT * FROM engine_added_pools WHERE state='searching' AND retryAt<=?
    ORDER BY updatedAt,chain,pool LIMIT 1`)
  const progress = db.prepare('UPDATE engine_added_pools SET nextBlock=?,span=?,updatedAt=?,retryAt=?,state=? WHERE chain=? AND pool=?')
  const found = db.prepare(`UPDATE engine_added_pools SET state='found',block=?,tx=?,token0=?,token1=?,spacing=?,updatedAt=?
    WHERE chain=? AND pool=?`)
  const indexHistory = db.prepare(`INSERT INTO engine_pool_history(chain,pool,at,verified) VALUES (?,?,?,1)
    ON CONFLICT(chain,pool) DO UPDATE SET at=max(at,excluded.at),verified=1`)
  const markAnnounced = db.prepare('INSERT OR REPLACE INTO engine_pool_announcements VALUES (?,?,?,?,?)')
  const recentKey = 'engine-add-token/recent'
  const sleep = engine.addTokenSleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  let running = false

  function evmChains() {
    return catalog.chains.filter(c => c.family === 'evm' && c.endpoints?.length)
  }
  function chainOf(input) {
    if (input == null || input === '') return null
    const text = String(input).toLowerCase()
    const chain = evmChains().find(c => c.id === text || String(c.number) === text)
    if (!chain) throw new AddTokenError(400, 'chain must be an EVM chain of the bundle: ' + evmChains().map(c => c.id).join(', '))
    return chain
  }
  function admit(now) {
    const recent = (store.getSetting(recentKey) ?? []).filter(t => Number.isFinite(t) && t > now - DAY)
    if (recent.filter(t => t > now - HOUR).length >= ADD_LIMITS.perHour || recent.length >= ADD_LIMITS.perDay) {
      const hour = recent.filter(t => t > now - HOUR)
      const retryAt = hour.length >= ADD_LIMITS.perHour ? hour[0] + HOUR : recent[0] + DAY
      throw new AddTokenError(429, 'add limit reached (' + ADD_LIMITS.perHour + ' per hour, ' + ADD_LIMITS.perDay +
        ' per day on this node)', { retryAt })
    }
    recent.push(now)
    store.setSetting(recentKey, recent)
  }

  /** ERC-20 check: code, decimals() (0 allowed), totalSupply(), allowance(); symbol()/name() sanitized. */
  async function verifyToken(chain, address, rpc) {
    const code = await rpc.call(chain.id, 'eth_getCode', [address, 'latest'])
    if (code === '0x' || code === '0x0') return { ok: false, reason: 'no contract code' }
    if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(code)) throw new Error('Invalid bytecode response')
    const own = word(address)
    const calls = ['0x313ce567', '0x95d89b41', '0x06fdde03', '0x18160ddd', '0xdd62ed3e' + own + own].map(data => ({ to: address, data }))
    const [dec, sym, nam, supply, allowance] = await multiRead(rpc, chain, calls)
    const decimals = abiDecimals(dec)
    if (decimals == null || decimals > 77) return { ok: false, reason: 'no ERC-20 decimals()' }
    if (!isWord(supply) || !isWord(allowance)) return { ok: false, reason: 'not an ERC-20 (totalSupply/allowance missing)' }
    const symbol = cleanLabel(abiLabel(sym), 16, address), name = cleanLabel(abiLabel(nam), 64, address)
    return { ok: true, decimals, symbol: symbol ?? null, name: name ?? symbol ?? null }
  }

  async function pinnedRead(source, rpc) {
    const header = await rpc.call(source.chain.id, 'eth_getBlockByNumber', ['latest', false])
    const tip = uint(header?.number)
    if (tip == null) throw new Error('Invalid chain head')
    const head = { tip, block: Math.max(0, tip - 2), ts: uint(header.timestamp) }
    const cache = new Map()
    const read = async calls => {
      const out = []
      for (let i = 0; i < calls.length; i += 128) {
        const chunk = calls.slice(i, i + 128), key = JSON.stringify(chunk)
        if (!cache.has(key)) cache.set(key, await multiRead(rpc, source.chain, chunk, hex(head.tip)))
        out.push(...cache.get(key))
      }
      return out
    }
    return { head, read }
  }

  /** The seeder's deterministic keys for ONE token: every signed deployment × the chain's quotes (+ native for V4). */
  function plan(source, token) {
    const native = registry.assets.get(source.chain.id + ':native')
    const v4 = source.chain.deployments.some(d => d.kind === 'v4')
    const counterparts = [...source.quotes.keys(), ...(v4 && native ? [ZERO] : [])].filter(q => q !== token)
    const methods = source.chain.deployments.flatMap(d => variants(d).map(args => ({ d, args })))
    return counterparts.flatMap(q => methods.map(m => probe([token, q].sort(), m))).filter(Boolean)
  }

  function registerFound(source, candidate, state, at, extra = {}) {
    const chain = source.chain.id
    const p = { ...candidate, chain, liquidity: state.liquidity, firstSeen: at, ...extra }
    let market = null
    store.transaction(() => {
      market = registry.pool(p, { token0: source.metadata(p.token0), token1: source.metadata(p.token1) })
      if (market) source.saveParameters(p)
    })
    return market && { market, row: source.stateRow(market, state.price, at) }
  }

  function describe(source, p, state, market, reason) {
    const sym = a => (a === 'native' ? registry.assets.get(source.chain.id + ':native')?.symbol : registry.assets.get(source.chain.id + ':' + a)?.symbol) ?? a
    return { market: market?.id ?? 'dex:' + source.chain.id + ':' + p.pool, pool: p.pool, dex: p.dex, kind: p.kind,
      token0: p.token0, token1: p.token1, pair: sym(p.token0) + '/' + sym(p.token1),
      price0in1: state && !state.empty ? state.price : null, liquidityUsd: state?.liquidity ?? null,
      registered: !!market, reason: reason ?? null }
  }

  /** A non-standard pool given by the caller: V4 pool IDs are identified from their Initialize log (creation
   * search); pool contracts must name a signed factory whose reverse lookup returns the same address. */
  async function poolContract(source, pool, read) {
    const selectors = ['0x0dfe1681', '0xd21220a7', '0xc45a0155', '0xddca3f43', '0x22be3de1', '0xd0c93a7c']
    const [a, b, f, fee, stable, spacing] = await read(selectors.map(data => ({ to: pool, data })))
    const token0 = evmAddress(a), token1 = evmAddress(b), factory = evmAddress(f)
    if (!token0 || !token1 || !factory) return { reason: 'not a pool contract (token0/token1/factory)' }
    const d = source.chain.deployments.find(x => x.address === factory.toLowerCase() &&
      ['v2', 'v3', 'pancake-v3', 'slipstream', 'velodrome-v2', 'solidly-v1'].includes(x.kind))
    if (!d) return { reason: 'factory ' + factory + ' is not a signed deployment on ' + source.chain.id }
    const args = word(token0) + word(token1)
    let data = '0xe6a43905' + args, extra = {}
    if (d.kind.includes('v3')) { if (uint(fee) == null) return { reason: 'no fee()' }; data = '0x1698ee82' + args + word(fee) }
    else if (d.kind === 'slipstream') {
      if (!(uint(spacing) > 0 && uint(spacing) <= 0x7fffff)) return { reason: 'no tickSpacing()' }
      data = '0x28af8d0b' + args + word(spacing); extra.spacing = uint(spacing)
    } else if (d.kind === 'velodrome-v2' || d.kind === 'solidly-v1') {
      if (![0, 1].includes(uint(stable))) return { reason: 'no stable()' }
      data = (d.kind === 'solidly-v1' ? '0x6801cc30' : '0x79bc57d5') + args + word(stable); extra.stable = uint(stable) === 1
    }
    const [back] = await read([{ to: factory, data }])
    if (evmAddress(back)?.toLowerCase() !== pool) return { reason: 'factory does not return this pool' }
    return { candidate: { pool, dex: d.name, kind: d.kind, token0: token0.toLowerCase(), token1: token1.toLowerCase(),
      manager: d.address, ...extra } }
  }

  // ---- creation transaction search (resumable, chunked for providers' span limits, inside the budget) ----
  function creationFilter(source, row) {
    const d = source.chain.deployments.find(x => x.name === row.dex && x.kind === row.kind)
    if (!d) return null
    const topics = Object.values(source.chain.events).filter(e => d.topics.includes(e.topic) &&
      (e.emitter === 'factory' || e.signature.startsWith('Initialize('))).map(e => e.topic)
    if (!topics.length) return null
    if (row.kind === 'v4') return { d, filter: { address: d.address, topics: [topics, row.pool] } }
    if (!row.token0 || !row.token1 || row.token0 === 'native') return null
    return { d, filter: { address: d.address, topics: [topics, '0x' + word(row.token0), '0x' + word(row.token1)] } }
  }
  function knownSpan(chain) {
    const endpoints = engine.rpc.chains?.get(chain) ?? []
    const ranges = endpoints.filter(e => e.logs !== false).map(e => (e.range > 0 ? e.range : Infinity))
    return ranges.length ? Math.max(...ranges) : Infinity
  }
  /** One eth_getLogs step, newest range first. Returns 'found', 'none', or 'searching'. */
  async function searchStep(row, rpc = engine.rpc) {
    const source = engine.evm.get(row.chain), now = clock()
    const setup = source && creationFilter(source, row)
    if (!setup) { progress.run(row.nextBlock, row.span, now, 0, 'unsupported', row.chain, row.pool); return 'none' }
    let to = row.nextBlock
    if (to == null || to < 0) {
      const header = await rpc.call(row.chain, 'eth_getBlockByNumber', ['latest', false])
      to = uint(header?.number)
      if (to == null) throw new Error('Invalid chain head')
    }
    const span = Math.max(1, Math.min(row.span ?? ADD_LIMITS.firstSpan, ADD_LIMITS.maxSpan, knownSpan(row.chain)))
    const from = Math.max(0, to - span + 1)
    let logs
    try {
      logs = await rpc.call(row.chain, 'eth_getLogs', [{ ...setup.filter, fromBlock: hex(from), toBlock: hex(to) }])
      if (!Array.isArray(logs)) throw new Error('Invalid log result')
    } catch (error) {
      if (error instanceof RateLimited) throw error
      // A span limit (or a timeout on a wide range) halves the window; progress is kept.
      const smaller = Math.max(1, Math.floor(span / 2))
      progress.run(to, smaller, now, span === 1 ? now + 15 * 60_000 : now, 'searching', row.chain, row.pool)
      return 'searching'
    }
    for (const log of logs) {
      const event = source.chain.events[log?.topics?.[0]]
      if (!event || !/^0x[0-9a-f]{64}$/i.test(log.transactionHash ?? '') || uint(log.blockNumber) == null) continue
      const decoded = decodeEvent(log, event)
      if (decoded?.type !== 'pool' || decoded.pool !== row.pool || decoded.emitter !== setup.d.address) continue
      const block = uint(log.blockNumber), tx = log.transactionHash.toLowerCase()
      const token0 = currency(decoded.token0.toLowerCase()), token1 = currency(decoded.token1.toLowerCase())
      found.run(block, tx, token0, token1, decoded.spacing ?? null, now, row.chain, row.pool)
      return 'found'
    }
    if (from === 0) { progress.run(-1, span, now, 0, 'none', row.chain, row.pool); return 'none' }
    progress.run(from - 1, Math.min(ADD_LIMITS.maxSpan, span * 2), now, now, 'searching', row.chain, row.pool)
    return 'searching'
  }

  /** A found creation: register block+tx on the pool, index it for catch-up by verification time and announce it. */
  async function share(row, rpc = engine.rpc) {
    const source = engine.evm.get(row.chain)
    const market = registry.markets.get('dex:' + row.chain + ':' + row.pool)
    if (!source || !market) return false
    const pool = store.reader.prepare('SELECT * FROM pools WHERE chain=? AND pool=?').get(row.chain, row.pool)
    if (!pool || pool.token0 !== row.token0 || pool.token1 !== row.token1) return false
    const record = { ...pool, block: row.block, tx: row.tx }
    if (!(await engine.hints.hasCreationReceipt(record, rpc))) return false
    const now = clock()
    store.transaction(() => {
      store.upsertPool(record)
      indexHistory.run(row.chain, row.pool, now)
      markAnnounced.run(row.chain, row.pool, row.tx, now, now + HOUR)
    })
    engine.discovery({ ...record, firstSeen: pool.firstSeen })
    return true
  }

  async function settle(row, budget) {
    let state = 'searching'
    while (state === 'searching' && budget.calls > 0) {
      budget.calls--
      row = poolRow.get(row.chain, row.pool)
      if (row.retryAt > clock()) break
      // Any failure leaves the durable search state for the background job; the add itself still succeeds.
      try { state = await searchStep(row, budget.rpc) } catch { break }
    }
    row = poolRow.get(row.chain, row.pool)
    return row
  }

  async function addOnChain(chain, address, info, pool, by, budget) {
    const now = clock(), id = chain.id + ':' + address
    const source = engine.evm.get(chain.id)
    store.transaction(() => {
      registry.registerToken(chain.id, address, { decimals: info.decimals, symbol: info.symbol ?? undefined, name: info.name ?? undefined })
      saveToken.run(id, chain.id, address, now, by, info.symbol, info.name, info.decimals)
    })
    engine.scheduleMeta?.(id, false)
    const result = { asset: id, chain: chain.id, address, symbol: info.symbol, name: info.name, decimals: info.decimals,
      pools: [], notes: [] }
    if (!source) { result.notes.push('no signed DEX deployments on ' + chain.id + '; token registered without pools'); return result }
    const { head, read } = await pinnedRead(source, budget.rpc)
    const at = (head.ts ?? Math.floor(now / 1000)) * 1000
    const rows = []
    const consider = async (candidate, state, extra) => {
      let market = null, reason = null
      if (!state || state.empty) reason = 'empty pool'
      else if (state.liquidity == null) reason = 'depth unknown (no USD price on either side yet)'
      else if (!(state.liquidity >= ADD_LIMITS.minDepthUsd)) reason = 'below the $' + ADD_LIMITS.minDepthUsd + ' depth floor for added tokens'
      else {
        const done = registerFound(source, candidate, state, at, extra)
        if (done) { market = done.market; rows.push(done.row) } else reason = 'registry refused the pool identity'
      }
      const row = describe(source, candidate, state, market, reason)
      if (market) row.reannounce = state.liquidity >= MARKET_POLICY.minPoolLiquidityUsd
      result.pools.push(row)
      if (market) {
        savePool.run(chain.id, candidate.pool, id, candidate.dex, candidate.kind, candidate.token0, candidate.token1,
          'searching', null, null, null, null, clock())
        // A pool this node already saw being created (live scan, hint, catch-up) needs no search.
        const known = store.reader.prepare('SELECT block,tx,token0,token1 FROM pools WHERE chain=? AND pool=?').get(chain.id, candidate.pool)
        if (known?.block != null && known.tx?.length === 66 && poolRow.get(chain.id, candidate.pool).state !== 'found')
          found.run(known.block, known.tx, known.token0, known.token1, candidate.spacing ?? null, clock(), chain.id, candidate.pool)
      }
    }
    // 1) the seeder's deterministic keys for this token
    const { found: hits, states } = await source.probeBatch(plan(source, address), read)
    for (const [i, candidate] of hits.entries()) await consider(candidate, states[i])
    // 2) an explicit pool the standard keys cannot derive
    if (pool && !result.pools.some(p => p.pool === pool)) {
      if (pool.length === 66) {
        const manager = source.chain.deployments.find(d => d.kind === 'v4')
        if (!manager) result.notes.push('pool: no Uniswap V4 PoolManager is signed for ' + chain.id)
        else {
          const [slot0] = await read([v4StateCall(manager.address, pool)])
          if (!BigInt.asUintN(160, field(slot0, 0) ?? 0n)) result.notes.push('pool: V4 pool id is not initialized on ' + chain.id)
          else {
            savePool.run(chain.id, pool, id, manager.name, 'v4', null, null, 'searching', null, null, null, null, clock())
            const row = await settle(poolRow.get(chain.id, pool), budget)
            if (row.state !== 'found') result.notes.push('pool: Initialize log not found yet (' + row.state + '); the search continues in the background')
            else if (![row.token0, row.token1].includes(address)) result.notes.push('pool: V4 pool does not contain this token')
            else {
              const candidate = { pool, dex: manager.name, kind: 'v4', token0: row.token0, token1: row.token1,
                manager: manager.address, spacing: row.spacing ?? undefined, slot0 }
              const [state] = await source.snapshots([candidate], read)
              await consider(candidate, state, { block: row.block, tx: row.tx })
            }
          }
        }
      } else {
        const checked = await poolContract(source, pool, read)
        if (!checked.candidate) result.notes.push('pool: ' + checked.reason)
        else if (![checked.candidate.token0, checked.candidate.token1].includes(address)) result.notes.push('pool: pool does not contain this token')
        else {
          const [state] = await source.snapshots([checked.candidate], read)
          await consider(checked.candidate, state)
        }
      }
    }
    if (rows.length) engine.publish(rows)
    // 3) creation transactions: a few inline steps, the rest resumes in the background job
    for (const p of result.pools.filter(x => x.registered)) {
      let row = poolRow.get(chain.id, p.pool)
      if (row.state === 'searching') row = await settle(row, budget)
      p.creation = { state: row.state, block: row.block ?? null, tx: row.tx ?? null, shared: false }
      if (row.state === 'found') p.creation.shared = await share(row, budget.rpc).catch(() => false)
    }
    const best = result.pools.filter(p => p.registered).sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0]
    if (best) {
      const usd0 = source.usd(best.token0), usd1 = source.usd(best.token1)
      const mine = best.token0 === address
      const other = mine ? usd1 : usd0
      if (other && best.price0in1) result.priceUsd = mine ? best.price0in1 * other : other / best.price0in1
    }
    if (!result.pools.length) result.notes.push('no pool found for the standard keys on ' + chain.id +
      ' (V2/V3/V4/Velodrome/Solidly/Slipstream × the chain\'s signed quotes); pass pool for a non-standard one')
    return result
  }

  async function add(input = {}, { by = 'agent' } = {}) {
    const address = typeof input.address === 'string' ? input.address.trim().toLowerCase() : ''
    if (!TOKEN.test(address) || address === ZERO) throw new AddTokenError(400, 'address must be a 0x-prefixed 20-byte EVM contract address')
    const pool = input.pool == null || input.pool === '' ? null : String(input.pool).trim().toLowerCase()
    if (pool != null && !POOL.test(pool)) throw new AddTokenError(400, 'pool must be a pool address or a 32-byte V4 pool id')
    const only = chainOf(input.chain)
    if (running) throw new AddTokenError(409, 'another token add is running on this node; retry in a few seconds')
    admit(clock())
    running = true
    const account = { requests: 0 }
    try {
      return await engine.budget.trackRequests(account, async () => {
        const chains = only ? [only] : evmChains()
        const rpc = patientRpc(engine.rpc, clock, sleep)
        const probes = await Promise.allSettled(chains.map(c => verifyToken(c, address, rpc)))
        const checked = chains.map((c, i) => ({ chain: c, result: probes[i] }))
        const tokens = checked.filter(x => x.result.status === 'fulfilled' && x.result.value.ok)
        if (!tokens.length) {
          const reasons = Object.fromEntries(checked.map(x => [x.chain.id, x.result.status === 'fulfilled' ? x.result.value.reason :
            'unavailable (' + (x.result.reason?.message ?? 'error') + ')']))
          const unavailable = checked.some(x => x.result.status === 'rejected')
          const coded = checked.filter(x => x.result.status === 'fulfilled' && x.result.value.reason !== 'no contract code')
          if (unavailable && !coded.length) throw new AddTokenError(503, 'token verification unavailable on some chains', { chains: reasons })
          throw new AddTokenError(422, coded.length ? 'contract is not an ERC-20 token' : 'no contract at this address on ' +
            (only ? only.id : 'any bundle EVM chain'), { chains: reasons })
        }
        const budget = { calls: ADD_LIMITS.inlineSearchCalls, rpc }
        const results = []
        for (const { chain, result } of tokens) results.push(await addOnChain(chain, address, result.value, pool, by, budget))
        const best = results.find(r => r.pools.some(p => p.registered)) ?? results[0]
        return { asset: best.asset, tokens: results, chainsProbed: chains.length, rpcCalls: account.requests }
      })
    } finally {
      running = false
      engine.book?.refresh?.()
    }
  }

  function list(limit = 100) {
    return listTokens.all(Math.max(1, Math.min(500, limit))).map(t => ({ ...t,
      pools: poolsOf.all(t.asset).map(p => ({ chain: p.chain, pool: p.pool, dex: p.dex, kind: p.kind, token0: p.token0,
        token1: p.token1, creation: { state: p.state, block: p.block, tx: p.tx } })) }))
  }

  // Background creation search: one getLogs per turn, oldest progress first, through the shared budget.
  engine.registerJob({ id: 'discovery:added-creation', interval: 5000, relevance: 0.5,
    ready: () => !running && !!nextSearch.get(clock()),
    async run() {
      const row = nextSearch.get(clock())
      if (!row) return
      const state = await searchStep(row)
      if (state !== 'found') return
      const done = poolRow.get(row.chain, row.pool)
      // An identified V4 pool given as `pool` input still needs its token check and depth before registration.
      if (registry.markets.has('dex:' + done.chain + ':' + done.pool)) await share(done)
    } })

  return { add, list, searchStep, share, limits: ADD_LIMITS }
}
