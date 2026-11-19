import { RateLimited } from '../../scheduler/index.js'
import { currencyContracts, directoryFor } from './catalog.js'
import { checkPrice, chooseContract, dexEvidence, venueQuotes } from './evidence.js'
import { registerVenueTokens } from './tokens.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Local evidence for one spot venue. Only the names of labels this reader took ownership of survive restart.
 * Old associations stay quarantined until both a fresh directory and an independent live ticker are available. */
class VenueContracts {
  constructor(engine, venue, evidence, tokens) {
    Object.assign(this, { engine, venue, evidence, tokens })
    this.key = 'engine-cex-contracts/' + venue.id
    this.bindings = new Map((engine.store.getSetting(this.key) ?? []).map(label => [label, null]))
    this.directory = new Map()
    this.readAt = -Infinity
    this.invalidated = new Set()
    this.resumed = new Set()
    this.pending = new Set()
    this.retry = new Map()
    this.partial = new Map()
    this.rotation = new Map()
    this.logged = new Set()
    this.marketRows = engine.store.writer.prepare("SELECT id FROM markets WHERE exchange=? AND kind='cex'")
    this.spec = directoryFor(venue)
    venue.contracts = this
    if (this.bindings.size) engine.store.transaction(() => this.rebind(new Set(this.bindings.keys())))
  }

  url() { return new URL(this.spec.path, this.venue.ticker.url).href }

  rebind(changed) {
    const { registry, book } = this.engine
    for (const { id } of this.marketRows.all(this.venue.id)) {
      const [base, quote] = id.split(':')[2].split('-')
      if (!changed.has(base) && !changed.has(quote)) continue
      const market = registry.markets.get(id)
      registry.cex(this.venue.id, base, quote, market.symbol)
    }
    book.dirty = true
  }

  expire() {
    if (!this.directory.size || this.engine.clock() - this.readAt <= DAY + HOUR) return
    this.directory.clear()
    this.sync()
  }

  async refresh() {
    this.expire()
    const { clock, registry, http } = this.engine, url = this.url()
    // Preserve a relist seen during the fetch, even when the clock hasn't advanced by a millisecond.
    const during = this.duringRead = new Set()
    try {
      const json = await http.getPublic(url, this.venue.rpm, this.spec.cost ?? 1, this.spec.body)
      if (this.url() !== url || this.engine.abort?.signal.aborted) return
      this.directory = currencyContracts(this.venue, json, registry.chains)
      this.source = url
      this.readAt = clock()
      this.invalidated = during
      this.logged.clear()
      this.retry.clear()
      this.partial.clear()
      this.sync()
    } finally {
      this.duringRead = null
    }
  }

  refused(label, asset, reason) {
    if (this.logged.has(label) || this.logged.size >= 32) return
    this.logged.add(label)
    const { store, clock } = this.engine
    const key = 'engine-cex-contract-refusals/' + this.venue.id
    const records = (store.getSetting(key) ?? []).slice(-31)
    records.push({ at: clock(), label, asset, reason })
    store.setSetting(key, records)
    this.engine.emit('sourceError', { message: this.venue.id + ' ' + label + ' contract binding withheld: ' + reason })
  }

  sync() {
    const { engine, venue } = this, { registry, clock, book } = engine
    if (!this.directory.size && !this.bindings.size && !this.duringRead) {
      this.resumed.clear()
      return
    }
    const now = clock(), current = now - this.readAt <= DAY + HOUR && this.source === this.url()
    const next = new Map(), pending = new Set()
    for (const label of this.bindings.keys()) next.set(label, null)
    const quotes = venueQuotes(venue, registry, now)
    // A resumed pair does not invalidate a currency still trading on another live pair (e.g. the quote USDT).
    if (this.resumed.size) {
      for (const [label, ticks] of quotes) if (ticks.every(tick => this.resumed.has(tick.market))) {
        this.invalidated.add(label)
        this.duringRead?.add(label)
      }
      this.resumed.clear()
    }
    if (current) {
      const { depths, prices } = this.evidence()
      for (const [label, ticks] of quotes) {
        const ids = this.directory.get(label)
        if (ids === undefined || this.invalidated.has(label)) continue
        const fallback = registry.resolveDefault(venue, label)
        if (!registry.canBindContract(venue, label, fallback)) continue
        if (ids === null) {
          if (!fallback.startsWith('unresolved:')) next.set(label, null)
          continue
        }
        if (!ids.length) continue
        if (ids.includes(fallback) && !next.has(label)) continue
        const asset = chooseContract(ids, this.tokens, registry.assets, depths)
        if (!asset) {
          if (!fallback.startsWith('unresolved:') && !ids.includes(fallback)) next.set(label, null)
          continue
        }
        // When a previously unique seed ticker collides, withhold the old identity while inspecting its replacement.
        if (!fallback.startsWith('unresolved:')) next.set(label, null)
        const sanity = checkPrice(prices.get(asset), ticks, book, now)
        if (sanity !== 'ok') {
          if (sanity !== 'no comparable quote') this.refused(label, asset, sanity)
          continue
        }
        if (!registry.assets.has(asset)) {
          if (!(this.retry.get(asset) > now)) pending.add(asset)
          continue
        }
        if (registry.assets.get(asset).kind === 'nft') continue
        if (asset === fallback) next.delete(label)
        else next.set(label, asset)
      }
    }
    this.pending = pending
    const changed = new Set(), old = this.bindings
    for (const [label, asset] of next) if (old.get(label) !== asset) changed.add(label)
    for (const label of old.keys()) if (!next.has(label)) changed.add(label)
    if (!changed.size) return
    engine.store.transaction(() => {
      this.bindings = next
      if ([...changed].some(label => old.has(label) !== next.has(label)))
        engine.store.setSetting(this.key, [...next.keys()])
      this.rebind(changed)
    })
  }

  async verify() {
    const { engine } = this, now = engine.clock()
    this.expire()
    const first = this.pending.values().next().value
    if (!first) return
    const chain = engine.registry.chains.get(first.split(':')[0])
    const limit = chain.family === 'solana' || (chain.family === 'evm' && chain.multicall) ? 16 : 1
    const ids = []
    for (const id of this.pending) {
      if (id.startsWith(chain.id + ':')) ids.push(id)
      if (ids.length === limit) break
    }
    const directory = this.directory
    const reads = this.partial.get(first) ?? {}
    try {
      await registerVenueTokens(engine, chain, ids, id => !engine.abort?.signal.aborted &&
        this.directory === directory && this.pending.has(id) && engine.clock() - this.readAt <= DAY + HOUR, reads, this.rotation)
      this.partial.delete(first)
      for (const id of ids) if (!engine.registry.assets.has(id)) this.retry.set(id, now + DAY)
    } catch (error) {
      // Move a busy or failed chain behind the others. A failed RPC does not settle token identity.
      if (error instanceof RateLimited && directory === this.directory && chain.family === 'tron') this.partial.set(first, reads)
      else this.partial.delete(first)
      const after = error instanceof RateLimited ? Math.min(now + HOUR, error.retryAt) : now + 15 * 60_000
      for (const id of ids) this.retry.set(id, after)
      throw error
    } finally {
      if (!engine.abort?.signal.aborted) this.sync()
    }
  }
}

export function registerVenueContracts(engine) {
  const tokens = new Map(engine.patches.current.tokens.tokens.map(t => [t.id, t]))
  let snapshot, expires = -Infinity, data
  const evidence = () => {
    if (snapshot !== engine.book.snapshots || engine.clock() >= expires) {
      data = dexEvidence(engine)
      snapshot = engine.book.snapshots
      expires = engine.clock() + 60_000
    }
    return data
  }
  for (const venue of engine.catalog.exchanges) {
    if (!directoryFor(venue)) continue
    const reader = new VenueContracts(engine, venue, evidence, tokens)
    engine.registerJob({ id: 'cex:' + venue.id + ':contracts', relevance: 0.15, interval: DAY,
      run: () => reader.refresh() })
    engine.registerJob({ id: 'cex:' + venue.id + ':verify-contracts', relevance: 0.1, interval: 15_000,
      ready: () => reader.pending.size > 0, run: () => reader.verify() })
  }
}
