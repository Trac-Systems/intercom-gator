// NFT collections measured by this node from marketplace sales. "Sale floor" is the low end (10th percentile) of
// recent clean sales, never a listing floor; the UI always says "sale floor".

import { esc, grp, money, ago, cnt, chainName } from '../lib/format.js';

const isNum = (x) => x != null && x !== '' && Number.isFinite(+x);

/** "12.4 ETH", "0.0312 ETH". @param {number|null|undefined} x */
export function ethTxt(x) {
  if (!isNum(x)) return '—';
  const n = +x;
  if (n === 0) return '0 ETH';
  const d = n >= 100 ? 0 : n >= 1 ? 2 : n >= 0.01 ? 3 : 5;
  return grp(n, d) + ' ETH';
}

/** "$3,750", "$12.40", larger amounts compact ("$1.2M"). @param {number} n */
export function usdTxt(n) {
  if (!isNum(n)) return '—';
  return Math.abs(+n) >= 1e5 ? money(+n) : '$' + grp(+n, Math.abs(+n) < 10 ? 2 : 0);
}

/** Two-line value: ETH on top, USD below. Sample rows carry preformatted strings. */
export function ethUsdHTML(eth, usd) {
  if (typeof eth === 'string' && !isNum(eth)) return esc(eth);
  if (!isNum(eth)) return '<span class="nil">—</span>';
  return `<span class="eu"><b class="n">${esc(ethTxt(eth))}</b>${isNum(usd) ? `<small class="n">${usdTxt(+usd)}</small>` : ''}</span>`;
}

export const nftHref = (id) => '#/nft/' + encodeURIComponent(id);

/** What the node collects, for empty and young-node states. @param {any} status @param {number} [now] */
export function collectingHTML(status, now = Date.now()) {
  const chains = Array.isArray(status?.chains) ? status.chains : [];
  if (!chains.length) return '<p class="muted">This node has no NFT marketplace contracts in its signed bundle.</p>';
  const parts = chains.map((c) => {
    const since = c.since ? ` since ${esc(ago(c.since, now))}` : ' (starting)';
    return `<li><b>${esc(c.chainName || chainName(c.chain))}</b>: ${esc((c.marketplaces || []).join(', '))}${since} · ${cnt(c.salesSeen ?? 0)} sales seen` +
      (c.lagSeconds != null && c.lagSeconds > 120 ? ` · ${esc(lagTxt(c.lagSeconds))} behind` : '') + '</li>';
  }).join('');
  return `<ul class="collect">${parts}</ul><p class="muted small">A collection is listed once your node sees ${cnt(status.minSales ?? 3)} sales in 24 h, ` +
    'or when it is on the signed seed list. Prices come from sales only: no listings, no paid APIs.</p>';
}

/** "3 min", "2 h". @param {number} s seconds */
export function lagTxt(s) {
  if (!isNum(s)) return '—';
  return s < 90 ? Math.round(s) + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(1) + ' h';
}
