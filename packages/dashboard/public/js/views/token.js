// Token page: header, price + trust, 1h/24h/7d, chart, markets, posts; side: why trusted, risk, links.

import { esc, money, pct, dir, cnt, priceH, priceParts, priceTxt, ago, shortAddr, cap, compact, chainName } from '../lib/format.js';
import { kp, hue, tokSeed } from '../lib/keyprint.js';
import { labelled, nameFlagChips, nameTip, unnamed, visBadge } from '../lib/listmeta.js';
import { tokMark, exMark, chainMark } from '../lib/logo.js';
import { href } from '../lib/router.js';
import { RANGES, rangeById, aggregate, TF_SECONDS, rangeChange, readoutTime, stepIndex } from '../lib/chart-format.js';
import { icon, trustWord, flagsHTML, postHTML, tableHTML, sortRows, nextSort, ch24, dash, tokHref } from '../ui/components.js';
import { flagSet } from '../lib/flags.js';
import { createPager, pagerCache, countText } from '../lib/pager.js';

const ui = { range: '1D', mode: 'line' };
// Markets page through the node's list (volume first, volumes it does not count last): 50 a page, and once the
// reader asks for more, the next pages load as the end of the list scrolls into view.
const MK_PAGE = 50;
const mkPagers = pagerCache(60000);
/** @type {Map<string, ''|'base'|'quote'>} token id → which side of its pairs the list shows */
const mkSide = new Map();
let mkAuto = '';     // token id whose list loads on scroll (after one "Show more")
let mkFocus = false;
const isNum = (x) => x != null && x !== '' && Number.isFinite(+x);
let msort = null;

/** One paged market list per token and side; the first page also brings the counted total and the side counts. */
function mkPagerFor(ctx, id, side) {
  return mkPagers.get(id + '|' + side, () => {
    const meta = { volumeTotal: null, suspect: null, counts: null };
    const pager = createPager(async (offset, limit) => {
      const r = await ctx.api.assetMarkets(id, { limit, offset, side: side || undefined });
      if (offset === 0) Object.assign(meta, { volumeTotal: r.volumeTotal ?? null, suspect: r.suspect ?? null, counts: r.counts ?? null });
      return r;
    }, { limit: MK_PAGE });
    return Object.assign(pager, { meta });
  });
}

async function load(ctx, route) {
  const id = route.params.id;
  const side = mkSide.get(id) || '';
  const pager = mkPagerFor(ctx, id, side);
  const [t, , posts] = await Promise.all([
    ctx.api.asset(id),
    pager.state.pages ? null : pager.more(),
    ctx.api.feed({ asset: id }).catch(() => ({ items: [] })),
  ]);
  ctx.noteTokens([t]);
  for (const p of posts.items) ctx.notePerson(p);
  return { t, pager, side, markets: pager.state.items, posts: posts.items };
}

function priceBlock(t) {
  const x = priceParts(t.price);
  const isNew = !t.rank;
  const age = t.age || (isNum(t.firstSeen) ? ago(+t.firstSeen) : '');
  const vol = isNum(t.volume24h) ? t.volume24h : t.volume;
  // A cap from an exchange-reported circulating supply says whose figure it is.
  const circ = t.supply && typeof t.supply === 'object' ? t.supply.circulating : null;
  const venue = { binance: 'Binance', coinbase: 'Coinbase' };
  const reported = circ && circ.method === 'exchange-reported'
    ? ` <span class="muted small">reported by ${esc(String(circ.source || '').split('+').map((v) => venue[v] || v).join(' and '))}</span>`
    : t.capBasis === 'total' ? ' <span class="muted small">from total supply</span>' : '';
  // [label, html, present?]: missing values are left out and named once below, not shown as dashes.
  const stats = isNew
    ? [['Age', esc(age), !!age], ['Liquidity', money(t.liquidity), isNum(t.liquidity)], ['Volume 24 h', money(vol), isNum(vol)], ['Holders', cnt(t.holders), isNum(t.holders)]]
    : [['1 h', `<span class="${dir(t.change1h)}">${pct(t.change1h)}</span>`, isNum(t.change1h)], ['7 d', `<span class="${dir(t.change7d)}">${pct(t.change7d)}</span>`, isNum(t.change7d)], ['Volume 24 h', money(vol), isNum(vol)], ['Market cap', money(t.marketCap) + reported, isNum(t.marketCap)], ['FDV', money(t.fdv), isNum(t.fdv)]];
  const missing = [];
  if (!isNew && !isNum(t.change1h) && !isNum(t.change7d)) missing.push('1 h and 7 d change: collecting history');
  else if (!isNew && !isNum(t.change7d)) missing.push('7 d change: collecting history');
  if (!isNew && !isNum(t.marketCap)) missing.push('Market cap and FDV: need supply data');
  const c = ch24(t);
  const ag = t.sources ? +(t.sources.agents ?? 0) : 0;
  const tw = t.sources ? `${trustWord(t.trust)} · ${cnt(ag)} ${ag === 1 ? 'agent' : 'agents'}` : trustWord(t.trust);
  const ch = isNum(c) ? `<span class="d n ${dir(c)}" id="tk-ch">${pct(c)} <span class="muted" style="font-weight:500;font-size:13px">24 h</span></span>`
    : `<span class="d n" id="tk-ch"><span class="muted" style="font-weight:500;font-size:13px">24 h: collecting</span></span>`;
  return `<section class="tk-price" aria-label="Price"><div><span class="lbl" style="display:block;font-size:12.5px;font-weight:520;color:var(--ink3);margin-bottom:6px">Price</span>` +
    `<div class="v"><span class="big" id="tk-big">${x[0]}${x[1]}</span>${ch}</div>` +
    `<a class="trust-w" href="#why" data-scroll="why"><span class="trust ${String(t.trust || 'n')[0]}" aria-hidden="true"></span>${esc(tw)}</a></div>` +
    `<div class="tk-stats">${stats.filter((s) => s[2]).map(([l, v]) => `<div class="stat"><span class="lbl">${l}</span><span class="val n">${v}</span></div>`).join('')}</div>` +
    (missing.length ? `<div class="note-row tk-miss">${missing.map((m) => `<span>${esc(m)}</span>`).join('')}</div>` : '') + '</section>';
}

function chartCard(t) {
  return `<section class="chart" id="chart" aria-label="Price chart">` +
    `<div class="chart-h"><div class="rng" role="group" aria-label="Range">${RANGES.map((r) => `<button data-range="${r.id}" aria-pressed="${ui.range === r.id}">${r.id}</button>`).join('')}<span class="rchg n" id="rchg"></span></div>` +
    `<div class="mode" role="group" aria-label="Chart type"><button data-mode="line" aria-pressed="${ui.mode === 'line'}">${icon('line')}Line</button><button data-mode="candle" aria-pressed="${ui.mode === 'candle'}">${icon('candle')}Candles</button></div></div>` +
    `<div class="chart-f"><div class="fig" id="fig" tabindex="0" role="img" aria-label="${esc(t.name)} price chart. Use arrow keys to read candles."></div><div class="state" id="chart-state">Loading chart…</div></div>` +
    `<dl class="readout now" id="readout" aria-live="polite"></dl>` +
    `<p class="credit"><span>Candles from reports your node accepted.</span><span>Chart by <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">TradingView</a> Lightweight Charts™ · © 2026 TradingView, Inc.</span></p></section>`;
}

/** Short words for a volume the node does not count (the API's `volumeNote` is the full sentence). */
export const SUSPECT_LABEL = { 'underlying-stock': 'stock volume', unconfirmed: 'not counted' };

function marketsTable(ctx, d) {
  // Shares are of the counted volume of every pair (the node sends the total); flagged volumes have no share.
  const meta = d.pager.meta;
  const total = meta.volumeTotal ?? d.markets.reduce((s, m) => s + (isNum(m.volume24h) && !m.volumeSuspect ? +m.volume24h : 0), 0);
  // The node's order by default (counted volume first); a header sorts the loaded rows, flagged volumes still last.
  const val = (m, k) => { const v = k === 'venue' ? String(m.venue).toLowerCase() : k === 'share' ? m.volume24h : m[k]; return v == null ? (msort.dir > 0 ? Infinity : -Infinity) : v; };
  const rows = msort && ['volume24h', 'share'].includes(msort.k)
    ? sortRows(d.markets.filter((m) => !m.volumeSuspect), msort, val).concat(sortRows(d.markets.filter((m) => m.volumeSuspect), msort, val))
    : sortRows(d.markets, msort, val);
  return tableHTML({
    cls: 't-mk', sort: msort, caption: 'Markets',
    cols: [['venue', 'Venue', 'l'], ['price', 'Price', ''], ['volume24h', 'Volume 24 h', 'c-vol2'], ['share', 'Share', ''], [null, 'Updated', 'c-upd']],
    rows,
    row: (m) => `<tr${m.volumeSuspect ? ' class="sus"' : ''}><td class="l"><div class="venue">${exMark(m.venue, m.venueLogo, 24)}<div><b>${esc(pairText(m.pair))}</b><span>${esc(m.venue)}${marketChain(d.t, m)}</span></div></div></td>` +
      `<td><span class="prc"><span class="n">${quotePrice(m.price, m.pair)}</span><span class="trust ${String(m.trust || 'n')[0]}" data-tip="${esc(m.trust ? trustWord(m.trust) : 'Not compared yet')}" role="img" aria-label="${esc(m.trust ? trustWord(m.trust) : 'Not compared yet')}" tabindex="0"></span></span></td>` +
      `<td class="c-vol2">${isNum(m.volume24h) ? (m.volumeSuspect ? `<span class="muted">${money(m.volume24h)}</span>` : money(m.volume24h)) : dash()}</td>` +
      `<td class="n">${m.volumeSuspect ? suspectTag(m) : total && isNum(m.volume24h) ? (m.volume24h / total * 100).toFixed(1) + '%' : dash()}</td><td class="c-upd muted n">${isNum(m.updated) ? esc(updatedAgo(+m.updated)) : '—'}</td></tr>`,
    empty: d.side ? 'No markets on this side yet.' : 'No markets seen yet.',
  });
}

/** The share cell of a flagged row: a short tag; the reason in plain words on hover and focus. */
function suspectTag(m) {
  const why = m.volumeNote || 'Reported volume not counted in totals, shares or ranking.';
  return `<span class="nflag q vsus" data-tip="${esc(why)}" tabindex="0" aria-label="${esc((isNum(m.volume24h) ? money(m.volume24h).replace(/<[^>]+>/g, '') + ' reported. ' : '') + why)}">${esc(SUSPECT_LABEL[m.volumeSuspect] || 'not counted')}</span>`;
}

/** "All / USDT/… / …/USDT" for an asset that is the quote of some pairs and the base of others (stablecoins, BTC, ETH). */
function sideControl(d, sym) {
  const c = d.pager.meta.counts, side = d.side;
  if (!c || !(c.quote > 0 && c.base > 0) && !side) return '';
  const s = esc(sym || 'it');
  const opts = [['', 'All', c.base + c.quote, 'All markets'], ['base', `${s}/…`, c.base, `Markets where ${s} is the base`],
    ['quote', `…/${s}`, c.quote, `Markets where ${s} is the quote`]];
  return `<span class="seg3 mk-side" role="group" aria-label="Pair side">${opts.map(([k, l, n, tip]) =>
    `<button data-mkside="${k}" aria-pressed="${side === k}" title="${tip}">${l} <small class="n">${cnt(n)}</small></button>`).join('')}</span>`;
}

/** @type {{ ctx: any, d: any }|null} the open token page, so a new page of markets patches only its section */
let mkView = null;
/** @type {IntersectionObserver|null} */
let mkObserver = null;

/** Redraw the markets table and its foot in place (the chart and the rest of the page stay). */
function patchMarkets() {
  const sec = document.getElementById('markets');
  if (!sec || !mkView) return;
  const { ctx, d } = mkView;
  const tw = sec.querySelector('.tw');
  if (tw) tw.innerHTML = marketsTable(ctx, d);
  sec.querySelectorAll('.mk-more, .mk-note').forEach((x) => x.remove());
  sec.insertAdjacentHTML('beforeend', marketsFoot(d));
  observeMore();
}

function moreMarkets(ctx) {
  const d = mkView?.d;
  if (!d || d.pager.state.done || d.pager.state.loading) return;
  const p = d.pager.more();
  patchMarkets();
  p.then(() => {
    patchMarkets();
    if (mkFocus) /** @type {HTMLElement|null} */ (document.querySelector('[data-mkmore]'))?.focus({ preventScroll: true });
    mkFocus = false;
  }, () => { mkFocus = false; ctx.toast('Could not load more markets.', true); patchMarkets(); });
}

/** After one "Show more", the next pages load as the end of the list comes into view. */
function observeMore() {
  mkObserver?.disconnect();
  const el = document.querySelector('.mk-more');
  if (!el || !mkView || mkAuto !== mkView.d.t.id || mkView.d.pager.state.done || typeof IntersectionObserver !== 'function') return;
  mkObserver = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) moreMarkets(mkView.ctx); }, { rootMargin: '400px 0px' });
  mkObserver.observe(el);
}

/** Under the table: what is shown, the next page, and why some volumes are listed last. */
function marketsFoot(d) {
  const st = d.pager.state, sus = d.pager.meta.suspect;
  const txt = countText(st, cnt) + (st.items.length ? ' · by volume' : '');
  const btn = st.done ? '' : `<button class="btn sm" data-mkmore${st.loading ? ' disabled aria-busy="true"' : ''}>${st.loading ? 'Loading…' : st.error ? 'Try again' : 'Show ' + cnt(st.total != null ? Math.min(MK_PAGE, st.total - st.items.length) : MK_PAGE) + ' more'}</button>`;
  const more = st.items.length > 0 && (btn || st.items.length > MK_PAGE) ? `<div class="more-row mk-more"><span class="n muted" aria-live="polite">${esc(txt)}</span>${btn}</div>` : '';
  const note = sus && sus.count > 0
    ? `<div class="note-row mk-note"><span>${cnt(sus.count)} ${sus.count === 1 ? 'market reports' : 'markets report'} ${money(sus.volume24h)} of volume your node does not count: tokenized stocks that carry the underlying stock market's volume, or numbers no other venue confirms. They are listed last, with the reported figure, and left out of totals, shares and rankings.</span></div>`
    : '';
  return more + note;
}

/** " · Ethereum": every market on a coin page names the chain of the contract it trades; elsewhere DEX pools only. */
export function marketChain(t, m) {
  const name = m.chainName || (m.chain ? chainName(m.chain) : '');
  if (t && Array.isArray(t.contracts) && t.contracts.length > 1) return name ? ' · ' + esc(name) : '';
  return m.kind === 'DEX' ? ' · ' + esc(name || 'DEX') : '';
}

/**
 * What the page headlines. A coin member shows the coin: its name, group price and cap, summed volume and the
 * representative's changes; the member's own figures move to the "This contract" panel.
 */
export function coinView(t) {
  const g = t && t.coinGroup;
  if (!g) return t;
  return { ...t, name: g.name || t.name, symbol: g.symbol || t.symbol, price: g.price ?? t.price, trust: g.trust || t.trust,
    change1h: g.change1h, change24h: g.change24h, change7d: g.change7d, volume24h: g.volume24h, marketCap: g.marketCap,
    fdv: null, rank: g.rank ?? t.rank };
}

const isNative = (c) => !c.address || c.address === 'native';
const chainOf = (c) => ({ name: c.chainName || chainName(c.chain), logo: c.logo });
const explorerName = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'explorer'; } };

/** The Contracts control: the open member's chain and address, copy, explorer, and the list of every member. */
export function contractsHTML(t) {
  const list = Array.isArray(t.contracts) ? t.contracts : [];
  const cur = list.find((c) => c.current) || list[0];
  if (!cur) return '';
  const others = list.length - 1;
  return `<span class="ct" role="group" aria-label="Contract">${chainMark(chainOf(cur), 18)}<span class="ct-ch">${esc(cur.chainName || chainName(cur.chain))}</span>` +
    (isNative(cur) ? '<span class="muted">native coin</span>' : `<span class="key" title="${esc(cur.address)}">${esc(shortAddr(cur.address))}</span><button class="ibtn ct-i" data-copy="${esc(cur.address)}" aria-label="Copy contract address">${icon('copy')}</button>`) +
    (cur.explorer ? `<a class="ibtn ct-i" href="${esc(cur.explorer)}" target="_blank" rel="noopener noreferrer" aria-label="Open on ${esc(explorerName(cur.explorer))}" data-tip="${esc(explorerName(cur.explorer))}">${icon('ext')}</a>` : '') +
    (others > 0 ? `<button class="btn sm ct-more" id="ct-more" aria-haspopup="dialog" aria-expanded="false">${others === 1 ? '1 more chain' : others + ' more chains'}${icon('down')}</button>` : '') + '</span>';
}

/** The dropdown: every member with chain, role, address, copy and explorer; choosing one opens its page. */
export function contractsPop(t) {
  const list = Array.isArray(t.contracts) ? t.contracts : [];
  return `<div class="ct-pop"><h3 id="ct-h">Contracts <span class="n">${list.length}</span></h3><ul class="ct-l" aria-labelledby="ct-h">` + list.map((c) => {
    const name = c.chainName || chainName(c.chain);
    const addr = isNative(c) ? 'native coin' : shortAddr(c.address);
    return `<li${c.current ? ' class="cur"' : ''}><a class="ct-go" href="${esc(tokHref(c))}"${c.current ? ' aria-current="page"' : ''} title="${esc(isNative(c) ? name : c.address)}">${chainMark(chainOf(c), 22)}` +
      `<span class="ct-t"><b>${esc(name)}</b>${c.role && c.role !== 'native' ? `<span class="ct-role">${esc(c.role)}</span>` : ''}<span class="key">${esc(addr)}</span></span></a>` +
      (isNative(c) ? '<span></span>' : `<button class="ibtn" data-copy="${esc(c.address)}" aria-label="Copy ${esc(name)} address">${icon('copy')}</button>`) +
      (c.explorer ? `<a class="ibtn" href="${esc(c.explorer)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(name)} on ${esc(explorerName(c.explorer))}">${icon('ext')}</a>` : '<span></span>') + '</li>';
  }).join('') + '</ul></div>';
}

/** Secondary detail on a coin page: the open contract's own price, cap, supply and markets. */
function memberPanel(t, markets) {
  if (!t.coinGroup) return '';
  const cur = (t.contracts || []).find((c) => c.current);
  const circ = t.supply && typeof t.supply === 'object' ? t.supply.circulating : null;
  const supply = circ && typeof circ === 'object' ? circ.value : circ;
  const own = markets.filter((m) => (m.asset || t.id) === t.id).length;
  const rows = [
    ['Price', isNum(t.price) ? priceH(t.price) : '<span class="muted">no own quote</span>'],
    ['Market cap', isNum(t.marketCap) ? money(t.marketCap) : '<span class="muted">—</span>'],
    isNum(supply) ? ['Circulating', compact(+supply) + ' ' + esc(t.symbol || '')] : null,
    ['Markets', cnt(own)],
  ].filter(Boolean);
  return `<section class="panel" aria-labelledby="mb-h"><div class="sec-h"><h2 id="mb-h">This contract</h2><span class="muted small">${esc(cur ? cur.chainName || chainName(cur.chain) : chainName(t.chain))}${cur && cur.role ? ' · ' + esc(cur.role) : ''}</span></div>` +
    `<ul class="why-l">${rows.map(([k, v]) => `<li><span class="muted">${k}</span><span class="n">${v}</span></li>`).join('')}</ul></section>`;
}

const SRC_SHOWN = 8;
let srcAll = '';
/** "BTC/unresolved:gate:USD1" → "BTC/USD1" (quote ids the registry has not resolved yet). */
export function pairText(p) { return String(p || '').replace(/unresolved:[^:/]*:/g, ''); }
const USDISH = /^(USD|USDT|USDC|USDS|USDE|USD1|FDUSD|DAI|TUSD|PYUSD|USDG|GUSD|BUSD|RLUSD|USDD)$/i;
/** A venue price in its own quote: "$" only for USD-like quotes; otherwise the number. */
export function quotePrice(price, pair) {
  const q = pairText(pair).split('/')[1] || 'USD';
  const h = priceH(price);
  return USDISH.test(q) ? h : h.replace(/^\$/, '');
}

/** Seconds since a market updated, as "12 s", "4 min", "3 h". */
function updatedAgo(s) { return s < 90 ? s + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : Math.round(s / 3600) + ' h'; }

function whyPanel(t) {
  const w = t.why;
  if (!w) return '';
  const st = String(w.state || 'n')[0];
  const rows = [
    isNum(w.reporters) ? ['Reporters', `${cnt(w.reporters)}${w.window ? ` <span class="muted">in ${esc(w.window)}</span>` : ''}`] : null,
    w.exchanges ? ['Exchanges', cnt(w.exchanges)] : null,
    isNum(w.spreadPct) ? ['Spread', `${(+w.spreadPct).toFixed(2)}%`] : null,
    w.spotCheck ? ['Your spot check', `<span class="${w.spotCheck.ok ? 'ok' : 'err'}">${w.spotCheck.ok ? 'Matches' : 'Differs'}</span> <span class="muted">${esc(w.spotCheck.venue)} · ${w.spotCheck.ageSec} s</span>`] : null,
  ].filter(Boolean);
  // A large asset has hundreds of sources: the ones the price uses come first (largest volume first), then the
  // outliers left out of it, a handful at a time.
  const all = (w.sources || []).filter((s) => isNum(s.price));
  const ranked = all.slice().sort((a, b) => !!a.excluded - !!b.excluded);
  const open = srcAll === t.id;
  const shown = open ? ranked : ranked.slice(0, SRC_SHOWN);
  const src = all.length ? `<table class="src"><thead><tr><th class="l" scope="col">Source</th><th scope="col">Last</th><th scope="col">Diff</th></tr></thead><tbody>${shown.map((s) =>
    `<tr><td class="l">${esc(s.venue)} <span class="muted">${esc(pairText(s.pair))}</span>${s.excluded ? ' <span class="muted">· not used</span>' : ''}</td><td class="n">${quotePrice(s.price, s.pair)}</td><td class="n ${isNum(s.deltaPct) && Math.abs(s.deltaPct) > 1 ? 'down' : 'muted'}">${pct(s.deltaPct)}</td></tr>`).join('')}</tbody></table>` +
    (all.length > SRC_SHOWN ? `<div class="more-row src-more"><span class="n muted">${open ? 'All ' + cnt(all.length) : `${SRC_SHOWN} of ${cnt(all.length)} · used in the price first`}</span><button class="btn sm" data-srcall aria-expanded="${open}">${open ? 'Fewer' : 'Show all'}</button></div>` : '') : '';
  return `<section class="panel" id="why" aria-labelledby="why-h"><div class="sec-h" style="margin-top:20px"><h2 id="why-h">Why trusted</h2></div>` +
    `<div class="why-h ${st}"><span class="big-dot" aria-hidden="true"></span><b>${esc(trustWord(w.state))}</b></div>` +
    (w.note ? `<p class="small" style="margin:0 0 8px;color:var(--ink2)">${esc(w.note)}</p>` : '') +
    `<ul class="why-l">${rows.map(([k, v]) => `<li><span class="muted">${k}</span><span>${v}</span></li>`).join('')}</ul>${src}</section>`;
}

function riskPanel(t) {
  const r = t.risk || (t.flags ? { flags: t.flags, raw: t.riskFlags } : null);
  if (!r) return '';
  // Every flag once: raised (Yes), not known yet (Unknown), checked and clear (No).
  const raw = r.raw || (Array.isArray(r.checks) ? Object.fromEntries(r.checks.map((c) => [c.flag, !!c.on])) : null);
  const fs = flagSet(r.flags, raw);
  const li = (f, st, cls) => `<li class="${cls}"><span>${esc(f.label)}</span><span class="st">${st}</span></li>`;
  const list = fs.raised.map((f) => li(f, 'Yes', 'on ' + f.sev)).join('') + fs.unknown.map((f) => li(f, 'Unknown', 'unk')).join('') + fs.clear.map((f) => li(f, 'No', 'off')).join('');
  const meta = [r.method, isNum(r.at) ? ago(+r.at) : ''].filter(Boolean).join(' · ');
  const body = list ? (fs.raised.length ? `<div class="flagbar">${flagsHTML(r.flags, raw)}</div>` : '') + `<ul class="risk-l">${list}</ul>`
    : `<p class="risk-note">${fs.checked ? 'No flags found.' : 'Not checked yet.'}</p>`;
  return `<section class="panel" aria-labelledby="risk-h"><div class="sec-h"><h2 id="risk-h">Risk check</h2>${meta ? `<span class="muted small">${esc(meta)}</span>` : ''}</div>` + body +
    (fs.unknown.length && fs.checked ? '<p class="risk-note">Unknown: the check could not read it yet.</p>' : '') + '</section>';
}

const LINK_ICON = { website: 'web', x: 'xl', github: 'gh', docs: 'doc' };
const PROOF = { green: 'Proven', yellow: 'Unconfirmed', red: 'Reported wrong' };
function linksPanel(t) {
  // A logo claim is drawn as the token's mark, not listed as a link.
  const links = (t.links || []).filter((l) => l.kind !== 'logo');
  if (!links.length) return '';
  return `<section class="panel" aria-labelledby="links-h"><div class="sec-h"><h2 id="links-h">Links</h2></div><ul class="links-l">` +
    links.map((l) => {
      const st = String(l.state)[0];
      const label = l.value.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const a = l.state === 'red' ? `<a href="${esc(l.value)}" rel="noopener noreferrer nofollow" target="_blank" title="Reported wrong — be careful">${esc(label)}</a>` : `<a href="${esc(l.value)}" rel="noopener noreferrer" target="_blank">${esc(label)}</a>`;
      return `<li class="${st}"><span class="k" aria-label="${esc(l.kind)}">${icon(LINK_ICON[l.kind] || 'web')}</span>${a}<span class="dotw ${st}">${PROOF[l.state] || ''}</span><span class="how">${esc(l.how)}</span></li>`;
    }).join('') + '</ul></section>';
}

function html(ctx, d) {
  const own = d.t;
  const t = coinView(own);
  const watching = ctx.watch.has(t.id);
  // Chain ids ("ethereum", "bnb-chain") read as names. Pages with contracts show the Contracts control instead.
  const chains = (Array.isArray(t.chains) ? t.chains : [t.chain]).filter(Boolean).map(chainName).join(', ');
  const ctl = contractsHTML(own);
  const contract = ctl || (t.contract ? `<span class="addr"><span class="key" title="${esc(t.contract)}">${esc(shortAddr(t.contract))}</span><button class="ibtn" data-copy="${esc(t.contract)}" aria-label="Copy contract address">${icon('copy')}</button></span>` : '');
  const where = ctl ? '' : `<span>${esc(chains)}</span>`;
  const main =
    `<a class="crumb" href="${t.rank ? '#/' : '#/new'}">${icon('down')}${t.rank ? 'Markets' : 'New'}</a>` +
    `<header class="tk-head" style="${hue(tokSeed(t))}">${tokMark(t, 52)}<h1>${esc(labelled(t).name)} <small>${esc(t.symbol || '')}</small>${unnamed(t) || t.nameFlags?.length || visBadge(t) ? `<span class="bdg">${unnamed(t) ? `<span class="nflag q" data-tip="${esc(nameTip(t))}">unnamed</span>` : ''}${nameFlagChips(t)}${visBadge(t)}</span>` : ''}</h1>` +
    `<div class="tk-acts"><button class="btn" data-star="${esc(t.id)}" aria-pressed="${watching}">${icon('star')}<span>Watch</span></button><button class="btn" id="alertbtn" aria-haspopup="dialog" aria-expanded="false">${icon('bell')}Alert</button></div>` +
    `<div class="tk-meta">${t.rank ? `<span class="rk n">#${t.rank}</span>` : '<span class="rk">New</span>'}${t.category ? `<span>${esc(t.category)}</span>${where || contract ? '<span>·</span>' : ''}` : ''}${where}${contract ? (where ? '<span>·</span>' : '') + contract : ''}</div></header>` +
    priceBlock(t) + chartCard(t) +
    `<section class="sec" id="markets" aria-labelledby="mk-h"><div class="sec-h"><h2 id="mk-h">Markets <small class="n">${cnt(d.pager.state.total ?? d.markets.length)}</small></h2>${sideControl(d, t.symbol)}</div><div class="tw">${marketsTable(ctx, d)}</div>` +
    marketsFoot(d) + '</section>' +
    `<section class="sec" id="posts" aria-labelledby="ps-h"><div class="sec-h"><h2 id="ps-h">Posts mentioning $${esc(t.symbol)} <small class="n">${d.posts.length}</small></h2></div>` +
    (d.posts.length ? d.posts.slice(0, 12).map((p) => postHTML(ctx, p)).join('') : '<p class="muted">No posts in your feed mention it yet.</p>') + '</section>';
  const side = memberPanel(own, d.markets) + whyPanel(own) + riskPanel(own) + linksPanel(own);
  return { title: `${t.symbol || t.name || 'Token'} ${priceTxt(t.price)}`, main, side, pv: 'both' };
}

/* ---------- chart controller ---------- */
let chartApi = null, series = [], bucket = 3600, loadSeq = 0;

function readout(i) {
  const el = document.getElementById('readout');
  if (!el || !series.length) return;
  const k = series[i < 0 ? series.length - 1 : i];
  el.classList.toggle('now', i < 0);
  const f = [['Time', esc(readoutTime(k.t, bucket))], ['Open', priceH(k.o)], ['High', priceH(k.h)], ['Low', priceH(k.l)], ['Close', priceH(k.c)], ['Volume', money(k.v)]];
  el.innerHTML = f.map(([a, b]) => `<div><dt>${a}</dt><dd>${b}</dd></div>`).join('');
}

async function draw(ctx, t) {
  const my = ++loadSeq;
  const r = rangeById(ui.range);
  const st = document.getElementById('chart-state');
  if (st) { st.hidden = false; st.textContent = 'Loading chart…'; }
  let res;
  try { res = await ctx.api.candles(t.id, r.tf, r.bars); } catch (e) { if (st) st.textContent = 'Could not load candles.'; return; }
  if (my !== loadSeq || !chartApi) return;
  let c = res.candles || [];
  bucket = TF_SECONDS[r.tf];
  if (ui.mode === 'candle' && TF_SECONDS[r.candle] > bucket) { c = aggregate(c, TF_SECONDS[r.candle]); bucket = TF_SECONDS[r.candle]; }
  series = c;
  if (!c.length) { if (st) st.textContent = 'No candles yet. They appear after the first reports.'; return; }
  if (st) st.hidden = true;
  chartApi.set(c, bucket, ui.mode);
  const ch = rangeChange(c);
  const rc = document.getElementById('rchg');
  if (rc) { rc.className = 'rchg n ' + dir(ch); rc.textContent = ch == null ? '' : pct(ch); }
  readout(-1);
}

const chosen = new Map(); // range the viewer picked, per token

function mount(ctx, d) {
  // A token younger than a day opens on 1H: wider ranges would hold only a few points.
  const young = d.t.firstSeen != null && Date.now() - d.t.firstSeen < 86400e3;
  ui.range = chosen.get(d.t.id) || (young ? '1H' : '1D');
  document.querySelectorAll('[data-range]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.range === ui.range)));
  const fig = document.getElementById('fig');
  let sel = -1;
  let alive = true;
  import('../chart/price-chart.js').then(({ createPriceChart }) => {
    if (!alive || !fig) return;
    chartApi = createPriceChart(fig, { onSelect: (i) => { sel = i; readout(i); } });
    draw(ctx, d.t);
  }).catch(() => { const st = document.getElementById('chart-state'); if (st) st.textContent = 'Chart could not load.'; });
  const onKey = (e) => {
    const n = stepIndex(e.key, sel, series.length);
    if (e.key === 'Escape') { sel = -1; chartApi?.select(-1); readout(-1); return; }
    if (n == null) return;
    e.preventDefault(); sel = n; chartApi?.select(n); readout(n);
  };
  fig?.addEventListener('keydown', onKey);
  // The Contracts list: arrow keys, Home and End move between members; Enter opens one; Escape closes (main.js).
  const onList = (e) => {
    const items = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('#pop.on .ct-go')]);
    const btn = /** @type {HTMLElement} */ (e.target).closest?.('#ct-more');
    if (btn && items.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      (items.find((x) => x.hasAttribute('aria-current')) || items[0]).focus();
      return;
    }
    const a = /** @type {HTMLElement} */ (e.target).closest?.('#pop .ct-l li > *');
    if (!a) return;
    const i = items.indexOf(/** @type {HTMLElement} */ (a.closest('li').querySelector('.ct-go')));
    const j = e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : e.key === 'ArrowUp' ? Math.max(0, i - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -1;
    if (j < 0) return;
    e.preventDefault(); items[j].focus();
  };
  document.addEventListener('keydown', onList);
  fig?.addEventListener('blur', () => { sel = -1; chartApi?.select(-1); readout(-1); });
  mkView = { ctx, d };
  observeMore();
  return () => { alive = false; mkObserver?.disconnect(); mkObserver = null; mkView = null; fig?.removeEventListener('keydown', onKey); document.removeEventListener('keydown', onList); chartApi?.destroy(); chartApi = null; series = []; };
}

function alertForm(t) {
  return `<form id="alertform" style="width:280px"><h3>Alert for ${esc(t.symbol)}</h3>` +
    `<label class="lbl2" for="al-op">When the price</label><select class="inp-t" id="al-op"><option value="above">goes above</option><option value="below">goes below</option><option value="move">moves by % in 1 h</option></select>` +
    `<label class="lbl2" for="al-v" style="margin-top:10px">Value</label><input class="inp-t n" id="al-v" inputmode="decimal" value="${esc(String(+(t.price * 1.05).toPrecision(4)))}" autocomplete="off">` +
    `<div class="frow" style="margin-top:12px;justify-content:flex-end"><button class="btn pri" type="submit">Set alert</button></div><p class="err" id="al-err" hidden></p></form>`;
}

function click(ctx, e, el) {
  const d = ctx.route.name === 'token' && el.closest('#view, #side, #pop') ? true : false;
  if (!d) return;
  let b;
  const t = ctx.idx.byId.get(ctx.route.params.id);
  if ((b = el.closest('[data-range]'))) { ui.range = b.dataset.range; if (t) chosen.set(t.id, ui.range); document.querySelectorAll('[data-range]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); if (t) draw(ctx, t); return; }
  if ((b = el.closest('[data-mode]'))) { ui.mode = b.dataset.mode; document.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); if (t) draw(ctx, t); return; }
  if ((b = el.closest('[data-scroll]'))) { e.preventDefault(); const w = document.getElementById(b.dataset.scroll); if (w) { w.scrollIntoView({ block: 'start' }); w.classList.remove('flash'); void w.offsetWidth; w.classList.add('flash'); } return; }
  if ((b = el.closest('#ct-more')) && t) {
    ctx.openPop(b, contractsPop(t), 'left');
    const cur = /** @type {HTMLElement|null} */ (document.querySelector('#pop .ct-go[aria-current]'));
    // Opened from the keyboard (Enter or Space: a click without a pointer), focus moves to the open member.
    if (/** @type {MouseEvent} */ (e).detail === 0 || b.matches(':focus-visible')) cur?.focus();
    cur?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if ((b = el.closest('[data-copy]'))) { navigator.clipboard?.writeText(b.dataset.copy).then(() => ctx.toast('Address copied.'), () => ctx.toast('Copy failed.', true)); return; }
  if ((b = el.closest('[data-sort]'))) { msort = nextSort(msort, b.dataset.sort); ctx.rerender(); return; }
  if ((b = el.closest('[data-srcall]'))) { srcAll = srcAll === ctx.route.params.id ? '' : ctx.route.params.id; ctx.rerender(); document.querySelector('[data-srcall]')?.focus(); return; }
  if ((b = el.closest('[data-mkside]'))) { mkSide.set(ctx.route.params.id, /** @type {any} */ (b.dataset.mkside)); ctx.reload(); return; }
  if ((b = el.closest('[data-mkmore]'))) { mkAuto = ctx.route.params.id; mkFocus = true; moreMarkets(ctx); return; }
  if ((b = el.closest('#alertbtn')) && t) {
    ctx.openPop(b, alertForm(t));
    const f = document.getElementById('alertform');
    f?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const op = /** @type {HTMLSelectElement} */ (document.getElementById('al-op')).value;
      const v = Number(/** @type {HTMLInputElement} */ (document.getElementById('al-v')).value.replace(/[$,\s]/g, ''));
      const err = document.getElementById('al-err');
      if (!(v > 0)) { err.hidden = false; err.textContent = 'Enter a number above 0.'; return; }
      try {
        await ctx.api.addAlert({ asset: t.id, op, value: v });
        ctx.invalidate('alerts');
        ctx.closePop();
        ctx.toast(`Alert set: ${t.symbol} ${op === 'move' ? 'moves ' + v + '%' : op + ' ' + priceTxt(v)}.`);
      } catch (x) { err.hidden = false; err.textContent = /** @type {Error} */ (x).message; }
    });
  }
}

export default {
  load, html, mount, click,
  onPrice(ctx, t) {
    if (ctx.route.name !== 'token' || ctx.route.params.id !== t.id) return;
    // A coin page headlines the group price; one member's own tick does not replace it.
    if (ctx.idx.byId.get(t.id)?.coinGroup) return;
    const big = document.getElementById('tk-big'); if (big) big.innerHTML = priceH(t.price);
    const ch = document.getElementById('tk-ch');
    if (ch && isNum(t.change24h)) { ch.className = 'd n ' + dir(t.change24h); ch.innerHTML = `${pct(t.change24h)} <span class="muted" style="font-weight:500;font-size:13px">24 h</span>`; }
  },
};

export { compact };
