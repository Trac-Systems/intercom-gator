import { isDeepStrictEqual } from 'node:util';
import { DAY, isTime } from './values.js';
import { socialScore } from './sentiment.js';

const mean = samples => samples.reduce((sum, value) => sum + value / samples.length, 0);
const score = n => Math.max(0, Math.min(100, Math.round(n)));
const midnight = at => Math.floor(at / DAY) * DAY;
const socialAuthors = 'followed-or-proven';
const comparisons = { yesterday: 1, lastWeek: 7, lastMonth: 30 };
const finite = n => (typeof n === 'number' || (typeof n === 'string' && /^\d+(\.\d+)?$/.test(n))) &&
  Number.isFinite(Number(n)) ? Number(n) : null;

// Symmetric ratio change, bounded even when a baseline is zero.
const relative = (a, b) => a === b ? 0 : (a - b) / (a + b);

// The shared accessor writes the inputs JSON. Keep its public array shape and store
// the indexed day's completeness in the same SQLite transaction, including on upsert.
export const partialFearGreed = {
  id: 'engine:intel-003-partial-fear-greed',
  up(db) {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='fear_greed'").get()) return;
    db.exec('ALTER TABLE fear_greed ADD COLUMN partial INTEGER NOT NULL DEFAULT 0 CHECK(partial IN (0,1))');
    for (const [name, event] of [['insert', 'INSERT'], ['update', 'UPDATE OF inputs']]) {
      db.exec(`CREATE TRIGGER intel_fear_greed_${name} AFTER ${event} ON fear_greed BEGIN
        UPDATE fear_greed SET partial=EXISTS (
          SELECT 1 FROM json_each(NEW.inputs) WHERE type='object' AND json_extract(value,'$.status')='collecting'
        ) WHERE at=NEW.at;
      END`);
    }
  },
};

export function fearGreedLabel(value) {
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  if (value < 25) return 'Extreme fear';
  if (value < 45) return 'Fear';
  if (value <= 55) return 'Neutral';
  if (value <= 75) return 'Greed';
  return 'Extreme greed';
}

function volatility(closes, count) {
  const series = closes.slice(-count - 1);
  const returns = series.slice(1).map((v, i) => Math.log(v) - Math.log(series[i]));
  const average = mean(returns);
  return Math.sqrt(returns.reduce((sum, r) => sum + (r - average) ** 2, 0) / (count - 1));
}

function component(name, value, have, need) {
  return value === null ? { name, value, status: 'collecting', days: { have, need } } : { name, value, status: 'ok' };
}

function priceFactor(name, days, need, measure) {
  const pairs = days.slice(-need).map(row => [finite(row?.btcClose), finite(row?.ethClose)])
    .filter(([btc, eth]) => btc > 0 && eth > 0);
  if (pairs.length < need) return component(name, null, pairs.length, need);
  const btc = measure(pairs.map(([close]) => close)), eth = measure(pairs.map(([, close]) => close));
  return component(name, score(mean([btc, eth])), pairs.length, need);
}

function monthlyFactor(name, days, field, valid, measure) {
  const series = days.slice(-31).map(row => finite(row?.[field])).filter(n => n !== null && valid(n));
  const value = series.length === 31 ? score(measure(series.at(-1), mean(series.slice(0, -1)))) : null;
  return component(name, value, series.length, 31);
}

/** @typedef {{name: string, value: number|null, status: 'ok'|'collecting',
 *             days?: {have: number, need: number}, authors?: string}} FearGreedInput
 * @typedef {{at: number, value: number|null, label: string|null, inputs: FearGreedInput[],
 *            partial: boolean, missing: string[]}} FearGreedPoint */

/** daily contains timestamped UTC daily observations. at is the snapshot boundary.
 * Uses the 91 completed UTC days before that boundary. Incomplete inputs remain null.
 * @returns {FearGreedPoint} */
export function computeFearGreed({ daily, posts, at = Date.now(), isFollowed, isProven }) {
  if (!isTime(at)) throw new TypeError('Invalid snapshot time');
  at = midnight(at);
  const start = at - 91 * DAY, days = Array(91).fill(null);
  for (const row of daily ?? []) {
    if (!isTime(row?.at) || row.at < start || row.at >= at) continue;
    const index = Math.floor((row.at - start) / DAY);
    if (!days[index] || days[index].at < row.at) days[index] = row;
  }
  const vol = priceFactor('Volatility', days, 91, closes => {
    const short = volatility(closes, 30), long = volatility(closes, 90);
    return Math.max(short, long) < 1e-12 ? 50 : 50 - 100 * relative(short, long);
  });
  const momentum = priceFactor('Momentum', days, 90, closes => {
    const last = closes.at(-1);
    return 50 + 200 * mean([relative(last, mean(closes.slice(-30))), relative(last, mean(closes))]);
  });
  const volume = monthlyFactor('Volume', days, 'volumeUsd', n => n >= 0, (last, prior) => 50 + 100 * relative(last, prior));
  const social = component('Social', socialScore(posts, at, { isFollowed, isProven }), 0, 8);
  const dominance = monthlyFactor('BTC dominance', days, 'btcDominance', n => n > 0 && n <= 100,
    (last, prior) => 50 - 5 * (last - prior));
  const inputs = [vol, momentum, volume, { ...social, authors: socialAuthors }, dominance];
  const available = inputs.filter(i => i.status === 'ok'), missing = inputs.filter(i => i.status === 'collecting').map(i => i.name);
  const value = available.length >= 2 && (vol.value !== null || momentum.value !== null)
    ? score(mean(available.map(i => i.value))) : null;
  return { at, value, label: fearGreedLabel(value), inputs, partial: missing.length > 0, missing };
}

function storedPoint(row) {
  // Pre-upgrade rows with a value were only written when all five inputs existed.
  const inputs = (row.inputs ?? []).map(input => ({ ...input, status: input.status ?? 'ok' }));
  const missing = inputs.filter(i => i.status === 'collecting').map(i => i.name);
  return { ...row, inputs, partial: Boolean(row.partial ?? missing.length), missing };
}

/** dailyMarket and postsSince receive half-open UTC ranges in ms. Comparison values
 * use the same market read as today's value. A complete stored day is final. */
export function createFearGreed({ dailyMarket, postsSince, store, now = Date.now, isFollowed, isProven }) {
  const memory = new Map(), pending = new Map();
  function history({ from = 0, to = Number.MAX_SAFE_INTEGER, limit = 100 } = {}) {
    if (store) return store.fearGreedHistory({ from, to, limit }).map(storedPoint);
    return structuredClone([...memory.values()].filter(r => r.at >= from && r.at < to).sort((a, b) => b.at - a.at).slice(0, limit));
  }
  async function build(at) {
    const range = { from: Math.max(0, at - 30 * DAY), to: at + DAY, limit: 31 };
    const points = new Map(history(range).map(row => [row.at, row]));
    const today = points.get(at);
    const legacyToday = row => row?.at === at && at === midnight(now()) &&
      !row.inputs.some(input => input.name === 'Social' && input.authors === socialAuthors);
    const needed = Object.values(comparisons).map(offset => at - offset * DAY)
      .filter(date => date >= 0 && (!points.has(date) || points.get(date).partial));
    if (!today || today.partial || legacyToday(today)) needed.push(at);
    if (needed.length) {
      const first = Math.min(...needed), to = Math.max(...needed);
      // Read the wider local calendar once. Only a gap in the requested day's price
      // window can initiate backfill. Comparisons share any resulting venue history.
      const backfillFrom = needed.includes(at) ? Math.max(0, at - 91 * DAY) : to;
      const [daily, posts] = await Promise.all([
        dailyMarket({ from: Math.max(0, first - 91 * DAY), to }, { backfillFrom }),
        postsSince?.({ from: Math.max(0, first - 8 * DAY), to }),
      ]);
      // Another snapshot may have completed one of these dates during the market read.
      for (const saved of history(range)) points.set(saved.at, saved);
      for (const date of needed) {
        const saved = points.get(date);
        if (saved && !saved.partial && !legacyToday(saved)) continue;
        const row = computeFearGreed({ at: date, daily, posts, isFollowed, isProven });
        // Keep an observed comparison unless the shared data supplies more inputs.
        // For today's partial, also accept fresher evidence at the same coverage.
        if (saved?.partial && (row.value === null || row.missing.length > saved.missing.length ||
            (date !== at && row.missing.length === saved.missing.length))) continue;
        points.set(date, row);
        if ((date === at || saved?.partial) && row.value !== null && !isDeepStrictEqual(row, saved)) {
          if (store) store.upsertFearGreed(row);
          else memory.set(date, row);
        }
      }
    }
    const historyPoints = Object.fromEntries(Object.entries(comparisons).map(([name, offset]) =>
      [name, points.get(at - offset * DAY) ?? null]));
    return { ...points.get(at), yesterday: historyPoints.yesterday?.value ?? null,
      lastWeek: historyPoints.lastWeek?.value ?? null, lastMonth: historyPoints.lastMonth?.value ?? null,
      historyPoints, history30d: Array.from({ length: 30 }, (_, i) => points.get(at - (29 - i) * DAY)?.value ?? null) };
  }
  return {
    history,
    async snapshot(time = now()) {
      if (!isTime(time)) throw new TypeError('Invalid snapshot time');
      const at = midnight(time);
      if (!pending.has(at)) pending.set(at, build(at).finally(() => pending.delete(at)));
      return structuredClone(await pending.get(at));
    },
  };
}
