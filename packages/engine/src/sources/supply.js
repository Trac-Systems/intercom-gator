import { decimal } from '../obs/index.js'
import { RateLimited } from '../scheduler/index.js'
import { formatUrl } from './http.js'
import { nativeReader } from './supply-native.js'
import { units } from './supply-emission.js'
import { momentum, momentumTotal, priorityDeployments, quant, reserveAccounts, tokenSupply } from './supply-token.js'
import { ethereumSupply, growthepieChain, stablecoinRows, tableEligible, tableTokens, DAY } from './supply-api.js'
import { SupplyClaims } from './supply-claims.js'
import { ISSUERS, tetherRows, circleRows, issuerSiblings } from './supply-issuer.js'
import { NATIVE_FEEDS, tapMintedTotal } from './supply-feeds.js'
import { COIN_FEEDS } from './supply-coin-feeds.js'
import { HYPEREVM_FULL_SUPPLY } from './supply-hyperliquid.js'
import { CIRCULATION_FEEDS, readCirculation } from './supply-circulation.js'
import { supplyValidity, expires } from './supply-validity.js'
import { isReported, registerReported } from './supply-reported.js'

const HOUR = 3_600_000
// A due top-100 supply read outranks market polling. Reads are cheap and bounded by cadence and backoff.
const URGENT = 1e6
const localReporter = 'local-supply'
const top = asset => asset?.rank > 0 && asset.rank <= 100
const cadence = asset => top(asset) ? HOUR : DAY
const issuerReaders = { 'tether-transparency': tetherRows, 'circle-stablecoins': circleRows }
const kindFor = quantity => quantity === 'circulating' ? 'supply' : 'supply-total'

/** Register background supply readers and return the display and diagnostic accessors. */
export function registerSupplyJobs(engine) {
  const { store, http, rpc, book, registry, clock, scheduler } = engine
  const local = new Map(), native = new Set(), unavailable = new Set()
  // Top-100 assets are read once after every start, then hourly.
  const started = new Set()
  const batches = new Map(), tokenRetry = new Map()
  const enabled = id => !scheduler.backgroundJobs || scheduler.backgroundJobs.has(id)
  const read = store.reader.prepare('SELECT asset,kind,value,proof,at FROM claims WHERE reporter=?')
  for (const row of read.all(localReporter)) {
    const records = local.get(row.asset) ?? {}
    records[row.kind === 'supply' ? 'circulating' : 'total'] = { ...JSON.parse(row.proof), value: row.value, checkedAt: row.at }
    local.set(row.asset, records)
  }

  const validity = supplyValidity(engine, local)
  const claims = new SupplyClaims(engine, id => {
    if (isReported(local.get(id)?.circulating) &&
        claims.consensus(id, local.get(id)?.total?.value ?? decimal(registry.assets.get(id)?.totalSupply)))
      validity.invalidate(id, isReported)
  })
  for (const id of [quant, ...reserveAccounts.keys()]) validity.invalidate(id, row => row.method === 'total-minus-burn')
  function save(id, result, share = true) {
    const checkedAt = clock(), { method, source, at = checkedAt, estimate = false, block, epoch, burnSlot, reserveSlot } = result
    const proof = { method, source, at, estimate, ...(block !== undefined && { block }), ...(epoch !== undefined && { epoch }),
      ...(burnSlot !== undefined && { burnSlot }), ...(reserveSlot !== undefined && { reserveSlot }),
      ...(result.expiresAt && { expiresAt: result.expiresAt }) }
    if (result.value !== undefined && !(expires(proof) > checkedAt)) throw new Error('Expired circulating supply')
    const previous = local.get(id) ?? {}, records = { ...previous }, changed = []
    const values = {}
    for (const [quantity, raw] of [['circulating', result.value], ['total', result.total]]) {
      if (raw === undefined) continue
      const value = decimal(raw)
      if (value === null) throw new Error('Invalid supply quantity')
      const old = records[quantity]
      if (old?.source === source && (old.at > at || block < old.block)) {
        // A lagging replica counts as a refresh attempt. Keep the newer measurement and its origin.
        records[quantity] = { ...old, checkedAt }
        continue
      }
      values[quantity === 'total' ? 'totalSupply' : 'circulatingSupply'] = Number(value)
      records[quantity] = { value, ...proof, checkedAt }
      if (old?.value !== value || old.at !== at || old.source !== source) changed.push(quantity)
    }
    store.transaction(() => {
      for (const quantity of ['circulating', 'total']) {
        if (records[quantity] === previous[quantity]) continue
        const { value, checkedAt: receipt, ...evidence } = records[quantity]
        store.upsertClaim({ asset: id, kind: kindFor(quantity), value, reporter: localReporter, at: receipt, proof: evidence })
      }
      if (Object.keys(values).length) engine.setSupply(id, values)
    })
    local.set(id, records)
    validity.watch(records.circulating)
    if (!isReported(result)) {
      started.add(id)
      if (records.circulating && !isReported(records.circulating)) unavailable.delete(id)
    }
    // For a source giving both quantities, send the circulating claim. A total-only claim is explicitly typed.
    const quantity = result.value === undefined ? 'total' : 'circulating'
    if (share && changed.includes(quantity)) claims.send(id, records[quantity], quantity)
  }

  let retryJoin = 0
  async function listen() {
    if (claims.attached || clock() < retryJoin) return
    try {
      await claims.listen()
    } catch (error) {
      if (engine.abort?.signal.aborted) throw error
      retryJoin = clock() + 60_000
      engine.emit('sourceError', { message: 'Supply channel unavailable' })
    }
  }
  /** `urgent()` lifts a ready job above market polling while it has due top-100 work. */
  function add(job, urgent) {
    const base = job.relevance ?? 1
    let stored
    engine.registerJob({ ...job,
      ready: () => {
        validity.expire()
        const ready = job.ready ? job.ready() : true
        if (ready !== false && stored) stored.relevance = urgent?.() ? URGENT : base
        return ready
      },
      run: async () => {
        await listen()
        return job.run()
      } })
    stored = engine.scheduler?.jobs?.get(job.id)
  }
  const due = (id, last) => !last || clock() >= last.checkedAt + cadence(registry.assets.get(id)) ||
    (top(registry.assets.get(id)) && !started.has(id))
  const needsMeasured = asset => asset && (asset.supply == null || isReported(local.get(asset.id)?.circulating))
  const liveGap = id => needsMeasured(registry.assets.get(id)) && book.snapshots.get(id)?.visibility === 'live'
  engine.registerJob({ id: 'supply:listen', ready: () => !claims.attached && clock() >= retryJoin, run: listen })

  const api = id => engine.bundle.apis.find(a => a.id === id)
  const terms = source => source.terms?.redistribution === 'allowed'
  const eth = api('ethereum-supply'), stable = api('growthepie-stablecoins')
  const spec = source => engine.catalog.apis.find(s => s.id === source.id)
  const specific = new Map()
  const prefer = (id, source) => {
    specific.set(id, source)
    // An earlier version may have valued a pre-mint or locked balance as circulating.
    validity.invalidate(id, row => row.method === 'total-minus-burn')
  }
  // These pre-mints and bridge escrows still exist if the operator disables the adjusted source.
  for (const id of tableTokens) prefer(id, 'growthepie-stablecoins')
  // USDT0 is backed by USDT locked on Ethereum. The group counts the issuer's Ethereum
  // figure including that backing and gives the destination zero additional supply.
  const grossIssuer = ISSUERS['tether-transparency'].deployments.eth
  const lockedBacking = engine.bundle.tokens.tokens.some(t => t.coin === 'tether-usdt' && t.coinSupply === 'escrow-backed')
  if (lockedBacking) {
    prefer(grossIssuer, 'tether-transparency')
    validity.invalidate(grossIssuer, row => row.source !== 'tether-transparency')
  }
  for (const id of Object.values(ISSUERS['circle-eurc'].deployments)) prefer(id, 'circle-stablecoins')
  function nativeJob(id, jobId, reader, share, relevance) {
    if (enabled(jobId)) native.add(id)
    add({ id: jobId, interval: 1000, relevance,
      ready: () => (id === 'cosmos:native' && !local.get(id)?.circulating) || due(id, local.get(id)?.total),
      run: async () => {
        try {
          const result = await reader()
          save(id, result, share)
          if (result.value === undefined) unavailable.add(id)
        } catch (error) {
          if (!(error instanceof RateLimited) && !engine.abort?.signal.aborted) {
            unavailable.add(id)
            validity.invalidate(id, row => row.source === local.get(id)?.total?.source && row.source !== specific.get(id))
          }
          throw error
        }
      },
    }, () => top(registry.assets.get(id)) || (id === 'cosmos:native' && liveGap(id)))
  }
  for (const chain of engine.bundle.chains) {
    const id = chain.id + ':native', jobId = 'supply:' + chain.id
    let reader = nativeReader(chain, http, rpc, clock), share = true
    if (chain.id === 'ethereum' && eth) {
      const { url, rpm } = spec(eth)
      reader = async () => ethereumSupply(await http.get(url, rpm), clock())
      share = terms(eth)
    }
    if (!reader || !registry.assets.has(id)) continue
    nativeJob(id, jobId, reader, share, chain.id === 'bitcoin' ? 6 : 2)
  }
  const suiRpc = engine.bundle.chains.find(c => c.id === 'sui')?.endpoints.find(e => e.protocol === 'sui-graphql')
  if (suiRpc && registry.assets.has(momentum))
    nativeJob(momentum, 'supply:mmt-total', () => momentumTotal(suiRpc, http, clock), false, 1)
  // The issuer vests EVAA on two networks. The jetton master establishes only TON's minted total.
  const evaa = 'ton:EQBKMfjX_a_dsOLm-juxyVZytFP7_KKnzGv6J01kGc72gVBp', tonApi = api('evaa-jetton')
  if (tonApi && registry.assets.has(evaa)) {
    const { url, rpm } = spec(tonApi)
    nativeJob(evaa, 'supply:evaa-total', async () => {
      const r = await http.get(url, rpm)
      if (r?.metadata?.address !== '0:4a31f8d7fdafddb0e2e6fa3bb1c95672b453fbfca2a7cc6bfa274d6419cef681' ||
          r.metadata.decimals !== '9' || !r.interfaces?.includes('jetton_master') ||
          !/^\d{1,17}$/.test(r.total_supply) || BigInt(r.total_supply) > 50_000_000_000_000_000n)
        throw new Error('Invalid EVAA jetton supply')
      return { total: units(BigInt(r.total_supply), 9), method: 'ton-jetton-total', source: tonApi.id }
    }, terms(tonApi), 2)
  }
  // TAP Protocol's minted total takes two TAP reader calls (deployment max, mint allowance left).
  const tapDeployment = api('tap-reader-deployment'), tapMintLeft = api('tap-reader-mint-left')
  if (tapDeployment && tapMintLeft && registry.assets.has('tap-protocol:native')) {
    let pending = null
    nativeJob('tap-protocol:native', 'supply:tap-protocol', async () => {
      const deployment = spec(tapDeployment), left = spec(tapMintLeft)
      // Resume the second read after a shared-host budget deferral; the deployment record itself never changes.
      if (!pending || clock() - pending.at > 60_000)
        pending = { data: await http.get(deployment.url, deployment.rpm), at: clock() }
      const result = tapMintedTotal(pending.data, await http.get(left.url, left.rpm), clock())
      pending = null
      return result
    }, terms(tapDeployment) && terms(tapMintLeft), 2)
  }
  // Official keyless feeds for native coins whose chain has no bundled reader. Untested terms stay local.
  for (const feed of NATIVE_FEEDS) {
    const source = api(feed.api), jobId = 'supply:' + feed.asset.slice(0, feed.asset.indexOf(':'))
    if (!source || !registry.assets.has(feed.asset) || engine.scheduler?.jobs?.has(jobId)) continue
    const { url, rpm } = spec(source)
    nativeJob(feed.asset, jobId, async () => feed.read(await http.get(url, rpm, 1, feed.body), clock()), terms(source), 2)
  }

  // A ledger total and an issuer's unlocked float can coexist for the same native asset.
  for (const feed of [...CIRCULATION_FEEDS, ...COIN_FEEDS]) {
    const id = feed.asset, jobId = 'supply:circulating:' + feed.api
    prefer(id, feed.api)
    if (!api(feed.api) || (feed.supplement && !api(feed.supplement)) || !enabled(jobId)) continue
    let refreshed = false
    let pending
    add({ id: jobId, interval: 1000, relevance: 2,
      ready: () => {
        const asset = registry.assets.get(id), row = local.get(id)?.circulating
        return !!asset && !!api(feed.api) && (!row || isReported(row) || clock() >= row.checkedAt + cadence(asset) || (top(asset) && !refreshed))
      },
      run: async () => {
        try {
          const source = api(feed.api), specNow = source && spec(source)
          if (!specNow) throw new Error('Circulation source removed')
          const url = formatUrl(specNow.url, { address: registry.assets.get(id).address })
          let payload
          if (feed.supplement) {
            // Resume the second read after a shared-host budget deferral. Bound the skew between snapshots.
            if (!pending || clock() - pending.at > 60_000)
              pending = { data: await http.get(url, specNow.rpm, 1, feed.body), at: clock() }
            const other = spec(api(feed.supplement))
            payload = { primary: pending.data, supplement: await http.get(other.url, other.rpm) }
            pending = null
          } else payload = await http.get(url, specNow.rpm, 1, feed.body)
          save(id, readCirculation(feed, payload, clock()), terms(source) && (!feed.supplement || terms(api(feed.supplement))))
          refreshed = true
        } catch (error) {
          if (!(error instanceof RateLimited) && !engine.abort?.signal.aborted) {
            pending = null
            validity.invalidate(id, row => row.source === feed.api)
          }
          throw error
        }
      },
    }, () => top(registry.assets.get(id)) || liveGap(id))
  }

  // Each cross-chain table is fetched once per chain, regardless of how many deployments it covers.
  if (stable && terms(stable)) {
    const table = spec(stable)
    for (const chain of engine.catalog.chains) {
      const origin = growthepieChain(chain.id)
      const assets = engine.catalog.assets.filter(a => a.chain === chain.id && tableEligible(a))
      if (!origin || !assets.length) continue
      const jobId = 'supply:stablecoins:' + chain.id, key = 'engine-' + jobId
      const batch = { checkedAt: store.getSetting(key) ?? 0, attempted: false }
      if (enabled(jobId)) batches.set(chain.id, batch)
      const clearMissing = rows => {
        for (const [id, record] of local) {
          if (record.circulating?.source === stable.id && id.startsWith(chain.id + ':') && !rows?.has(id))
            validity.invalidate(id, () => true)
        }
      }
      const ranked = () => assets.some(a => top(registry.assets.get(a.id)))
      add({ id: jobId, relevance: chain.id === 'ethereum' ? 5 : 2, interval: 1000,
        ready: () => !batch.checkedAt || clock() >= batch.checkedAt + (ranked() ? HOUR : DAY) ||
          (ranked() && !batch.attempted),
        run: async () => {
          try {
            const data = await http.get(formatUrl(table.url, { chain: origin }), table.rpm)
            const rows = stablecoinRows(data, chain.id, registry.assets, clock())
            for (const [id, result] of rows) {
              if (!(lockedBacking && id === grossIssuer)) save(id, result)
            }
            clearMissing(rows)
            batch.checkedAt = clock()
            store.setSetting(key, batch.checkedAt)
            batch.attempted = true
          } catch (error) {
            if (!(error instanceof RateLimited) && !engine.abort?.signal.aborted) {
              batch.attempted = true
              clearMissing()
            }
            throw error
          }
        },
      }, () => ranked() || assets.some(a => tableTokens.has(a.id) && liveGap(a.id)))
    }
  }

  // One issuer report covers every pinned deployment. Bridge-adjusted growthepie rows take precedence.
  const issuerGroups = Map.groupBy(Object.entries(ISSUERS), ([id, group]) => group.api ?? id)
  for (const [source, groups] of issuerGroups) {
    const ids = groups.flatMap(([, group]) => Object.values(group.deployments))
    const entry = api(source)
    if (!entry || !ids.some(id => registry.assets.has(id))) continue
    const { url, rpm } = spec(entry), jobId = 'supply:issuer:' + source, key = 'engine-' + jobId
    const batch = { checkedAt: store.getSetting(key) ?? 0, attempted: false }
    const ranked = () => ids.some(id => top(registry.assets.get(id)))
    add({ id: jobId, relevance: 2, interval: 1000,
      ready: () => !batch.checkedAt || clock() >= batch.checkedAt + (ranked() ? HOUR : DAY) ||
        (ranked() && !batch.attempted),
      run: async () => {
        try {
          const now = clock()
          const rows = issuerReaders[source](await http.get(url, rpm), now)
          for (const id of ids) if (!rows.has(id)) validity.invalidate(id, row => row.source === source)
          for (const [id, result] of rows) {
            const row = local.get(id)?.circulating
            if (!registry.assets.has(id) || (stable && row?.source === stable.id && now - row.at <= 4 * DAY)) continue
            save(id, result, terms(entry))
          }
          batch.checkedAt = now
          store.setSetting(key, now)
        } catch (error) {
          if (!(error instanceof RateLimited) && !engine.abort?.signal.aborted)
            for (const id of ids) validity.invalidate(id, row => row.source === source)
          throw error
        } finally {
          batch.attempted = true
        }
      },
    }, () => ranked() || ids.some(liveGap))
  }

  const issuancePeers = new Map()
  const issuerAssets = new Set(Object.values(ISSUERS).flatMap(group => Object.values(group.deployments)))
  for (const members of Map.groupBy(engine.bundle.tokens.tokens.filter(t => t.coin), t => t.coin).values()) {
    const ids = members.map(t => t.id)
    for (const t of members) {
      if (t.coinSupply === 'issuance' && !issuerAssets.has(t.id)) issuancePeers.set(t.id, ids)
    }
  }
  function supportedToken(a) {
    if (!a || a.address === 'native' || a.kind === 'nft') return false
    const price = book.snapshots.get(a.id)
    if (!price || price.why.stale || !(price.price > 0)) {
      if (!issuancePeers.get(a.id)?.some(id => book.snapshots.get(id)?.visibility === 'live')) return false
    }
    const chain = registry.chains.get(a.chain)
    return enabled('supply:tokens') && chain?.endpoints.length > 0 && ['evm', 'solana'].includes(chain.family) &&
      (a.chain !== 'hyperevm' || HYPEREVM_FULL_SUPPLY.has(a.id))
  }
  function tokenDue(a, now) {
    if (!supportedToken(a) || specific.has(a.id)) return false
    const row = local.get(a.id)?.circulating
    if (a.supply != null && (!row || Number(row.value) !== a.supply)) return false
    if (row && (row.source === stable?.id || Object.hasOwn(ISSUERS, row.source)) && now - row.at <= 4 * DAY) return false
    const batch = tableEligible(a) && batches.get(a.chain)
    if (batch && !batch.attempted && !batch.checkedAt) return false
    // An exchange-reported figure does not stop the chain read; its cadence follows the measured total.
    return due(a.id, isReported(row) ? local.get(a.id)?.total : row) && (tokenRetry.get(a.id) ?? 0) <= now
  }
  function tokenClient(id) {
    // A peer-only price or discovery must not trigger reads on a configured private endpoint.
    if (!registry.seedIds.has(id)) return rpc.publicOnly
    const why = book.snapshots.get(id)?.why
    if (!why || why.stale) return rpc.publicOnly
    if (why.referenceProviders?.length) return rpc
    if (why.ownSources) {
      for (const m of book.marketPrices.values()) if (m.base === id && m.ownFresh && !m.fromHint) return rpc
    }
    return rpc.publicOnly
  }

  let attempt, nextScan = 0, candidate = null, scanned = -Infinity
  let topVolume = new Set()
  const gap = asset => needsMeasured(asset) && (priorityDeployments.has(asset.id) || topVolume.has(asset.id))
  const order = a => a.rank ?? Infinity
  // Lowest rank first. One scan per second at most, because readiness is polled every step.
  function scan(now, force = false) {
    if (!force && now - scanned < 1000) return candidate
    scanned = now
    candidate = null
    let routine = null
    topVolume = new Set([...book.snapshots.values()].filter(p => p.visibility === 'live' && p.volume24h > 0)
      .sort((a, b) => b.volume24h - a.volume24h).slice(0, 100).map(p => p.asset))
    for (const id of new Set([...book.snapshots.keys(), ...issuancePeers.keys()])) {
      const a = registry.assets.get(id)
      if (!tokenDue(a, now)) continue
      if (gap(a)) {
        if (!candidate || order(a) < order(candidate)) candidate = a
      } else if (!routine || order(a) < order(routine)) routine = a
    }
    candidate ??= routine
    return candidate
  }
  const current = now => attempt && now - attempt.started <= 5 * 60_000 && tokenDue(attempt.asset, now) ? attempt.asset : null
  add({ id: 'supply:tokens', relevance: 1, interval: 1000,
    ready: () => book.snapshots.size > 0 && clock() >= nextScan,
    run: async () => {
      const now = clock()
      if (!current(now)) {
        attempt = null
        const best = scan(now, true)
        if (!best) { nextScan = now + 30_000; return }
        attempt = { asset: best, started: now, reads: {} }
      }
      const { asset, reads } = attempt, chain = registry.chains.get(asset.chain)
      try {
        const result = await tokenSupply(asset, chain, tokenClient(asset.id), reads)
        // Total minus burn addresses is only an upper bound: an exchange-reported figure inside it stays.
        if (result.method === 'total-minus-burn' && isReported(local.get(asset.id)?.circulating)) delete result.value
        save(asset.id, result)
        tokenRetry.delete(asset.id)
        attempt = null
        scanned = -Infinity
      } catch (error) {
        if (error instanceof RateLimited) throw error
        for (const [id, retry] of tokenRetry) if (retry <= now) tokenRetry.delete(id)
        if (!engine.abort?.signal.aborted)
          validity.invalidate(asset.id, row => row.source === chain.id + '/erc20' ||
            row.source === chain.id + '/spl-token' || row.source === 'ethereum/qnt-crowdsale')
        tokenRetry.set(asset.id, now + 15 * 60_000)
        attempt = null
        scanned = -Infinity
        throw error
      }
    },
  }, () => {
    const now = clock()
    const asset = current(now) ?? scan(now)
    return top(asset) || gap(asset)
  })

  /** Local or corroborated display evidence. Peer hints never enter engine_asset_data or the ranking inputs. */
  function display(id) {
    validity.expire()
    const a = registry.assets.get(id)
    if (!a) return null
    const row = local.get(id)
    function evidence(record, value) {
      if (value == null) return null
      if (record && Number(record.value) === value) return { ...record }
      return { value: decimal(value), method: 'registry', source: 'local-registry', at: null }
    }
    const total = evidence(row?.total, a.totalSupply)
    let circulating = evidence(row?.circulating, a.supply)
    const batch = tableEligible(a) && batches.get(a.chain)
    const awaitingOwn = (native.has(id) && !unavailable.has(id) && !total) ||
      (supportedToken(a) && !tokenRetry.has(id)) || (batch && !batch.attempted && !batch.checkedAt)
    if (!circulating && !awaitingOwn) circulating = claims.consensus(id, total?.value)
    return { circulating, total }
  }
  const reportedStatus = registerReported(engine, { add, local, save, validity, claims })
  // Readers outside this module (Bittensor subnet pools) store measured figures through the same path, locally.
  const record = (id, result) => save(id, result, false)
  return { display, siblings: issuerSiblings, reportedStatus, record }
}
