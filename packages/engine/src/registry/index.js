import { categoryLabels } from '@gator/bundle'
import { nativeCategoryId } from './native-category.js'
import { symbolPattern } from '../obs/index.js'
import { SPLIT_FACTOR, SPLIT_REVIEW_MS, venueLabel } from '../aggregate/collisions.js'

const EVM = /^0x[0-9a-f]{40}$/i
const SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const POOL_ID = /^0x[0-9a-f]{64}$/
// Wrapped SOL is native SOL one to one; Solana pools quote SOL by this mint.
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112'
// Durable ticker-collision splits live in settings rows: engine-split/<venue>/<label>.
const SPLIT = 'engine-split/'
/**
 * The bundle adapter merges derived defaults (natives, linked multi-chain tokens, stablecoins) into every venue's
 * symbolMap. A venue's own (curated) entries are those that differ from the value most venues share for that label;
 * only they are bundle statements about that venue's ticker and win over a collision split.
 * @returns {Map<string, Set<string>>} venue id → curated labels
 */
export function curatedSymbols(exchanges) {
  const values = new Map()
  for (const e of exchanges)
    for (const [label, id] of Object.entries(e.symbolMap ?? {})) {
      if (!values.has(label)) values.set(label, new Map())
      values.get(label).set(id, (values.get(label).get(id) ?? 0) + 1)
    }
  const curated = new Map()
  for (const e of exchanges)
    for (const [label, id] of Object.entries(e.symbolMap ?? {})) {
      const [shared, count] = [...values.get(label)].sort((a, b) => b[1] - a[1])[0]
      if (id === shared && count > exchanges.length / 2) continue
      if (!curated.has(e.id)) curated.set(e.id, new Set())
      curated.get(e.id).add(label)
    }
  return curated
}
export function assetId(chain, address) {
  return chain + ':' + (EVM.test(address) ? address.toLowerCase() : address)
}

/** Resolve symbols only inside a venue. An ambiguous label cannot create a price relationship. */
export class Registry {
  constructor(store, catalog, categorySources = []) {
    this.store = store
    this.catalog = catalog
    this.assets = new Map()
    this.markets = new Map()
    this.symbols = new Map()
    this.seedIds = new Set(catalog.assets.map((a) => a.id))
    this.fixedRanks = new Map(catalog.assets.filter((a) => a.rank > 0).map((a) => [a.id, a.rank]))
    this.main = new Map()
    this.active = new Map()
    this.pinned = new Set()
    this.venues = new Map(catalog.exchanges.map((e) => [e.id, e]))
    this.curated = curatedSymbols(catalog.exchanges)
    this.chains = new Map(catalog.chains.map((c) => [c.id, c]))
    // RPC-less networks enter the signed catalog specifically for their native CEX identity.
    this.nativeSymbols = new Map(catalog.assets.filter(a => a.address === 'native' &&
      this.chains.get(a.chain)?.family === 'cex-only').map(a => [a.symbol.toUpperCase(), a.id]))
    this.db = store.writer
    this.writeAsset = this.db.prepare(`INSERT INTO engine_asset_data VALUES (?,?,?,?,?)
      ON CONFLICT(asset) DO UPDATE SET decimals=coalesce(excluded.decimals,decimals),
      supply=coalesce(excluded.supply,supply), totalSupply=coalesce(excluded.totalSupply,totalSupply), stable=excluded.stable`)
    this.writeMarket = this.db.prepare(`INSERT INTO engine_market_data(market,symbol,inverse) VALUES (?,?,?)
      ON CONFLICT(market) DO UPDATE SET symbol=coalesce(excluded.symbol,symbol), inverse=excluded.inverse`)
    this.discoveryCategories = new Map(categorySources.flatMap(s =>
      (s.assetCategories ?? []).filter(a => this.chains.has(a.id.split(':', 1)[0]))
        .map(a => [a.id, categoryLabels[a.category]])))
    const hasCategoryIds = catalog.assets.some(t => Object.hasOwn(categoryLabels, t.category))
    this.store.transaction(() => {
      // A classification can annotate a discovered asset but cannot register it as a CEX currency.
      const previous = store.getSetting('engine-discovery-categories') ?? []
      if (previous.length || this.discoveryCategories.size) {
        const revise = this.db.prepare("UPDATE assets SET category=? WHERE id=? AND kind='token' AND category IS NOT ?")
        const withdraw = this.db.prepare("UPDATE assets SET category=NULL WHERE id=? AND kind='token' AND category=?")
        for (const [id, label] of previous) {
          if (!this.discoveryCategories.has(id) && !this.seedIds.has(id)) withdraw.run(id, label)
        }
        for (const [id, label] of this.discoveryCategories) revise.run(label, id, label)
        store.setSetting('engine-discovery-categories', [...this.discoveryCategories])
      }
      for (const token of catalog.assets) {
        const legacy = hasCategoryIds ? null : token.category
        const category = Object.hasOwn(categoryLabels, token.category) ? categoryLabels[token.category]
          : legacy ?? categoryLabels[nativeCategoryId(token.id)] ?? (!hasCategoryIds && token.stable ? 'Stablecoin' : null)
        this.saveAsset({ ...token, category })
      }
    })
    this.marketOrigin = this.db.prepare('UPDATE engine_market_data SET fromHint=? WHERE market=? AND fromHint<>?')
    for (const asset of this.db
      .prepare(
        'SELECT a.*,d.decimals,d.supply,d.totalSupply,d.stable FROM assets a LEFT JOIN engine_asset_data d ON d.asset=a.id'
      )
      .all()) {
      this.indexAsset(asset)
    }
    for (const m of this.db
      .prepare(
        'SELECT m.*,d.symbol,d.inverse,d.fromHint FROM markets m LEFT JOIN engine_market_data d ON d.market=m.id ORDER BY m.id'
      )
      .all()) {
      this.markets.set(m.id, m)
    }
    /** venue:label → { venue, label, asset, price, keptPrice, ratio, at, checkedAt } (see aggregate/collisions.js) */
    this.splits = new Map()
    for (const row of this.db.prepare("SELECT key,value FROM settings WHERE key LIKE 'engine-split/%'").all()) {
      try {
        const split = JSON.parse(row.value)
        if (typeof split?.venue === 'string' && typeof split.label === 'string' && typeof split.asset === 'string')
          this.splits.set(split.venue + ':' + split.label, split)
      } catch {}
    }
    // Restore durable pairs against newly signed identities before replaying their observations.
    // The venue and traded pair are unchanged, so their own price history still belongs to this market.
    this.store.transaction(() => {
      for (const market of this.markets.values()) {
        if (market.kind !== 'cex') continue
        const venue = this.venues.get(market.exchange), pair = market.id.split(':')[2]?.split('-')
        if (!venue || pair?.length !== 2 || !pair.some(s => this.nativeSymbols.has(s))) continue
        const [base, quote] = pair.map((s, i) => this.nativeSymbols.has(s) ? this.resolve(venue, s) :
          i === 0 ? market.base : market.quote)
        if (!base || !quote || (base === market.base && quote === market.quote)) continue
        this.db.prepare('DELETE FROM asset_markets WHERE asset=? AND market=?').run(market.base, market.id)
        const updated = { ...market, base, quote }
        this.store.upsertMarket(updated)
        if (this.assets.has(base)) this.store.linkAssetMarket(base, market.id)
        this.markets.set(market.id, updated)
      }
    })
  }
  saveAsset(asset) {
    this.store.upsertAsset(asset)
    this.writeAsset.run(
      asset.id,
      asset.decimals ?? null,
      asset.supply ?? null,
      asset.totalSupply ?? null,
      asset.stable ? 1 : 0
    )
  }
  indexAsset(asset) {
    this.assets.set(asset.id, asset)
    // An arbitrary newly discovered token cannot claim a CEX currency code.
    if (!this.seedIds.has(asset.id)) return
    const sym = asset.symbol.toUpperCase()
    if (!this.symbols.has(sym)) this.symbols.set(sym, new Set())
    this.symbols.get(sym).add(asset.id)
  }
  token(chain, address, info = {}) {
    if (address === WRAPPED_SOL && this.chains.get(chain)?.family === 'solana') {
      const native = this.assets.get(assetId(chain, 'native'))
      if (native) return native
    }
    return this.registerToken(chain, address, info)
  }
  // A purchase commits to the exact mint, including wrapped SOL. Market routes can still resolve it to native SOL.
  registerToken(chain, address, info = {}) {
    const id = assetId(chain, address)
    const prev = this.assets.get(id)
    if (prev && (prev.decimals != null || info.decimals == null)) return prev
    const label =
      typeof info.symbol === 'string' && /^[^\p{Cc}<>]{1,32}$/u.test(info.symbol) ? info.symbol : address
    const name = typeof info.name === 'string' && /^[^\p{Cc}<>]{1,100}$/u.test(info.name) ? info.name : label
    const decimals =
      Number.isInteger(info.decimals) && info.decimals >= 0 && info.decimals <= 77 ? info.decimals : null
    const token = { symbol: label, name, ...prev, id, chain, address, decimals: decimals ?? prev?.decimals ?? null }
    if (this.discoveryCategories.has(id)) token.category = this.discoveryCategories.get(id)
    this.saveAsset(token)
    this.indexAsset(token)
    return token
  }
  resolve(venue, label) {
    if (
      [
        'USD',
        'EUR',
        'GBP',
        'JPY',
        'KRW',
        'CHF',
        'AUD',
        'CAD',
        'BRL',
        'TRY',
        'IDR',
        'PHP',
        'THB',
        'MXN',
        'ZAR',
        'PLN',
        'SGD',
        'NZD',
      ].includes(label)
    )
      return 'fiat:' + label
    const explicit = venue.symbolMap?.[label]
    if (explicit && this.curated.get(venue.id)?.has(label)) return this.assets.has(explicit) ? explicit : null
    // A label split off as another project on this venue stays unresolved until the daily re-check.
    const native = this.nativeSymbols.get(label)
    const split = this.splits.get(venue.id + ':' + label)
    if (split && !split.reviewing && (!native || split.asset === native)) return 'unresolved:' + venue.id + ':' + label
    if (native) return native
    if (explicit) return this.assets.has(explicit) ? explicit : null
    const ids = this.symbols.get(label)
    return ids?.size === 1 ? [...ids][0] : 'unresolved:' + venue.id + ':' + label
  }
  register(market) {
    const old = this.markets.get(market.id)
    if (old?.base === market.base && old.quote === market.quote && (!market.symbol || old.symbol === market.symbol))
      return old
    if (old && (old.base !== market.base || old.quote !== market.quote)) {
      this.db.prepare('DELETE FROM asset_markets WHERE asset=? AND market=?').run(old.base, market.id)
      this.db.prepare('DELETE FROM engine_latest WHERE market=?').run(market.id)
    }
    this.store.upsertMarket(market)
    if (this.assets.has(market.base)) this.store.linkAssetMarket(market.base, market.id)
    this.writeMarket.run(market.id, market.symbol ?? null, market.inverse ? 1 : 0)
    this.markets.set(market.id, market)
    return market
  }
  cex(venueId, baseLabel, quoteLabel, symbol) {
    const venue = this.venues.get(venueId)
    if (
      !venue ||
      venue.derivativeOnly ||
      !symbolPattern.test(baseLabel) ||
      !symbolPattern.test(quoteLabel) ||
      baseLabel === quoteLabel
    )
      return null
    const base = this.resolve(venue, baseLabel),
      quote = this.resolve(venue, quoteLabel)
    if (!base || !quote || base === quote || base === 'fiat:USD') return null
    return this.register({
      id: 'cex:' + venueId + ':' + baseLabel + '-' + quoteLabel,
      kind: 'cex',
      exchange: venueId,
      base,
      quote,
      symbol,
    })
  }
  /** A CEX market whose venue label the bundle maps explicitly for that venue; a split never detaches it. */
  mapped(market) {
    const label = venueLabel(market)
    return !!(label && this.curated.get(label.venue)?.has(label.label))
  }
  /** Point every market of one venue label at `base`, keeping its observations (the pair itself is unchanged). */
  rebindLabel(key, base) {
    const changed = []
    for (const market of this.markets.values()) {
      if (venueLabel(market)?.key !== key || market.base === base) continue
      const next = { ...market, base }
      this.db.prepare('DELETE FROM asset_markets WHERE asset=? AND market=?').run(market.base, market.id)
      this.store.upsertMarket(next)
      if (this.assets.has(base)) this.store.linkAssetMarket(base, market.id)
      this.markets.set(market.id, next)
      changed.push(market.id)
    }
    return changed
  }
  /**
   * Reference prices read for each asset's address in the last day (median per asset). They anchor collision splits;
   * the 10-minute freshness the USD price needs would let the choice depend on where the reference rotation is.
   */
  referencePrices(now) {
    const prices = new Map()
    this.referenceQuery ??= this.db.prepare('SELECT asset,price FROM engine_references WHERE at>=? AND price>0')
    for (const r of this.referenceQuery.iterate(now - SPLIT_REVIEW_MS))
      prices.set(r.asset, [...(prices.get(r.asset) ?? []), r.price])
    return new Map([...prices].map(([asset, list]) => {
      const sorted = list.sort((a, b) => a - b)
      return [asset, sorted[(sorted.length - 1) >> 1] / 2 + sorted[sorted.length >> 1] / 2]
    }))
  }
  /**
   * Splits checked a day ago or more go back to their asset for one aggregation; applySplits confirms or drops them.
   * A split is reviewed early (at most every 10 minutes) when the asset's reference price sits near the detached price
   * and far from the kept one (a turnover or venue-count choice that the token's own price contradicts).
   */
  reviewSplits(now, references = new Map()) {
    const far = (a, b) => !(Math.abs(Math.log(a / b)) <= Math.log(SPLIT_FACTOR))
    const contradicted = s => {
      const ref = references.get(s.asset)
      return now - s.checkedAt >= 600_000 && ref > 0 && s.price > 0 && s.keptPrice > 0 &&
        !far(s.price, ref) && far(s.keptPrice, ref)
    }
    const due = [...this.splits].filter(([, s]) => !s.reviewing &&
      (!(now - s.checkedAt < SPLIT_REVIEW_MS) || contradicted(s)))
    if (!due.length) return []
    this.store.transaction(() => {
      for (const [key, split] of due) {
        split.reviewing = true
        const base = this.resolve(this.venues.get(split.venue) ?? { id: split.venue }, split.label)
        if (base) this.rebindLabel(key, base)
      }
    })
    return due.map(([key]) => key)
  }
  /**
   * Persist the detachments of one aggregation (collisions from aggregateAssets) and rebind those markets to
   * `unresolved:<venue>:<label>`. Only fresh markets with own/proven evidence, against a supported kept cluster, are
   * detached durably. Reviewed splits that were not seen again are dropped (their markets stay with the asset).
   * `prices` (the book's market prices) get the new base so this refresh's ranking already ignores them.
   */
  applySplits(collisions, prices, now, review = []) {
    const confirmed = new Set()
    const durable = []
    for (const [asset, record] of collisions) {
      if (!record.kept?.supported) continue
      const groups = new Map()
      for (const d of record.detached ?? [])
        if (d.proven && d.current) groups.set(d.key, [...(groups.get(d.key) ?? []), d])
      for (const [key, items] of groups) durable.push({ asset, record, key, items })
    }
    if (!durable.length && !review.length) return confirmed
    this.store.transaction(() => {
      for (const { asset, record, key, items } of durable) {
        const values = items.map(d => d.price).sort((a, b) => a - b)
        const price = values[(values.length - 1) >> 1] / 2 + values[values.length >> 1] / 2
        const { venue, label } = items[0]
        const previous = this.splits.get(key)
        const split = { venue, label, asset, price, keptPrice: record.kept.price, reason: record.kept.reason,
          ratio: record.kept.price > 0 ? price / record.kept.price : null,
          at: previous?.asset === asset ? previous.at : now, checkedAt: now }
        this.store.setSetting(SPLIT + venue + '/' + label, split)
        this.splits.set(key, split)
        confirmed.add(key)
        for (const id of this.rebindLabel(key, 'unresolved:' + key)) {
          const p = prices?.get(id)
          if (p) p.base = 'unresolved:' + key
        }
      }
      for (const key of review) {
        const split = this.splits.get(key)
        if (confirmed.has(key) || !split?.reviewing) continue
        this.db.prepare('DELETE FROM settings WHERE key=?').run(SPLIT + split.venue + '/' + split.label)
        this.splits.delete(key)
      }
    })
    return confirmed
  }
  known(id) {
    if (this.markets.has(id)) return this.markets.get(id)
    const [kind, venue, pair] = id.split(':')
    if (kind !== 'cex' || !pair) return null
    const [base, quote] = pair.split('-')
    const definition = this.venues.get(venue)
    if (
      !definition ||
      [base, quote].some((label) => {
        const id = this.resolve(definition, label)
        return !id || id.startsWith('unresolved:')
      })
    )
      return null
    return this.cex(venue, base, quote)
  }
  pool(discovery, info = {}, fromHint = false) {
    const { chain, pool, token0, token1, dex } = discovery
    const definition = this.chains.get(chain)
    if (!definition || token0 === token1) return null
    const isSol = definition.family === 'solana'
    const validToken = (address) => (isSol ? SOL.test(address) : EVM.test(address) || address === 'native')
    if (
      !validToken(token0) ||
      !validToken(token1) ||
      !(isSol ? SOL.test(pool) : EVM.test(pool) || POOL_ID.test(pool))
    )
      return null
    const id = 'dex:' + chain + ':' + pool
    const first = this.token(chain, token0, info.token0),
      second = this.token(chain, token1, info.token1)
    const score = (t) => (t.stable ? 3 : definition.quotes.includes(t.address) ? 2 : 0)
    const inverse = score(first) > score(second) || (score(first) === score(second) && first.id > second.id)
    const base = inverse ? second.id : first.id,
      quote = inverse ? first.id : second.id
    const existing = this.markets.get(id)
    if (existing && (existing.base !== base || existing.quote !== quote)) return null
    this.store.upsertPool(discovery)
    // A discovery hint may precede local verification. Persist the verified identity in the shared row.
    if (!existing)
      this.store.writer
        .prepare('UPDATE pools SET token0=?,token1=?,dex=?,kind=?,block=?,tx=? WHERE chain=? AND pool=?')
        .run(token0, token1, dex, discovery.kind, discovery.block ?? null, discovery.tx ?? null, chain, pool)
    const market = this.register({ id, base, quote, chain, exchange: dex, kind: 'dex', inverse })
    // Preserve public-only enrichment across restart until an independent scan sees this pool.
    const origin = Number(fromHint && (!existing || existing.fromHint === 1))
    if (Number(market.fromHint ?? 0) !== origin) {
      this.marketOrigin.run(origin, id, origin)
      market.fromHint = origin
    }
    return market
  }
  rankMarkets(snapshots, prices, now) {
    this.pinned = new Set(
      this.db
        .prepare('SELECT asset FROM watchlist UNION SELECT asset FROM portfolio')
        .all()
        .map((r) => r.asset)
    )
    const ranked = [...snapshots.values()].filter(p => p.why.provenSources || p.why.referenceProviders?.length).sort(
      (a, b) =>
        (b.marketCap ?? 0) - (a.marketCap ?? 0) ||
        (b.why.provenVolume24h ?? 0) - (a.why.provenVolume24h ?? 0) || a.asset.localeCompare(b.asset)
    )
    const reserved = new Set(this.fixedRanks.values())
    let rank = 0
    const update = this.store.writer.prepare('UPDATE assets SET rank=? WHERE id=?')
    this.store.transaction(() => {
      const supported = new Set(ranked.map(p => p.asset))
      for (const id of snapshots.keys()) {
        const asset = this.assets.get(id)
        if (asset?.rank != null && !this.fixedRanks.has(id) && !supported.has(id)) {
          update.run(null, asset.id)
          asset.rank = null
        }
      }
      for (const p of ranked) {
        const a = this.assets.get(p.asset)
        if (!a || this.fixedRanks.has(a.id)) continue
        do {
          rank++
        } while (reserved.has(rank))
        if (a.rank !== rank) {
          a.rank = rank
          update.run(rank, a.id)
        }
      }
    })
    this.main.clear()
    this.active.clear()
    for (const p of prices.values()) {
      // An unverified volume (including zero) cannot pick a main market or stop exploration.
      if (!p.provenAgents.length) continue
      // Value base turnover at the market's own price and a supported quote rate, never the asset's price.
      const fx = snapshots.get(p.quote)
      const rate = p.quote === 'fiat:USD' ? 1 : fx?.why.provenSources || fx?.why.referenceProviders?.length ? fx.price : 0
      const volume = p.usdVolume ?? p.baseVolume * p.price * rate
      this.active.set(p.id, (volume > 0 || p.baseVolume > 0) && now - p.at <= 3600000)
      const best = this.main.get(p.base)
      if (!best || volume > best.volume || (volume === best.volume && p.id < best.id))
        this.main.set(p.base, { id: p.id, volume })
    }
  }
  marketRank(market) {
    const rank = this.assets.get(market.base)?.rank
    const main = this.main.get(market.base)
    return main && rank > 0 && rank <= 50 && main.id !== market.id ? 51 : rank
  }
  setSupply(id, { circulatingSupply, totalSupply }) {
    const a = this.assets.get(id)
    if (!a) throw new RangeError('Unknown asset')
    for (const n of [circulatingSupply, totalSupply])
      if (n != null && (!Number.isFinite(n) || n < 0)) throw new RangeError('Invalid supply')
    if (circulatingSupply != null) a.supply = circulatingSupply
    if (totalSupply != null) a.totalSupply = totalSupply
    this.saveAsset(a)
  }
  jobsFor(predicate) {
    const markets = []
    for (const market of this.markets.values())
      if (predicate(market)) {
        const rank = this.marketRank(market)
        const relevance = this.pinned.has(market.base) ? 6 : undefined
        markets.push({
          id: market.id,
          rank,
          relevance,
          active: (rank > 0 && rank <= 500) || this.active.get(market.id) !== false,
        })
      }
    return markets
  }
}
