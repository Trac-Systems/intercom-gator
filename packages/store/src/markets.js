import { OBS_SPAN_MS } from './observations.js';
import { isSummaryTab, summaryRows } from './market-tabs.js';
import { decimal, integer, page } from './values.js';

/** Shared limits for market lists, retention and book admission. All ages are milliseconds. */
export const MARKET_POLICY = Object.freeze({
  maxPriceAge: 3_600_000,
  maxNewAge: 86_400_000,
  forgetAfter: 7 * 86_400_000,
  minPoolLiquidityUsd: 10_000,
  // Gainers and losers: a red price or a thin market (INDEX +4,587% on $3.5k) is not a mover.
  moverMinVolumeUsd: 50_000,
  ingestWindow: 60_000,
  unprovenPerKey: 120,
  unprovenTotal: 2000,
});

const expired = `p.at < list_clock.now - ${MARKET_POLICY.maxPriceAge}`;
const visibility = `CASE WHEN p.at IS NULL THEN 'unconfirmed' WHEN ${expired} THEN 'stale'
  ELSE coalesce(s.visibility,'unconfirmed') END`;
const staleSince = `CASE WHEN p.at IS NULL THEN NULL WHEN ${expired}
  THEN min(coalesce(s.staleSince,p.at+${MARKET_POLICY.maxPriceAge}),p.at+${MARKET_POLICY.maxPriceAge})
  ELSE s.staleSince END`;
const columns = `a.*, p.price, p.priceReal, p.at, p.change1h, p.change24h, p.change7d,
  p.volume24h, p.marketCap, p.fdv, p.trust, p.agents, p.exchanges, p.trending, p.floor, p.floorCurrency,
  ${visibility} AS visibility, ${staleSince} AS staleSince`;
// Every row in a page and its counts use the same clock reading, including on a slow scan.
const assetsAt = time => ` FROM main.assets a LEFT JOIN prices p ON p.asset=a.id
  LEFT JOIN store_market_list s ON s.asset=a.id CROSS JOIN (SELECT ${time} AS now) list_clock`;
const joined = assetsAt('?');
const sorts = {
  rank: 'a.rank', symbol: 'a.symbol COLLATE NOCASE', name: 'a.name COLLATE NOCASE', price: 'p.priceReal',
  change1h: 'p.change1h', change24h: 'p.change24h', change7d: 'p.change7d',
  volume24h: 'p.volume24h', marketCap: 'p.marketCap', fdv: 'p.fdv', trending: 'p.trending', views: 'a.views',
};
const mover = `coalesce(p.trust,'') <> 'red' AND p.volume24h >= ${MARKET_POLICY.moverMinVolumeUsd}`;
const tabs = {
  all: "a.kind='token'", nfts: "a.kind='nft'", watch: 'a.id IN (SELECT asset FROM watchlist)',
  trending: "a.kind='token' AND p.trending IS NOT NULL",
  gainers: `a.kind='token' AND p.change24h > 0 AND ${mover}`, losers: `a.kind='token' AND p.change24h < 0 AND ${mover}`,
};

/** @param {import('./database.js').StoreDatabase} db */
export function marketAccessors({ writer, reader, transaction }) {
  // A derived list index. Existing stores start without standing evidence until the book refreshes them.
  writer.exec(`CREATE TABLE IF NOT EXISTS store_market_list (
    asset TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE, firstSeen INTEGER NOT NULL, lastObserved INTEGER,
    forgotten INTEGER NOT NULL DEFAULT 0, visibility TEXT NOT NULL DEFAULT 'unconfirmed'
      CHECK(visibility IN ('live','stale','unconfirmed','dust')), staleSince INTEGER
  ) STRICT, WITHOUT ROWID`);
  let clock = Date.now, tracking = false;
  const register = writer.prepare('INSERT OR IGNORE INTO store_market_list(asset,firstSeen) VALUES (?,?)');
  const activity = writer.prepare(`INSERT INTO store_market_list(asset,firstSeen,lastObserved) VALUES (?1,?2,?2)
    ON CONFLICT(asset) DO UPDATE SET lastObserved=excluded.lastObserved,forgotten=0
    WHERE lastObserved IS NULL OR excluded.lastObserved>lastObserved`);
  const saveVisibility = writer.prepare(`INSERT INTO store_market_list(asset,firstSeen,lastObserved,visibility,staleSince)
    VALUES (?1,?2,?2,?3,?4) ON CONFLICT(asset) DO UPDATE SET lastObserved=max(coalesce(lastObserved,0),excluded.lastObserved),
    forgotten=CASE WHEN excluded.lastObserved>coalesce(lastObserved,0) THEN 0 ELSE forgotten END,
    visibility=excluded.visibility,staleSince=excluded.staleSince`);
  const hasMoveAlerts = writer.prepare("SELECT 1 FROM sqlite_schema WHERE name='api_move_alerts'").get();
  const protectedAsset = `a.id IN (SELECT asset FROM watchlist UNION SELECT asset FROM portfolio
    UNION SELECT asset FROM alerts ${hasMoveAlerts ? 'UNION SELECT asset FROM api_move_alerts' : ''})`;
  const retained = `(coalesce(s.forgotten,0)=0 OR ${protectedAsset})`;
  const forget = writer.prepare(`UPDATE store_market_list SET forgotten=1 WHERE forgotten=0 AND coalesce(lastObserved,firstSeen)<=?
    AND asset NOT IN (SELECT a.id FROM assets a WHERE ${protectedAsset})`);
  const member = reader.prepare(`SELECT ${retained} AS kept FROM assets a
    LEFT JOIN store_market_list s ON s.asset=a.id WHERE a.id=?`);
  const forgetCutoff = reader.prepare("SELECT value FROM settings WHERE key='store:market-forget-before'");
  const saveCutoff = writer.prepare(`INSERT INTO settings(key,value) VALUES ('store:market-forget-before',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`);

  const assetWrite = writer.prepare(`INSERT INTO assets(id, chain, address, symbol, name, category, rank, kind)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET symbol=excluded.symbol,
    name=excluded.name, category=excluded.category, rank=excluded.rank, kind=excluded.kind`);
  const marketWrite = writer.prepare(`INSERT INTO markets(id,kind,exchange,chain,base,quote,instrument,
    volume24h,funding,openInterest,oiChange24h) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, exchange=excluded.exchange, chain=excluded.chain,
    base=excluded.base, quote=excluded.quote, instrument=excluded.instrument, volume24h=excluded.volume24h,
    funding=excluded.funding, openInterest=excluded.openInterest, oiChange24h=excluded.oiChange24h`);
  const link = writer.prepare('INSERT INTO asset_markets VALUES (?,?) ON CONFLICT DO NOTHING');
  const savePrice = writer.prepare(`INSERT INTO prices(asset,price,at,change1h,change24h,change7d,
    volume24h,marketCap,fdv,trust,agents,exchanges,trending,floor,floorCurrency) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(asset) DO UPDATE SET price=excluded.price, at=excluded.at, change1h=excluded.change1h,
    change24h=excluded.change24h, change7d=excluded.change7d, volume24h=excluded.volume24h,
    marketCap=excluded.marketCap, fdv=excluded.fdv, trust=excluded.trust, agents=excluded.agents,
    exchanges=excluded.exchanges, trending=excluded.trending, floor=excluded.floor,
    floorCurrency=excluded.floorCurrency WHERE excluded.at >= prices.at`);
  const asset = reader.prepare('SELECT ' + columns + joined + ' WHERE a.id = ?');
  const view = writer.prepare('UPDATE assets SET views = views + 1 WHERE id = ?');
  const market = reader.prepare('SELECT * FROM markets WHERE id = ?');
  const linked = reader.prepare(`SELECT m.* FROM asset_markets am JOIN markets m ON m.id=am.market
    WHERE am.asset=? ORDER BY m.id`);
  const price = reader.prepare('SELECT * FROM prices WHERE asset = ?');
  const prefixSearch = reader.prepare(`SELECT ` + columns + joined + ` WHERE a.id IN (
    SELECT id FROM assets WHERE symbol LIKE ? ESCAPE '!'
    UNION SELECT id FROM assets WHERE name LIKE ? ESCAPE '!'
    UNION SELECT id FROM assets WHERE address GLOB ?
    UNION SELECT id FROM assets WHERE id GLOB ?
    ) AND ${retained} ORDER BY a.rank NULLS LAST, a.id LIMIT ? OFFSET ?`);

  function selection(options) {
    const { tab = 'all', chain, category, trust } = options;
    if (!Object.hasOwn(tabs, tab)) throw new RangeError('Unknown markets tab');
    const where = [tabs[tab], retained];
    if (options.categorized) where.push('a.category IS NOT NULL');
    const params = [];
    for (const [column, value] of [['a.chain', chain], ['a.category', category], ['p.trust', trust]]) {
      if (value != null) { where.push(column + ' = ?'); params.push(value); }
    }
    return { filter: ' WHERE ' + where.join(' AND '), params };
  }
  function visibleFilter(options) {
    return options.include === 'hidden' || ['watch', 'nfts'].includes(options.tab) ? '' : ` AND ${visibility}='live'`;
  }
  // Scope the inputs to the existing summary projections. Filtering their finished groups
  // would leave hidden members in category caps, chain turnover and pool counts.
  function summaryList(tab, options) {
    const now = integer(options.now ?? clock(), 'now');
    const all = options.include === 'hidden';
    let sources;
    if (tab === 'categories' || tab === 'chains') {
      const eligible = `eligible AS (SELECT a.id ${assetsAt(now)} WHERE a.kind='token' AND ${retained}${visibleFilter(options)})`;
      if (tab === 'categories') {
        sources = eligible + ', assets AS (SELECT * FROM main.assets WHERE id IN eligible)';
      } else {
        sources = eligible + `, admitted AS (SELECT id FROM main.markets WHERE base IN eligible
          UNION SELECT market FROM asset_markets WHERE asset IN eligible),
          markets AS (SELECT * FROM main.markets WHERE id IN admitted),
          pools AS (SELECT * FROM main.pools WHERE 'dex:'||chain||':'||pool IN admitted
          ${all ? "OR 'dex:'||chain||':'||pool NOT IN (SELECT id FROM main.markets)" : ''})`;
      }
    } else if (!all) {
      const recent = `SELECT DISTINCT market FROM obs WHERE srcTs>=${now - MARKET_POLICY.maxPriceAge - OBS_SPAN_MS}
        AND coalesce(lastTs,srcTs)>=${now - MARKET_POLICY.maxPriceAge}`;
      if (tab === 'new') sources = `pools AS (SELECT * FROM main.pools WHERE firstSeen>=${now - MARKET_POLICY.maxNewAge})`;
      if (tab === 'derivatives') sources = `markets AS (SELECT * FROM main.markets WHERE id IN (${recent}))`;
      if (tab === 'exchanges') sources = `markets AS (SELECT * FROM main.markets WHERE exchange IN
        (SELECT exchange FROM main.markets WHERE id IN (${recent})))`;
    }
    const source = sources ? { prepare: sql => reader.prepare('WITH ' + sources + ' ' + sql) } : reader;
    return summaryRows(source, tab, { ...options, now });
  }
  /** The Markets screen lists assets. Use marketsForAsset for trading pairs. */
  function listMarkets(options = {}) {
    let { tab = 'all', sort, order } = options;
    if (isSummaryTab(tab)) return summaryList(tab, options);
    if (tab === 'nfts' && sort === 'floor') sort = 'price';
    sort ??= tab === 'trending' ? 'trending' : ['gainers', 'losers'].includes(tab) ? 'change24h' : 'rank';
    order ??= ['rank', 'symbol', 'name'].includes(sort) || (tab === 'losers' && sort === 'change24h') ? 'asc' : 'desc';
    if (!Object.hasOwn(sorts, sort) || !['asc', 'desc'].includes(order)) throw new RangeError('Unknown markets sort');
    const { filter, params } = selection(options);
    return reader.prepare('SELECT ' + columns + joined + filter + visibleFilter(options) + ' ORDER BY ' + sorts[sort] + ' ' + order +
      ' NULLS LAST, a.id LIMIT ? OFFSET ?').all(options.now ?? clock(), ...params, ...page(options));
  }

  return {
    /** Install the engine clock and extend the store's existing prune transaction once per open store. */
    trackMarketActivity(now, onPrune) {
      clock = now;
      if (tracking) return;
      // A legacy asset may have raw observations without a convertible USD snapshot. Seed its
      // activity once, before raw history rolls off. A registry refresh never renews this timestamp.
      if (writer.prepare('SELECT 1 FROM assets a LEFT JOIN store_market_list s ON s.asset=a.id WHERE s.asset IS NULL LIMIT 1').get()) {
        writer.prepare(`WITH observations AS (
          SELECT market,max(coalesce(lastTs,srcTs)) AS at FROM obs GROUP BY market
        ), evidence AS (
          SELECT asset,at FROM prices UNION ALL
          SELECT m.base,o.at FROM observations o JOIN markets m ON m.id=o.market UNION ALL
          SELECT m.quote,o.at FROM observations o JOIN markets m ON m.id=o.market
        ), latest AS (SELECT asset,max(at) AS at FROM evidence GROUP BY asset)
        INSERT OR IGNORE INTO store_market_list(asset,firstSeen,lastObserved)
        SELECT a.id,?,l.at FROM assets a LEFT JOIN latest l ON l.asset=a.id`).run(clock());
      }
      tracking = true;
      onPrune((db, { now }) => {
        const cutoff = now - MARKET_POLICY.forgetAfter;
        forget.run(cutoff);
        saveCutoff.run(String(cutoff));
      });
    },
    recordMarketActivity(asset, at) { activity.run(asset, at); },
    /** A New discovery can precede registration. Use its first local sighting until a market is registered. */
    retainedDiscoveries(rows) {
      const saved = forgetCutoff.get();
      if (!saved) return rows;
      const cutoff = Number(saved.value);
      return rows.filter(row => member.get(row.asset)?.kept ?? row.firstSeen > cutoff);
    },
    rankedAssetIds(options = {}) {
      const { filter, params } = selection(options);
      return new Set(reader.prepare('SELECT a.id' + joined + filter + visibleFilter(options)).all(options.now ?? clock(), ...params).map(r => r.id));
    },
    marketCounts(options = {}) {
      const { filter, params } = selection(options);
      const hidden = { stale: 0, unconfirmed: 0, dust: 0 };
      const defaultFilter = visibleFilter({ tab: options.tab });
      const showAll = !defaultFilter || options.include === 'hidden';
      let total = 0;
      for (const row of reader.prepare(`SELECT ${visibility} AS state,count(*) AS n` + joined + filter + ' GROUP BY state').all(options.now ?? clock(), ...params)) {
        if (defaultFilter && row.state !== 'live') hidden[row.state] = row.n;
        if (row.state === 'live' || showAll) total += row.n;
      }
      return { total, hidden };
    },
    /** Identity is chain:address. Registry refreshes retain local view counts. */
    upsertAsset({ id, symbol, name, category = null, rank = null, kind = 'token' }) {
      const colon = typeof id === 'string' ? id.indexOf(':') : -1;
      if (colon < 1 || colon === id.length - 1) throw new TypeError('Expected chain:address asset id');
      assetWrite.run(id, id.slice(0, colon), id.slice(colon + 1), symbol, name, category, rank, kind);
      if (tracking) register.run(id, clock());
    },
    getAsset: id => asset.get(clock(), id),
    recordView: id => view.run(id).changes,
    upsertMarket({ id, kind, exchange = null, chain = null, base, quote, instrument = 'spot',
      volume24h = null, funding = null, openInterest = null, oiChange24h = null }) {
      marketWrite.run(id, kind, exchange, chain, base, quote, instrument, volume24h, funding, openInterest, oiChange24h);
    },
    getMarket: id => market.get(id),
    linkAssetMarket: (asset, market) => link.run(asset, market).changes,
    marketsForAsset: id => linked.all(id),
    /** Replace the current USD snapshot only if it is at least as recent. */
    upsertPrice({ asset, price, at, change1h = null, change24h = null, change7d = null,
      volume24h = null, marketCap = null, fdv = null, trust = null, agents = null, exchanges = null, trending = null,
      floor = null, floorCurrency = null, visibility = 'unconfirmed', staleSince = null }) {
      return transaction(() => {
        const changes = savePrice.run(asset, decimal(price), integer(at, 'at'), change1h, change24h, change7d,
          volume24h, marketCap, fdv, trust, agents, exchanges, trending, floor === null ? null : decimal(floor, 'floor'), floorCurrency).changes;
        if (changes) saveVisibility.run(asset, at, visibility, staleSince);
        return changes;
      });
    },
    getPrice: id => price.get(id),
    listMarkets,
    movers({ direction = 'gainers', ...options } = {}) {
      if (!['gainers', 'losers'].includes(direction)) throw new RangeError('Unknown movers direction');
      return listMarkets({ ...options, tab: direction });
    },
    searchAssets(prefix, paging) {
      if (typeof prefix !== 'string') throw new TypeError('Expected a search prefix');
      if (!prefix) return [];
      const pattern = prefix.replace(/[!%_]/gu, '!$&') + '%';
      // EVM ids use lowercase hex. Other address alphabets can distinguish letter case.
      const canonical = prefix.replace(/(^|:)0x[\da-f]*/giu, part => part.toLowerCase());
      const glob = canonical.replace(/[?*\[]/gu, char => '[' + char + ']') + '*';
      return prefixSearch.all(clock(), pattern, pattern, glob, glob, ...page(paging));
    },
  };
}
