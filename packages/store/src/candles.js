import { compareDecimal, decimal, integer, page, timeRange } from './values.js';

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
const FRAMES = { '1m': MINUTE, '5m': 5 * MINUTE, '1h': 60 * MINUTE, '1d': DAY };
const bucket = (ts, width) => ts - ts % width;

/** Merge disjoint sets of observations. Source time orders the ends; insertion id breaks ties. */
function mergeBar(bar, delta) {
  if (compareDecimal(delta.high, bar.high) > 0) bar.high = delta.high;
  if (compareDecimal(delta.low, bar.low) < 0) bar.low = delta.low;
  if (delta.firstTs < bar.firstTs || (delta.firstTs === bar.firstTs && delta.firstId < bar.firstId)) {
    bar.firstTs = delta.firstTs;
    bar.firstId = delta.firstId;
    bar.open = delta.open;
  }
  if (delta.lastTs > bar.lastTs || (delta.lastTs === bar.lastTs && delta.lastId > bar.lastId)) {
    bar.lastTs = delta.lastTs;
    bar.lastId = delta.lastId;
    bar.close = delta.close;
  }
  bar.samples += delta.samples;
}

/** @param {import('./database.js').StoreDatabase} db */
export function candleAccessors({ transaction, writer, reader }) {
  const current = writer.prepare('SELECT * FROM candles WHERE asset=? AND tf=? AND ts=?');
  const save = writer.prepare(`INSERT INTO candles(asset,tf,ts,open,high,low,close,samples,firstTs,firstId,lastTs,lastId)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(asset,tf,ts) DO UPDATE SET open=excluded.open, high=excluded.high,
    low=excluded.low, close=excluded.close, samples=excluded.samples, firstTs=excluded.firstTs,
    firstId=excluded.firstId, lastTs=excluded.lastTs, lastId=excluded.lastId`);
  const candles = reader.prepare(`SELECT asset,tf,ts,open,high,low,close,samples FROM candles
    WHERE asset=? AND tf=? AND ts>=? AND ts<? ORDER BY ts LIMIT ? OFFSET ?`);
  // Apply only the new minute contributions. Reapplying a whole minute to its parent would double-count
  // earlier observations, and rebuilding parents from children would lose expired history.
  function flush(minutes) {
    for (const delta of minutes.values()) {
      for (const [tf, width] of Object.entries(FRAMES)) {
        const ts = bucket(delta.firstTs, width);
        const stored = current.get(delta.asset, tf, ts);
        if (stored) mergeBar(stored, delta);
        const bar = stored ?? delta;
        save.run(delta.asset, tf, ts, bar.open, bar.high, bar.low, bar.close, bar.samples,
          bar.firstTs, bar.firstId, bar.lastTs, bar.lastId);
      }
    }
    minutes.clear();
  }

  /** Asset candles come only from the aggregated USD price (after outlier trimming and trust),
   *  one sample per change of that price. Samples apply in time order per bar, so a late sample
   *  can extend high/low but never replaces a newer close.
   *  @param {Iterable<{asset: string, price: string, at: number}>} samples */
  function recordPrices(samples) {
    return transaction(() => {
      const minutes = new Map();
      let recorded = 0;
      for (const { asset, price, at } of samples) {
        const usd = decimal(price);
        integer(at, 'at');
        const sample = { asset, open: usd, high: usd, low: usd, close: usd, samples: 1,
          firstTs: at, firstId: 0, lastTs: at, lastId: 0 };
        const key = asset + ':' + bucket(at, MINUTE);
        const existing = minutes.get(key);
        if (existing) mergeBar(existing, sample);
        else minutes.set(key, sample);
        recorded++;
        if (minutes.size >= 1024) flush(minutes);
      }
      flush(minutes);
      return recorded;
    });
  }

  return {
    recordPrices,
    candles({ asset, tf = '1m', ...options }) {
      if (!Object.hasOwn(FRAMES, tf)) throw new RangeError('Unknown candle timeframe');
      return candles.all(asset, tf, ...timeRange(options), ...page(options));
    },
  };
}
