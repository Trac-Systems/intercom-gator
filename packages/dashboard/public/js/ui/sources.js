// Settings → Sources: every upstream the node depends on (GET /api/v1/sources), with its state, last success,
// error share and requests in the last hour. Host names only; never a path, key or full user URL.

import { esc, cnt, ago } from '../lib/format.js';
import { icon } from './components.js';
import { lagTxt } from './nfts.js';

export const STATES = { ok: ['g', 'OK'], slow: ['y', 'Slow'], failing: ['r', 'Failing'], 'rate-limited': ['y', 'Rate-limited'], standby: ['n', 'Standby'], off: ['n', 'Off'] };
const ORDER = { failing: 0, 'rate-limited': 1, slow: 2, ok: 3, standby: 4, off: 5 };

/** The section; `report` undefined while loading. */
export function sourcesPanel(report, now = Date.now()) {
  return `<section class="sect" id="sources"><h2>Sources</h2><p class="sub">Everything your node reads from: exchange APIs, chain RPCs, ` +
    `scanners and data APIs. Counts cover the last hour on this machine.</p><div id="sources-body">${report === undefined ? '<p class="muted">Loading sources…</p>' : sourcesBody(report, now)}</div></section>`;
}

const pctTxt = (x) => (x == null ? '—' : x === 0 ? '0%' : x < 0.01 ? '<1%' : Math.round(x * 100) + '%');
function detail(i, now) {
  const bits = []
  if (i.lagSeconds != null) bits.push(lagTxt(i.lagSeconds) + ' behind');
  if (i.lastGap) bits.push(`gap ${cnt(i.lastGap.to - i.lastGap.from + 1)} blocks ${ago(i.lastGap.at, now)}`);
  if (i.salesSeen != null) bits.push(cnt(i.salesSeen) + ' sales');
  if (i.latencyMs != null) bits.push(cnt(i.latencyMs) + ' ms');
  if (i.rateLimited1h) bits.push(cnt(i.rateLimited1h) + '× 429');
  if (i.cooldownUntil) bits.push('cooling down');
  if (i.budgetWait) bits.push('waiting for budget');
  return bits.join(' · ');
}

/** @param {any} report @param {number} [now] */
export function sourcesBody(report, now = Date.now()) {
  if (!report || !Array.isArray(report.groups)) return '<p class="muted">Not available from this node.</p>';
  const counts = report.counts || {};
  const sum = `<div class="src-sum">${Object.entries(STATES).map(([k, [c, w]]) => `<span class="dotw ${c}">${cnt(counts[k] ?? 0)} ${w.toLowerCase()}</span>`).join('')}` +
    (report.budget ? `<span class="muted small n">Budget ${cnt(report.budget.used1m)} / ${cnt(report.budget.limit)} requests this minute</span>` : '') + '</div>';
  const groups = report.groups.map((g) => {
    const items = [...g.items].sort((a, b) => (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9) || (b.requests1h ?? 0) - (a.requests1h ?? 0));
    const by = {};
    for (const i of items) by[i.state] = (by[i.state] ?? 0) + 1;
    const rows = items.map((i) => {
      const [c, w] = STATES[i.state] || STATES.off;
      const sub = [i.host, i.chain && i.kind === 'rpc' ? null : null, i.yours ? 'yours' : null].filter(Boolean).join(' · ');
      return `<tr><td><b>${esc(i.name)}</b>${sub ? `<span class="h">${esc(sub)}</span>` : ''}</td><td><span class="dotw ${c}">${w}</span></td>` +
        `<td class="r n">${i.lastSuccess ? esc(ago(i.lastSuccess, now)) : '—'}</td><td class="r n">${pctTxt(i.errorShare1h)}</td>` +
        `<td class="r n">${cnt(i.requests1h ?? 0)}</td><td class="c-opt muted small">${esc(detail(i, now))}</td></tr>`;
    }).join('');
    const cnts = Object.entries(by).map(([k, n]) => `<span class="dotw ${(STATES[k] || STATES.off)[0]}">${cnt(n)}</span>`).join('');
    return `<details class="src-g" data-src="${esc(g.id)}"><summary>${esc(g.label)} <span class="cnts">${cnts}</span>${icon('down')}</summary>` +
      (items.length ? `<div class="tw"><table class="src"><caption class="vh">${esc(g.label)}</caption><colgroup>${[1, 2, 3, 4, 5, 6].map((n) => `<col class="c${n}${n === 6 ? ' c-opt' : ''}">`).join('')}</colgroup><thead><tr><th>Source</th><th>State</th><th class="r">Last OK</th>` +
        `<th class="r">Errors 1 h</th><th class="r">Req. 1 h</th><th class="c-opt">Detail</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">None.</p>') +
      '</details>';
  }).join('');
  return sum + groups;
}
