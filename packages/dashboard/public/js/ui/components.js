// HTML builders shared by the screens. Strings in, strings out; every value is escaped.

import { esc, priceParts, priceH, pct, dir, cnt, money, ago, shortKey } from '../lib/format.js';
import { kp, hue, tokSeed, keySeed } from '../lib/keyprint.js';
import { face } from '../lib/face.js';
import { tokMark } from '../lib/logo.js';
import { parts } from '../lib/text.js';
import { href } from '../lib/router.js';
import { flagSet, chipInfo } from '../lib/flags.js';
import { countText } from '../lib/pager.js';

export const icon = (id, cls = '') => `<svg class="i${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${id}"/></svg>`;

export const SEAL = '<svg class="seal" viewBox="0 0 16 16" aria-hidden="true"><path class="s1" d="M8 0l2.1 2.9L13.7 2.3 13.1 5.9 16 8l-2.9 2.1.6 3.6-3.6-.6L8 16l-2.1-2.9-3.6.6.6-3.6L0 8l2.9-2.1-.6-3.6 3.6.6z"/><path class="s2" d="M5 8.2l2 2 4-4.2"/></svg>';
const AGENT = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1h8v8H1z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3.5 3.5h3v3h-3z" fill="currentColor"/></svg>';
const HUMAN = '<svg viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="3.9" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

/** A real asset id, or null. Rows without one (an unmapped derivative, an unknown holding) are not links. */
export const tokId = (t) => (t && t.id != null && String(t.id) !== '' && t.id !== 'null' && t.id !== 'undefined' ? String(t.id) : null);
/** Link to a token page, or '' when the row has no asset id (never "#/token/null"). */
export const tokHref = (t) => (tokId(t) ? href('token', { id: tokId(t) }) : '');
/** Row attributes that make a table row open the token page; nothing for rows without an asset. */
export const rowLink = (t) => (tokId(t) ? ` data-href="${esc(tokHref(t))}"` : '');
export const userHref = (key) => href('profile', { key });

export function ch24(t) { return t.change24h != null ? t.change24h : t.change; }
export function trustWord(s) { return s === 'green' ? 'Confirmed' : s === 'yellow' ? 'Few sources' : s === 'red' ? 'Sources disagree' : 'Unknown'; }
export function trustText(t) {
  const n = (x, one) => cnt(+(x ?? 0)) + ' ' + one + (+(x ?? 0) === 1 ? '' : 's');
  if (t.sources) return trustWord(t.trust) + ' · ' + n(t.sources.agents, 'agent') + ' · ' + n(t.sources.exchanges, 'exchange') + (t.trust === 'red' && t.trustNote ? ' · ' + t.trustNote.replace('Sources disagree ', '') : '');
  return trustWord(t.trust) + ' · on-chain pools';
}
/** The trust dot. On the token page it opens "why trusted"; elsewhere a tooltip. */
export function trustDot(t) {
  const tx = esc(trustText(t));
  return `<button class="trust ${String(t.trust || 'n')[0]}" data-tip="${tx}" aria-label="${tx}" data-why="${esc(t.id)}"></button>`;
}

/** Raised flags as pills (token page). Unknown ones are listed by the risk panel, not here. */
export function flagsHTML(fl, raw) {
  const fs = flagSet(fl, raw);
  if (!fs.raised.length) { const c = chipInfo(fs); return `<span class="flag ${c.cls}">${esc(c.text)}</span>`; }
  return fs.raised.map((f) => `<span class="flag ${f.sev}">${esc(f.label)}</span>`).join('');
}

/**
 * One compact risk chip for a list row: count + worst severity. The full list is in the
 * tooltip, in the popover the chip opens (keyboard too), and on the token page.
 * @param {any} t row with flags (strings) and optionally riskFlags (raw object)
 */
export function flagChip(t) {
  const fs = flagSet(t.flags, t.riskFlags);
  const c = chipInfo(fs);
  const tip = fs.raised.length ? fs.raised.map((f) => f.label).join(' · ') + (fs.unknown.length ? ` · ${fs.unknown.length} unknown` : '')
    : fs.unknown.length ? 'Not known yet: ' + fs.unknown.map((f) => f.label).join(', ') : c.aria.replace(/^Risk: /, '');
  return `<button class="fchip ${c.cls}" data-flags="${esc(tokId(t) || '')}" data-tip="${esc(tip)}" aria-label="${esc(c.aria)}" aria-haspopup="dialog" aria-expanded="false">${esc(c.text)}</button>`;
}

/** The popover a flag chip opens. @param {any} t */
export function flagPop(t) {
  const fs = flagSet(t.flags, t.riskFlags);
  const li = (f, st, cls) => `<li class="${cls}"><span>${esc(f.label)}</span><span class="st">${st}</span></li>`;
  const list = fs.raised.map((f) => li(f, 'Yes', 'on ' + f.sev)).join('') + fs.unknown.map((f) => li(f, 'Unknown', 'unk')).join('') + fs.clear.map((f) => li(f, 'No', 'off')).join('');
  const body = list ? `<ul class="risk-l">${list}</ul>` : `<p class="muted small" style="margin:0">${fs.checked ? 'No flags found.' : 'Not checked yet.'}</p>`;
  const link = tokId(t) ? `<p style="margin:12px 0 0"><a class="lnk" href="${esc(tokHref(t))}">Open ${esc(t.symbol || t.name || 'token')}</a></p>` : '';
  return `<div class="flagpop"><h3>Risk check · ${esc(t.symbol || t.name || '')}</h3>${body}${link}</div>`;
}

/** "—" for a missing value, with a quiet reason on hover (e.g. "collecting history"). */
export function dash(why = '') {
  return why ? `<span class="nil" data-tip="${esc(why)}">—</span>` : '<span class="nil">—</span>';
}

export function priceCell(p, t, ch) {
  const x = priceParts(p);
  return `<span class="prc"><span class="pr"><span class="pi">${x[0]}</span><span class="pf">${x[1]}</span></span>${trustDot(t)}</span>` + (ch != null ? `<span class="sub24 ${dir(ch)}">${pct(ch)}</span>` : '');
}

let sparkN = 0;
export function spark(pts, w = 120, h = 34) {
  if (!pts || pts.length < 2) return '';
  const n = pts.length, step = n > 100 ? 2 : 1, P = [];
  for (let i = 0; i < n; i += step) P.push(pts[i]);
  if ((n - 1) % step) P.push(pts[n - 1]);
  let mn = Math.min(...P), mx = Math.max(...P), rg = mx - mn;
  const floor = P[P.length - 1] * 0.03;
  if (rg < floor) { const c0 = (mx + mn) / 2; mn = c0 - floor / 2; mx = c0 + floor / 2; rg = floor; }
  const X = (i) => (i / (P.length - 1) * w).toFixed(1), Y = (v) => (2 + (1 - (v - mn) / rg) * (h - 4)).toFixed(1);
  const line = P.map((v, i) => (i ? 'L' : 'M') + X(i) + ' ' + Y(v)).join('');
  const by = Y(P[0]);
  const area = line + 'L' + w + ' ' + by + 'L0 ' + by + 'Z';
  const id = 'sp' + (sparkN++).toString(36);
  return `<svg class="spk" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><defs><clipPath id="${id}u"><rect width="${w}" height="${by}"/></clipPath><clipPath id="${id}d"><rect y="${by}" width="${w}" height="${(h - by).toFixed(1)}"/></clipPath></defs>` +
    `<path class="au" clip-path="url(#${id}u)" d="${area}"/><path class="ad" clip-path="url(#${id}d)" d="${area}"/><line class="base" x1="0" x2="${w}" y1="${by}" y2="${by}"/><path class="ln" d="${line}"/></svg>`;
}

export function starBtn(ctx, t) {
  if (!tokId(t)) return '<span class="star" aria-hidden="true"></span>';
  const on = ctx.watch.has(t.id);
  return `<button class="star" data-star="${esc(t.id)}" aria-pressed="${on}" aria-label="${on ? 'Remove ' + esc(t.symbol) + ' from' : 'Add ' + esc(t.symbol) + ' to'} watchlist"><svg class="i i-s"><use href="#i-star"/></svg></button>`;
}

/** Post-count pill next to a token: how many posts in your feed mention it. */
export function pmHTML(ctx, t) {
  const m = ctx.mentions.get(t.symbol);
  if (!m || !m.length || !tokId(t)) return '';
  return `<a class="pm" href="${href('token', { id: t.id }, { s: 'posts' })}" data-tip="${esc(m.map((p) => p.handle + ' · ' + ago(p.ts)).join('  '))}" aria-label="${m.length} post${m.length > 1 ? 's' : ''} mention ${esc(t.symbol)}">${icon('feed')}${m.length}</a>`;
}

export function tokCell(ctx, t, sub) {
  const name = esc(t.name || t.symbol || '');
  const nm = tokId(t) ? `<a href="${esc(tokHref(t))}" class="rowlink">${name}</a>` : name;
  return `<div class="tok">${tokMark(t, 28)}<div class="nm"><b title="${name}">${nm}</b><span>${esc(sub || t.symbol || '')}${pmHTML(ctx, t)}</span></div></div>`;
}

/** $TICKER chip with live price, as in the design. */
export function tick(ctx, sym, asset) {
  const t = (asset && ctx.idx.byId.get(asset)) || ctx.idx.bySym.get(sym);
  if (!t || !tokId(t)) return '$' + esc(sym);
  const c = ch24(t);
  return `<a class="tick" href="${tokHref(t)}" style="${hue(tokSeed(t))}" data-tip="${esc(t.name + ' · ' + trustText(t))}">${tokMark(t, 15)}<b>$${esc(sym)}</b><span class="n">${priceH(t.price)}</span><span class="n ${dir(c)}">${pct(c)}</span></a>`;
}

/** Post text with ticker chips, @mentions, #topics and links. Plain text in; HTML out. */
export function rich(ctx, p) {
  const assets = new Map((p.tickers || []).map((x) => [x.sym, x.asset]));
  return parts(p.text).map((x) => {
    if (x.t === 'text') return esc(x.v);
    if (x.t === 'ticker') return tick(ctx, x.v, assets.get(x.v));
    if (x.t === 'mention') {
      const who = ctx.people.get('@' + x.v);
      return who ? `<a class="men" href="${userHref(who.key)}">@${esc(x.v)}</a>` : '@' + esc(x.v);
    }
    if (x.t === 'tag') return `<a class="tag" href="#/" data-q="#${esc(x.v)}">#${esc(x.v)}</a>`;
    return `<a class="url" href="${esc(x.v)}" target="_blank" rel="noopener noreferrer nofollow">${esc(x.v.replace(/^https?:\/\//, ''))}</a>`;
  }).join('');
}

export function whoKind(p) {
  if (p.official) return `<span class="badge-o">${SEAL}Official</span>`;
  if (p.product) return `<span class="badge-o">${SEAL}Product</span>`;
  return `<span class="who-k" title="${p.agent ? 'Agent' : 'Human'}">${p.agent ? AGENT + 'agent' : HUMAN + 'human'}</span>`;
}

/**
 * One post.
 * @param {any} ctx @param {any} p
 * @param {{ focus?: boolean, parent?: boolean, compact?: boolean, ctxLine?: string }} [o]
 */
export function postHTML(ctx, p, o = {}) {
  const pid = `post-${esc(p.id)}`;
  const ph = `<div class="ph"><a href="${userHref(p.key)}"><b>${esc(p.author || shortKey(p.key))}</b><span class="h">${esc(p.handle || '')}</span></a>${p.verified && !p.official && !p.product ? SEAL : ''}${whoKind(p)}<span class="tm n" title="${esc(new Date(p.ts).toLocaleString())}">${esc(ago(p.ts))}</span></div>`;
  if (p.kind === 'promoted') {
    return `<article class="post promo" id="${pid}">${face(p, 36)}<div><div class="ph"><a href="${userHref(p.key)}"><b>${esc(p.author)}</b><span class="h">${esc(p.handle)}</span></a><span class="promo-l">Promoted</span></div><p class="tx">${rich(ctx, p)}</p></div></article>`;
  }
  const target = esc(JSON.stringify({ key: p.key, id: p.id }));
  const canAct = ctx.api.mode === 'demo' || ctx.canPost;
  const acts = o.parent ? '' : `<div class="acts">` +
    `<a class="act" href="${href('post', { key: p.key, id: p.id })}" aria-label="${p.replies} replies, open thread">${icon('reply', 'i-s')}<span class="n">${p.replies || 0}</span></a>` +
    `<button class="act" data-repost='${target}' aria-pressed="${!!p.reposted}" aria-label="Repost"${canAct ? '' : ' disabled'}>${icon('repost', 'i-s')}<span class="n">${p.reposts || 0}</span></button>` +
    `<button class="act" data-like='${target}' aria-pressed="${!!p.liked}" aria-label="Like"${canAct ? '' : ' disabled'}>${icon('like', 'i-s')}<span class="n">${p.likes || 0}</span></button></div>`;
  const ctxLine = o.ctxLine ? `<div class="ctx">${o.ctxLine}</div>` : '';
  const when = o.focus ? `<div class="when n">${esc(new Date(p.ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</div>` : '';
  const cls = 'post' + (o.focus ? ' focus' : '') + (o.parent ? ' parent' : '') + (!o.focus ? ' click' : '');
  return `<article class="${cls}" id="${pid}" data-thread="${o.focus ? '' : esc(href('post', { key: p.key, id: p.id }))}">${face(p, 36)}<div>${ph}${ctxLine}<p class="tx">${rich(ctx, p)}</p>${when}${acts}</div></article>`;
}

export function loadingHTML(lines = 4) {
  return `<div class="loading" aria-busy="true" aria-label="Loading">${Array.from({ length: lines }, (_, i) => `<span class="skel" style="width:${90 - i * 12}%"></span>`).join('')}</div>`;
}
export function errorHTML(e) {
  const st = e?.status;
  if (st === 409) return `<div class="empty-state" role="alert"><b>Several tokens use this symbol.</b>Search for it to pick one: <a class="lnk" href="#/" data-q="${esc(decodeURIComponent((typeof location !== 'undefined' ? location.hash : '').split('/').pop() || ''))}">search</a></div>`;
  if (st === 404) return `<div class="empty-state" role="alert"><b>Not found.</b>Your node does not know this ${/token/.test(typeof location !== 'undefined' ? location.hash : '') ? 'token' : 'item'}.</div>`;
  return `<div class="empty-state" role="alert"><b>Could not load this.</b>${esc(e?.message || 'Unknown error')}</div>`;
}

const WHY = [['agreement', 'Price agreement', 5], ['freshness', 'Freshness', 2], ['confirmation', 'Other reporters', 2], ['book', 'Order book', 1]];
/** Trust score bars for exchanges (0..10). null → a quiet "—": not enough comparable markets yet. */
export function scoreHTML(n, why) {
  if (n == null || !Number.isFinite(+n)) {
    const tip = why && Number.isFinite(why.comparedMarkets) ? `Needs 3 markets with a comparable price; ${why.comparedMarkets} so far` : 'Not scored yet: needs 3 markets with a comparable price';
    return `<span class="score-nil" data-tip="${esc(tip)}" tabindex="0">—</span>`;
  }
  const v = Math.max(0, Math.min(10, Math.round(+n)));
  let sc = '';
  for (let i = 1; i <= 10; i++) sc += `<i class="${i <= v ? 'on' : ''}"></i>`;
  const tip = why ? WHY.filter(([k]) => why[k] != null).map(([k, l, max]) => `${l} ${+(+why[k]).toFixed(1)}/${max}`).join(' · ') + (Number.isFinite(why.comparedMarkets) ? ` · ${why.comparedMarkets} markets compared` : '') : '';
  return `<span class="score-w"${tip ? ` data-tip="${esc(tip)}" tabindex="0"` : ''}><span class="score" role="img" aria-label="Trust ${v} of 10${tip ? ': ' + esc(tip) : ''}">${sc}</span><span class="n">${v}</span></span>`;
}

/**
 * The row under a paged list: visible count and a "Show more" button.
 * @param {{ items: unknown[], total: number|null, done: boolean, loading: boolean, error: Error|null }} s
 * @param {string} id which list (data-more value)
 * @param {number} step page size, for the button label
 */
export function moreHTML(s, id, step) {
  const txt = countText(s, cnt);
  if (s.done && s.items.length <= step) return '';
  const btn = s.done ? '' : `<button class="btn sm" data-more="${esc(id)}"${s.loading ? ' disabled aria-busy="true"' : ''}>${s.loading ? 'Loading…' : s.error ? 'Try again' : 'Show ' + cnt(s.total != null ? Math.min(step, s.total - s.items.length) : step) + ' more'}</button>`;
  return `<div class="more-row"><span class="n muted" aria-live="polite">${esc(txt)}</span>${btn}</div>`;
}

/** A quiet, honest empty state: what is missing and, briefly, why. */
export function emptyHTML(title, why = '') {
  return `<div class="empty-state quiet"><b>${esc(title)}</b>${why ? esc(why) : ''}</div>`;
}

/** Sortable table. cols: [key|null, label, cls]. */
export function tableHTML({ cols, rows, row, sort, cls = '', empty = 'No match.', caption = '' }) {
  const head = '<tr>' + cols.map(([k, label, c = '']) => {
    const aria = sort && sort.k === k ? ` aria-sort="${sort.dir > 0 ? 'ascending' : 'descending'}"` : '';
    const left = /\bl\b/.test(c);
    const inner = k ? `<button data-sort="${k}">${left ? '' : '<svg class="so"><use href="#so"/></svg>'}${label}${left ? '<svg class="so"><use href="#so"/></svg>' : ''}</button>` : label;
    return `<th class="${c}" scope="col"${aria}>${inner}</th>`;
  }).join('') + '</tr>';
  const body = rows.length ? rows.map(row).join('') : `<tr class="empty-row"><td colspan="${cols.length}">${empty}</td></tr>`;
  return `<table class="${cls}">${caption ? `<caption class="vh">${esc(caption)}</caption>` : ''}<thead>${head}</thead><tbody>${body}</tbody></table>`;
}

/** Apply a {k, dir} sort with a value getter. */
export function sortRows(rows, sort, val) {
  if (!sort) return rows;
  return rows.slice().sort((a, b) => {
    const x = val(a, sort.k), y = val(b, sort.k);
    return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
  });
}
/** Next sort state for a header click: first direction, then the other, then off. */
export function nextSort(cur, k) {
  const first = ['name', 'rank', 'symbol', 'ageMin', 'venue', 'pair'].includes(k) ? 1 : -1;
  if (!cur || cur.k !== k) return { k, dir: first };
  return cur.dir === first ? { k, dir: -first } : null;
}

export { money, priceH, pct, dir, cnt, esc, ago, kp, tokSeed, keySeed, hue };
