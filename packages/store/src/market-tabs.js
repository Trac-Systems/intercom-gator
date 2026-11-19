import { DAY, MINUTE } from './candles.js';
import { integer, page } from './values.js';

// These projections have different row types from the ranked asset list. All identifiers
// used for sorting or filtering come from the fixed specifications below.
const tabs = {
  new: {
    sql: `SELECT pool.*, am.asset, a.name, a.symbol, a.category, p.price, p.priceReal,
      p.change24h, p.trust, r.flags, CAST(max(0,(? - pool.firstSeen) / ` + MINUTE + `) AS INTEGER) AS ageMin
      FROM pools pool LEFT JOIN asset_markets am ON am.market='dex:' || pool.chain || ':' || pool.pool
      LEFT JOIN assets a ON a.id=am.asset LEFT JOIN prices p ON p.asset=am.asset LEFT JOIN risk r ON r.asset=am.asset`,
    sorts: ['firstSeen','ageMin','name','priceReal','change24h','liquidity'],
    filters: ['chain','category','trust','dex'], tie: 'chain,pool,asset',
  },
  categories: {
    sql: `WITH ranked AS (
      SELECT a.symbol, a.category, p.marketCap, p.change24h,
        row_number() OVER (PARTITION BY a.category ORDER BY p.marketCap DESC, a.id) AS position
      FROM assets a LEFT JOIN prices p ON p.asset=a.id WHERE a.category IS NOT NULL AND a.kind='token'
    ) SELECT category AS name, count(*) AS assets, sum(marketCap) AS marketCap,
      sum(marketCap * change24h) / nullif(sum(marketCap) FILTER (WHERE change24h IS NOT NULL),0) AS change24h,
      json_group_array(symbol ORDER BY position) FILTER (WHERE position<=3) AS top
      FROM ranked GROUP BY category`,
    sorts: ['marketCap','name','change24h','assets'], filters: ['name'], tie: 'name',
  },
  chains: {
    sql: `WITH ids(chain) AS (SELECT chain FROM assets UNION SELECT chain FROM pools
        UNION SELECT chain FROM markets WHERE chain IS NOT NULL),
      venues AS (SELECT chain,sum(volume24h) AS volume FROM markets WHERE kind='dex' GROUP BY chain),
      counts AS (SELECT chain,count(*) AS pools,count(*) FILTER (WHERE firstSeen BETWEEN ? AND ?) AS recent
        FROM pools GROUP BY chain)
      SELECT ids.chain AS name, ids.chain, venues.volume AS dexVolume24h,
        coalesce(counts.pools,0) AS pools, coalesce(counts.recent,0) AS newPools24h
      FROM ids LEFT JOIN venues USING(chain) LEFT JOIN counts USING(chain)`,
    sorts: ['dexVolume24h','name','pools','newPools24h'], filters: ['chain'], tie: 'name',
  },
  derivatives: {
    sql: `SELECT id, exchange, chain, base AS symbol, quote, instrument, funding, openInterest, oiChange24h
      FROM markets WHERE instrument <> 'spot'`,
    sorts: ['openInterest','symbol','funding','oiChange24h'], filters: ['chain','exchange','instrument'], tie: 'id',
  },
  exchanges: {
    sql: `SELECT exchange AS name,kind,chain,count(*) AS markets,sum(volume24h) AS volume24h
      FROM markets WHERE exchange IS NOT NULL GROUP BY exchange,kind,chain`,
    sorts: ['volume24h','name','markets'], filters: ['kind','chain','name'], tie: 'name,kind,chain',
  },
};

export function isSummaryTab(tab) { return Object.hasOwn(tabs, tab); }

export function summaryRows(reader, tab, options) {
  const spec = tabs[tab];
  let { sort = spec.sorts[0], order, now = Date.now() } = options;
  if (tab === 'new' && sort === 'price') sort = 'priceReal';
  order ??= ['name','symbol','ageMin'].includes(sort) ? 'asc' : 'desc';
  if (!spec.sorts.includes(sort) || !['asc','desc'].includes(order)) throw new RangeError('Unknown markets sort');
  const args = [], where = [];
  if (tab === 'new' || tab === 'chains') {
    integer(now, 'now');
    if (tab === 'chains') args.push(Math.max(0, now - DAY));
    args.push(now);
  }
  for (const key of spec.filters) {
    if (options[key] == null) continue;
    where.push(key + ' = ?');
    args.push(options[key]);
  }
  const filter = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const rows = reader.prepare('SELECT * FROM (' + spec.sql + ')' + filter + ' ORDER BY ' + sort +
    ' ' + order + ' NULLS LAST, ' + spec.tie + ' LIMIT ? OFFSET ?').all(...args, ...page(options));
  if (tab === 'categories') for (const row of rows) row.top = JSON.parse(row.top);
  if (tab === 'new') for (const row of rows) if (row.flags !== null) row.flags = JSON.parse(row.flags);
  return rows;
}
