import { MARKET_POLICY } from '../../../store/src/markets.js'
import { coverageTarget } from '../scheduler/index.js'
import { exchangeRows, trackVenueVolumes } from './venue-trust.js'
import { marketUsdVolume } from './collisions.js'
import { bestState, chainLabel, contractRole, explorerUrl, linkGroups, representativeOrder, rowOrder } from './coins.js'

const DAY = 86400_000
const page = (rows, { limit = 100, offset = 0 } = {}) => rows.slice(offset, offset + limit)
const value = (n) => (n == null ? null : Number(n))
const ALL_ROWS = Number.MAX_SAFE_INTEGER
/** A collapsed row passes its list's figure filters on the coin's own figures (the representative's change). */
const mover = (row) => row.trust !== 'red' && row.volume24h >= MARKET_POLICY.moverMinVolumeUsd
const tabMatches = (tab, row) =>
  tab === 'trending' ? row.trending != null : tab === 'gainers' ? row.change24h > 0 && mover(row)
    : tab === 'losers' ? row.change24h < 0 && mover(row) : true
/** The store's default order for a markets tab. */
export function listOrder({ tab = 'all', sort, order } = {}) {
  sort ??= tab === 'trending' ? 'trending' : ['gainers', 'losers'].includes(tab) ? 'change24h' : 'rank'
  order ??= ['rank', 'symbol', 'name'].includes(sort) || (tab === 'losers' && sort === 'change24h') ? 'asc' : 'desc'
  return { sort, order }
}

/** Filter by local source time before paging. The counter covers the complete matching list. */
export function pageByAge(rows, { include, offset = 0, limit = rows.length }, now, maxAge, timestamp) {
  const items = [], hidden = { stale: 0, unconfirmed: 0, dust: 0 }
  let matches = 0
  for (const row of rows) {
    const at = timestamp(row)
    const stale = at == null || at < now - maxAge
    if (stale) hidden.stale++
    if (stale && include !== 'hidden') continue
    if (matches >= offset && items.length < limit) items.push({ ...row,
      visibility: stale ? 'stale' : 'live', staleSince: stale && at != null ? at + maxAge : null })
    matches++
  }
  return { items, hidden }
}

/** Normalize the contract syntax in the bundle's venue probes, retaining digits in asset labels. */
function derivativeBase(venue, raw) {
  let symbol = raw.toUpperCase()
  const catalogBase = venue?.catalogCache?.get(symbol)?.pair?.[0]
  if (typeof catalogBase === 'string' && catalogBase) return catalogBase.toUpperCase()
  if (venue?.format?.mode === 'fixed-quote') return symbol

  switch (venue?.id) {
    case 'bitfinex': return /^T([A-Z0-9.]+)F0:[A-Z0-9.]+F0$/.exec(symbol)?.[1] ?? null
    case 'bitrue': symbol = symbol.replace(/^E-/, ''); break
    case 'btse': symbol = symbol.replace(/PFC$/, ''); break
    case 'gemini': symbol = symbol.replace(/GUSDPERP$/, ''); break
    case 'kraken': case 'kraken-futures': symbol = symbol.replace(/^(?:PF|PI|FF|FI)_/, ''); break
    case 'kucoin': symbol = symbol.replace(/(USD[TC]?)M$/, '$1'); break
    case 'bitmex': symbol = symbol.replace(/[FGHJKMNQUVXZ]\d{2}$/, ''); break
  }
  symbol = symbol
    .replace(/[-_:/]?(?:\d{8}|\d{6}|\d{1,2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2})$/, '')
    .replace(/[-_:/]?(?:PERPETUAL|PERP|SWAP)$/, '')
    .replace(/(\/[A-Z0-9]+):[A-Z0-9]+$/, '$1')
    .replace(/[-_:/]?(?:USDT|USDC|USD)$|[-_:/](?:BTC|ETH|EUR)$/, '')
    .replace(/[-_:/](?:SWAP|PERP)$/, '')
  return symbol
}

function derivativeAssets(registry, snapshots) {
  const spot = new Map()
  for (const market of registry.markets.values()) {
    if (market.kind !== 'cex' || (market.instrument ?? 'spot') !== 'spot' || !registry.assets.has(market.base)) continue
    // The wire pair preserves the venue's base label even for an explicit symbolMap alias.
    const key = market.id.slice(0, market.id.lastIndexOf('-'))
    if (!spot.has(key)) spot.set(key, market.base)
    else if (spot.get(key) !== market.base) spot.set(key, null)
  }

  const priced = new Map()
  for (const id of snapshots.keys()) {
    const asset = registry.assets.get(id)
    if (!(asset?.rank > 0)) continue
    const symbol = asset.symbol.toUpperCase(), rank = asset.rank
    const best = priced.get(symbol)
    if (!best || rank < best.rank) priced.set(symbol, { rank, id })
    else if (rank === best.rank) best.id = null
  }
  return ({ exchange, symbol }) => {
    const venue = registry.venues.get(exchange)
    const base = derivativeBase(venue, symbol)
    if (!base) return null
    const label = venue?.format?.aliases?.[base] ?? base
    const key = 'cex:' + (exchange === 'kraken-futures' ? 'kraken' : exchange) + ':' + label
    return spot.has(key) ? spot.get(key) : priced.get(label)?.id ?? null
  }
}

/** Sample-data shapes with explicit nulls for measurements the node hasn't seen. */
export class Queries {
  constructor(engine) {
    this.engine = engine
    this.coinByAsset = new Map()
    const tokens = engine.bundle?.tokens.tokens ?? []
    for (const [coin, members] of Map.groupBy(tokens.filter(t => t.coin), t => t.coin)) {
      const group = { key: 'coin:' + coin, kind: 'coin', collapse: true, coin, members,
        stable: members.some(t => t.category === 'stablecoin' || engine.registry.assets.get(t.id)?.stable) }
      for (const t of members) this.coinByAsset.set(t.id, group)
    }
    // Bridged copies joined only by bundle links share a Contracts list; they list as one row unless they are pegs.
    this.linkByAsset = new Map()
    for (const group of linkGroups(tokens)) for (const t of group.members) this.linkByAsset.set(t.id, group)
    this.records = new Map(tokens.map(t => [t.id, t]))
    // The signed chain records (name, family, explorer); the engine catalog keeps only what sources need.
    this.chainRecords = new Map((engine.bundle?.chains ?? []).map(c => [c.id, c]))
    this.cache = null
    trackVenueVolumes(engine)
  }
  /** "Ethereum", "TRON", "Arbitrum One": a chain id as its signed short name. */
  chainName(id) {
    return chainLabel(this.chainRecords.get(id) ?? this.engine.registry.chains.get(id), id)
  }
  /** The signed coin group or link set of an asset (for its Contracts list). */
  groupOf(id) {
    return this.coinByAsset.get(id) ?? this.linkByAsset.get(id)
  }
  /** The group an asset lists under as one row. */
  listGroup(id) {
    const group = this.groupOf(id)
    return group?.collapse ? group : undefined
  }
  /**
   * A group's cap: the signed coin's counted-once cap, else its largest member cap (bridged supply is escrowed).
   * An escrow-backed deployment holds only the bridged share, so its own cap never stands in for the coin's.
   */
  groupCap(group) {
    if (group.kind === 'coin') {
      const cap = this.coinValue(group).cap
      if (cap != null) return cap
    }
    const { snapshots } = this.engine.book
    let best = null
    for (const t of group.members) {
      if (t.coinSupply === 'escrow-backed') continue
      const cap = snapshots.get(t.id)?.marketCap
      if (cap != null && (best == null || cap > best)) best = cap
    }
    return best
  }
  /**
   * Per book refresh: live markets per asset, the representative order and the display ranks. The registry ranks
   * deployments by their own cap; a group takes one rank by its group cap and the ranks behind it close up.
   */
  derived() {
    const { book, registry, clock } = this.engine
    const snapshots = book.snapshots
    if (this.cache?.snapshots === snapshots) return this.cache
    const cutoff = clock() - MARKET_POLICY.maxPriceAge
    const live = new Map()
    for (const p of book.marketPrices.values()) if (p.at >= cutoff) live.set(p.base, (live.get(p.base) ?? 0) + 1)
    const order = representativeOrder(id => live.get(id) ?? 0, id => this.records.get(id),
      id => registry.assets.get(id)?.supply)
    // Signed fixed ranks stay where they are; the others are numbered around them, as the registry does.
    const fixed = registry.fixedRanks ?? new Map(), reserved = new Set(fixed.values())
    const units = new Map()
    for (const a of registry.assets.values()) {
      if (!(a.rank > 0)) continue
      const group = this.listGroup(a.id), key = group?.key ?? a.id
      let unit = units.get(key)
      if (!unit) units.set(key, unit = { key, rank: a.rank, fixed: null,
        cap: group ? this.groupCap(group) : snapshots.get(a.id)?.marketCap ?? null })
      unit.rank = Math.min(unit.rank, a.rank)
      if (fixed.has(a.id)) unit.fixed = Math.min(unit.fixed ?? Infinity, fixed.get(a.id))
    }
    const ranks = new Map()
    let rank = 0
    for (const unit of [...units.values()].sort((a, b) => (b.cap ?? 0) - (a.cap ?? 0) || a.rank - b.rank)) {
      if (unit.fixed != null) { ranks.set(unit.key, unit.fixed); continue }
      do rank++
      while (reserved.has(rank))
      ranks.set(unit.key, rank)
    }
    this.cache = { snapshots, live, order, ranks }
    return this.cache
  }
  /** The rank shown for an asset: its coin's rank for a group member. */
  displayRank(id, fallback = null) {
    return this.derived().ranks.get(this.listGroup(id)?.key ?? id) ?? fallback
  }
  spark(id) {
    return this.engine.store
      .candles({ asset: id, tf: '1h', from: Math.max(0, this.engine.clock() - 7 * DAY), limit: 168 })
      .map((c) => +c.close)
  }
  /**
   * One row for a coin. `matched` are the member rows the list's filters selected: the row links to the best of them
   * (a chain filter links to that chain's member). Figures are the coin's: group price and cap, volume and
   * exchange counts summed over live members, change and trending from the representative.
   */
  coinRow(group, matched, showAll = true) {
    const { store, registry, book } = this.engine
    const { order } = this.derived()
    const byId = new Map(matched.map(r => [r.id, r]))
    const all = group.members.filter(t => registry.assets.has(t.id))
      .map(t => byId.get(t.id) ?? store.getAsset(t.id)).filter(Boolean)
    const live = all.filter(r => r.visibility === 'live')
    const pool = live.length ? live : all
    const first = (rows) => rows.slice().sort((a, b) => order(a.id, b.id))[0]
    const rep = first(pool) ?? matched[0]
    const eligible = showAll ? matched : matched.filter(r => r.visibility === 'live')
    const target = first(eligible.length ? eligible : matched)
    const base = this.token(rep)
    const sum = (rows, read) => rows.reduce((n, r) => (read(r) == null ? n : (n ?? 0) + Number(read(r))), null)
    let price = base.price, trust = rep.trust
    if (group.kind === 'coin') {
      const quote = this.coinValue(group).price
      if (quote) ({ price, trust } = quote)
    }
    return {
      ...base,
      id: target.id, chain: target.chain, address: target.address,
      visibility: showAll ? bestState(matched.map(r => r.visibility)) : 'live',
      staleSince: target.staleSince ?? null,
      price, priceReal: price, trust,
      marketCap: this.groupCap(group),
      volume24h: sum(pool, r => r.volume24h),
      exchanges: sum(pool, r => r.exchanges),
      views: sum(all, r => r.views),
      rank: this.displayRank(rep.id, rep.rank ?? null),
      chains: [...new Set(pool.slice().sort((a, b) => order(a.id, b.id)).map(r => r.chain))],
      sources: { agents: Math.max(0, ...pool.map(r => r.agents ?? 0)), exchanges: sum(pool, r => r.exchanges) ?? 0,
        pools: sum(pool, r => book.snapshots.get(r.id)?.why.pools) ?? 0 },
      representative: rep.id,
      group: group.kind,
      members: all.length,
    }
  }
  /**
   * Ranked asset lists with one row per coin. Counters cover the collapsed list. By default only live rows are read;
   * the hidden counters start from the store's per-asset counts and are corrected for the members of collapsed groups.
   */
  marketList(options = {}) {
    const { book } = this.engine
    const snapshots = book.refresh()
    const tab = options.tab ?? 'all'
    const { sort, order } = listOrder(options)
    const { offset = 0, limit = 100, now, ...filters } = options
    const key = JSON.stringify({ ...filters, sort, order })
    let list = tab === 'watch' ? null : this.lists?.snapshots === snapshots ? this.lists.entries.get(key) : null
    if (!list) {
      list = this.collapsedList({ ...filters, now, tab, sort, order })
      if (tab !== 'watch') {
        if (this.lists?.snapshots !== snapshots) this.lists = { snapshots, entries: new Map() }
        if (this.lists.entries.size >= 16) this.lists.entries.clear()
        this.lists.entries.set(key, list)
      }
    }
    const items = list.rows.slice(offset, offset + limit).map(({ row, spark }) =>
      ({ ...(typeof row === 'function' ? row() : row), spark7d: this.spark(spark) }))
    return { items, total: list.rows.length, hidden: { ...list.hidden } }
  }
  collapsedList(options) {
    const { store } = this.engine
    const { tab, sort, order } = options
    const hiding = !['watch', 'nfts'].includes(tab)
    const showAll = !hiding || options.include === 'hidden'
    const rows = store.listMarkets({ ...options, offset: 0, limit: ALL_ROWS })
    const units = new Map()
    for (const row of rows) {
      const group = this.listGroup(row.id), key = group?.key ?? row.id
      if (!units.has(key)) units.set(key, { group, rows: [] })
      units.get(key).rows.push(row)
    }
    const hidden = showAll && hiding ? { stale: 0, unconfirmed: 0, dust: 0 } : { ...store.marketCounts(options).hidden }
    if (hiding && !showAll) this.correctHidden(options, units, hidden)
    const listed = []
    const field = sort === 'price' ? 'priceReal' : sort
    for (const { group, rows: matched } of units.values()) {
      const state = bestState(matched.map(r => r.visibility)) ?? 'unconfirmed'
      if (group) {
        const row = this.coinRow(group, matched, showAll)
        if (!tabMatches(tab, row)) continue
        if (hiding && state !== 'live') hidden[state]++
        listed.push({ sortBy: { id: row.id, [field]: sort === 'price' ? row.price : row[sort] }, row, spark: row.representative })
        continue
      }
      const row = matched[0]
      if (hiding && showAll && state !== 'live') hidden[state]++
      const value = sort === 'rank' ? this.displayRank(row.id, row.rank ?? null) : row[field] ?? (sort === 'price' ? row.price : null)
      listed.push({ sortBy: { id: row.id, [field]: value }, row: () => this.token(row), spark: row.id })
    }
    const compare = rowOrder(field, order)
    listed.sort((a, b) => compare(a.sortBy, b.sortBy))
    return { rows: listed, hidden }
  }
  /**
   * The store counts hidden rows per asset. A hidden member of a coin that lists through another member is no hidden
   * row; the hidden members of a coin without a live member count as one hidden row.
   */
  correctHidden(options, units, hidden) {
    const { store } = this.engine
    const groups = new Set()
    for (const group of new Set([...this.coinByAsset.values(), ...this.linkByAsset.values()])) if (group.collapse) groups.add(group)
    if (!groups.size) return
    const matching = store.rankedAssetIds({ ...options, include: 'hidden' })
    for (const group of groups) {
      const members = group.members.filter(t => matching.has(t.id))
      if (!members.length) continue
      const listed = units.get(group.key)
      const rows = members.filter(t => !listed?.rows.some(r => r.id === t.id)).map(t => store.getAsset(t.id)).filter(Boolean)
      for (const r of rows) if (r.visibility !== 'live') hidden[r.visibility]--
      if (listed || !rows.length) continue
      const figures = ['trending', 'gainers', 'losers'].includes(options.tab)
      if (!figures || tabMatches(options.tab, this.coinRow(group, rows, true)))
        hidden[bestState(rows.map(r => r.visibility)) ?? 'unconfirmed']++
    }
    for (const reason of Object.keys(hidden)) hidden[reason] = Math.max(0, hidden[reason])
  }
  /** Use independently priced, live members. Token supply is locally verified and expires independently of price. */
  coinValue(group) {
    const { book, registry, clock } = this.engine
    let price = null, supply = null
    const cutoff = clock() - MARKET_POLICY.maxPriceAge
    for (const t of group.members) {
      const p = book.snapshots.get(t.id)
      if (p?.visibility === 'live' && !p.why?.stale && p.at >= cutoff &&
          (p.trust === 'green' || p.trust === 'yellow') && p.price > 0 &&
          (!price || p.at > price.at || (p.at === price.at && (p.trust < price.trust ||
            (p.trust === price.trust && p.asset < price.asset))))) price = p
      const amount = registry.assets.get(t.id)?.supply
      if (t.coinSupply === 'issuance' && amount != null) supply = (supply ?? 0) + amount
    }
    return { price, cap: price && supply != null ? price.price * supply : null }
  }
  token(row, withSpark = false) {
    if (!row) return null
    const { book } = this.engine
    const current = book.snapshots.get(row.id)
    const group = this.coinByAsset.get(row.id)
    const spark = withSpark ? { spark7d: this.spark(row.id) } : {}
    return {
      ...row,
      ...spark,
      rank: row.kind === 'nft' ? row.rank : this.displayRank(row.id, row.rank ?? null),
      price: value(row.price),
      coin: group?.coin ?? row.id,
      coinMarketCap: group ? this.coinValue(group).cap : row.marketCap ?? null,
      chains: [row.chain],
      valuation: row.marketCap != null ? 'Market cap' : row.fdv != null ? 'FDV' : null,
      // The cap rests on the total supply while no circulating figure is known.
      capBasis: row.marketCap != null && this.engine.registry.assets.get(row.id)?.supply == null ? 'total' : null,
      sources: { agents: row.agents ?? 0, exchanges: row.exchanges ?? 0, pools: current?.why.pools ?? 0 },
      whyTrusted: current?.why ?? null,
      trustNote:
        row.trust === 'green'
          ? 'Confirmed'
          : current?.why.stale
            ? 'Stale'
            : row.trust === 'red'
              ? 'Sources disagree'
              : row.trust
                ? 'Few sources'
                : null,
    }
  }
  listedPrices(options) {
    const { book, store } = this.engine
    book.refresh()
    const ids = store.rankedAssetIds(options)
    return [...book.snapshots.values()].filter(p => ids.has(p.asset))
  }
  global() {
    const { registry } = this.engine, all = this.listedPrices()
    let marketCap = 0,
      volume24h = 0,
      stablecoins = 0,
      previous = 0,
      comparable = 0,
      marketCapAssets = 0
    const pegs = []
    const include = (cap, change) => {
      marketCap += cap
      marketCapAssets++
      if (change != null && change > -100) {
        comparable += cap
        previous += cap / (1 + change / 100)
      }
    }
    // Totals take only prices the node can stand behind: green, or yellow with two independent sources or for a
    // native coin or stablecoin. A red or single-source contract-token price matched by ticker (RAIN at $65 instead
    // of $0.0044, RLB at $71) once added $74T to the total. Excluded assets remain listed with their own caveat.
    const counted = (p) => {
      if (p.trust === 'green') return true
      if (p.trust !== 'yellow') return false
      const a = registry.assets.get(p.asset)
      return (p.why?.independentSources ?? 0) >= 2 || a?.address === 'native' || !!a?.stable
    }
    const coinCaps = new Map(), liquidCoins = new Map()
    let hasStableCap = false
    for (const p of all) {
      const group = this.coinByAsset.get(p.asset)
      let cap = p.marketCap
      if (group) {
        if (!coinCaps.has(group)) {
          const result = this.coinValue(group)
          coinCaps.set(group, result.cap)
          if (result.cap != null) {
            include(result.cap, result.price.change24h)
            if (group.stable) {
              stablecoins += result.cap
              hasStableCap = true
            }
          }
        }
        cap = coinCaps.get(group)
      }
      if (p.volume24h > 0) {
        const id = group?.coin ?? p.asset
        const volume = (liquidCoins.get(id)?.volume ?? 0) + p.volume24h
        liquidCoins.set(id, { volume, cap })
      }
      if (!counted(p)) continue
      if (!group && cap != null) include(cap, p.change24h)
      volume24h += p.volume24h ?? 0
      const a = registry.assets.get(p.asset)
      if (a?.stable) {
        if (!group && cap != null) { stablecoins += cap; hasStableCap = true }
        pegs.push({ asset: a.id, symbol: a.symbol, price: p.price })
      }
    }
    const dominance = (symbol) => {
      const cap = all.find(
        (p) => registry.assets.get(p.asset)?.symbol === symbol && p.asset.endsWith(':native')
      )?.marketCap
      return cap != null && marketCap ? (100 * cap) / marketCap : null
    }
    // Completeness of the total: the share of the 100 highest-volume priced assets that have a cap.
    const liquid = [...liquidCoins.values()]
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 100)
    return {
      marketCap: marketCapAssets ? marketCap : null,
      marketCapChange24h: previous ? 100 * (comparable / previous - 1) : null,
      marketCapAssets,
      marketCapCoverage: liquid.length ? liquid.filter((p) => p.cap != null).length / liquid.length : null,
      volume24h: all.some((p) => p.volume24h != null) ? volume24h : null,
      stablecoins: hasStableCap ? stablecoins : null,
      btcDominance: dominance('BTC'),
      ethDominance: dominance('ETH'),
      gas: this.engine.store.reader
        .prepare("SELECT value FROM settings WHERE key LIKE 'engine-fee/%' ORDER BY key")
        .all()
        .map((r) => JSON.parse(r.value))
        .filter((r) => r.at >= this.engine.clock() - 600000),
      pegs,
    }
  }
  markets(options = {}) {
    const { book, store } = this.engine
    book.refresh()
    switch (options.tab) {
      case 'new': {
        const offset = options.offset ?? 0,
          limit = options.limit ?? 100
        const range = { ...options, offset: 0, limit: offset + limit }
        const now = this.engine.clock()
        if (options.include !== 'hidden') range.from = Math.max(0, range.from ?? 0, now - MARKET_POLICY.maxNewAge)
        return pageByAge([...store.newPools(range), ...store.newListings(range)].sort((a, b) => b.firstSeen - a.firstSeen),
          { ...options, limit }, now, MARKET_POLICY.maxNewAge, row => row.firstSeen).items
      }
      case 'exchanges':
        return this.exchangeList({ limit: 100, ...options }).items
      case 'derivatives':
        return this.derivativeList({ limit: 100, ...options }).items
      case 'categories':
        return page(this.categories(options), options)
      case 'chains':
        return page(this.chains(options), options)
      default:
        return this.marketList(options).items
    }
  }
  /**
   * An asset page. A group member answers for its coin: `coinGroup` holds the coin's figures, `contracts` every member and
   * `markets` the union of the members' markets. The top-level price, cap and supply stay the member's own.
   */
  detail(id) {
    const { store, book } = this.engine
    book.refresh()
    const row = store.getAsset(id)
    const token = this.token(row)
    if (!token) return null
    store.recordView(id)
    const group = this.listGroup(id)
    let coin = null
    if (group) {
      const c = this.coinRow(group, [row])
      coin = { kind: group.kind, coin: group.coin ?? null, name: c.name, symbol: c.symbol, price: c.price, trust: c.trust,
        marketCap: c.marketCap, volume24h: c.volume24h, change1h: c.change1h, change24h: c.change24h,
        change7d: c.change7d, exchanges: c.exchanges, members: c.members, representative: c.representative,
        chains: c.chains, rank: c.rank }
    }
    return {
      ...token,
      ...(coin && { chains: coin.chains }),
      coinGroup: coin,
      contracts: this.contracts(id),
      markets: this.assetMarkets(id),
      spark7d: this.spark(id),
    }
  }
  /**
   * Every deployment that represents the asset, representative first: chain, address, explorer page and role.
   * A standalone token has one entry; a standalone native coin has none.
   */
  contracts(id) {
    const { registry } = this.engine
    const group = this.groupOf(id)
    if (!group && id.endsWith(':native')) return []
    const { order } = this.derived()
    const ids = group ? group.members.map(t => t.id).filter(m => m === id || registry.assets.has(m)).sort(order) : [id]
    const symbol = this.records.get(ids[0])?.symbol ?? registry.assets.get(ids[0])?.symbol
    return ids.map(m => {
      const chainId = m.slice(0, m.indexOf(':')), chain = this.chainRecords.get(chainId), record = this.records.get(m)
      return { id: m, chain: chainId, chainName: this.chainName(chainId), address: m.slice(m.indexOf(':') + 1),
        symbol: record?.symbol ?? registry.assets.get(m)?.symbol ?? null, explorer: explorerUrl(record, chain, m),
        role: contractRole(record, group, symbol), current: m === id }
    })
  }
  /** Markets of an asset, or of every member of its coin. `member` names the deployment each market binds to. */
  assetMarkets(id) {
    const { book, registry } = this.engine
    book.refresh()
    const ids = new Set(this.listGroup(id)?.members.map(t => t.id) ?? [])
    ids.add(id)
    return [...registry.markets.values()]
      .filter((m) => ids.has(m.base) || ids.has(m.quote))
      .map((m) => {
        const p = book.marketPrices.get(m.id)
        return {
          ...m,
          member: ids.has(m.base) ? m.base : m.quote,
          price: p?.price ?? null,
          at: p?.at ?? null,
          reporters: p?.agents.length ?? 0,
          baseVol24h: p?.baseVolume ?? null,
          volume24h: marketUsdVolume(p, book.snapshots),
        }
      })
      .sort((a, b) => (b.volume24h ?? -1) - (a.volume24h ?? -1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }
  /** Search exposes hidden assets; a coin answers once, linked to the best member the query matched. */
  search(query, options = {}) {
    this.engine.book.refresh()
    const offset = options.offset ?? 0, limit = options.limit ?? 100
    const rows = this.engine.store.searchAssets(query, { offset: 0, limit: Math.min(1000, (offset + limit) * 20) })
    const units = new Map()
    for (const row of rows) {
      const group = this.listGroup(row.id), key = group?.key ?? row.id
      if (!units.has(key)) units.set(key, { group, rows: [] })
      units.get(key).rows.push(row)
    }
    return [...units.values()]
      .map(({ group, rows: matched }) => (group ? this.coinRow(group, matched) : this.token(matched[0])))
      .sort(rowOrder('rank', 'asc'))
      .slice(offset, offset + limit)
  }
  exchangeList(options = {}) {
    const { book, clock } = this.engine, now = clock()
    const rows = exchangeRows(this.engine, now).filter(row => !options.kind || row.kind === options.kind.toUpperCase())
    const latest = new Map()
    for (const m of book.marketPrices.values()) latest.set(m.exchange, Math.max(latest.get(m.exchange) ?? 0, m.at))
    return pageByAge(rows, options, now, MARKET_POLICY.maxPriceAge, row => latest.get(row.id))
  }
  exchanges(options) {
    return this.exchangeList(options).items
  }
  derivativeList(options = {}) {
    const { store, registry, book, clock } = this.engine
    const rows = store.reader
      .prepare(
        `SELECT d.*, CASE WHEN h.value>0 THEN (d.openInterest/h.value-1)*100 END AS oiChange24h,
      'provider units' AS openInterestUnit FROM engine_derivatives d LEFT JOIN engine_interest_history h
      ON h.exchange=d.exchange AND h.symbol=d.symbol AND h.hour=d.at-d.at%3600000-86400000
      ORDER BY d.exchange,d.symbol`
      )
      .all()
    const result = pageByAge(rows, options, clock(), MARKET_POLICY.maxPriceAge, row => row.at)
    if (result.items.length) {
      const resolve = derivativeAssets(registry, book.refresh())
      result.items = result.items.map(row => ({ ...row, asset: resolve(row) }))
    }
    return result
  }
  derivatives(options) {
    return this.derivativeList(options).items
  }
  categories({ include, now } = {}) {
    const { registry } = this.engine
    const groups = new Map()
    for (const p of this.listedPrices({ include, now })) {
      const a = registry.assets.get(p.asset),
        name = a?.category
      if (!name) continue
      if (!groups.has(name)) groups.set(name, { name, marketCap: 0, top: [], items: [] })
      const g = groups.get(name)
      g.marketCap += p.marketCap ?? 0
      g.items.push({ symbol: a.symbol, cap: p.marketCap ?? 0, change: p.change24h })
    }
    return [...groups.values()]
      .map(({ name, marketCap, items }) => {
        const known = items.filter((i) => i.change != null && i.change > -100)
        const prior = known.reduce((n, i) => n + i.cap / (1 + i.change / 100), 0)
        return {
          name,
          marketCap,
          change24h: prior ? (known.reduce((s, i) => s + i.cap, 0) / prior - 1) * 100 : null,
          top: items
            .sort((a, b) => b.cap - a.cap)
            .slice(0, 3)
            .map((i) => i.symbol),
        }
      })
      .sort((a, b) => b.marketCap - a.marketCap)
  }
  /** Every bundle chain, busiest first, with what this node knows about it so far. */
  chains({ include, now } = {}) {
    const { book, registry, store, clock } = this.engine
    book.refresh()
    const ids = store.rankedAssetIds({ include, now })
    const volumes = new Map(),
      tokens = new Map()
    for (const p of book.marketPrices.values())
      if (p.kind === 'dex' && ids.has(p.base)) {
        const usd = marketUsdVolume(p, book.snapshots) ?? 0
        volumes.set(p.chain, (volumes.get(p.chain) ?? 0) + usd)
      }
    for (const a of registry.assets.values())
      if (a.chain && ids.has(a.id) && book.snapshots.has(a.id)) tokens.set(a.chain, (tokens.get(a.chain) ?? 0) + 1)
    const pools = new Map()
    for (const p of store.reader.prepare('SELECT chain,pool,firstSeen FROM pools').iterate()) {
      const market = registry.markets.get('dex:' + p.chain + ':' + p.pool)
      if (market ? !ids.has(market.base) : include !== 'hidden') continue
      if (!pools.has(p.chain)) pools.set(p.chain, { pools: 0, newPools24h: 0 })
      const group = pools.get(p.chain)
      group.pools++
      if (p.firstSeen >= clock() - DAY) group.newPools24h++
    }
    const fees = new Map(
      store.reader
        .prepare("SELECT key,value FROM settings WHERE key LIKE 'engine-fee/%'")
        .all()
        .map((r) => [r.key.slice('engine-fee/'.length), JSON.parse(r.value)])
        .filter(([, f]) => f.at >= clock() - 600000)
    )
    return [...registry.chains.values()]
      .map((c) => {
        const native = book.snapshots.get(c.id + ':native')
        return {
          chain: c.id,
          name: c.name ?? c.id,
          family: c.family ?? null,
          pools: pools.get(c.id)?.pools ?? 0,
          newPools24h: pools.get(c.id)?.newPools24h ?? 0,
          dexVolume24h: volumes.get(c.id) ?? 0,
          tokens: tokens.get(c.id) ?? 0,
          nativePrice: native && ids.has(native.asset) ? native.price : null,
          gas: fees.get(c.id)?.value ?? null,
        }
      })
      .sort(
        (a, b) =>
          b.dexVolume24h - a.dexVolume24h || b.pools - a.pools || b.tokens - a.tokens || a.name.localeCompare(b.name)
      )
  }
  network() {
    const { store, registry, book, clock, budget, scheduler, transport } = this.engine
    const now = clock(),
      db = store.reader
    const counts = db
      .prepare(
        `SELECT count(*) AS harnessesSeen24h,
      max(at) AS lastUpdate FROM store_reporters_seen WHERE at>=?`
      )
      .get(now - DAY)
    let underCovered = 0
    for (const market of registry.markets.values()) {
      const target = coverageTarget(registry.marketRank(market), scheduler.targets)
      if (book.coverage(market.id, target.window) < target.count) underCovered++
    }
    return {
      ...counts,
      myReportsPerHour: store.reportsSince(transport.publicKey, now - 3_600_000),
      droppedUnproven1h: book.unprovenIngest.dropped1h(now),
      harnessesOnline: transport.peerCount() + 1,
      myBudgetUsed: budget.used / budget.limit,
      storageUsedMB: db
        .prepare('SELECT page_count*page_size/(1024.0*1024) AS n FROM pragma_page_count,pragma_page_size')
        .get().n,
      storageFileBytes: store.fileBytes(),
      storageCapMB: store.limits.storeBudgetMB,
      coverage: { underCovered, items: registry.markets.size },
    }
  }
}
