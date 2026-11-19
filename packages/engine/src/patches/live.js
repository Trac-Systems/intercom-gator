import { canonical } from '../../../bundle/src/index.js'
import { RpcClient } from '../rpc/index.js'
import { adaptBundle } from '../sources/bundle-adapter.js'
import { derivativeJobs } from '../sources/derivatives.js'

const same = (a, b) => canonical(a ?? null) === canonical(b ?? null)
const byId = (list) => new Map((list ?? []).map((item) => [item.id, item]))
// Fetch progress owned by the running jobs, not by the bundle.
const runtime = ['catalogCache', 'catalogAt', 'instruments', 'nextSymbol']

function dropJobs(engine, match) {
  for (const id of [...engine.scheduler.jobs.keys()]) if (match(id)) engine.scheduler.jobs.delete(id)
}

/** Rebuild the bundle part of each changed chain's RPC pool. User endpoints stay first and keep their state;
 * known URLs keep their rate bucket (same approach as the settings route). */
function refreshRpc(engine, ids) {
  const { rpc, store, catalog } = engine
  const fresh = new RpcClient({
    endpoints: Object.fromEntries(catalog.chains.filter((c) => ids.has(c.id)).map((c) => [c.id, c.endpoints])),
    aliases: rpc.aliases,
    loadHealth: (id) => store.getEndpointHealth(id),
    clock: engine.clock,
    budget: engine.budget,
  })
  for (const id of ids) {
    const users = (rpc.chains.get(id) ?? []).filter((e) => e.user)
    const userUrls = new Set(users.map((e) => e.url))
    const bundled = (fresh.chains.get(id) ?? []).filter((e) => !userUrls.has(e.url))
    for (const entry of bundled) {
      if (rpc.buckets.has(entry.url)) entry.bucket = rpc.buckets.get(entry.url)
      else rpc.buckets.set(entry.url, entry.bucket)
    }
    rpc.chains.set(id, [...users, ...bundled])
  }
}

/** Make a newly accepted effective bundle take effect on a running engine where that is practical.
 * Live: chain RPC endpoint lists (pool + log ranges), exchange request specs, terms and rate limits (venue table),
 * API source URLs and limits, removal of exchanges and APIs (their jobs stop). Next start: everything else
 * (new chains, exchanges or APIs, other chain fields, DEX deployments and events, tokens, paid extras).
 * @returns {{restart: string[]}} the datasets whose change waits for the next start */
export function takeEffect(engine, before, after) {
  const restart = new Set()
  for (const name of ['tokens', 'dex', 'paidExtras']) if (!same(before[name], after[name])) restart.add(name)
  const fresh = adaptBundle(after)
  const { catalog } = engine

  const oldChains = byId(before.chains)
  const freshChains = byId(fresh.chains)
  const liveChains = byId(catalog.chains)
  const rpcIds = new Set()
  if (oldChains.size !== after.chains.length || after.chains.some((c) => !oldChains.has(c.id))) restart.add('chains')
  for (const raw of after.chains) {
    const old = oldChains.get(raw.id)
    if (!old) continue
    const { endpoints, ...rest } = raw
    const { endpoints: oldEndpoints, ...oldRest } = old
    if (!same(rest, oldRest)) restart.add('chains')
    const chain = liveChains.get(raw.id)
    if (same(endpoints, oldEndpoints) || !chain) continue
    const next = freshChains.get(raw.id)
    chain.endpoints = next.endpoints
    chain.range = next.range
    rpcIds.add(raw.id)
    const source = engine.evm.get(raw.id)
    if (source) {
      const ranges = chain.endpoints.filter((e) => e.logs !== false && e.range > 0).map((e) => e.range)
      source.lookupRange = Math.min(200000, ...ranges)
      source.span = Math.min(source.span, chain.range)
    }
  }
  if (rpcIds.size) refreshRpc(engine, rpcIds)

  const oldVenues = byId(before.exchanges)
  const freshVenues = byId(fresh.exchanges)
  for (const raw of after.exchanges) {
    const old = oldVenues.get(raw.id)
    const venue = engine.registry.venues.get(raw.id)
    if (!old || !venue) {
      restart.add('exchanges')
      continue
    }
    if (same(raw, old)) continue
    const next = freshVenues.get(raw.id)
    if (next.perSymbolCatalog !== venue.perSymbolCatalog) restart.add('exchanges')
    const keep = same(raw.symbols, old.symbols) ? runtime : ['instruments', 'nextSymbol']
    for (const [key, value] of Object.entries(next)) if (!keep.includes(key)) venue[key] = value
    if (!same(raw.derivatives, old.derivatives)) {
      dropJobs(engine, (id) => id.startsWith('cex:' + raw.id + ':derivatives:'))
      for (const job of derivativeJobs(venue, engine.http, engine.clock, engine.saveDerivative))
        engine.scheduler.add(job)
    }
  }
  const kept = new Set(after.exchanges.map((e) => e.id))
  for (const id of oldVenues.keys()) {
    if (kept.has(id)) continue
    dropJobs(engine, (job) => job === 'cex:' + id || job.startsWith('cex:' + id + ':'))
    const venue = engine.registry.venues.get(id)
    if (venue) venue.publishMarketData = false
  }

  const oldApis = byId(before.apis)
  const freshApis = byId(fresh.apis)
  const liveApis = byId(catalog.apis)
  for (const raw of after.apis) {
    const source = liveApis.get(raw.id)
    if (!oldApis.has(raw.id) || !source) {
      restart.add('apis')
      continue
    }
    const { name, url, rpm } = freshApis.get(raw.id)
    Object.assign(source, { name, url, rpm })
  }
  const apiIds = new Set(after.apis.map((a) => a.id))
  for (const id of oldApis.keys())
    if (!apiIds.has(id)) dropJobs(engine, (job) => job === 'api:' + id || job === 'sol:' + id)

  engine.bundle = after
  return { restart: [...restart].sort() }
}
