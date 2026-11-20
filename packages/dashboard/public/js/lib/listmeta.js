// What a list leaves out, and why: the quiet "N hidden · show" control, row badges for hidden entries
// (stale / unconfirmed / dust), labels for tokens without a readable name, imitation warnings and the
// exchange figure we cannot verify. Pure strings; the views place them.

import { esc, cnt, money, ago, shortAddr } from './format.js';

const REASONS = ['stale', 'unconfirmed', 'dust'];
const WHY = {
  stale: 'no price for over an hour',
  unconfirmed: 'price not yet confirmed by your own reads or a proven reporter',
  dust: 'too little turnover or pool depth to rank',
};

/** Lists that currently include hidden entries (this page session). */
const shown = new Set();
/** Last hidden counts seen per list. @type {Map<string, Record<string, number>>} */
const counts = new Map();

/** @param {string} list */
export const showsHidden = (list) => shown.has(list);
/** @param {string} list */
export function toggleHidden(list) { if (shown.has(list)) shown.delete(list); else shown.add(list); }
/** Query fields for a list API call. @param {string} list */
export const includeFor = (list) => (shown.has(list) ? { include: 'hidden' } : {});
/** Pager cache suffix, so the two views of a list page separately. @param {string} list */
export const hiddenKey = (list) => (shown.has(list) ? ':hidden' : '');
/** @param {string} list @param {unknown} hidden */
export function noteHidden(list, hidden) {
  if (hidden && typeof hidden === 'object') counts.set(list, /** @type {Record<string, number>} */ (hidden));
}
/** @param {string} list */
export const hiddenOf = (list) => counts.get(list) ?? null;
/** @param {Record<string, number>|null|undefined} h */
export const hiddenTotal = (h) => (h ? REASONS.reduce((s, k) => s + (Number(h[k]) > 0 ? Number(h[k]) : 0), 0) : 0);

/**
 * "N hidden · show" (or "Showing N hidden · hide"), with the reasons in the tooltip. Empty when nothing is hidden.
 * @param {string} list @param {Record<string, number>|null} [h]
 */
export function hiddenControl(list, h = hiddenOf(list)) {
  const n = hiddenTotal(h), on = shown.has(list);
  if (!n && !on) return '';
  const parts = REASONS.filter((k) => h && Number(h[k]) > 0).map((k) => `${cnt(h?.[k])} ${k}: ${WHY[k]}`);
  const tip = (parts.length ? parts.join('. ') + '. ' : '') + (on ? 'Hide them again.' : 'Left out of the list, totals and ranks.');
  const label = on ? `Showing ${cnt(n)} hidden · hide` : `${cnt(n)} hidden · show`;
  return `<div class="hid-row"><button type="button" class="hid-t" data-hidden="${esc(list)}" aria-pressed="${on}" data-tip="${esc(tip)}">${label}</button></div>`;
}

/**
 * Badge for a row shown only because hidden entries are on. Live rows get nothing.
 * @param {{visibility?: string, staleSince?: number|null}} row @param {number} [now]
 */
export function visBadge(row, now = Date.now()) {
  const v = row?.visibility;
  if (!v || !REASONS.includes(v)) return '';
  const since = v === 'stale' && Number.isFinite(row.staleSince) ? /** @type {number} */ (row.staleSince) : null;
  const age = since != null ? ago(since, now) : '';
  const tip = v === 'stale'
    ? (since != null ? `No fresh price since ${new Date(since).toLocaleString()}` : 'No fresh price') + '. Hidden from lists and totals.'
    : `${WHY[v][0].toUpperCase() + WHY[v].slice(1)}. Hidden from lists and totals.`;
  return `<span class="vis vis-${v}" data-tip="${esc(tip)}">${v}${age && age !== 'now' ? ' · ' + esc(age) : ''}</span>`;
}

/** Address part of an asset id, shortened: "ethereum:0x1234…abcd" → "0x1234…abcd". @param {string} id */
export function shortAsset(id) {
  const s = String(id || '');
  const at = s.indexOf(':');
  const addr = at >= 0 ? s.slice(at + 1) : s;
  return addr === 'native' ? s.slice(0, at) : shortAddr(addr);
}

/** @param {{nameStatus?: string, name?: string|null}} t */
export const unnamed = (t) => t?.nameStatus === 'pending' || t?.nameStatus === 'unresolvable';

/**
 * A row object safe to label: tokens without an established name read "Unnamed · 0x1234…abcd".
 * @template {{id?: string, name?: string|null, symbol?: string|null, nameStatus?: string}} T @param {T} t @returns {T}
 */
export function labelled(t) {
  if (!unnamed(t)) return t;
  return { ...t, name: 'Unnamed · ' + shortAsset(t.id || ''), symbol: t.symbol || '' };
}

/** Tooltip for an unnamed token. @param {{nameStatus?: string}} t */
export function nameTip(t) {
  return t?.nameStatus === 'pending' ? 'Name not read yet: your node is asking the token contract.'
    : 'The contract gives no readable name. Shown by its address.';
}

/** Small warning chip per name flag ("imitates:USDT"). @param {{nameFlags?: string[]}} t */
export function nameFlagChips(t) {
  const flags = Array.isArray(t?.nameFlags) ? t.nameFlags : [];
  return flags.map((f) => {
    const [kind, sym = ''] = String(f).split(':');
    if (kind === 'imitates') {
      return `<span class="nflag" data-tip="${esc(`Uses the ticker ${sym} but is not a signed deployment of it: a bridged copy or an imitation. Check the address and the bridge before you trust the name.`)}">same ticker</span>`;
    }
    return `<span class="nflag" data-tip="${esc('Name warning: ' + f)}">${esc(kind)}</span>`;
  }).join('');
}

/** Name chips and the hidden-entry badge for one token row. @param {any} t @param {number} [now] */
export function rowBadges(t, now) {
  const name = unnamed(t) ? `<span class="nflag q" data-tip="${esc(nameTip(t))}">unnamed</span>` : '';
  return name + nameFlagChips(t) + visBadge(t, now);
}

/**
 * Put badges into a rendered token cell's subtitle line; append them after the cell if its markup differs.
 * @param {string} cell @param {string} badges
 */
export function withBadges(cell, badges) {
  if (!badges) return cell;
  const end = cell.lastIndexOf('</span></div></div>');
  return end >= 0 ? cell.slice(0, end) + `<span class="bdg">${badges}</span>` + cell.slice(end) : cell + `<span class="bdg">${badges}</span>`;
}

/** "+ $722B unverified" under an exchange's volume. @param {{unresolvedVolume24h?: number|null}} e */
export function unverifiedVolume(e) {
  const v = Number(e?.unresolvedVolume24h), x = Number(e?.suspectVolume24h);
  const tip = 'Turnover this venue reports for markets your node cannot match to a known asset. Not counted in its volume or rank.';
  const tipX = 'Volume this venue reports that your node does not count: tokenized stocks carrying the underlying stock ' +
    'market’s volume, or numbers out of line that no other venue confirms. Not in its volume or rank.';
  return (v > 0 ? `<span class="unv n" data-tip="${esc(tip)}">+ ${money(v)} unverified</span>` : '') +
    (x > 0 ? `<span class="unv n" data-tip="${esc(tipX)}">+ ${money(x)} not counted</span>` : '');
}
