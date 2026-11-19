import { symbolPattern } from '../obs/index.js'
import { formatUrl } from './http.js'

/** All source-bundle field names, paths and format-specific defaults live here. */
const stableSymbols = new Set([
  'USDC',
  'USDT',
  'DAI',
  'USDG',
  'USDE',
  'PYUSD',
  'USDS',
  'FDUSD',
  'TUSD',
  'USDP',
  'GUSD',
])
const nativeMarkets = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  DOGE: 'dogecoin',
  LTC: 'litecoin',
  BNB: 'bsc',
  AVAX: 'avalanche',
  XRP: 'xrpl',
  ADA: 'cardano',
  TRX: 'tron',
  TON: 'ton',
  SUI: 'sui',
  APT: 'aptos',
  // HyperCore HYPE is the coin; HyperEVM gas HYPE is the same coin moved from HyperCore.
  HYPE: 'hyperliquid',
}

/** Convert compound rate-limit notes to the most restrictive requests/minute. */
export function rateLimit(value) {
  if (Number.isFinite(value) && value > 0) return value
  if (typeof value !== 'string') return 12
  const limits = []
  for (const m of value
    .replaceAll(',', '')
    .matchAll(
      /(\d+(?:\.\d+)?)\s*(?:requests?|reqs?|weight)?\s*(?:\/|per)\s*(\d+(?:\.\d+)?)?\s*(second|minute|hour|day|s|m|h|d)\w*/gi
    )) {
    const seconds = { s: 1, m: 60, h: 3600, d: 86400 }[m[3][0].toLowerCase()]
    limits.push((+m[1] * 60) / (+(m[2] ?? 1) * seconds))
  }
  return limits.length ? Math.min(...limits) : 12
}

/** The widest eth_getLogs block range some log-capable endpoint serves (Infinity if one has no limit). Each request
 * goes only to endpoints whose own maxRange fits it (RpcClient), so a 100-block free tier (drpc) no longer shrinks
 * every scan window of its chain. */
export function logWindow(endpoints) {
  const ranges = endpoints.filter((e) => e.logs !== false).map((e) => (e.range > 0 ? e.range : Infinity))
  return ranges.length ? Math.max(...ranges) : Infinity
}

export async function digestPrefix(bundle) {
  const { bundleDigest } = await import('@gator/bundle')
  return bundleDigest(bundle).slice(0, 16)
}

export function deploymentId(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '')
}

export function adaptBundle(bundle) {
  const tokens = bundle.tokens.tokens
  const assets = tokens.map((t) => {
    const separator = t.id.indexOf(':')
    const chain = t.id.slice(0, separator)
    const address = t.id.slice(separator + 1)
    const stable = t.category === 'Stablecoin' || stableSymbols.has(t.symbol.toUpperCase())
    return {
      id: t.id,
      chain,
      address,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      stable,
      category: t.category ?? (stable ? 'Stablecoin' : null),
      rank: t.rank ?? null,
      supply: t.circulatingSupply ?? null,
      totalSupply: t.totalSupply ?? null,
    }
  })
  const identities = new Set(assets.map((a) => a.id))
  const groups = Map.groupBy(tokens, (t) => t.symbol.toUpperCase())
  const common = Object.create(null)
  for (const [sym, list] of groups) {
    const native = nativeMarkets[sym] + ':native'
    if (list.some((t) => t.id === native)) common[sym] = native
    // One coin under one ticker: linked deployments, or deployments of the same signed coin group (USDT0 bridges).
    else if (list.length > 1 && list.every((t) => t === list[0] || list[0].links?.includes(t.id) || (t.coin && t.coin === list[0].coin))) {
      common[sym] = (list.find((t) => t.id.startsWith('ethereum:')) ?? list[0]).id
    }
  }
  const canonicalQuotes = bundle.dex.evm.find((c) => c.chain === 'ethereum')?.quoteTokens ?? []
  for (const q of canonicalQuotes) {
    const id = 'ethereum:' + q.address.toLowerCase()
    if (stableSymbols.has(q.symbol) && identities.has(id)) common[q.symbol] = id
  }
  const events = new Map(bundle.dex.events.map((e) => [e.id, e]))
  const kinds = new Map(bundle.dex.kinds.map((k) => [k.id, k.events]))
  const chains = bundle.chains.map((c) => {
    const dex = bundle.dex.evm.find((d) => d.chain === c.id)
    const active = Object.create(null)
    const deployments = (dex?.deployments ?? []).map((d) => {
      const topics = []
      for (const id of kinds.get(d.kind) ?? []) {
        const e = events.get(id)
        if (!e || e.signature.startsWith('Sync(')) continue
        active[e.topic0] = { topic: e.topic0, signature: e.signature, emitter: e.emitter }
        if (e.indexed) {
          const types = e.signature.slice(e.signature.indexOf('(') + 1, -1).split(',')
          active[e.topic0].topicCount = 1 + e.indexed.length
          active[e.topic0].dataWords = types.reduce((n, type, i) =>
            n + (e.indexed.includes(i) ? 0 : Number(type.match(/\[(\d+)\]$/)?.[1] ?? 1)), 0)
        }
        topics.push(e.topic0)
      }
      return {
        name: deploymentId(d.name),
        displayName: d.name,
        kind: d.kind,
        address: d.address.toLowerCase(),
        topics,
      }
    })
    // A record whose dated probe failed (needs a key now, chain dropped, blocked) stays in the signed bundle as
    // evidence, but the node never calls it, so it is not a source either.
    const endpoints = c.endpoints
      .filter((e) => ['evm-jsonrpc', 'solana-jsonrpc'].includes(e.protocol) && e.verified?.ok !== false)
      .map((e) => ({
        url: e.url,
        rpm: rateLimit(e.limits),
        batch: e.batch === true,
        logs: e.getLogs?.allowed,
        range: e.getLogs?.maxRange,
        verified: e.verified?.ok === true,
      }))
      .sort((a, b) => Number(b.verified) - Number(a.verified))
    return {
      id: c.id,
      name: c.name,
      family: c.family,
      number: c.chainId,
      blockTime: 1000 * c.blockTimeSeconds,
      quotes: (dex?.quoteTokens ?? []).map((q) => q.address.toLowerCase()),
      deployments,
      events: active,
      multicall: c.multicall3,
      endpoints,
      range: Math.min(128, logWindow(endpoints)),
    }
  })
  return {
    assets,
    chains,
    exchanges: bundle.exchanges.map((e) => exchange(e, common)),
    apis: bundle.apis.map((a) => ({
      id: a.id,
      name: a.name,
      url: a.base + a.path,
      rpm: rateLimit(a.requestsPerMinute),
      programs: bundle.dex.solana?.find((d) => d.api === a.id)?.programs.map((p) => p.address) ?? [],
    })),
  }
}

const intervalNames = {
  '1m': ['1m', '1min', 'min1', 'minute1', 'ONE_MINUTE', 'MINUTE_1', 'M1', '1MIN'],
  '5m': ['5m', '5min', 'min5', 'minute5', 'FIVE_MINUTE', 'MINUTE_5', 'M5', '5MINS'],
  '1h': ['1h', '1H', '1hr', '1hour', 'hour1', '60min', '60m', 'ONE_HOUR', 'HOUR_1', 'H1', '1HOUR'],
  '1d': ['1d', '1D', '1day', 'day1', 'ONE_DAY', 'DAY_1', 'D1', '1DAY', 'D'],
}

function candleSpec(e) {
  if (!e.candles) return null
  const c = e.candles,
    intervals = {}
  const seconds = ['bitso', 'bitstamp', 'coinw', 'phemex'].includes(e.id)
  for (const [frame, names] of Object.entries(intervalNames)) {
    const minutes = { '1m': 1, '5m': 5, '1h': 60, '1d': 1440 }[frame]
    const numeric = String(minutes * (seconds ? 60 : 1))
    intervals[frame] = [...names, numeric, ...(e.id === 'pionex' ? [minutes + 'M'] : [])].find((name) =>
      c.intervals.includes(name)
    )
  }
  const url = new URL(c.path, e.restBase)
  if (['binance', 'binance-us', 'bybit', 'bitfinex'].includes(e.id)) {
    const suffix = e.id.startsWith('binance') ? 'Time' : ''
    url.searchParams.set('start' + suffix, '{startMs}')
    url.searchParams.set('end' + suffix, '{lastMs}')
  }
  if (e.id === 'kraken') url.searchParams.set('since', '{startSec}')
  return {
    url: url.href.replaceAll('%7B', '{').replaceAll('%7D', '}'),
    intervals,
    max: c.maxLimit,
    method: c.method,
    body: c.body,
  }
}

function exchange(e, common) {
  const m = e.tickers.mapping,
    f = m.fields,
    symbols = e.symbols,
    limits = e.rateLimit
  const absolute = (path) => new URL(path, e.restBase).href.replaceAll('%7B', '{').replaceAll('%7D', '}')
  const documented = [limits.requestsPerMinute, limits.weightPerMinute].filter((n) => n > 0)
  const rpm = documented.length ? Math.min(...documented) : rateLimit(limits.note)
  const derivatives = Object.entries(e.derivatives ?? {})
    .filter(([, spec]) => spec)
    .map(([kind, spec]) => {
      const [prefix, suffix] = spec.url.split('{symbol}')
      const probe = (e.verified?.successful ?? []).find(
        (p) => suffix !== undefined && p.url.startsWith(prefix) && p.url.endsWith(suffix)
      )
      const sample =
        probe && decodeURIComponent(probe.url.slice(prefix.length, suffix ? -suffix.length : undefined))
      return { kind, field: spec.field, url: spec.url, method: spec.method, body: spec.body, sample }
    })
  return {
    id: e.id,
    name: e.name,
    publishMarketData: e.terms?.redistribution !== 'restricted',
    derivativeOnly: e.kind === 'derivatives' || e.id === 'phemex',
    symbolMap: Object.assign(Object.create(null), common, e.symbolMap ?? {}),
    ticker: {
      url: absolute(e.tickers.path),
      method: e.tickers.method,
      body: e.tickers.body,
      path: m.list,
      rows: m.rows,
      filter: m.filter,
      join: m.joinByIndex,
      cost: limits.weightPerMinute > 0 ? (limits.tickerWeight ?? 1) : 1,
      fields: {
        ...f,
        price: f.last,
        base: symbols.mode === 'fields' ? symbols.base : null,
        quote: symbols.mode === 'fields' ? symbols.quote : null,
      },
    },
    perSymbolCatalog: symbols.mode === 'catalog' && symbols.url.includes('{lowerSymbol}'),
    format: {
      mode: symbols.mode,
      delimiter: symbols.separator,
      reverse: symbols.order === 'quote-base',
      field: symbols.field,
      quote: symbols.quote,
      catalog:
        symbols.mode === 'catalog'
          ? {
              url: symbols.url,
              path: symbols.list,
              base: symbols.base,
              quote: symbols.quote,
              symbol: symbols.symbol,
            }
          : null,
      pairs: symbols.mode === 'index-pairs' ? { universe: symbols.universe, tokens: symbols.tokens } : null,
      aliases: { XBT: 'BTC', XDG: 'DOGE', ...(e.id === 'bitfinex' ? { UST: 'USDT', UDC: 'USDC' } : {}) },
    },
    candles: candleSpec(e),
    derivatives,
    rpm,
    catalogCache: new Map(),
    catalogAt: null,
    instruments: new Set(),
  }
}

export function atPath(row, path) {
  if (path == null) return null
  for (const key of String(path).split('.').filter(Boolean)) {
    if (row == null || !Object.hasOwn(row, key)) return null
    row = row[key]
  }
  return row
}

function entries(json, spec) {
  const list = atPath(json, spec.path)
  if (!list || typeof list !== 'object') throw new Error('Missing response list')
  if ((spec.rows === 'array' && !Array.isArray(list)) || (spec.rows === 'object' && Array.isArray(list))) {
    throw new Error('Unexpected ticker response list')
  }
  return Object.entries(list)
}
function read(row, path, key, joined) {
  if (path === '$key') return key
  if (typeof path === 'string' && path.startsWith('$join.')) return atPath(joined, path.slice(6))
  return atPath(row, path)
}

/** Preserve native market symbols for history requests. Apply aliases solely to wire labels. */
function splitPair(raw, format, base, quote) {
  if (typeof raw !== 'string' || raw.length > 80) return null
  const s = raw.toUpperCase()
  if (!(base && quote)) {
    if (format.mode === 'fixed-quote') {
      base = s
      quote = format.quote
    } else if (format.mode === 'bitfinex') {
      const pair = s.slice(1)
      if (!s.startsWith('T') || pair.includes('F0')) return null
      ;[base, quote] = pair.includes(':') ? pair.split(':') : [pair.slice(0, -3), pair.slice(-3)]
    } else if (format.delimiter) {
      const parts = s.split(format.delimiter)
      if (parts.length !== 2) return null
      ;[base, quote] = format.reverse ? parts.reverse() : parts
    } else return null
  }
  if (typeof base !== 'string' || typeof quote !== 'string') return null
  const normalize = (label) => format.aliases?.[label.toUpperCase()] ?? label.toUpperCase()
  base = normalize(base)
  quote = normalize(quote)
  return symbolPattern.test(base) && symbolPattern.test(quote) && base !== quote ? [base, quote] : null
}

export async function loadCatalog(venue, http, now, raw) {
  const spec = venue.format.catalog
  if (!spec) return
  const perSymbol = venue.perSymbolCatalog
  if (perSymbol && (!raw || venue.catalogCache.has(raw))) return
  if (!perSymbol && venue.catalogAt != null && now - venue.catalogAt < 6 * 3600000) return
  const json = await http.get(formatUrl(spec.url, { lowerSymbol: raw?.toLowerCase() }), venue.rpm)
  const items = perSymbol ? [['', json]] : entries(json, spec)
  const next = perSymbol ? venue.catalogCache : new Map()
  for (const [key, r] of items) {
    const symbol = read(r, spec.symbol, key)
    if (typeof symbol !== 'string' || symbol.length > 80) continue
    const pair =
      venue.id === 'kraken' && typeof r.wsname === 'string'
        ? r.wsname.split('/')
        : [atPath(r, spec.base), atPath(r, spec.quote)]
    const kind = String(r.marketType ?? r.instrument_type ?? r.inst_type ?? r.product_type ?? '').toLowerCase()
    // Status vocabularies differ, even between exchanges serving exchangeInfo.
    const halted = r.isSpotTradingAllowed === false ||
      (['binance', 'binance-us'].includes(venue.id) && r.status != null && r.status !== 'TRADING') ||
      (venue.id === 'bybit' && r.status != null && r.status !== 'Trading') ||
      (venue.id === 'bitget' && r.status === 'offline') ||
      (venue.id === 'kraken' && ['cancel_only', 'maintenance', 'delisted'].includes(r.status))
    next.set(symbol.toUpperCase(), { pair, derivative: /(perp|future|swap|option)/.test(kind), halted })
  }
  venue.catalogCache = next
  venue.catalogAt = now
}

/** Pair name → its two token names, from pair rows that reference token rows by their `index` field. */
export function indexPairs(json, spec) {
  if (!spec) return null
  const tokens = atPath(json, spec.tokens), universe = atPath(json, spec.universe)
  if (!Array.isArray(tokens) || !Array.isArray(universe)) throw new Error('Missing pair catalog')
  const names = new Map(), pairs = new Map()
  for (const t of tokens) if (Number.isSafeInteger(t?.index) && typeof t.name === 'string') names.set(t.index, t.name)
  for (const u of universe) {
    const [base, quote] = Array.isArray(u?.tokens) ? u.tokens : []
    if (typeof u?.name === 'string' && names.has(base) && names.has(quote))
      pairs.set(u.name.toUpperCase(), { pair: [names.get(base), names.get(quote)], derivative: false })
  }
  return pairs
}

/** Interpret the exchange's declarative row and field mapping before the source processes observations. */
/** The venue's own 24 h move as last / open, from its open price or its change field in the bundle's unit. */
export function dayRatio(fields, field, price) {
  const last = Number(price)
  if (!(last > 0)) return null
  const open = fields.open24h ? Number(field(fields.open24h)) : NaN
  let ratio = open > 0 ? last / open : NaN
  const raw = !(ratio > 0) && fields.change24h ? field(fields.change24h) : null
  if (raw != null && raw !== '') {
    const value = fields.changeUnit === 'percent-string' ? parseFloat(String(raw)) : Number(raw)
    ratio = fields.changeUnit === 'absolute' ? last / (last - value)
      : 1 + (fields.changeUnit === 'ratio' ? value : value / 100)
  }
  // Outside 1/100..100 the field is not a 24 h move (a wrong unit or an empty open).
  return ratio >= 0.01 && ratio <= 100 ? ratio : null
}

export function* tickerRecords(venue, json) {
  const spec = venue.ticker
  const fields = spec.fields
  const joined = atPath(json, spec.join)
  const pairs = indexPairs(json, venue.format.pairs)
  const funding = venue.derivatives.find((d) => d.kind === 'fundingRate')
  const interest = venue.derivatives.find((d) => d.kind === 'openInterest')
  for (const [key, row] of entries(json, spec)) {
    if (row == null) continue
    const field = (path) => read(row, path, key, joined?.[key])
    const filter = spec.filter
    if (filter) {
      const value = field(filter.field)
      if (value === filter.exceptValue || (filter.startsWith && !String(value).startsWith(filter.startsWith))) continue
    }
    const raw = field(fields.symbol)
    if (typeof raw !== 'string' || raw.length > 80) continue
    const entry = venue.catalogCache.get(raw.toUpperCase()) ?? pairs?.get(raw.toUpperCase())
    const pair = splitPair(
      venue.format.field ? field(venue.format.field) : raw,
      venue.format,
      entry?.pair[0] ?? field(fields.base),
      entry?.pair[1] ?? field(fields.quote)
    )
    yield {
      raw,
      row,
      pair,
      catalogDerivative: entry?.derivative,
      catalogHalted: entry?.halted,
      funding: field(funding?.field),
      openInterest: field(interest?.field),
      // Some feeds omit the trade price on quiet markets; the bundle names an indicative fallback.
      price: field(fields.price) ?? field(fields.referencePrice),
      dayRatio: dayRatio(fields, field, field(fields.price)),
      baseVolume: field(fields.baseVolume?.replace('{base}', pair?.[0].toLowerCase())),
      quoteVolume: field(fields.quoteVolume?.replace('{quote}', pair?.[1].toLowerCase())),
      usdVolume: field(fields.usdVolume),
      bid: field(fields.bid),
      ask: field(fields.ask),
      at: field(fields.at),
    }
  }
}

export { ROOT_KEY } from '../../../bundle/src/root-key.js'
