// Settings → Network: current ticker splits (GET /api/v1/collisions). One ticker can name different projects on
// different venues; your node keeps the main cluster as the asset and detaches the venues that price something else.

import { esc, cnt, ago, priceTxt } from '../lib/format.js';
import { shortAsset } from '../lib/listmeta.js';

/** "×12.4" / "×0.031" for a detached-to-kept price ratio. @param {number|null|undefined} r */
export function ratioText(r) {
  if (!(Number(r) > 0)) return '—';
  const n = Number(r);
  return '×' + (n >= 100 ? Math.round(n).toLocaleString('en-US') : n >= 1 ? n.toFixed(1) : n.toPrecision(2));
}

/**
 * The Network section. `items` undefined: still loading (the body is filled in by splitsBody once it arrives).
 * @param {SplitRow[]|null|undefined} items @param {number} [now]
 */
export function splitsPanel(items, now = Date.now()) {
  return `<section class="sect" id="network"><h2>Network</h2><p class="sub">Ticker splits: the same ticker names another project on some venues. ` +
    `Your node keeps the main price cluster as the asset and detaches the others, so their prices cannot mix.</p>` +
    `<div id="splits-body">${items === undefined ? '<p class="muted">Loading splits…</p>' : splitsBody(items, now)}</div></section>`;
}

/**
 * @typedef {{asset: string, symbol?: string|null, name?: string|null, price?: number|null, venues?: number|null,
 *   reason?: string|null, guard?: object|null, detached: Array<{venue: string, label?: string, markets?: string[],
 *   price?: number|null, ratio?: number|null, since?: number|null}>}} SplitRow
 */

/** The splits table (or a quiet one-liner). @param {SplitRow[]|null} items @param {number} [now] */
export function splitsBody(items, now = Date.now()) {
  if (items == null) return '<p class="muted">Not available from this node.</p>';
  const rows = items.filter((r) => r.detached?.length || r.guard);
  if (!rows.length) return '<p class="muted">No splits right now.</p>';
  const body = rows.map((r) => {
    const detached = r.detached || [];
    const since = detached.map((x) => Number(x.since)).filter(Number.isFinite);
    const first = since.length ? Math.min(...since) : null;
    const venues = detached.map((x) => `<span class="vn">${esc(x.venue)}${x.label && x.label !== r.symbol ? ` <span class="muted">as ${esc(x.label)}</span>` : ''}</span>` +
      (x.markets?.length ? `<span class="mk" title="${esc(x.markets.join(', '))}">${esc(x.markets.slice(0, 2).map((m) => m.split(':').pop()).join(', '))}${x.markets.length > 2 ? ' +' + (x.markets.length - 2) : ''}</span>` : '')).join('') ||
      `<span class="vn muted">none: ${esc(r.reason || 'remaining markets disagree')}</span>`;
    const ratios = detached.map((x) => `<span class="vn n" title="${esc(x.price != null ? 'Detached price ' + priceTxt(x.price) : '')}">${ratioText(x.ratio)}</span>`).join('') || '—';
    return `<tr><td><b>${esc(r.symbol || r.asset)}</b><span class="mk" title="${esc(r.asset)}">${esc(r.asset.split(':')[0] + ' · ' + shortAsset(r.asset))}</span></td>` +
      `<td class="n">${r.venues == null ? '—' : cnt(r.venues)}</td><td>${venues}</td><td class="n">${ratios}</td>` +
      `<td class="n"${first ? ` title="${esc(new Date(first).toLocaleString())}"` : ''}>${first ? esc(ago(first, now)) : '—'}</td></tr>`;
  }).join('');
  return `<div class="tw"><table class="splits"><caption class="vh">Ticker splits</caption><thead><tr><th>Asset</th><th class="n">Kept venues</th>` +
    `<th>Detached venues</th><th class="n">Price ratio</th><th class="n">Since</th></tr></thead><tbody>${body}</tbody></table></div>`;
}
