// Pure helpers for the price chart (asset candles). No DOM; the drawing lives in ../chart/price-chart.js.

import { MONTHS, grp } from './format.js';

/** Seconds per stored timeframe (DESIGN §6: candles 1m/5m/1h/1d) and per display bucket. */
export const TF_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '2h': 7200, '6h': 21600, '1d': 86400, '1w': 604800 };

/**
 * The six ranges. `tf` is what the store is asked for (and what the line draws);
 * `candle` is the bucket the candles are drawn in, so each range keeps legible candles.
 */
export const RANGES = Object.freeze([
  { id: '1H', tf: '1m', bars: 60, candle: '1m' },
  { id: '1D', tf: '5m', bars: 288, candle: '15m' },
  { id: '1W', tf: '1h', bars: 168, candle: '2h' },
  { id: '1M', tf: '1h', bars: 720, candle: '6h' },
  { id: '1Y', tf: '1d', bars: 365, candle: '1w' },
  { id: 'ALL', tf: '1d', bars: 0, candle: '1w' },
]);

/** @param {string} id */
export function rangeById(id) { return RANGES.find((r) => r.id === id) || RANGES[1]; }

/** @typedef {{ t: number, o: number, h: number, l: number, c: number, v: number }} Candle  t = seconds */

/**
 * Merge candles into wider buckets (e.g. 5m → 15m). Buckets are aligned to the
 * bucket size in UTC (weeks to Monday). Input oldest first; output oldest first.
 * @param {Candle[]} candles
 * @param {number} seconds bucket size
 * @returns {Candle[]}
 */
export function aggregate(candles, seconds) {
  /** @type {Candle[]} */
  const out = [];
  for (const k of candles) {
    const start = bucketStart(k.t, seconds);
    const last = out[out.length - 1];
    if (last && last.t === start) {
      if (k.h > last.h) last.h = k.h;
      if (k.l < last.l) last.l = k.l;
      last.c = k.c;
      last.v += k.v;
    } else {
      out.push({ t: start, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v });
    }
  }
  return out;
}

/** Bucket start in seconds; weeks start on Monday 00:00 UTC. @param {number} t @param {number} seconds */
export function bucketStart(t, seconds) {
  if (seconds === 604800) {
    // 1970-01-01 was a Thursday; Monday-aligned weeks are offset by 4 days.
    const off = 4 * 86400;
    return Math.floor((t - off) / seconds) * seconds + off;
  }
  return Math.floor(t / seconds) * seconds;
}

/**
 * Change over the drawn range: first open to last close.
 * @param {Candle[]} candles
 */
export function rangeChange(candles) {
  if (!candles.length) return null;
  const a = candles[0].o, b = candles[candles.length - 1].c;
  return a > 0 ? (b / a - 1) * 100 : null;
}

/** High / low over the range. @param {Candle[]} candles */
export function rangeHighLow(candles) {
  let hi = -Infinity, lo = Infinity;
  for (const k of candles) { if (k.h > hi) hi = k.h; if (k.l < lo) lo = k.l; }
  return candles.length ? { high: hi, low: lo } : null;
}

const pad2 = (n) => String(n).padStart(2, '0');
/** @param {number} seconds @param {boolean} utc */
function parts(seconds, utc) {
  const d = new Date(seconds * 1000);
  return utc
    ? { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() }
    : { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes() };
}

/**
 * Axis label for a bucket: time of day up to an hour bucket, the day up to a week,
 * month + year above. Local time by default (the dashboard is the owner's own).
 * @param {number} seconds @param {number} bucket bucket size in seconds @param {boolean} [utc]
 */
export function timeLabel(seconds, bucket, utc = false) {
  if (!Number.isFinite(seconds)) return '';
  const p = parts(seconds, utc);
  if (bucket < 86400) return pad2(p.h) + ':' + pad2(p.mi);
  if (bucket < 604800) return p.d + ' ' + MONTHS[p.mo];
  return MONTHS[p.mo] + ' ' + p.y;
}

/** Crosshair label on the time axis. @param {number} seconds @param {number} bucket @param {boolean} [utc] */
export function crosshairTime(seconds, bucket, utc = false) {
  if (!Number.isFinite(seconds)) return '';
  const p = parts(seconds, utc);
  const day = p.d + ' ' + MONTHS[p.mo];
  return bucket >= 86400 ? day + ' ' + p.y : day + ' ' + pad2(p.h) + ':' + pad2(p.mi);
}

/** Readout time under the chart. @param {number} seconds @param {number} bucket @param {boolean} [utc] */
export function readoutTime(seconds, bucket, utc = false) {
  if (!Number.isFinite(seconds)) return '';
  const p = parts(seconds, utc);
  const day = p.d + ' ' + MONTHS[p.mo] + ' ' + p.y;
  return bucket >= 86400 ? day : day + ' ' + pad2(p.h) + ':' + pad2(p.mi) + (utc ? ' UTC' : '');
}

const SUBS = '₀₁₂₃₄₅₆₇₈₉';

/**
 * One price as the chart prints it (last-price tag, crosshair, grid). Five
 * significant digits; tiny prices keep a subscript zero count and never read 0.
 * @param {number} value
 */
export function priceLabel(value) {
  if (!Number.isFinite(value) || value === 0) return '0';
  const neg = value < 0 ? '-' : '';
  const a = Math.abs(value);
  if (a >= 10000) return neg + grp(a, 0);
  if (a >= 1000) return neg + grp(a, 2);
  const e = Math.floor(Math.log10(a));
  const places = Math.max(2, 4 - e);
  // Below 0.001 the dashboard writes prices with a subscript zero count; the axis does the same.
  if (a < 0.001) {
    const [mant, ex] = a.toExponential(4).split('e');
    const digits = mant.replace('.', '').replace(/0+$/, '');
    const zeros = String(-Number(ex) - 1).split('').map((d) => SUBS[+d]).join('');
    return neg + '0.0' + zeros + digits;
  }
  let s = a.toFixed(places);
  // Trim trailing zeros but keep two decimals, so the axis reads like money.
  while (s.endsWith('0') && s.length - s.indexOf('.') - 1 > 2) s = s.slice(0, -1);
  return neg + s;
}

/**
 * Smallest axis step for the prices drawn: five significant digits at the peak.
 * @param {Array<{h?: number, c?: number, value?: number}>} points
 */
export function minMove(points) {
  let peak = 0;
  for (const p of points) {
    const v = Math.max(p.h ?? 0, p.c ?? 0, p.value ?? 0);
    if (v > peak) peak = v;
  }
  if (!(peak > 0) || !Number.isFinite(peak)) return 0.01;
  const ex = Math.floor(Math.log10(peak));
  return Number('1e' + Math.max(-18, Math.min(2, ex - 4)));
}

/** Snap a grid value to the step (the library's tick walk leaves float residue). @param {number} v @param {number} step */
export function axisPrice(v, step) {
  if (!Number.isFinite(v) || !(step > 0)) return v;
  const n = Math.round(v / step);
  // Divide by the inverse step for decimal steps: 15 / 1e5 is exactly 0.00015, 15 * 1e-5 is not.
  const s = step < 1 ? n / Math.round(1 / step) : n * step;
  return Math.abs(v - s) <= step * 1e-6 ? s : v;
}

/** Tickmark label formatter bound to a step. @param {number} step */
export function tickmarkLabels(step) {
  return (/** @type {number[]} */ values) => values.map((v) => priceLabel(axisPrice(v, step)));
}

/**
 * Library price format for a series: custom formatter + its step.
 * @param {Array<{h?: number, c?: number, value?: number}>} points
 */
export function priceFormat(points) {
  const step = minMove(points);
  return { type: 'custom', formatter: priceLabel, minMove: step, base: Math.pow(10, Math.round(-Math.log10(step))) };
}

/**
 * Keyboard step through candles: returns the new index for a key, or null.
 * @param {string} key @param {number} index current (-1 = live/last) @param {number} total
 */
export function stepIndex(key, index, total) {
  if (total <= 0) return null;
  const cur = index < 0 ? total - 1 : index;
  if (key === 'ArrowLeft') return Math.max(0, cur - 1);
  if (key === 'ArrowRight') return Math.min(total - 1, cur + 1);
  if (key === 'Home') return 0;
  if (key === 'End') return total - 1;
  if (key === 'PageUp') return Math.max(0, cur - 10);
  if (key === 'PageDown') return Math.min(total - 1, cur + 10);
  return null;
}
