// NFT collection page: sale floor, volume and recent sales as seen by this node (GET /api/v1/nfts/:id).

import { esc, cnt, pct, dir, ago, shortAddr } from '../lib/format.js';
import { kp } from '../lib/keyprint.js';
import { href } from '../lib/router.js';
import { icon, emptyHTML } from '../ui/components.js';
import { loadSocial, socialSide } from '../ui/side.js';
import { ethTxt, ethUsdHTML, usdTxt } from '../ui/nfts.js';

async function load(ctx, route) {
  const [c, social] = await Promise.all([ctx.api.nft(route.params.id), loadSocial(ctx)]);
  return { c, social };
}

const FLAG = { self: 'Same wallet on both sides', loop: 'Returned to an earlier seller within a day, without fees' };

function stat(label, value, sub = '', tip = '') {
  return `<div class="stat"${tip ? ` data-tip="${esc(tip)}" tabindex="0"` : ''}><span class="lbl">${label}</span><span class="val n">${value}</span>${sub ? `<span class="d">${sub}</span>` : ''}</div>`;
}

function html(ctx, d) {
  const c = d.c, now = Date.now();
  const name = c.name || shortAddr(c.address);
  const floorTip = 'The 10th percentile of clean sales in the last 24 h (or the last 20 within 7 days), from at least 3 sales. Not a listing floor.';
  const stats = '<div class="stats nft-stats">' +
    stat('Sale floor', c.floor == null ? '<span class="nil">—</span>' : esc(ethTxt(c.floor)),
      c.floor == null ? 'needs 3 clean sales' : `${c.floorUsd != null ? usdTxt(c.floorUsd) + ' · ' : ''}${cnt(c.floorSales)} sales`, floorTip) +
    stat('24 h', c.change24h == null ? '<span class="nil">—</span>' : `<span class="${dir(c.change24h)}">${pct(c.change24h)}</span>`, c.change24h == null ? 'collecting history' : 'sale floor change') +
    stat('Volume 24 h', esc(ethTxt(c.volume24hEth)), c.volume24h != null ? usdTxt(c.volume24h) : '') +
    stat('Sales 24 h', cnt(c.sales24h ?? 0), c.washSales24h ? `+${cnt(c.washSales24h)} wash-like left out` : '') +
    stat('Last sale', c.lastSale ? esc(ethTxt(c.lastSale.priceEth)) : '<span class="nil">—</span>', c.lastSale ? esc(ago(c.lastSale.at, now)) + ' · ' + esc(c.lastSale.marketplace) : '') +
    '</div>';
  const rows = (c.sales || []).map((s) => `<tr${s.flag ? ' class="flagged"' : ''}><td class="l n">${esc(ago(s.at, now))}</td>` +
    `<td class="l n mono" title="${esc(s.tokenId)}">#${esc(s.tokenId.length > 12 ? s.tokenId.slice(0, 10) + '…' : s.tokenId)}${s.qty > 1 ? ` ×${cnt(s.qty)}` : ''}</td>` +
    `<td>${ethUsdHTML(s.priceEth, s.priceUsd)}</td><td class="l">${esc(s.marketplace)}${s.bundle > 1 ? ` <span class="muted small">bundle of ${cnt(s.bundle)}</span>` : ''}</td>` +
    `<td class="l c-flag">${s.flag ? `<span class="bdg warn" data-tip="${esc(FLAG[s.flag] || s.flag)}" tabindex="0">wash-like</span>` : ''}</td>` +
    `<td class="l mono small c-tx" title="${esc(s.tx)}">${esc(s.tx.slice(0, 10))}…</td></tr>`).join('');
  const table = rows ? `<div class="tw"><table class="t-nft-sales"><caption class="vh">Recent sales</caption><thead><tr><th class="l">When</th><th class="l">Token</th><th>Price</th><th class="l">Marketplace</th><th class="l c-flag">Flag</th><th class="l c-tx">Transaction</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : emptyHTML('No sales seen yet.', c.seeded ? ' This collection is on the signed seed list; it shows numbers once your node sees sales.' : '');
  const main = `<div class="page-h nft-h"><a class="back" href="${href('markets', { tab: 'nfts' })}" aria-label="Back to NFTs">${icon('back')}</a>` +
    `<div class="tok big">${kp('nft:' + c.chain + ':' + c.address, 'tag', 44)}<div class="nm"><h1>${esc(name)}</h1><span>${esc([c.symbol, c.chainName].filter(Boolean).join(' · '))} · <span class="mono" title="${esc(c.address)}">${esc(shortAddr(c.address))}</span></span></div></div></div>` +
    stats +
    `<p class="note-row"><span>Measured by your node from on-chain marketplace sales. Sale floor is not a listing floor; wash-like trades are left out.</span></p>` +
    `<div class="sec-h"><h2>Recent sales <small class="n">${cnt((c.sales || []).length)}</small></h2></div>` + table;
  return { title: name, main, side: socialSide(ctx, d.social) };
}

export default { load, html };
