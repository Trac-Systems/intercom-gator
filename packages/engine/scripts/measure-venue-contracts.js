/** Offline replay: node packages/engine/scripts/measure-venue-contracts.js /path/to/manifest.json
 * The local manifest has {at, venues:[{venue,directory,tickers,pairs?}], rpc?:[file], dex?:[file], sample?:[...]}.
 * All file references are relative to the manifest. Private exchange fixtures stay with the operator.
 * RPC fixtures contain {ids,request:{method,params},result}, DEX fixtures are Dexscreener /tokens/v1 responses.
 * A sample item is {venue,label,asset}. Output distinguishes eligible candidates from actual registry bindings. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleDigest, loadBundle, loadReleaseExtensions } from '@gator/bundle'
import { openStore } from '@gator/store'
import { Engine, migrations } from '../src/index.js'
import { validRow } from '../src/obs/index.js'
import { weightedMedian } from '../src/aggregate/index.js'
import { chooseContract, venueQuotes } from '../src/sources/venue-contracts/evidence.js'
import { registerVenueTokens } from '../src/sources/venue-contracts/tokens.js'

const manifestPath = resolve(process.argv[2]), local = dirname(manifestPath)
const read = file => JSON.parse(readFileSync(resolve(local, file), 'utf8'))
const manifest = read(manifestPath), now = manifest.at
assert.ok(Number.isSafeInteger(now) && now > 0)
const bundle = loadBundle(), digest = bundleDigest(bundle)
const snapshot = fileURLToPath(new URL('../../bundle/data/patches/' + digest + '.json', import.meta.url))
const store = openStore({ file: ':memory:', profile: 'normal', migrations })
try {
  const engine = new Engine({ store, bundle, extensions: loadReleaseExtensions(), clock: () => now,
    backgroundJobs: [], patches: { snapshot, patchFeed: false },
    transport: Object.assign(new EventEmitter(), { publicKey: 'a'.repeat(64) }),
    rpcConfig: { fetch: () => { throw new Error('Offline fixture missing') } } })
  const { registry, book } = engine
  engine.publish = (rows, volumes) => book.ingest(book.ownKey, rows.filter(r => validRow(r, now)), true, volumes)
  const tokens = new Map(engine.patches.current.tokens.tokens.map(t => [t.id, t]))
  const quotes = new Map(), reports = [], dex = new Map()
  for (const file of manifest.dex ?? []) {
    for (const p of read(file)) {
      const raw = p.baseToken?.address
      if (typeof raw !== 'string' || !(Number(p.priceUsd) > 0)) continue
      const id = p.chainId + ':' + (/^0x[0-9a-f]{40}$/i.test(raw) ? raw.toLowerCase() : raw)
      if (!dex.has(id)) dex.set(id, [])
      dex.get(id).push({ value: Number(p.priceUsd), weight: Math.max(1, Number(p.liquidity?.usd) || 0) })
    }
  }
  const reference = store.writer.prepare("INSERT OR REPLACE INTO engine_references VALUES (?,'dexscreener',?,?)")
  const recordPrices = () => {
    for (const [id, pools] of dex) if (registry.assets.has(id)) reference.run(id, weightedMedian(pools), now)
  }
  recordPrices()

  for (const v of manifest.venues) {
    const venue = registry.venues.get(v.venue)
    engine.http.get = async url => {
      if (venue.format.catalog?.url === url && v.pairs) return read(v.pairs)
      if (url === venue.ticker.url) return read(v.tickers)
      throw new Error('Unexpected ticker URL ' + url)
    }
    await engine.scheduler.jobs.get('cex:' + venue.id).run()
    const live = venueQuotes(venue, registry, now)
    // Count each live base once even when an exchange has several quote markets for it.
    const active = [...live.keys()].filter(label => live.get(label).some(t => t.market.split(':')[2].split('-')[0] === label))
    const unresolved = active.filter(label => registry.resolveDefault(venue, label)?.startsWith('unresolved:'))
    reports.push({ venue: venue.id, liveBases: active.length, unresolved, eligible: 0, initiallyBound: 0 })
    quotes.set(venue.id, live)
  }
  book.refresh()
  for (const [i, v] of manifest.venues.entries()) {
    const venue = registry.venues.get(v.venue), r = reports[i]
    engine.http.getPublic = async url => {
      assert.equal(url, venue.contracts.url())
      return read(v.directory)
    }
    await engine.scheduler.jobs.get('cex:' + v.venue + ':contracts').run()
    for (const label of r.unresolved) {
      const id = chooseContract(venue.contracts.directory.get(label), tokens, registry.assets, new Map())
      if (id) r.eligible++
      if (venue.contracts.bindings.get(label)) r.initiallyBound++
    }
  }
  const pending = new Set(manifest.venues.flatMap(v => [...registry.venues.get(v.venue).contracts.pending]))
  for (const file of manifest.rpc ?? []) {
    const { request, result, ids } = read(file), chain = registry.chains.get(ids[0].split(':')[0])
    engine.rpc.publicOnly = { call(c, method, params) {
      assert.equal(c, chain.id)
      assert.deepEqual({ method, params }, request)
      return result
    } }
    await registerVenueTokens(engine, chain, ids, id => pending.has(id))
  }
  // Captured address-specific prices can now reference the newly verified assets.
  recordPrices()
  book.dirty = true
  book.refresh()
  for (const r of reports) registry.venues.get(r.venue).contracts.sync()

  const prices = []
  for (const [venueId, live] of quotes) {
    const venue = registry.venues.get(venueId)
    for (const [label, ticks] of live) {
      const id = chooseContract(venue.contracts.directory.get(label), tokens, registry.assets, new Map())
      if (!id) continue
      const tick = ticks.filter(t => {
        const [base, quote] = t.market.split(':')[2].split('-')
        return base === label && ['USD','USDC','USDT'].includes(quote)
      }).sort((a, b) => venue.lastTickers.get(b.market).volume - venue.lastTickers.get(a.market).volume)[0]
      if (tick) prices.push({ venue: venueId, label, asset: id, price: tick.price })
    }
  }
  const sample = (manifest.sample ?? []).map(s => {
    const venue = registry.venues.get(s.venue), id = registry.resolve(venue, s.label)
    const own = prices.find(p => p.venue === s.venue && p.label === s.label && p.asset === s.asset)
    const others = prices.filter(p => p.venue !== s.venue && p.asset === s.asset)
    return { ...s, bound: id === s.asset, symbol: registry.assets.get(s.asset)?.symbol ?? null,
      price: own?.price ?? null, dex: weightedMedian(dex.get(s.asset) ?? []), others }
  })
  console.log(JSON.stringify({ at: now, digest: engine.patches.digest(), reports: reports.map(r => ({
    venue: r.venue, liveBases: r.liveBases, unresolved: r.unresolved.length, eligible: r.eligible,
    initiallyBound: r.initiallyBound, bound: r.unresolved.filter(label => {
      const venue = registry.venues.get(r.venue)
      return venue.contracts.bindings.get(label) && !registry.resolve(venue, label).startsWith('unresolved:')
    }).length,
  })), sample }, null, 2))
} finally { store.close() }
