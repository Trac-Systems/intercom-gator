import { MARKET_POLICY } from '../../store/src/markets.js';
import { pageByAge } from '../../engine/src/aggregate/queries.js';
import { check } from './local.js';
import { volumeOrder } from '../../engine/src/aggregate/volume-guard.js';

const widths = { '1m': 60_000, '5m': 300_000, '1h': 3_600_000, '1d': 86_400_000 };
// DESIGN "Trust dot per number": a venue's number is confirmed (green) when it is fresh, its own reporters agree, the
// asset's price is green, the venue is not one of the asset's outliers, and its USD value is within 1% of that price.
// Limited or provisional evidence stays yellow; stale or > 3% disagreement inside the market is red.
// (v0.1.0-v0.1.2 never returned green for a market row, so every row read "Few sources".)
export function marketDot({ stale, spread, usd, ageMs, windowMs, assetTrust, assetUsd, outlier }) {
  if (stale || spread > 0.03) return 'red';
  const agrees = usd > 0 && assetUsd > 0 && Math.abs(usd / assetUsd - 1) <= 0.01;
  return assetTrust === 'green' && agrees && ageMs <= windowMs && !outlier ? 'green' : 'yellow';
}

export function integer(value, fallback, max, min = 0) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  check(Number.isSafeInteger(n) && n >= min && n <= max, 'bad range');
  return n;
}

export function marketViews(app, people) {
  const { engine, store, intel } = app;
  function resolve(query, allowDiscovery = true) {
    check(typeof query === 'string' && query.length > 0 && query.length <= 256, 'unknown asset', 404);
    if (store.getAsset(query)) return query;
    if (allowDiscovery && query.includes(':') && intel.newTokens.list().some(t => t.asset === query)) return query;
    const ids = engine.registry.symbols.get(query.replace(/^\$/, '').toUpperCase());
    check(ids?.size, 'unknown asset', 404);
    check(ids.size === 1, 'ambiguous symbol; use chain:address', 409);
    return [...ids][0];
  }
  function markets(id) {
    const outliers = new Map();
    const excluded = (asset, market) => {
      if (!outliers.has(asset)) outliers.set(asset, new Set(engine.whyTrusted(asset)?.outliers ?? []));
      return outliers.get(asset).has(market);
    };
    return engine.assetMarkets(id).map(m => {
      const source = engine.book.marketPrices.get(m.id);
      const age = m.at == null ? null : Math.max(0, app.clock() - m.at);
      const stale = source && age > 3 * source.window;
      const base = engine.registry.assets.get(m.base)?.symbol ?? m.base;
      const quote = engine.registry.assets.get(m.quote)?.symbol ?? m.quote.replace(/^fiat:/, '');
      // A coin page lists every member's markets: a DEX pool on its chain, a CEX pair on the member it binds to.
      const member = m.member ?? id, chainId = m.chain ?? member.slice(0, member.indexOf(':'));
      return { id: m.id, venue: engine.registry.venues.get(m.exchange)?.name ?? m.exchange,
        kind: m.kind.toUpperCase(), chain: m.chain, pair: base + '/' + quote, base: m.base, quote: m.quote,
        asset: member, chainName: engine.queries.chainName(chainId),
        price: m.price, volume24h: m.volume24h, liquidity: m.liquidity ?? null,
        ...(m.volumeSuspect && { volumeSuspect: m.volumeSuspect.reason, volumeNote: m.volumeSuspect.note }),
        trust: source ? marketTrust(m, member, source, stale, age, excluded) : null,
        updated: age == null ? null : Math.floor(age / 1000), windowMs: source?.window ?? null };
    });
  }
  function marketTrust(m, member, source, stale, age, excluded) {
    const asset = store.getPrice(member);
    const fx = m.quote === 'fiat:USD' ? 1 : engine.book.snapshots.get(m.quote)?.price;
    return marketDot({ stale, spread: source.spread, usd: fx && m.price > 0 ? fx * m.price : null, ageMs: age,
      windowMs: source.window, assetTrust: asset?.trust, assetUsd: asset?.priceReal, outlier: excluded(member, m.id) });
  }
  // Only display comparisons the engine actually performed. The engine records
  // the local observation and peer key. Ambiguous remote matches stay unknown.
  const lastCheck = store.reader.prepare(`SELECT h.market,c.price,h.srcTs,h.reporter FROM asset_markets a
    JOIN engine_last_spot h ON h.market=a.market JOIN engine_spot_checks c ON c.localId=h.localId AND c.reporter=h.reporter
    JOIN obs o ON o.id=h.localId WHERE a.asset=? AND o.reporter=? ORDER BY h.srcTs DESC,h.seq DESC LIMIT 1`);
  function spotCheck(id, rows) {
    const local = lastCheck.get(id, app.transport.publicKey);
    if (!local) return null;
    const matches = store.checkedPrices(local.market, local.reporter, local.srcTs - 30_000, local.srcTs + 30_000);
    if (matches.length !== 1) return null;
    return { venue: rows.find(m => m.id === local.market)?.venue ?? local.market,
      ok: Math.abs(Number(matches[0]) / Number(local.price) - 1) <= 0.03 + 1e-12,
      ageSec: Math.max(0, Math.floor((app.clock() - local.srcTs) / 1000)) };
  }
  function why(id, rows = markets(id)) {
    const w = engine.whyTrusted(id);
    if (!w) return null;
    const price = store.getPrice(id);
    const sources = rows.filter(m => m.price != null && m.base === id).map(m => {
      const fx = m.quote === 'fiat:USD' ? 1 : engine.book.snapshots.get(m.quote)?.price;
      const usd = fx ? fx * m.price : null;
      return { venue: m.venue, pair: m.pair, price: m.price, ageSec: m.updated,
        deltaPct: usd && price?.priceReal ? (usd / price.priceReal - 1) * 100 : null,
        ...(w.outliers?.includes(m.id) && { excluded: 'outlier' }) };
    }).sort((a, b) => !!a.excluded - !!b.excluded);
    const windows = [...new Set(rows.filter(m => m.windowMs).map(m => m.windowMs / 60_000))];
    return { ...w, reporters: w.agents, state: price?.trust, window: windows.map(w => w + ' min').join(' / ') || null,
      sources, spotCheck: spotCheck(id, rows), note: w.stale ? 'Stale observations' : null };
  }
  function flags(values = {}) {
    const entries = Object.entries(values);
    return [...entries.filter(([,v]) => v === true).map(([k]) => k),
      ...entries.filter(([,v]) => v === 'unknown').map(([k]) => k + ' unknown'),
      ...(entries.length ? [] : ['risk unchecked'])];
  }
  /**
   * Markets by 24 h volume, paged: a stablecoin page otherwise carries every X/USDT pair (20,000+, ~9 MB).
   * Rows whose volume the guard does not count (`volumeSuspect`) follow the counted ones and stay out of `volumeTotal`
   * (the base of each row's share). `side=base|quote` keeps the markets where the asset is the base or the quote;
   * `counts` gives both before that filter, so a stablecoin page can offer "USDT as base / as quote".
   */
  function marketPage(id, { limit = 100, offset = 0, side } = {}, rows = markets(id)) {
    const vol = m => (Number.isFinite(+m.volume24h) && m.volume24h != null ? +m.volume24h : -1);
    const quoteSide = m => m.quote === m.asset && m.base !== m.asset;
    const counts = { base: 0, quote: 0 };
    for (const m of rows) counts[quoteSide(m) ? 'quote' : 'base']++;
    const matching = side === 'base' || side === 'quote' ? rows.filter(m => quoteSide(m) === (side === 'quote')) : rows;
    const sorted = [...matching].sort(volumeOrder);
    let volumeTotal = 0, suspectTotal = 0, suspects = 0;
    for (const m of matching) {
      if (m.volumeSuspect) { suspects++; suspectTotal += Math.max(0, vol(m)); } else volumeTotal += Math.max(0, vol(m));
    }
    return { items: sorted.slice(offset, offset + limit), total: matching.length, offset, volumeTotal,
      suspect: { count: suspects, volume24h: suspectTotal }, counts };
  }
  function detail(id) {
    const t = engine.asset(id) ?? discoveryToken(intel.newTokens.list().find(row => row.asset === id));
    check(t, 'unknown asset', 404);
    const rows = markets(id);
    const r = intel.risk.get(id) ?? store.getRisk(id);
    const links = intel.claims.list(id).filter(l => ['website','x','github','docs','logo'].includes(l.kind) && /^https?:\/\//i.test(l.value))
      .map(l => ({ kind: l.kind, value: l.value, state: l.trust, how: l.wrong ? 'Reported wrong' : l.verified ? 'Verified proof' : l.reporters + ' reporters' }));
    // Supply provenance: own reads (method, source, time, estimate flag) or display-only corroborated peer hints.
    const top = marketPage(id, { limit: 25 }, rows);
    return { ...t, placement: intel.placements.state(id), markets: top.items, marketsTotal: top.total, why: why(id, rows), supply: engine.supply?.display(id) ?? null, risk: r ? { at: r.at, method: r.method, flags: flags(r.flags),
      checks: Object.entries(r.flags).filter(([,on]) => typeof on === 'boolean').map(([flag,on]) => ({ flag,on })) } : null,
      contract: id.endsWith(':native') ? null : id.slice(id.indexOf(':') + 1), links,
      contracts: (t.contracts ?? engine.queries.contracts(id)).map(c => ({ ...c, logo: engine.logos?.chain(c.chain) ?? null })),
      coinGroup: t.coinGroup ?? null, watched: !!store.reader.prepare('SELECT 1 FROM watchlist WHERE asset=?').get(id) };
  }
  function discoveryToken(row) {
    if (!row) return null;
    const t = store.getAsset(row.asset);
    const ageMin = Math.floor(row.ageMs / 60_000);
    return { visibility: 'unconfirmed', staleSince: null, ...t, id: row.asset, name: t?.name ?? row.asset,
      symbol: t?.symbol ?? null, chain: row.asset.split(':')[0], price: t?.price == null ? null : +t.price,
      change: t?.change24h ?? null, firstSeen: row.firstSeen, ageMin,
      age: ageMin < 60 ? ageMin + 'm' : Math.floor(ageMin / 60) + 'h', liquidity: row.liquidityUsd,
      holders: null, flags: flags(row.flags), riskFlags: row.flags };
  }
  function newTokens(options) {
    const now = app.clock();
    const result = pageByAge(store.retainedDiscoveries(intel.newTokens.list()), options, now, MARKET_POLICY.maxNewAge,
      row => Math.min(row.firstSeen, now - row.ageMs));
    result.items = result.items.map(row => ({ ...discoveryToken(row), visibility: row.visibility, staleSince: row.staleSince }));
    return result;
  }
  async function candles(id, q) {
    const tf = Object.hasOwn(widths, q.tf) ? q.tf : '1h';
    const limit = integer(q.limit, 500, 5000) || 5000, width = widths[tf];
    const to = integer(q.to, app.clock() + 1, Number.MAX_SAFE_INTEGER);
    const from = integer(q.from, Math.max(0, Math.floor((to - 1) / width) * width - (limit - 1) * width), to);
    // Keep sparse local history anywhere in the requested interval. Bound upstream
    // work to at most three disjoint pages, each within the engine's 2,000-bar cap.
    const bars = new Map(store.candles({ asset: id, tf, from, to, limit }).map(row => [row.ts, row]));
    let start = from;
    for (let remaining = limit; remaining > 0 && start < to && bars.size < limit; remaining -= 2000) {
      const count = Math.min(remaining, 2000);
      const end = remaining <= 2000 ? to : Math.min(to, (Math.floor(start / width) + count) * width);
      try {
        for (const row of await engine.candles(id, { tf, from: start, to: end, limit: count })) bars.set(row.ts, row);
      } catch (error) {
        if (!bars.size) throw error;
        break;
      }
      start = end;
    }
    const rows = [...bars.values()].sort((a,b) => a.ts - b.ts).slice(0,limit);
    return { asset: id, tf, candles: rows.map(r => ({ t: Math.floor(r.ts / 1000), o: +r.open, h: +r.high,
      l: +r.low, c: +r.close, v: r.volume ?? null })) };
  }
  function* extraCandidates(slot) {
    if (!slot || slot === 'pinned-news') {
      const rows = store.reader.prepare("SELECT key,id FROM social_visible_posts WHERE t='post' AND channel LIKE 'soc/u/%' ORDER BY ts DESC").iterate();
      for (const r of rows) yield { slot: 'pinned-news', authorKey: r.key, envelopeId: r.id };
    }
    for (const kind of ['spotlight','promoted-token']) {
      if (slot && slot !== kind) continue;
      for (const t of store.reader.prepare('SELECT id FROM assets').iterate()) yield { slot: kind, assetId: t.id };
    }
  }
  /** The live item of each slot (or of one slot): a pinned post and a promoted token can run at the same time. */
  function extras(slot) {
    const items = [];
    for (const kind of slot ? [slot] : ['promoted-token', 'pinned-news', 'spotlight']) {
      const [item] = intel.extras.active(extraCandidates(kind), 1);
      if (!item) continue;
      const fields = { slot: item.slot, label: item.label, until: item.purchase.end, purchaseId: item.purchase.id,
        chain: item.purchase.chain, contract: item.purchase.address, contentHash: item.purchase.contentHash };
      if (item.slot === 'pinned-news') fields.post = people.thread({ key: item.authorKey, id: item.envelopeId }).post;
      else fields.token = engine.queries.token(store.getAsset(item.assetId));
      items.push(fields);
    }
    return { items };
  }
  return { resolve, markets, marketPage, why, detail, newTokens, candles, extras, extraCandidates };
}
