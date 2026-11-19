import { setTimeout as delay } from 'node:timers/promises';
import { routerFor } from './routes.js';
import { deploymentId } from '../sources/bundle-adapter.js';
import { DAY, isAddress } from './values.js';

// Volume can be observed before supply is available for BTC dominance (and vice versa).
export const independentMarketDays = {
  id: 'engine:intel-002-market-days',
  up(db) {
    db.exec(`CREATE TABLE intel_market_days_new (
      at INTEGER PRIMARY KEY, observedAt INTEGER NOT NULL, volumeUsd REAL, btcDominance REAL
    ) STRICT;
    INSERT INTO intel_market_days_new SELECT at,observedAt,volumeUsd,btcDominance FROM intel_market_days;
    DROP TABLE intel_market_days;
    ALTER TABLE intel_market_days_new RENAME TO intel_market_days;`);
  },
};

const priceAssets = [['bitcoin:native', 'btcClose'], ['ethereum:native', 'ethClose']];
const lookback = 121; // 91 completed days for the score 30 days ago.

/** Keep one bounded cache entry per asset. Requests (including failures) share the
 * UTC day's allowance. A fresh local candle always takes priority over cached closes. */
function dailyPrices(engine) {
  const { store, registry } = engine, requests = new Map();

  function readyAt(asset, range) {
    // The first intel refresh can precede market discovery. Wait for a convertible
    // daily route before spending the day's only attempt on an empty registry.
    const convertible = new Map([['fiat:USD', true]]);
    let ready = null;
    for (const m of registry.markets.values()) {
      if (m.base !== asset || m.kind !== 'cex' || !m.symbol) continue;
      const spec = registry.venues.get(m.exchange)?.candles;
      if (!spec?.intervals?.['1d']) continue;
      if (!convertible.has(m.quote)) convertible.set(m.quote, store.candles({ ...range, asset: m.quote, limit: 1 }).length > 0);
      if (!convertible.get(m.quote)) continue;
      // BTC and ETH often share their only host. Respect its existing cooldown
      // before dispatching the next asset through CandleHistory's scheduler.
      const bucket = engine.http?.hosts?.get(new URL(spec.url).origin);
      ready = Math.max(ready ?? 0, bucket?.next ?? 0);
    }
    return ready;
  }

  async function venueCloses(asset, day, fetchMissing) {
    const current = requests.get(asset);
    if (current?.day === day) return current.result;
    const key = 'intel:fear-greed:closes/' + asset, saved = store.getSetting?.(key);
    if (saved?.day === day) return saved.closes;
    const from = Math.max(0, day - lookback * DAY);
    const range = { tf: '1d', from, to: day, limit: lookback + 1 };
    const closes = new Map(saved?.closes?.filter(([ts]) => ts >= from && ts < day));
    if (!fetchMissing) return [...closes];
    const ready = readyAt(asset, range);
    if (ready === null || (engine.budget && engine.budget.used >= engine.budget.limit)) return [...closes];
    const entry = { day };
    async function fetchCloses() {
      let bars;
      const wait = ready - engine.clock();
      if (wait > 0) {
        await delay(wait, undefined, { signal: engine.http?.signal });
        const latest = store.getSetting?.(key);
        if (latest?.day === day) return latest.closes;
      }
      if (Math.floor(engine.clock() / DAY) * DAY !== day) return [...closes];
      // Record the attempt before dispatch so a same-day restart also respects the cap.
      store.setSetting?.(key, { day, closes: [...closes] });
      try { bars = await engine.candles(asset, range); }
      catch { return [...closes]; } // A venue or its budget can be unavailable.
      for (const { ts, close } of bars) {
        if (Number.isSafeInteger(ts) && ts % DAY === 0 && ts >= from && ts < day && Number.isFinite(+close) && +close > 0) {
          closes.set(ts, close);
        }
      }
      const result = [...closes];
      if (requests.get(asset) === entry) store.setSetting?.(key, { day, closes: result });
      return result;
    }
    requests.set(asset, entry);
    entry.result = fetchCloses().catch(error => {
      if (requests.get(asset) === entry) requests.delete(asset);
      throw error;
    });
    return entry.result;
  }

  return async function fill(days, from, to, backfillFrom) {
    const day = Math.floor(engine.clock() / DAY) * DAY;
    const start = Math.max(0, from), limit = Math.ceil((to - start) / DAY);
    if (limit <= 0) return;
    const readLocal = asset => store.candles({ asset, tf: '1d', from: start, to, limit })
      .filter(c => Number.isFinite(+c.close) && +c.close > 0);
    function setClose(ts, field, close) {
      if (!days.has(ts)) days.set(ts, { at: ts });
      days.get(ts)[field] = close;
    }
    if (start < day && to > day - lookback * DAY) {
      const first = Math.max(start, backfillFrom, day - lookback * DAY), end = Math.min(day, to);
      const need = Math.ceil((end - first) / DAY);
      for (const [asset, field] of priceAssets) {
        const local = readLocal(asset);
        if (local.length === limit) continue;
        const have = local.filter(c => c.ts >= first && c.ts < end).length;
        for (const [ts, close] of await venueCloses(asset, day, have < need)) {
          if (ts >= start && ts < to) setClose(ts, field, close);
        }
      }
    }
    // Overlay both assets after all venue reads, including local observations received in flight.
    for (const [asset, field] of priceAssets) {
      for (const { ts, close } of readLocal(asset)) setClose(ts, field, close);
    }
  };
}

/** Read market data through the shared store and the engine's budgeted candle history. */
export function engineData(engine) {
  const { store, bundle, registry } = engine;
  // The asset's markets through indexes only (asset_markets for the base side, markets(quote) for the quote side);
  // `base=? OR quote=?` on markets scanned the whole table for every listed discovery (/new took 10-25 s).
  const assetMarkets = 'SELECT market FROM asset_markets WHERE asset=:asset UNION SELECT id FROM markets WHERE quote=:asset';
  const pools = store.reader.prepare(`SELECT p.* FROM (${assetMarkets}) x JOIN markets m ON m.id=x.market AND m.kind='dex'
    JOIN pools p ON p.chain=m.chain AND p.pool=substr(m.id, length(m.chain)+6)
    ORDER BY p.liquidity DESC NULLS LAST, p.firstSeen DESC LIMIT 1`);
  const trades = store.reader.prepare(`SELECT count(*) AS n FROM engine_trades
    WHERE market IN (${assetMarkets}) AND at>=:from AND at<:to`);
  const dailyGlobals = store.reader.prepare('SELECT * FROM intel_market_days WHERE at>=? AND at<?');
  const globalWrite = store.writer.prepare(`INSERT INTO intel_market_days(at,observedAt,volumeUsd,btcDominance) VALUES (?,?,?,?)
    ON CONFLICT(at) DO UPDATE SET observedAt=excluded.observedAt,
    volumeUsd=coalesce(excluded.volumeUsd,volumeUsd), btcDominance=coalesce(excluded.btcDominance,btcDominance)
    WHERE excluded.observedAt >= intel_market_days.observedAt`);
  const quoted = new Set((bundle.dex?.evm ?? []).flatMap(d => (d.quoteTokens ?? []).map(q => d.chain + ':' + q.address.toLowerCase())));
  const fillPrices = dailyPrices(engine);
  function poolFor(asset) {
    return pools.get({ asset });
  }
  return {
    rpc: engine.rpc, bundle, store, transport: engine.transport, now: engine.clock,
    isMuted: key => engine.book.muted(key),
    isProven: key => engine.book.isProven(key),
    isFollowed: key => engine.book.followed(key),
    isKnownAsset: id => quoted.has(id) || id.endsWith(':native'),
    resolveAssets(m) {
      const market = m.t === 'pool' ? 'dex:' + m.chain + ':' + (isAddress(m.pool) ? m.pool.toLowerCase() : m.pool)
        : 'cex:' + m.exchange + ':' + m.symbol;
      const known = registry.markets.get(market);
      return known ? [known.base] : undefined;
    },
    resolveSymbol(sym) {
      const ids = registry.symbols.get(sym);
      return ids?.size === 1 ? [...ids][0] : null;
    },
    resolveContext(asset) {
      const p = poolFor(asset);
      if (!p) return {};
      const dex = bundle.dex?.evm?.find(d => d.chain === p.chain);
      const matches = dex?.deployments?.filter(d => d.kind === p.kind &&
        (d.name === p.dex || deploymentId(d.name) === p.dex));
      const deployment = matches?.length === 1 ? matches[0] : undefined;
      const pool = { address: p.pool, kind: p.kind, router: routerFor(p.chain, deployment), routerKind: deployment?.routerKind,
        factory: deployment?.address, discoveryTx: p.tx };
      const prices = Object.fromEntries([p.token0, p.token1].map(t => [t, store.getPrice(p.chain + ':' + t)?.price]));
      return { pool, prices, lockers: dex?.lockers };
    },
    metricsFor(asset) {
      const time = engine.clock(), row = poolFor(asset);
      return { liquidityUsd: row?.liquidity, trades: trades.get({ asset, from: time - DAY, to: time + 1 }).n };
    },
    sampleGlobal(at) {
      const { volume24h, btcDominance } = engine.global();
      const volume = Number.isFinite(volume24h) && volume24h >= 0 ? volume24h : null;
      const dominance = Number.isFinite(btcDominance) && btcDominance > 0 && btcDominance <= 100 ? btcDominance : null;
      if (volume !== null || dominance !== null) globalWrite.run(Math.floor(at / DAY) * DAY, at, volume, dominance);
    },
    async dailyMarket({ from, to }, { backfillFrom = from } = {}) {
      const days = new Map(dailyGlobals.all(from, to).map(r => [r.at, r]));
      await fillPrices(days, from, to, backfillFrom);
      return [...days.values()];
    },
  };
}
