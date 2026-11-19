// Post text: plain text only (no HTML). Splits it into parts the UI renders as
// $TICKER chips, @mentions, #topics and links. Pure: no DOM.

export const POST_MAX = 500;

/** Characters as the network counts them (Unicode code points). @param {string} s */
export function charCount(s) { return [...String(s || '')].length; }

/**
 * Counter state for the compose box.
 * @param {string} s
 * @returns {{ used: number, left: number, over: boolean, near: boolean, ratio: number }}
 */
export function counter(s, max = POST_MAX) {
  const used = charCount(s);
  const left = max - used;
  return { used, left, over: left < 0, near: left <= 40, ratio: Math.min(1, used / max) };
}

const RX = /(\$[A-Z][A-Z0-9]{1,9}\b)|(@[a-z0-9_]{2,24}\b)|(#[A-Za-z][A-Za-z0-9_]{1,31})|(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)])/g;

/**
 * @typedef {{ t: 'text', v: string } | { t: 'ticker', v: string } | { t: 'mention', v: string } | { t: 'tag', v: string } | { t: 'url', v: string }} Part
 */

/**
 * @param {string} s
 * @returns {Part[]}
 */
export function parts(s) {
  s = String(s || '');
  /** @type {Part[]} */
  const out = [];
  let last = 0;
  RX.lastIndex = 0;
  let m;
  while ((m = RX.exec(s))) {
    if (m.index > last) out.push({ t: 'text', v: s.slice(last, m.index) });
    if (m[1]) out.push({ t: 'ticker', v: m[1].slice(1) });
    else if (m[2]) out.push({ t: 'mention', v: m[2].slice(1) });
    else if (m[3]) out.push({ t: 'tag', v: m[3].slice(1) });
    else out.push({ t: 'url', v: m[4] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
  return out;
}

/** Unique tickers in a text, in order. @param {string} s */
export function tickers(s) {
  return [...new Set(parts(s).filter((p) => p.t === 'ticker').map((p) => p.v))];
}

/** Unique #topics (lower case). @param {string} s */
export function topics(s) {
  return [...new Set(parts(s).filter((p) => p.t === 'tag').map((p) => p.v.toLowerCase()))];
}

/** Case-insensitive match of a query anywhere in any of the fields. @param {string} q @param {...unknown} fields */
export function matches(q, ...fields) {
  const l = String(q || '').trim().toLowerCase();
  if (!l) return true;
  return fields.some((f) => f != null && String(f).toLowerCase().includes(l));
}

/** Validate a handle per DESIGN §5.1 (2–24 of [a-z0-9_]). @param {string} h */
export function validHandle(h) { return /^[a-z0-9_]{2,24}$/.test(String(h || '')); }

/** Validate an http(s) endpoint URL. @param {string} u */
export function validUrl(u) {
  try { const x = new URL(String(u)); return x.protocol === 'https:' || x.protocol === 'http:' || x.protocol === 'wss:' || x.protocol === 'ws:'; } catch { return false; }
}

/** Looks like an EVM / Solana / Bitcoin address. @param {string} s */
export function addressKind(s) {
  s = String(s || '').trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return 'evm';
  if (/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(s)) return 'btc';
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return 'sol';
  return null;
}

/** 64-hex public key. @param {string} s */
export function isKey(s) { return /^[0-9a-f]{64}$/.test(String(s || '')); }
