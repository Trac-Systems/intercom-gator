import { DAY, isAsset, isKey, isTime } from './values.js';

const bull = new Set('bull bullish rally breakout growth strong gain gains buy buying optimistic recovery adoption'.split(' '));
const bear = new Set('bear bearish crash dump weak loss losses sell selling fear panic decline downside'.split(' '));

/** Normalize visible social feed rows or signed envelopes already accepted by the social layer. */
export function socialPosts(rows, from, to, acceptsKey) {
  const posts = [], seen = new Set();
  for (const row of rows) {
    const m = row?.message ?? row, key = row?.from ?? row?.key, id = row?.id;
    if (!isKey(key) || (acceptsKey && !acceptsKey(key)) || typeof id !== 'string' || !/^[a-zA-Z0-9_.:@-]{1,192}$/.test(id) ||
        !isTime(row.ts) || row.ts < from || row.ts >= to || !['post', 'reply'].includes(m.t) ||
        typeof m.text !== 'string' || [...m.text].length > 500) continue;
    const identity = key + ':' + id;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const tickers = [];
    for (const ticker of Array.isArray(m.tickers) ? m.tickers.slice(0, 100) : []) {
      if (!/^[A-Z0-9][A-Z0-9_]{0,15}$/.test(ticker?.sym ?? '')) continue;
      tickers.push({ sym: ticker.sym, ...(isAsset(ticker.asset) && { asset: ticker.asset }) });
    }
    const known = new Set(tickers.map(t => t.sym));
    const plain = m.text.replace(/https?:\/\/[^\s]+/gi, ' ');
    for (const match of plain.matchAll(/(?<![\w$])\$([a-z][a-z0-9_]{0,15})(?![\w])/gi)) {
      const sym = match[1].toUpperCase();
      if (!known.has(sym)) { known.add(sym); tickers.push({ sym }); }
    }
    posts.push({ key, id, ts: row.ts, text: m.text, tickers });
  }
  return posts.sort((a, b) => b.ts - a.ts || a.key.localeCompare(b.key) || a.id.localeCompare(b.id));
}

export function lexicon(text) {
  let positive = 0, negative = 0;
  for (const term of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (bull.has(term)) positive++;
    if (bear.has(term)) negative++;
  }
  return { positive, negative };
}

export function notablePosts(posts, { isFollowed = () => false, isReputable = () => false }, limit = 100) {
  return posts.filter(p => isFollowed(p.key) || isReputable(p.key)).slice(0, Math.min(100, limit));
}

/** Count one mention per unique signed post per asset in adjacent half-open windows.
 * resolveSymbol may resolve an unambiguous cashtag to one canonical asset ID. */
export function sentiment(asset, { posts, at = Date.now(), windowMs = DAY, resolveSymbol,
  isFollowed, isReputable }) {
  if (!isAsset(asset) || !isTime(at) || !Number.isSafeInteger(windowMs) || windowMs <= 0) throw new TypeError('Invalid sentiment query');
  const since = at - windowMs;
  const relevant = socialPosts(posts, since - windowMs, at).filter(p =>
    p.tickers.some(t => (t.asset ?? resolveSymbol?.(t.sym)) === asset));
  const current = relevant.filter(p => p.ts >= since), previous = relevant.length - current.length;
  const change = current.length - previous;
  return { asset, from: since, to: at, mentions: current.length, previous, change,
    changePct: previous ? 100 * change / previous : null, posts: notablePosts(current, { isFollowed, isReputable }) };
}

/** Component of the daily index. A directional lexicon score scales with mention activity
 * versus the previous seven days. More discussion by itself has no bullish sign. */
export function socialScore(rows, at, { isFollowed, isProven } = {}) {
  if (!Array.isArray(rows)) return null;
  let previous = 0, current = 0, tone = 0;
  const eligible = new Map();
  const accepts = key => {
    if (!eligible.has(key)) eligible.set(key, Boolean(isFollowed?.(key) || isProven?.(key)));
    return eligible.get(key);
  };
  for (const post of socialPosts(rows, at - 8 * DAY, at, accepts)) {
    if (!post.tickers.length) continue;
    if (post.ts < at - DAY) { previous++; continue; }
    current++;
    const { positive, negative } = lexicon(post.text);
    if (positive + negative) tone += (positive - negative) / (positive + negative);
  }
  if (!current) return 50;
  const typical = previous / 7;
  const activity = (current + 1) / (current + typical + 2);
  return Math.round(50 + 50 * (tone / current) * activity);
}
