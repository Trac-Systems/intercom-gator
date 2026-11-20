import { EventEmitter } from 'node:events'
import { adaptBundle, digestPrefix, ROOT_KEY } from './sources/bundle-adapter.js'
import { Registry } from './registry/index.js'
import { RpcClient } from './rpc/index.js'
import { Scheduler, RequestBudget, RateLimited, seededRandom } from './scheduler/index.js'
import { ObservationExchange, PeerQuota, NEW_POLICY, keyPattern } from './obs/index.js'
import { MarketBook } from './aggregate/book.js'
import { Queries } from './aggregate/queries.js'
import { collisionReport } from './aggregate/collisions.js'
import { PoolHints } from './sources/pool-hints.js'
import { CATCHUP_JOB, PoolCatchup, POOL_CHANNEL } from './intel/pool-catchup.js'
import { HttpSources } from './sources/http.js'
import { derivativeJobs } from './sources/derivatives.js'
import { fetchTickers, loadNextSymbol } from './sources/cex.js'
import { registerVenueContracts } from './sources/venue-contracts/index.js'
import { PendingDexQuotes } from './coverage/seed-identity.js'
import { StoredDiscoveries } from './coverage/discoveries.js'
import { FactoryBackfill } from './coverage/backfill.js'
import { DexCoverage } from './coverage/dex.js'
import { registerTron } from './sources/tron/source.js'
import { EvmSource, seedValue } from './sources/evm.js'
import { SolanaCoverage } from './coverage/solana.js'
import { checkSolanaPrice, fetchSolana } from './sources/solana.js'
import { registerNamesJob } from './sources/metadata.js'
import { fetchReferences } from './sources/api.js'
import { registerSupplyJobs } from './sources/supply.js'
import { registerSubnets } from './sources/subtensor.js'
import { registerHistorySeed } from './candles/seed.js'
import { registerNftJobs } from './nfts/index.js'
import { SourceStats, sourcesReport } from './health/sources.js'
import { CandleHistory } from './candles/index.js'
import { migrations as coreMigrations } from './schema.js'
import { BundlePatches, migrations as patchMigrations } from './patches/index.js'
import { applyReleaseExtensions } from '../../bundle/src/extensions.js'
import { settleWithin } from './grace.js'
import { registerLogos } from './logos/index.js'
import { registerFocus } from './focus/index.js'
import { registerAddTokens } from './intel/add-token.js'
import { registerAnnouncedPools } from './intel/announced-pools.js'

export const migrations = [...coreMigrations, ...patchMigrations]
/** Scheduler jobs in flight at once, per machine profile; the request budget still caps the rate. */
export const CONCURRENCY = Object.freeze({ small: 2, normal: 4, large: 8 })
const REFRESH_GAP_MS = 5000
const REFERENCE_PINNED = 8
/** Reference-only chain deployments of top coins (Polygon WBTC: no price of its own until a pool is live) ride along
 * in every llama request, 24 at a time from the best 192 by seed value: each is re-read every ~4 min, inside the
 * reference validity, so the row stops flipping live/stale. Same request, same budget (11-20, WP-evmcov2). */
const REFERENCE_ROTATING = 24
const REFERENCE_TOP = 192
/** A reference stays valid for one full rotation plus the 10 min a provider timestamp may already lag on arrival
 * (at most an hour): with 10 min against a ~23 min rotation, reference-only rows went live/stale periodically. */
export function referenceValidity(rotationMs) {
  return Math.min(3_600_000, Math.max(600_000, rotationMs + 600_000))
}
export { RpcClient, Scheduler, seededRandom }

/** @typedef {{endpoints?: Record<string,Array<string|object>>, requestsPerMinute?: number,
 * timeout?: number, retries?: number, fetch?: typeof globalThis.fetch, bundleDigest?: string,
 * isFollowed?: (publicKey:string)=>boolean, metaFor?: (assetId:string, context:object)=>Promise<void>}} RpcConfig
 * @typedef {{bundle: object, transport: object, store: object, rpcConfig?: RpcConfig,
 * profile?: 'small'|'normal'|'large', backgroundJobs?: string[], clock?: () => number,
 * random?: (() => number)|number, patches?: {rootKey?: string, log?: (line: string) => void, patchFeed?: boolean|string,
 * snapshot?: string|false}, extensions?: object|null, nfts?: boolean, readStaleMs?: number}} Options
 * `extensions` is the release extension (`@gator/bundle` loadReleaseExtensions): read on top of the effective signed
 * bundle, never digested. `patches.snapshot` is the release's shipped feed file, applied once at startup. */
export class Engine extends EventEmitter {
  /** @param {Options} options */
  constructor({
    bundle,
    transport,
    store,
    rpcConfig = {},
    profile = store.profile,
    backgroundJobs,
    clock = Date.now,
    random = Math.random,
    patches = {},
    extensions = null,
    // NFT sale collection stays off until the NFTs tab ships in a later update; it costs RPC requests.
    nfts = false,
    // How old a price-book rebuild a read may use while new observations arrive (the daemon passes a few seconds).
    readStaleMs = 0,
  }) {
    super()
    if (typeof clock !== 'function') clock = clock.now.bind(clock)
    if (!keyPattern.test(transport.publicKey)) throw new TypeError('Expected transport public key')
    Object.assign(this, { bundle, transport, store, profile, clock, rpcConfig, nftsEnabled: nfts, extensions })
    this.patches = new BundlePatches(this, patches)
    this.bundle = this.extend(this.patches.restore())
    this.catalog = adaptBundle(this.bundle)
    this.registry = new Registry(store, this.catalog, this.bundle.tokens.sources)
    this.budget = new RequestBudget(profile, rpcConfig.requestsPerMinute, clock)
    this.localLimit = this.budget.limit
    this.book = new MarketBook({
      store,
      registry: this.registry,
      ownKey: transport.publicKey,
      clock,
      followed: rpcConfig.isFollowed,
      onPrice: (p) => this.emit('price', p),
      onDisagreement: id => {
        const market = this.registry.markets.get(id)
        const job = market.kind === 'cex' ? 'cex:' + market.exchange :
          market.chain === 'tron' ? 'tron:sunswap' :
          this.evm.has(market.chain) ? 'evm:' + market.chain + ':state' : 'sol:' + market.exchange
        this.scheduler.requestSpotCheck(job, id)
      },
    })
    this.book.maxStaleMs = readStaleMs
    this.scheduler = new Scheduler({
      clock,
      backgroundJobs,
      scannerEvery: profile === 'small' ? 4 : 8,
      random: typeof random === 'function' ? random : seededRandom(random),
      coverage: (id, window) => this.book.coverage(id, window),
      scoreTtl: 5000,
    })
    this.sourceStats = new SourceStats(clock)
    this.rpc = new RpcClient({
      ...rpcConfig,
      endpoints: Object.fromEntries(this.catalog.chains.map((c) => [c.id, c.endpoints])),
      aliases: Object.fromEntries(
        this.catalog.chains.filter((c) => c.family === 'evm').map((c) => [c.number, c.id])
      ),
      userEndpoints: rpcConfig.endpoints,
      loadHealth: (id) => store.getEndpointHealth(id),
      clock,
      budget: this.budget,
      recordHealth: (h) => {
        this.sourceStats.record('rpc:' + h.id, h)
        const prev = store.getEndpointHealth(h.id)
        const failures = h.ok ? Math.max(0, (prev?.failures ?? 0) - 1) : Math.min(8, (prev?.failures ?? 0) + 1)
        store.setEndpointHealth({
          id: h.id,
          failures,
          retryAt: h.ok ? 0 : clock() + 250 * 2 ** failures,
          lastSuccess: h.ok ? h.at : (prev?.lastSuccess ?? null),
        })
      },
    })
    this.http = new HttpSources({ ...rpcConfig, clock, budget: this.budget })
    this.http.record = (r) => this.sourceStats.record('http:' + r.origin, r)
    this.history = new CandleHistory({
      store,
      registry: this.registry,
      http: this.http,
      clock,
      scheduler: this.scheduler,
      outliers: (asset) => this.book?.snapshots?.get(asset)?.why?.outliers,
    })
    this.queries = new Queries(this)
    this.dexCoverage = new DexCoverage(this)
    this.pendingDexQuotes = new PendingDexQuotes(this)
    this.storedDiscoveries = new StoredDiscoveries(this)
    this.evm = new Map()
    this.hints = new PoolHints({ preference: id => this.storedDiscoveries.preference(id), book: this.book, clock, evm: this.evm, registry: this.registry,
      rpc: this.rpc.publicOnly, http: this.http, catalog: this.catalog, onConfirmed: pool => this.discovery(pool, true) })
    this.discoveryQuota = new PeerQuota(clock, 60)
    this.onMessage = (channel, env) => this.receive(channel, env)
    this.joined = []
    this.lifecycle = Promise.resolve()
    this.inflight = new Set()
    this.active = false
    this.control(store.getSetting('engine-settings'))
    this.installJobs()
    this.catchup = new PoolCatchup(this)
    this.dexCoverage.installBacklogJob()
    this.backfill = new FactoryBackfill(this)
  }
  installJobs() {
    const { registry, store, clock, http } = this
    const publicHttp = { get: http.getPublic.bind(http) }
    const publish = (rows, localQuoteVolumes) => this.publish(rows, localQuoteVolumes)
    const discover = (discovery) => this.discovery(discovery)
    const save = store.writer.prepare(`INSERT INTO engine_references VALUES (?,?,?,?) ON CONFLICT(asset,provider)
      DO UPDATE SET price=excluded.price,at=excluded.at WHERE excluded.at>=at`)
    const derivative = store.writer.prepare(`INSERT INTO engine_derivatives VALUES (?,?,?,?,?)
      ON CONFLICT(exchange,symbol) DO UPDATE SET funding=coalesce(excluded.funding,funding),
      openInterest=coalesce(excluded.openInterest,openInterest),at=excluded.at`)
    const interest = store.writer.prepare('INSERT OR REPLACE INTO engine_interest_history VALUES (?,?,?,?)')
    this.saveDerivative = (venue, symbol, funding, oi, at) => {
      const num = (n) => (['string', 'number'].includes(typeof n) && n !== '' && Number.isFinite(+n) ? +n : null)
      if (typeof symbol === 'string' && symbol.length <= 80 && (num(funding) != null || num(oi) != null)) {
        store.transaction(() => {
          derivative.run(venue, symbol, num(funding), num(oi), at)
          if (num(oi) != null) interest.run(venue, symbol, at - (at % 3600000), num(oi))
        })
      }
    }
    for (const venue of this.catalog.exchanges) {
      if (!venue.ticker) continue
      const tickers = (client, fromHint = false) => fetchTickers({ venue, registry, http: client, clock, publish,
        discover: data => this.discovery(data, fromHint),
        saveDerivative: this.saveDerivative })
      this.scheduler.add({
        id: 'cex:' + venue.id,
        interval: 15000,
        markets: () => registry.jobsFor((m) => m.exchange === venue.id),
        run: () => tickers(http),
        spotCheck: () => tickers(publicHttp, true),
      })
    }
    for (const venue of this.catalog.exchanges) {
      if (venue.perSymbolCatalog)
        this.scheduler.add({
          id: 'cex:' + venue.id + ':symbols',
          ready: () => !!venue.nextSymbol,
          run: () => loadNextSymbol(venue, http, clock),
        })
      for (const job of derivativeJobs(venue, http, clock, this.saveDerivative)) this.scheduler.add(job)
    }
    for (const chain of this.catalog.chains) {
      if (chain.family !== 'evm' || !chain.deployments.length) continue
      const source = new EvmSource({ chain, store, rpc: this.rpc, registry, clock, publish, discover,
        dex: this.bundle.dex, profile: this.profile, coverage: this.dexCoverage })
      this.evm.set(chain.id, source)
      if (chain.deployments.some((d) => d.kind === 'v4'))
        this.scheduler.add({
          id: 'evm:' + chain.id + ':initialize',
          interval: 15000,
          relevance: 0.5,
          ready: () => !!source.lookup.get(chain.id),
          run: () => source.lookupV4(),
        })
      this.scheduler.add({
        id: 'evm:' + chain.id + ':logs',
        marketChain: chain.id,
        interval: source.limits.period,
        run: () => source.logs(),
      })
      // Price scanners: their own scheduler turn and reserved budget share (DESIGN 5.3), weighted by the chain's
      // signed token count (Polygon 183 -> 8.5, Scroll 1 -> 2) and doubled for the seeder's priority prefix.
      const scanner = run => () => this.budget.scanner(run)
      const weight = 1 + Math.log2(1 + this.catalog.assets.filter(a => a.chain === chain.id).length)
      this.scheduler.add({ id: 'evm:' + chain.id + ':seed', interval: () => source.seedDelay(), lane: 'scanner',
        weight: () => weight * (source.seedHot ? 2 : 1),
        ready: () => source.seedReady(), run: scanner(() => source.seed()) })
      this.scheduler.add({ id: 'evm:' + chain.id + ':trades', marketChain: chain.id, interval: () => source.tradesDelay(),
        lane: 'scanner', weight: () => weight, ready: () => source.hasPools(), run: scanner(() => source.trades()) })
      this.scheduler.add({
        id: 'evm:' + chain.id + ':state',
        marketChain: chain.id,
        lane: 'scanner',
        weight: () => weight,
        interval: 2000,
        ready: () => source.stateReady(),
        run: scanner(() => source.scheduledState()),
        spotCheck: (market, reads) => source.spotCheck(market, this.rpc.publicOnly, reads),
      })
    }
    this.hints.tron = this.tron = registerTron(this)
    const sol = this.catalog.chains.find((c) => c.family === 'solana')
    this.solanaReaders = new Map()
    for (const source of this.catalog.apis) {
      if (sol && ['raydium', 'meteora', 'orca'].includes(source.id)) {
        const reader = new SolanaCoverage(this, { source, registry, http, clock, chain: sol.id, publish, discover })
        const directory = this.catalog.apis.find(api => api.id === 'dexscreener')
        this.solanaReaders.set(source.id, reader)
        this.scheduler.add({
          id: 'sol:' + source.id,
          interval: 30000,
          markets: () => registry.jobsFor((m) => m.exchange === source.id),
          run: () => reader.run(),
          spotCheck: id => {
            if (this.dexCoverage.members().split) return reader.spotCheck(id)
            if (directory) return checkSolanaPrice(directory, http, registry, id, publish, clock)
            return fetchSolana({ ...reader.options, http: publicHttp, fromHint: true,
              discover: data => this.discovery(data, true) })
          },
        })
      } else if (source.id === 'bitcoin-fees') {
        this.scheduler.add({
          id: 'api:' + source.id,
          interval: 60000,
          relevance: 0.2,
          run: async () => {
            const fees = await http.get(source.url, source.rpm)
            if (fees && Number.isFinite(fees.fastestFee) && fees.fastestFee >= 0) {
              store.setSetting('engine-fee/bitcoin', {
                chain: 'Bitcoin',
                at: clock(),
                kind: 'priority',
                value: fees.fastestFee + ' sat/vB',
              })
            }
          },
        })
      } else if (['llama-prices', 'dexscreener'].includes(source.id) || source.id.startsWith('jupiter')) {
        const jupiter = source.id.startsWith('jupiter')
        const assets = this.catalog.assets
          .filter((a) => a.address !== 'native' && (!jupiter || a.chain === sol?.id))
          .sort((a, b) => Number(b.stable) - Number(a.stable))
        let cursor = 0, rotationStart = clock(), rotationMs = 0, lastRun = null, gap = 30000
        const size = source.id === 'dexscreener' ? 1 : 32
        const general = source.id === 'llama-prices'
        const batches = Math.ceil(assets.length / size)
        if (general) this.book.referenceValidity = referenceValidity(batches * gap)
        const reference = async () => {
          if (general) {
            // The validity follows the observed cadence: a busy scheduler stretches the rotation.
            const now = clock()
            if (lastRun != null) gap = 0.75 * gap + 0.25 * Math.max(30000, now - lastRun)
            lastRun = now
            this.book.referenceValidity = referenceValidity(Math.max(batches * gap, rotationMs))
          }
          await fetchReferences({
            source,
            http,
            clock,
            assets: this.referenceBatch(assets, cursor, size, general),
            slot: jupiter && sol ? await this.rpc.call(sol.id, 'getSlot', []) : null,
            slotMs: sol?.blockTime,
            save: (...args) => {
              save.run(...args)
              this.book.dirty = true
            },
          })
          cursor = cursor + size >= assets.length ? 0 : cursor + size
          if (general && cursor === 0) {
            rotationMs = clock() - rotationStart
            rotationStart = clock()
          }
        }
        if (assets.length)
          this.scheduler.add({
            id: (jupiter ? 'sol:' : 'api:') + source.id,
            interval: 30000,
            // The general reference refreshes up to 64 prices per request. As a job without markets it waited behind
            // ~1,000 maintenance jobs for its every-fourth turn: one run in 22 min on a fresh normal node (11-20), so
            // the chains' reference-only USD quotes lapsed. It takes a price-scanner turn when due, and the scanners'
            // budget reserve (a saturated normal node spends 240 of 240 requests a minute).
            ...(general && { lane: 'scanner', weight: () => 24 }),
            run: () => (general ? this.budget.scanner(reference) : reference()),
          })
      }
    }
    this.names = registerNamesJob(this)
    registerVenueContracts(this)
    this.supply = registerSupplyJobs(this)
    this.subnets = registerSubnets(this)
    this.historySeed = registerHistorySeed(this)
    this.logos = registerLogos(this)
    this.focus = registerFocus(this)
    this.addTokens = registerAddTokens(this)
    this.announcedPools = registerAnnouncedPools(this)
    this.nfts = registerNftJobs(this, { enabled: this.nftsEnabled })
    this.scheduler.add({ id: 'discovery:verify', interval: 15_000,
      ready: () => this.hints.size > 0 || (this.dexCoverage.members().split && this.storedDiscoveries.due()),
      run: () => this.verifyHint() })
  }
  /** One rotation slice, plus (for the general price reference) the top assets that have no market of their own:
   * their only price is this reference, and a 20-minute rotation let them go stale and drop out of totals
   * (Tron USDT, $92B, 11-19). */
  referenceBatch(assets, cursor, size, pinReferenceOnly) {
    const batch = assets.slice(cursor, cursor + size)
    if (!pinReferenceOnly) return batch
    const pinned = assets
      .filter((a) => !this.registry.main.get(a.id) && !batch.includes(a))
      .sort((a, b) => (this.registry.assets.get(a.id)?.rank ?? Infinity) - (this.registry.assets.get(b.id)?.rank ?? Infinity))
      .slice(0, REFERENCE_PINNED)
    if (!this.book || !this.registry.catalog) return [...pinned, ...batch]
    // Rotating top reference-only deployments: no own or proven price yet, ranked by own or coin/ticker rank.
    const value = seedValue(this.registry), taken = new Set([...pinned, ...batch])
    const top = assets.filter(a => !taken.has(a) && !(this.book.snapshots.get(a.id)?.why?.provenSources > 0))
      .map(a => ({ a, v: value(this.registry.assets.get(a.id) ?? a) })).filter(x => x.v < Infinity)
      .sort((x, y) => x.v - y.v || (x.a.id < y.a.id ? -1 : 1)).slice(0, REFERENCE_TOP).map(x => x.a)
    const turn = this.referenceTurn = ((this.referenceTurn ?? -1) + 1) % Math.max(1, Math.ceil(top.length / REFERENCE_ROTATING))
    return [...pinned, ...top.slice(turn * REFERENCE_ROTATING, (turn + 1) * REFERENCE_ROTATING), ...batch]
  }
  control(message) {
    if (!message) return
    if (message.targets) this.scheduler.setTargets(message.targets)
    if (Number.isFinite(message.budgets?.[this.profile]))
      this.budget.setLimit(Math.min(this.localLimit, message.budgets[this.profile]))
  }
  receive(channel, env) {
    if (env?.channel !== channel || !keyPattern.test(env.from) || env.message?.v !== 1) return
    const msg = env.message
    if (channel === POOL_CHANNEL) return this.catchup.receive(env)
    if (channel === 'gator/ctl' && msg.t === 'patch') return void this.patches.receive(env)
    if (
      channel === 'gator/ctl' &&
      env.from === ROOT_KEY &&
      msg.t === 'engine' &&
      Number.isSafeInteger(msg.seq) &&
      msg.seq > (this.store.getSetting('engine-settings')?.seq ?? -1) &&
      Buffer.byteLength(JSON.stringify(msg)) <= 65536
    ) {
      const targets = msg.targets
      if (
        targets !== undefined &&
        (!Array.isArray(targets) || targets.length !== 3 || !targets.every(Number.isSafeInteger))
      )
        return
      if (
        msg.budgets !== undefined &&
        (!msg.budgets ||
          typeof msg.budgets !== 'object' ||
          Array.isArray(msg.budgets) ||
          !Object.entries(msg.budgets).every(
            ([key, n]) => ['small', 'normal', 'large'].includes(key) && Number.isSafeInteger(n)
          ))
      )
        return
      this.control(msg)
      this.store.setSetting('engine-settings', {
        seq: msg.seq,
        targets: this.scheduler.targets,
        budgets: { [this.profile]: this.budget.limit },
      })
    }
    if (
      channel !== 'gator/new' ||
      env.from === this.transport.publicKey ||
      this.book.muted(env.from) ||
      Buffer.byteLength(JSON.stringify(msg)) > 8192 ||
      !this.discoveryQuota.take(env.from, 1)
    )
      return
    if (msg.t === 'pool') {
      this.hints.receive(msg, env.from)
      this.backfill?.heard(msg, env.from)
    }
    if (
      msg.t === 'listing' &&
      this.registry.venues.has(msg.exchange) &&
      typeof msg.symbol === 'string' &&
      /^[A-Z0-9._]{1,32}-[A-Z0-9._]{1,32}$/.test(msg.symbol)
    )
      this.emit('listingHint', { exchange: msg.exchange, symbol: msg.symbol })
  }
  async verifyHint() {
    if (!this.hints.size) this.storedDiscoveries.enqueue()
    await this.hints.verifyNext()
    this.pendingDexQuotes.flush()
  }
  discovery(data, fromHint = false, historyReporter) {
    const { pool, chain, dex, kind, token0, token1, block, tx, exchange, symbol, firstSeen } = data
    const msg = pool
      ? { t: 'pool', v: 1, chain, pool, dex, kind, token0, token1, block: block ?? null, tx: tx ?? null }
      : { t: 'listing', v: 1, exchange, symbol, firstSeen }
    if (pool) this.pendingDexQuotes.flush('dex:' + chain + ':' + pool)
    this.emit('discovery', msg, data.firstSeen, fromHint, historyReporter)
    if (historyReporter && chain !== 'tron') return
    const archivedHint = pool && fromHint && this.evm.has(chain) && firstSeen < this.clock() - 7 * 86400_000
    const share = pool ? chain !== 'tron' || !!tx : this.registry.venues.get(exchange)?.publishMarketData
    if (share && !historyReporter && !archivedHint) this.transport.send('gator/new', msg)
    if (pool) for (const address of [token0, token1]) {
      const id = chain + ':' + address
      if (archivedHint) this.names.enqueueFactory(id, true)
      else this.scheduleMeta(id, fromHint)
    }
  }
  /** What this node reads: an effective signed bundle plus the release extension (venue labels, coin groups).
   * The digest, `obs.b` and every patch check use the signed bundle alone. A failing extension is left out. */
  extend(bundle) {
    if (!this.extensions) return bundle
    try {
      return applyReleaseExtensions(bundle, this.extensions).bundle
    } catch {
      this.patches.note('Release extensions could not be applied; using the signed bundle alone')
      return bundle
    }
  }
  start() {
    const result = this.lifecycle.then(() => this.open())
    this.lifecycle = result.catch(() => {})
    return result
  }
  async open() {
    if (this.active) return
    // The signed (release + patch chain) digest; this.bundle may carry the release extension, which is never digested.
    const digest =
      (this.patches.head ?? this.rpcConfig.bundleDigest)?.slice(0, 16) ?? (await digestPrefix(this.patches.release))
    this.abort = new AbortController()
    this.http.signal = this.rpc.signal = this.abort.signal
    this.obs = new ObservationExchange({
      transport: this.transport,
      digest,
      clock: this.clock,
      muted: (k) => this.book.muted(k),
      accepts: (r) => !!this.registry.known(r[0]),
      onUnknown: (key, rows, digest) => this.pendingDexQuotes.remember(key, rows, digest),
      canPublish: ([id]) => {
        const [kind, venue] = id.split(':', 2)
        return kind !== 'cex' || this.registry.venues.get(venue)?.publishMarketData
      },
      ingest: (key, rows, own, localQuoteVolumes) => this.book.ingest(key, rows, own, localQuoteVolumes),
    })
    try {
      await this.obs.start()
      this.transport.on('message', this.onMessage)
      const existing = new Set(this.transport.channels?.() ?? [])
      const wanted = [
        ['gator/new', NEW_POLICY],
        [
          'gator/ctl',
          { ownerKey: this.patches.rootKey, ownerWriteOnly: true, verifySignature: true, maxReceiveBytes: 65536 },
        ],
      ]
      const results = await Promise.allSettled(wanted.map(([channel, policy]) => this.transport.join(channel, policy)))
      wanted.forEach(([channel], i) => {
        if (results[i].status === 'fulfilled' && results[i].value !== false && !existing.has(channel)) this.joined.push(channel)
      })
      const failed = results.findIndex((r) => r.status === 'rejected' || r.value === false)
      if (failed >= 0) throw results[failed].reason ?? new Error('Cannot join ' + wanted[failed][0])
      this.active = true
      if (this.evm.size) this.catchup.join(this.abort.signal)
      this.unregister = this.store.onPrune?.((db, { now }) => {
        for (const table of ['engine_trades', 'engine_derivatives', 'engine_references'])
          db.prepare('DELETE FROM ' + table + ' WHERE at<?').run(now - 86400_000)
        db.prepare('DELETE FROM engine_v4_lookup WHERE lastSeen<?').run(now - 86400_000)
        db.prepare('DELETE FROM engine_interest_history WHERE hour<?').run(now - 2 * 86400_000)
        this.catchup.expire.run(now - 7 * 86400_000)
        this.focus.resize(now)
        this.book.dirty = true
      })
      this.book.refresh()
      this.schedule()
      this.nfts.start()
      this.patches.feed.start()
    } catch (err) {
      await this.close()
      throw err
    }
  }
  /** Start at most one job per tick and keep up to CONCURRENCY[profile] in flight: one job at a time
   * left most of the request budget unused while slow sources (RPC log scans, venue history) waited. */
  schedule() {
    if (!this.active) return
    this.timer = setTimeout(
      () => {
        const slots = CONCURRENCY[this.profile] ?? CONCURRENCY.normal
        if (this.active && this.inflight.size < slots) {
          const dispatches = this.budget.dispatches
          const run = this.scheduler
            .runOne({ allowIdle: this.inflight.size < slots - 1 })
            .then((id) => {
              // Historical identities carry no new price observations.
              if (!id || id === CATCHUP_JOB) return
              this.requestRefresh()
              // A full catalog can have a due maintenance job on every tick. Reuse an
              // unspent turn only after it finishes and another slot is free for prices.
              if (this.active && this.inflight.size < slots && dispatches === this.budget.dispatches)
                return this.catchup.unusedTurn() ?? this.backfill.unusedTurn()
            })
            .catch((err) => {
              if (this.active && !(err instanceof RateLimited))
                this.emit('sourceError', { message: 'Source request failed' })
            })
            .finally(() => this.inflight.delete(run))
          this.inflight.add(run)
        }
        this.schedule()
      },
      Math.max(50, Math.floor(60000 / this.budget.limit))
    )
    this.timer.unref()
  }
  /** Background jobs coalesce book refreshes: a full rebuild after every job took 37% of a node's CPU
   * (profile 11-19) and starved the scheduler. Explicit reads (step, price, why) still refresh at once. */
  requestRefresh() {
    if (this.refreshTimer) return
    const wait = Math.max(0, REFRESH_GAP_MS - (this.clock() - (this.book.refreshed ?? 0)))
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      if (this.active) this.book.refresh()
    }, wait)
    this.refreshTimer.unref?.()
  }
  step() {
    if (!this.active) throw new Error('Engine is stopped')
    if (!this.pending)
      this.pending = this.scheduler
        .runOne()
        .then((id) => {
          this.book.refresh()
          return id
        })
        .finally(() => {
          this.pending = null
        })
    return this.pending
  }
  stop() {
    const result = this.lifecycle.then(() => this.close())
    this.lifecycle = result.catch(() => {})
    return result
  }
  async close() {
    this.active = false
    clearTimeout(this.timer)
    clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    this.nfts?.stop()
    this.abort?.abort()
    // Jobs see the abort signal through rpc/http; a read that ignores it gets a short grace, not the whole shutdown.
    await settleWithin([this.catchup.leave(), this.patches.feed.stop(), this.pending, ...this.inflight])
    this.unregister?.()
    this.transport.off('message', this.onMessage)
    await this.obs?.stop()
    await settleWithin(this.joined.splice(0).map((c) => this.transport.leave(c)))
  }
  publish(rows, localQuoteVolumes) {
    return this.active ? this.obs.publish(rows, localQuoteVolumes) : 0
  }
  registerJob(job) {
    this.scheduler.add(job)
  }
  scheduleMeta(id, fromHint = false) {
    this.names.enqueue(id, fromHint)
    // The optional operator hook is for other enrichment. Names and EVM totals use the durable batch job.
    const jobId = 'meta:' + id
    if (fromHint || !this.rpcConfig.metaFor || !this.registry.assets.has(id) || this.scheduler.jobs.has(jobId)) return
    this.scheduler.add({
      id: jobId,
      markets: () => this.registry.jobsFor(m => m.base === id),
      run: async () => {
        await this.rpcConfig.metaFor(id, { rpc: this.rpc, store: this.store })
        this.book.dirty = true
        this.scheduler.jobs.delete(jobId)
      },
    })
  }
  /** Called only with locally confirmed supply (e.g. an on-chain totalSupply read). */
  setSupply(id, values) {
    this.registry.setSupply(id, values)
    this.book.dirty = true
  }
  global() {
    return this.queries.global()
  }
  markets(options) {
    return this.queries.markets(options)
  }
  asset(id) {
    return this.queries.detail(id)
  }
  assetMarkets(id) {
    return this.queries.assetMarkets(id)
  }
  candles(id, options) {
    return this.history.get(id, options)
  }
  search(query, options) {
    return this.queries.search(query, options)
  }
  /** Gainers/losers with coin groups collapsed, like the markets list. */
  movers(options = {}) {
    return this.queries.marketList({ tab: options.direction ?? 'gainers', ...options }).items
  }
  trending(options) {
    return this.markets({ ...options, tab: 'trending' })
  }
  exchanges() {
    return this.queries.exchanges()
  }
  derivatives() {
    return this.queries.derivatives()
  }
  /** NFT collections from locally measured sales (never in caps or totals). */
  nftCollections(options) {
    return this.nfts.list(options)
  }
  /** Every upstream this node uses, with state and the last hour's counters (Settings → Sources). */
  sources() {
    return this.patches.feed.addToSources(sourcesReport(this))
  }
  network() {
    return this.queries.network()
  }
  trendingInputs(options) {
    return this.trending(options).map(({ id, volume24h, change24h, sources, trending }) => ({
      asset: id,
      volume24h,
      change24h,
      sources,
      score: trending,
    }))
  }
  whyTrusted(id) {
    return this.book.refresh().get(id)?.why ?? null
  }
  /** Ticker-collision diagnostics: assets with venue labels split off as another project, and assets whose
   * remaining markets still disagree by more than 10× (no USD price published). See aggregate/collisions.js. */
  collisions() {
    return collisionReport(this)
  }
}
