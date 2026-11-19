// Number, price, time and text formatting. Pure: no DOM, runs in Node for tests.

export const MINUS = '−';
const SUBS = '₀₁₂₃₄₅₆₇₈₉';

/** @param {unknown} s */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Grouped number with fixed decimals. @param {number} n @param {number} d */
export function grp(n, d = 0) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Whole count with grouping. @param {number} n */
export function cnt(n) { return grp(n, 0); }

/** Compact dollars: $3.28T, $38.2B, $1.9M, $312K, $12.50. @param {number} n */
export function money(n) {
  if (n == null || !Number.isFinite(+n)) return '—';
  const a = Math.abs(n), s = n < 0 ? MINUS : '';
  if (a >= 1e12) return s + '$' + (a / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return s + '$' + Math.round(a / 1e3) + 'K';
  return s + '$' + grp(a, 2);
}

/** Compact plain number: 1.2K, 3.4M. @param {number} n */
export function compact(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return Math.round(n / 1e3) + 'K';
  if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(Math.round(n));
}

function strip(s) {
  const k = s.indexOf('.');
  if (k < 0) return s;
  let e = s.length;
  while (e > k + 3 && s[e - 1] === '0') e--;
  return s.slice(0, e);
}

/**
 * A price split for display: [integer part with $, fraction part as HTML].
 * Tiny prices use a subscript zero count: $0.0<sub>4</sub>1242 = 0.00001242.
 * @param {number} p
 * @returns {[string, string]}
 */
export function priceParts(p) {
  if (p == null || !Number.isFinite(+p)) return ['—', ''];
  if (p === 0) return ['$0', ''];
  let s;
  if (p >= 1000) s = grp(p, 2);
  else if (p >= 10) s = p.toFixed(2);
  else if (p >= 1) s = strip(p.toFixed(4));
  else if (p >= 0.001) s = strip(Number(p.toPrecision(4)).toFixed(Math.max(2, -Math.floor(Math.log10(p)) + 3)));
  else {
    const z = -Math.floor(Math.log10(p)) - 1;
    const sig = Math.round(p * Math.pow(10, z + 4)).toString().replace(/0+$/, '');
    return ['$0', '.0<sub>' + z + '</sub>' + sig];
  }
  const k = s.indexOf('.');
  return k < 0 ? ['$' + s, ''] : ['$' + s.slice(0, k), s.slice(k)];
}

/** Price as HTML (may contain <sub>). @param {number} p */
export function priceH(p) { const x = priceParts(p); return x[0] + x[1]; }

/** Price as plain text (subscript digits as Unicode). @param {number} p */
export function priceTxt(p) {
  return priceH(p).replace(/<sub>(\d+)<\/sub>/, (_, d) => String(d).split('').map((c) => SUBS[+c]).join(''));
}

/** Signed percent with a real minus. @param {number} x */
export function pct(x) {
  if (x == null || !Number.isFinite(+x)) return '—';
  if (Math.abs(x) < 0.005) return '0.0%';
  const a = Math.abs(x), d = a >= 100 ? 0 : a < 0.1 ? 2 : 1;
  return (x > 0 ? '+' : MINUS) + a.toFixed(d) + '%';
}

/** CSS class for a change. @param {number} x */
export function dir(x) { return x == null || Math.abs(x) < 0.005 ? 'flat' : x > 0 ? 'up' : 'down'; }

/** Funding rate (already in percent). @param {number} f */
export function funding(f) { return (f > 0 ? '+' : f < 0 ? MINUS : '') + Math.abs(f).toFixed(4) + '%'; }

/**
 * Short relative time: "now", "4 min", "2 h", "3 d", then a date.
 * @param {number} ts ms since epoch
 * @param {number} [now]
 */
export function ago(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' h';
  const d = Math.round(h / 24);
  if (d < 8) return d + ' d';
  const at = new Date(ts);
  return at.getUTCDate() + ' ' + MONTHS[at.getUTCMonth()] + (at.getUTCFullYear() !== new Date(now).getUTCFullYear() ? ' ' + at.getUTCFullYear() : '');
}

/** Age of a token in minutes from a label like "12 min" / "2 h" or from ms. @param {string|number} v */
export function ageMinutes(v) {
  if (typeof v === 'number') return v;
  const m = /(\d+(?:\.\d+)?)\s*(min|h|d)/.exec(String(v));
  return m ? +m[1] * (m[2] === 'h' ? 60 : m[2] === 'd' ? 1440 : 1) : 0;
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Short key: first 4 hex. @param {string} key */
export function shortKey(key) { return String(key || '').slice(0, 4); }

/** Key in groups of four for reading aloud / comparing. @param {string} key */
export function keyGroups(key) { return (String(key || '').match(/.{1,4}/g) || []).join(' '); }

/** Address shortened in the middle: 0x6982…1933. @param {string} a */
export function shortAddr(a) {
  a = String(a || '');
  return a.length > 14 ? a.slice(0, 6) + '…' + a.slice(-4) : a;
}

/** A chain id as a name: "ethereum" → "Ethereum", "bnb-chain" → "Bnb chain"; names stay as they are. @param {string} c */
export function chainName(c) { c = String(c || ''); return c && c === c.toLowerCase() ? cap(c.replace(/[-_]/g, ' ')) : c; }

/** Capitalise the first letter. @param {string} s */
export function cap(s) { s = String(s || ''); return s ? s[0].toUpperCase() + s.slice(1) : s; }

/** Plural helper. @param {number} n @param {string} one @param {string} [many] */
export function plural(n, one, many) { return cnt(n) + ' ' + (n === 1 ? one : many || one + 's'); }

/** Fear & Greed label for a value 0..100. @param {number} v */
export function fgLabel(v) { return v < 25 ? 'Extreme fear' : v < 45 ? 'Fear' : v <= 55 ? 'Neutral' : v < 76 ? 'Greed' : 'Extreme greed'; }

/** Amount of a holding: few decimals for big amounts. @param {number} n */
export function amount(n) { return grp(n, Math.abs(n) < 10 ? (Math.abs(n) < 1 ? 4 : 2) : 0); }
