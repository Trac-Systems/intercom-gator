import { NameClaims } from '../intel/claims.js'
import { RateLimited } from '../scheduler/index.js'
import { evmNames } from './names/evm.js'
import { solanaNames } from './names/solana.js'
import { contractName } from './names/contracts.js'
import { offchainReader } from './names/ton.js'
import { cleanLabel, labels, validDecimals } from './names/text.js'
import { flagReader } from './names/flags.js'

const families = new Set(['evm', 'solana', 'tron', 'sui', 'aptos', 'ton', 'cosmos'])
const day = 86_400_000
const NAMES_TICK_MS = 3000
const HISTORY_PRIORITY = 2

/** @typedef {{name: string|null, symbol: string|null, decimals: number|null,
 * nameStatus: 'resolved'|'pending'|'unresolvable', nameSource: 'on-chain'|'contract-uri'|'bundle'|'registry'|'reported'|null,
 * nameFlags: string[]}} AssetNameView */

/** One durable queue for discovery and restart recovery. Internal addresses and signed venue aliases
 * stay usable while the public projection can say precisely which labels the node has established.
 * @param {import('../index.js').Engine} engine
 */
export function registerNamesJob(engine) {
  const { registry, store, book, clock, rpc } = engine, db = store.writer
  const seeds = new Map(engine.catalog.assets.map(asset => [asset.id, asset]))
  const flags = flagReader(engine, seeds), claims = new NameClaims(engine)
  const cooldown = new Map(), rotation = new Map(), offchain = offchainReader(engine)
  const rowFor = db.prepare('SELECT * FROM engine_names WHERE asset=?')
  const insert = db.prepare(`INSERT INTO engine_names(asset,chain,publicOnly,priority,nextRetry) VALUES(?,?,?,?,?)
    ON CONFLICT(asset) DO UPDATE SET publicOnly=0,priority=excluded.priority WHERE excluded.publicOnly=0 AND publicOnly=1`)
  const head = db.prepare(`SELECT nextRetry FROM engine_names WHERE chain=? AND publicOnly=? AND priority=? AND nextRetry IS NOT NULL
    ORDER BY nextRetry,asset LIMIT 1`)
  const defer = db.prepare('UPDATE engine_names SET nextRetry=? WHERE asset=? AND publicOnly=? AND nextRetry IS NOT NULL')
  const started = db.prepare('UPDATE engine_names SET lastAttempt=? WHERE asset=? AND nextRetry IS NOT NULL')
  const group = db.prepare(`SELECT asset FROM engine_names WHERE chain=? AND publicOnly=? AND priority=? AND nextRetry<=?
    ORDER BY nextRetry,asset LIMIT ?`)
  const persist = db.prepare(`UPDATE engine_names SET name=?,symbol=?,decimals=?,method=?,block=?,lastAttempt=?,
    failures=?,nextRetry=?,publishAt=? WHERE asset=?`)
  const setLabels = db.prepare('UPDATE assets SET name=?,symbol=? WHERE id=? AND (name<>? OR symbol<>?)')
  const setUnits = db.prepare(`INSERT INTO engine_asset_data(asset,decimals,totalSupply) VALUES(?,?,?)
    ON CONFLICT(asset) DO UPDATE SET decimals=excluded.decimals,
    totalSupply=coalesce(excluded.totalSupply,totalSupply)`)
  const outbox = db.prepare('SELECT * FROM engine_names WHERE publishAt<=? ORDER BY publishAt,asset LIMIT 8')
  const hasOutbox = db.prepare('SELECT 1 FROM engine_names WHERE publishAt<=? LIMIT 1')
  const ack = db.prepare('UPDATE engine_names SET publishAt=? WHERE asset=?')

  // Separate startup seed checks from discovery and public-only work. A slow endpoint cannot occupy turns for other chains.
  const routes = new Map()
  let changed = true, nextHistory = 0
  const ordinary = {}, history = {}
  function routeFor(chainId, publicOnly, priority) {
    const key = chainId + ':' + publicOnly + ':' + priority
    if (!routes.has(key)) routes.set(key, { chainId, publicOnly, priority })
  }

  function enqueue(id, fromHint = false, fromHistory = false) {
    const a = registry.assets.get(id)
    if (!a || a.address === 'native' || a.kind === 'nft' || !families.has(registry.chains.get(a.chain)?.family)) return
    const priority = fromHistory ? HISTORY_PRIORITY : Number(!!labels(seeds.get(id), a.address))
    const result = insert.run(id, a.chain, Number(fromHint), priority, clock())
    if (result.changes) changed = true
    routeFor(a.chain, Number(fromHint), priority)
  }

  // Old discoveries have no names row. Only an independent market or the signed bundle authorizes
  // configured RPCs on recovery; an unclassified legacy asset takes the public-only route.
  const independent = new Set(registry.seedIds)
  for (const m of registry.markets.values()) if (m.kind === 'dex' && !m.fromHint) {
    independent.add(m.base)
    independent.add(m.quote)
  }
  store.transaction(() => {
    for (const a of registry.assets.values()) enqueue(a.id, !independent.has(a.id))
    for (const r of db.prepare('SELECT DISTINCT chain,publicOnly,priority FROM engine_names').all()) routeFor(r.chain, r.publicOnly, r.priority)
    // Registry seeds are reapplied at construction. Restore locally measured labels/units over that seed.
    for (const r of db.prepare('SELECT * FROM engine_names WHERE name IS NOT NULL OR decimals IS NOT NULL').iterate()) {
      const a = registry.assets.get(r.asset)
      if (!a) continue
      if (r.name && r.symbol) {
        setLabels.run(r.name, r.symbol, a.id, r.name, r.symbol)
        Object.assign(a, { name: r.name, symbol: r.symbol })
      }
      const places = r.decimals <= 77 ? r.decimals : null
      if (r.decimals != null && a.decimals !== places) {
        setUnits.run(a.id, places, null)
        a.decimals = places
      }
    }
  })

  function display(id) {
    const a = registry.assets.get(id)
    if (!a || a.kind === 'nft') return null
    const r = rowFor.get(id), seed = seeds.get(id), bundled = labels(seed, a.address)
    const contract = a.address !== 'native' && families.has(registry.chains.get(a.chain)?.family)
    let fields, nameSource = null
    if (r?.name && r.symbol) {
      fields = { name: r.name, symbol: r.symbol }
      nameSource = r.method === 'jetton-https' ? 'contract-uri' : 'on-chain'
    } else if (bundled) {
      fields = bundled
      nameSource = 'bundle'
    } else if (!contract) {
      fields = labels(a, a.address)
      if (fields) nameSource = 'registry'
    } else if (r?.failures) {
      const remote = claims.consensus(id)
      if (remote && ['name', 'symbol', 'decimals'].every(k => r[k] == null || remote[k] === r[k]) &&
          (a.decimals == null || a.decimals === remote.decimals)) {
        fields = remote
        nameSource = 'reported'
      }
    }
    const unavailable = r?.failures || !contract
    return { name: fields?.name ?? null, symbol: fields?.symbol ?? null,
      decimals: r?.decimals ?? fields?.decimals ?? a.decimals ?? null,
      nameStatus: fields ? 'resolved' : unavailable ? 'unresolvable' : 'pending',
      nameSource, nameFlags: flags(id, fields?.symbol) }
  }

  // All token detail, search, movers and ordinary market rows go through this shared projection.
  const tokenView = engine.queries.token.bind(engine.queries)
  engine.queries.token = (row, withSpark) => {
    const token = tokenView(row, withSpark)
    return token ? { ...token, ...display(token.id) } : token
  }

  let joinAfter = 0
  async function listen() {
    if (!engine.active || claims.attached || clock() < joinAfter) return
    try { await claims.listen() }
    catch (error) {
      if (engine.abort?.signal.aborted) throw error
      joinAfter = clock() + 60_000
      engine.emit('sourceError', { message: 'Name claim channel unavailable' })
    }
  }

  function publish() {
    if (!claims.attached || !engine.active) return
    for (const r of outbox.all(clock())) {
      const { name, symbol, decimals, method, block } = r
      const sent = claims.send(r.asset, { name, symbol, decimals, method, ...(block != null && { block }) })
      ack.run(sent ? null : clock() + 300_000, r.asset)
    }
  }

  function nextRoute(lane = ordinary) {
    if (changed) {
      changed = false
      for (const queue of [ordinary, history]) { queue.selected = null; queue.wakeAt = Infinity }
      const now = clock()
      for (const route of routes.values()) {
        const r = route.attempt ?? head.get(route.chainId, route.publicOnly, route.priority)
        if (!r) continue
        const queue = route.priority === HISTORY_PRIORITY ? history : ordinary
        const bothReady = r.nextRetry <= now && queue.wakeAt <= now
        if (bothReady && route.priority > queue.selected.priority) continue
        if (r.nextRetry < queue.wakeAt || (bothReady && route.priority < queue.selected.priority)) {
          queue.selected = route
          queue.wakeAt = r.nextRetry
        }
      }
    }
    return clock() >= lane.wakeAt ? lane.selected : null
  }

  function nextBatch({ chainId, publicOnly, priority }) {
    const now = clock(), chain = registry.chains.get(chainId)
    // 24 EVM tokens are 72 calls: one multicall chunk (128).
    const limit = chain?.family === 'solana' ? 16 : chain?.family === 'evm' && !(cooldown.get(chainId) > now) ? 24 : 1
    const assets = group.all(chainId, publicOnly, priority, now, limit).map(r => registry.assets.get(r.asset)).filter(Boolean)
    store.transaction(() => { for (const a of assets) started.run(now, a.id) })
    return { chain, publicOnly, assets, reads: {}, start: now }
  }

  async function resolve({ chain, publicOnly, assets, reads }, client = publicOnly ? rpc.publicOnly : rpc) {
    if (chain?.family === 'evm') return evmNames(chain, assets, client, reads, cooldown, clock())
    if (chain?.family === 'solana') return solanaNames(chain, assets, client)
    const raw = engine.bundle.chains.find(c => c.id === chain?.id)
    return [raw ? await contractName(raw, assets[0], engine.http, reads, rotation, offchain) : null]
  }

  function save(assets, results) {
    const now = clock(), changes = []
    store.transaction(() => {
      for (const [i, result] of results.entries()) {
        const a = assets[i], old = rowFor.get(a.id)
        if (!old || old.nextRetry === null) continue // Another route may already have resolved a promoted public hint.
        const name = cleanLabel(result?.name, 64, a.address) ?? old.name
        const symbol = cleanLabel(result?.symbol, 16, a.address) ?? old.symbol
        const decimals = validDecimals(result?.decimals) ? result.decimals : old.decimals
        const method = result?.method ?? old.method
        const block = result?.block ?? old.block
        const complete = name && symbol && decimals != null && method
        const failures = complete ? 0 : Math.min(32, old.failures + 1)
        const nextRetry = complete ? null : now + Math.min(day, 60_000 * 2 ** (failures - 1))
        const publishAt = complete && old.priority !== HISTORY_PRIORITY ? now : null
        persist.run(name, symbol, decimals, method, block, now, failures, nextRetry, publishAt, a.id)
        const patch = {}
        if (name && symbol) {
          setLabels.run(name, symbol, a.id, name, symbol)
          Object.assign(patch, { name, symbol })
        }
        const places = decimals != null && decimals <= 77 ? decimals : null
        const total = result?.totalSupply ?? null
        if (decimals != null) {
          setUnits.run(a.id, places, total)
          patch.decimals = places
        }
        if (total != null) patch.totalSupply = total
        changes.push([a.id, patch])
      }
    })
    for (const [id, patch] of changes) Object.assign(registry.assets.get(id), patch)
    if (changes.length) book.dirty = true
  }

  let busy = null
  const runNames = () => busy ??= runOnce().finally(() => { busy = null })
  engine.registerJob({ id: 'names', interval: 1000,
    ready: () => !!(nextRoute() || (engine.active &&
      (claims.attached ? hasOutbox.get(clock()) : clock() >= joinAfter))),
    run: runNames })
  // About a hundred background jobs share the scheduler's oldest-first turn, which left the names job minutes apart
  // and >1,400 EVM tokens never tried. It also paces itself: a batch every few seconds while names are due, idle when
  // more than half the request budget is used. Off when a test restricts the background jobs.
  if (!engine.scheduler.backgroundJobs) {
    const arm = () => setTimeout(tick, NAMES_TICK_MS).unref?.()
    const tick = async () => {
      try {
        if (engine.active && engine.budget.used < engine.budget.limit / 2 && nextRoute()) await runNames()
      } catch {}
      if (engine.active || !engine.abort?.signal.aborted) arm()
    }
    arm()
  }
  async function runOnce() {
    await listen()
    publish()
    const route = nextRoute()
    if (route) { await readRoute(route); publish() }
  }
  async function readRoute(route, client) {
    const attempt = route.attempt ?? nextBatch(route)
    changed = true
    route.attempt = null
    if (!attempt.assets.length) return
    let results
    try { results = await resolve(attempt, client) }
    catch (error) {
      if (engine.abort?.signal.aborted) throw error
      if (error instanceof RateLimited) {
        const now = clock(), retry = Math.max(now + 1000, Math.min(now + day, error.retryAt))
        store.transaction(() => { for (const a of attempt.assets) defer.run(retry, a.id, route.publicOnly) })
        // Preserve completed selectors across budget turns. Release stale partial reads so a persistently
        // unavailable token cannot block the rest of its chain. A budget deferral never enables peer fallback.
        if (now - attempt.start < 15 * 60_000) route.attempt = { ...attempt, nextRetry: retry }
        changed = true
        return
      }
      results = attempt.assets.map(() => null)
    }
    save(attempt.assets, results)
    changed = true
  }
  // Historical labels share the durable batch/validation path. Only the idle catch-up job
  // runs these public reads, and locally resolved historical names stay out of the live outbox.
  return { enqueue, display,
    // Reuse an independent on-chain read without issuing a second names batch or enqueuing a venue-derived announcement.
    recordVerified(asset, row) {
      enqueue(asset.id, true, true)
      save([asset], [row])
    },
    historyDue: () => clock() >= nextHistory && !!nextRoute(history),
    async readHistory(client) {
      const route = nextRoute(history)
      if (!route) return
      nextHistory = clock() + 10_000
      await readRoute(route, client)
    },
  }
}
