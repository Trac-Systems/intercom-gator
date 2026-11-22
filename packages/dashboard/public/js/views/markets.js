// Markets (home): pulse band, global numbers + Fear & Greed, tabs, the list.
//
// Lists are paged (the API answers 100 rows by default, 500 at most). Token tabs sort on the
// server, so a sort holds across pages; the smaller summary lists (categories, chains, …) load
// 500 rows a page and sort in the browser. A young node lacks history: columns with no value in
// any loaded row are left out and named in one quiet note instead of a column of dashes.

import { esc, money, pct, dir, cnt, grp, priceTxt, funding, compact, chainName, MINUS } from '../lib/format.js';
import { kp, hue, tokSeed } from '../lib/keyprint.js';
import { tokMark, chainMark, exMark } from '../lib/logo.js';
import { href } from '../lib/router.js';
import { matches } from '../lib/text.js';
import { createPager, pagerCache } from '../lib/pager.js';
import { icon, tokCell, priceCell, spark, starBtn, tableHTML, sortRows, nextSort, scoreHTML, tokHref, tokId, rowLink, moreHTML, emptyHTML, dash } from '../ui/components.js';
import { loadSocial, socialSide } from '../ui/side.js';
import { ribbon } from '../ui/ribbon.js';
import { hiddenControl, hiddenKey, includeFor, labelled, noteHidden, rowBadges, toggleHidden, unverifiedVolume, visBadge, withBadges } from '../lib/listmeta.js';
import { ethUsdHTML, nftHref, collectingHTML } from '../ui/nfts.js';

const TABS = [['all', 'All'], ['watch', 'Watchlist'], ['trending', 'Trending'], ['gainers', 'Gainers'], ['losers', 'Losers'], ['categories', 'Categories'], ['chains', 'Chains']];
// NFTs stay hidden until the on-chain NFT sales source ships; the view below is kept for it.
const MORE = [['derivatives', 'Derivatives'], ['exchanges', 'Exchanges']];
const TOKEN_TABS = new Set(['all', 'watch', 'trending', 'gainers', 'losers']);
// Lists that leave out stale, unconfirmed and dust entries (the watchlist always shows yours; NFTs have no prices).
const HIDING = new Set(['all', 'trending', 'gainers', 'losers', 'categories', 'chains', 'derivatives', 'exchanges']);
export const PAGE = 100; // token rows per page
export const PAGE_SUMMARY = 500; // summary rows per page (the API maximum)
let sort = null; // { tab, k, dir }
let focusAfter = ''; // selector to focus after the next paint (sort header, "Show more")
let nftStatus = null; // what the node collects (GET /nfts status), for the NFTs tab's notes and empty state
const pagers = pagerCache(60000);

const isNum = (x) => x != null && x !== '' && Number.isFinite(+x);
const has = (rows, f) => rows.some((r) => isNum(f(r)));

function tabOf(route) { const t = route.params.tab || 'all'; return TABS.some((x) => x[0] === t) || MORE.some((x) => x[0] === t) ? t : 'all'; }

/** Server sort keys for /markets, as the dashboard's column keys. */
const SERVER_SORT = new Set(['rank', 'name', 'price', 'change1h', 'change24h', 'change7d', 'volume24h', 'marketCap']);

/** The pager for a tab (+ filter + sort). Exported for tests. */
export function listPager(api, tab, { cat, chain, so, note } = {}) {
  if (TOKEN_TABS.has(tab)) {
    const s = so && SERVER_SORT.has(so.k) ? so : null;
    const key = `mk:${tab}:${cat || ''}:${chain || ''}:${s ? s.k + ':' + s.dir : ''}${hiddenKey(tab)}`;
    return pagers.get(key, () => createPager(async (offset, limit) => {
      const r = await api.markets({ tab, category: cat, chain, limit, offset, ...(s ? { sort: s.k, order: s.dir > 0 ? 'asc' : 'desc' } : {}), ...includeFor(tab) });
      if (offset === 0) noteHidden(tab, r.hidden);
      if (note) note(r.items || []);
      // The API's total counts every token, so it only describes the unfiltered All list.
      return { items: r.items, total: tab === 'all' && !cat && !chain ? r.total : undefined };
    }, { limit: PAGE }));
  }
  const call = { categories: api.categories, chains: api.chains, derivatives: api.derivatives, nfts: api.nfts, exchanges: api.exchanges }[tab];
  const idOf = tab === 'categories' || tab === 'chains' ? (x) => x.name : tab === 'derivatives' ? (x) => x.id ?? `${x.exchange || ''}:${x.symbol}` : (x) => x.id ?? x.name;
  return pagers.get('mk:' + tab + hiddenKey(tab), () => createPager(async (offset, limit) => {
    const r = await call({ limit, offset, ...(HIDING.has(tab) ? includeFor(tab) : {}) });
    if (offset === 0 && HIDING.has(tab)) noteHidden(tab, r.hidden);
    if (offset === 0 && tab === 'nfts') nftStatus = r.status ?? null;
    return r;
  }, { limit: PAGE_SUMMARY, idOf }));
}

async function load(ctx, route) {
  const tab = tabOf(route);
  const { api } = ctx;
  const cat = route.query.cat, chain = route.query.chain;
  const so = sort && sort.tab === tab ? sort : null;
  if (tab === 'watch') pagers.clear('mk:watch:'); // your own list: always fresh
  const pager = listPager(api, tab, { cat, chain, so, note: (items) => ctx.noteTokens(items) });
  const first = pager.state.pages ? null : pager.more();
  const [global, fg, all, social, counts] = await Promise.all([
    ctx.cached('global', () => api.global()),
    ctx.cached('fg', () => api.fearGreed()),
    ctx.cached('markets:all::', () => api.markets({ tab: 'all' })),
    loadSocial(ctx),
    ctx.cached('more-counts', async () => {
      const n = (r) => (r.items.length >= PAGE_SUMMARY ? PAGE_SUMMARY + '+' : r.items.length);
      const [d, e] = await Promise.all([api.derivatives({ limit: PAGE_SUMMARY }), api.exchanges({ limit: PAGE_SUMMARY })]);
      for (const x of e.items) if (x.id && x.name) venues.set(x.id, x.name);
      return { derivatives: n(d), exchanges: n(e) };
    }, 300000).catch(() => ({})),
    first,
  ]);
  const extras = await ctx.cached('extras', () => api.extras()).catch(() => ({ items: [] }));
  ctx.noteTokens(all.items);
  const tp = {};
  for (const t of social.trending) if (t.tag[0] === '$') tp[t.tag.slice(1)] = t.posts;
  return { tab, global, fg, all: all.items, pager, list: pager.state.items, social, counts, cat, chain, tagPosts: tp, extras: extras.items || [] };
}

/* ---------- hero ---------- */
/** "0.000000007 gwei" → "<0.001", "7.512 gwei" → "7.51": the stat has room for a few characters. */
export function gasNum(v) {
  const n = parseFloat(String(v));
  if (!Number.isFinite(n)) return String(v).replace(/\s*gwei/, '');
  if (n > 0 && n < 0.001) return '<0.001';
  return String(+n.toPrecision(n < 1 ? 2 : 3));
}
function hero(g, f) {
  // A fresh or partial node can lack any of these measurements: a quiet dash and, on hover, why.
  const dom = (x) => (isNum(x) ? (+x).toFixed(1) + '%' : '—');
  const capS = money(g.marketCap);
  const capHtml = capS === '—' ? '<span class="big n nil">—</span>' : `<span class="big n"><span class="cur">$</span>${capS.slice(1, -1)}<span class="u">${capS.slice(-1)}</span></span>`;
  const capSub = capS === '—' ? '<span class="d why">needs supply data</span>' : `<span class="d n ${dir(g.marketCapChange24h)}">${isNum(g.marketCapChange24h) ? pct(g.marketCapChange24h) : ''}</span>`;
  // Ethereum's base fee leads when the node has it; the others are in the tooltip.
  const gas0All = Array.isArray(g.gas) ? g.gas.filter((x) => x && typeof x.value === 'string') : [];
  const gasList = gas0All.slice().sort((a, b) => Number(/^ethereum$/i.test(b.chain || '')) - Number(/^ethereum$/i.test(a.chain || '')));
  const pegs = (Array.isArray(g.pegs) ? g.pegs : []).map((x) => x.symbol + ' ' + priceTxt(x.price)).join(' · ');
  const gas0 = gasList[0];
  const gasV = !gas0 || typeof gas0.value !== 'string' ? '—'
    : /gwei/.test(gas0.value) ? `${esc(gasNum(gas0.value))}<small>gwei</small>` : esc(gas0.value);
  const stat = (lbl, val, tip) => `<div class="stat"${tip ? ` data-tip="${esc(tip)}" tabindex="0"` : ''}><span class="lbl">${lbl}</span><span class="val n${val === '—' ? ' nil' : ''}">${val}</span></div>`;
  const fv = f && isNum(f.value) ? Math.round(+f.value) : null;
  const partial = fv != null && (f.partial === true || (Array.isArray(f.missing) && f.missing.length > 0));
  const hist = f && Array.isArray(f.history30d) ? f.history30d : [];
  const fgLbl = fv == null ? '<span class="part">collecting</span>' : `<span>${esc(f.label || '')}</span>${partial ? '<span class="part">partial</span>' : ''}`;
  return `<section class="hero" id="hero" aria-label="Global">` +
    `<div class="cap"><span class="lbl">Market cap</span><div class="v">${capHtml}${capSub}</div></div>` +
    '<div class="stats">' +
    stat('Volume 24 h', money(g.volume24h)) +
    stat('BTC dominance', dom(g.btcDominance), isNum(g.btcDominance) ? `ETH ${dom(g.ethDominance)}` : 'Needs supply data') +
    stat('Stablecoins', money(g.stablecoins), pegs || (isNum(g.stablecoins) ? '' : 'Needs supply data')) +
    stat('Gas', gasV, gasList.map((x) => x.chain + ' ' + x.value).join(' · ')) +
    '</div>' +
    `<button class="fg" id="fg" aria-haspopup="dialog" aria-expanded="false" aria-label="Fear and Greed ${fv == null ? 'collecting' : fv + ', ' + esc(f.label || '') + (partial ? ', partial' : '')}"><span class="lbl">Fear &amp; Greed</span><span class="val n">${fv == null ? '<span class="nil">—</span>' : fv}${fgLbl}</span>${hist.filter(isNum).length >= 2 ? ribbon(hist, 112, 30) : ''}</button>` +
    '</section>';
}

/* ---------- pulse band (drawn after insertion: labels depend on measured width) ---------- */
function tone(ch) {
  if (!isNum(ch)) return { bg: 'var(--s3)', strong: false };
  const a = Math.abs(ch);
  if (a < 0.3) return { bg: 'var(--s3)', strong: false };
  const p = Math.round(26 + Math.min(a / 10, 1) * 62);
  return { bg: `color-mix(in oklab,var(--${ch > 0 ? 'up' : 'down'}) ${p}%,var(--bg))`, strong: p > 52 };
}
/** What sizes the band: market cap when enough tokens have one, else 24 h volume. Exported for tests. */
export function bandBasis(tokens) {
  // Market cap only once the biggest tokens (by volume) all have one; with partial supply data a
  // cap-sized band would silently drop the largest assets (BTC before its supply is known).
  const ids = tokens.filter((t) => tokId(t));
  const topVol = ids.filter((t) => isNum(t.volume24h) && t.volume24h > 0).sort((a, b) => b.volume24h - a.volume24h).slice(0, 10);
  const k = topVol.length >= 3 && topVol.every((t) => isNum(t.marketCap) && t.marketCap > 0) ? 'marketCap' : 'volume24h';
  const list = tokens.filter((t) => isNum(t[k]) && t[k] > 0 && tokId(t)).sort((a, b) => b[k] - a[k]).slice(0, 30);
  return { k, list, changes: list.some((t) => isNum(t.change24h)) };
}
function drawBand(el, tokens) {
  const { k, list, changes } = bandBasis(tokens);
  const total = list.reduce((s, t) => s + t[k], 0);
  const w = el.clientWidth || 800;
  el.innerHTML = list.map((t) => {
    const share = t[k] / total, px = share * w, tn = tone(t.change24h);
    const v = changes ? pct(t.change24h) : money(t[k]);
    const inner = px > 150 ? `<span class="sl wide">${tokMark(t, 22)}<b>${esc(t.symbol)}</b><span>${v}${changes ? ` <span class="mc">· ${money(t[k])}</span>` : ''}</span></span>`
      : px > 84 ? `<span class="sl mid">${tokMark(t, 18)}<b>${esc(t.symbol)}</b><span>${v}</span></span>`
        : px > 54 ? `<span class="sl nok"><b>${esc(t.symbol)}</b><span>${v}</span></span>`
          : px > 40 ? `<span class="sl nok"><b>${esc(t.symbol)}</b></span>` : '';
    return `<a class="seg${tn.strong ? ' strong' : ''}" href="${esc(tokHref(t))}" data-band="${esc(t.id)}" style="flex-grow:${share.toFixed(5)};--tone:${tn.bg};${hue(tokSeed(t))}" aria-label="${esc(t.name + ' ' + (changes ? pct(t.change24h) : money(t[k])))}">${inner}</a>`;
  }).join('');
}
function legend() {
  return `<span class="n">${MINUS}10%</span>` + [-10, -5, 0, 5, 10].map((s) => `<i style="background:${tone(s).bg}"></i>`).join('') + '<span class="n">+10%</span>';
}
function pulse(all) {
  const { k, list, changes } = bandBasis(all);
  if (list.length < 3) return '';
  const basis = k === 'marketCap' ? 'market cap' : 'volume';
  const title = `Top ${list.length} · ${basis} · ` + (changes ? '24 h' : '24 h change: collecting history');
  return `<section class="pulse" aria-label="Market pulse"><div class="band" id="band"></div><div class="band-h"><h2 data-short="Top ${list.length} · ${changes ? '24 h' : basis}">${esc(title)}</h2>${changes ? `<div class="legend">${legend()}</div>` : ''}</div></section>`;
}

/* ---------- tables ---------- */
/** Venue display names from the exchanges list ("crypto-com" → "Crypto.com"). */
const venues = new Map();
const venueName = (id) => venues.get(id) || id;

const derivFunding = (x) => {
  if (!isNum(x.funding)) return null;
  // Engine rows (they carry openInterestUnit) hold the venue's raw rate, a fraction per interval; sample rows are in percent.
  return x.openInterestUnit !== undefined ? +x.funding * 100 : +x.funding;
};

function models(ctx, d) {
  const q = ctx.q;
  const rows0 = d.list;
  return {
    tokens: () => {
      const show = {
        change1h: has(rows0, (t) => t.change1h), change24h: has(rows0, (t) => t.change24h), change7d: has(rows0, (t) => t.change7d),
        marketCap: has(rows0, (t) => t.marketCap), spark: rows0.some((t) => Array.isArray(t.spark7d) && t.spark7d.length > 1),
      };
      const cols = [['rank', '#', 'l c-rank'], ['name', 'Token', 'l c-tok'], ['price', 'Price', 'c-price'],
        show.change1h && ['change1h', '1 h', 'c-1h'], show.change24h && ['change24h', '24 h', 'c-24'], show.change7d && ['change7d', '7 d', 'c-7d'],
        ['volume24h', 'Volume', 'c-vol'], show.marketCap && ['marketCap', 'Market cap', 'c-mc'], show.spark && [null, '7 days', 'c-spark']].filter(Boolean);
      const notes = [];
      if (rows0.length && !show.change24h && !show.change7d) notes.push('24 h and 7 d change: collecting history');
      else if (rows0.length && !show.change7d) notes.push('7 d change: collecting history');
      if (rows0.length && !show.marketCap) notes.push('Market cap: needs supply data');
      if (rows0.length && !show.spark && show.change7d) notes.push('7-day chart: collecting history');
      const empty = {
        all: d.cat || d.chain ? ['No tokens here yet.', 'Prices for this filter arrive as your node reads them.'] : ['No prices yet.', 'Your node is joining the network; the first prices arrive within minutes.'],
        watch: ['No stars yet.', 'Tap the star next to a token to watch it.'],
        trending: ['Nothing trending yet.', ''],
        gainers: ['No gainers yet.', 'Gainers need 24 h of prices; your node is collecting them.'],
        losers: ['No losers yet.', 'Losers need 24 h of prices; your node is collecting them.'],
      }[d.tab];
      return {
        cols, notes, server: true, cls: 't-tok',
        rows: () => rows0.filter((t) => (d.tab !== 'watch' || ctx.watch.has(t.id)) && matches(q, t.name, t.symbol)),
        row: (t) => {
          const sub = d.tab === 'trending' && d.tagPosts[t.symbol] ? `${t.symbol} · ${cnt(d.tagPosts[t.symbol])} posts` : t.symbol;
          const c = (k, cls) => (show[k] ? `<td class="${cls} ${dir(t[k])}">${pct(t[k])}</td>` : '');
          return `<tr data-id="${esc(t.id)}"${rowLink(t)} style="${hue(tokSeed(t))}"><td class="l c-rank">${starBtn(ctx, t)}<span class="rk n">${t.rank ?? ''}</span></td><td class="l c-tok">${withBadges(tokCell(ctx, labelled(t), sub), rowBadges(t))}</td>` +
            `<td class="c-price">${priceCell(t.price, t, show.change24h ? t.change24h : null)}</td>${c('change1h', 'c-1h')}${c('change24h', 'c-24')}${c('change7d', 'c-7d')}` +
            `<td class="c-vol">${money(t.volume24h)}</td>${show.marketCap ? `<td class="c-mc">${money(t.marketCap)}</td>` : ''}${show.spark ? `<td class="c-spark">${spark(t.spark7d)}</td>` : ''}</tr>`;
        },
        val: (t, k) => (k === 'name' ? String(t.name).toLowerCase() : t[k]),
        empty: q ? emptyHTML('No match in the loaded rows.', '⌘K searches every token.') : emptyHTML(empty[0], empty[1]),
      };
    },
    categories: () => {
      const showCap = has(rows0, (c) => (c.marketCap > 0 ? c.marketCap : null)), showCh = has(rows0, (c) => c.change24h);
      return {
        cols: [['name', 'Category', 'l c-tok'], [null, 'Top', 'l c-extra'], showCap && ['marketCap', 'Market cap', 'c-mc'], showCh && ['change24h', '24 h', '']].filter(Boolean),
        notes: rows0.length ? [!showCap && 'Market cap: needs supply data', !showCh && '24 h change: collecting history'].filter(Boolean) : [],
        rows: () => rows0.filter((x) => matches(q, x.name)),
        row: (c) => {
          const top = Array.isArray(c.top) ? c.top : [];
          return `<tr class="click" data-href="${esc(href('markets', {}, { cat: c.name }))}" tabindex="0"><td class="l c-tok"><b style="font-weight:640;font-size:14.5px">${esc(c.name)}</b>${isNum(c.assets) ? ` <span class="muted n small">${cnt(c.assets)}</span>` : ''}</td><td class="l c-extra"><span class="stack">${top.map((s) => { const t = ctx.idx.bySym.get(s); return t ? tokMark(t, 22) : kp('Ethereum:' + s, 'coin', 22); }).join('')}</span> <span class="muted" style="margin-left:8px">${esc(top.join(', '))}</span></td>` +
            `${showCap ? `<td class="c-mc">${c.marketCap > 0 ? money(c.marketCap) : dash()}</td>` : ''}${showCh ? `<td class="${dir(c.change24h)}">${pct(c.change24h)}</td>` : ''}</tr>`;
        },
        val: (c, k) => (k === 'name' ? String(c.name).toLowerCase() : c[k]),
        empty: emptyHTML('No categories yet.', 'They fill in as prices arrive.'),
      };
    },
    chains: () => ({
      cols: [['name', 'Chain', 'l c-tok'], ['dexVolume24h', 'DEX volume', ''], ['pools', 'Pools', 'c-mc'], ['newPools24h', 'New 24 h', 'c-extra']],
      notes: [],
      rows: () => rows0.filter((x) => matches(q, x.name)),
      row: (c) => `<tr class="click" data-href="${esc(href('markets', {}, { chain: c.name }))}" tabindex="0"><td class="l c-tok"><div class="tok">${chainMark(c, 28)}<div class="nm"><b>${esc(chainName(c.name))}</b></div></div></td><td>${isNum(c.dexVolume24h) ? money(c.dexVolume24h) : dash()}</td><td class="c-mc n">${cnt(c.pools ?? 0)}</td><td class="c-extra n">${cnt(c.newPools24h ?? 0)}</td></tr>`,
      val: (c, k) => (k === 'name' ? String(c.name).toLowerCase() : c[k]),
      empty: emptyHTML('No chain activity yet.', 'Chains appear once your node reads DEX pools.'),
    }),
    derivatives: () => {
      const showOi = has(rows0, (x) => x.oiChange24h);
      return {
        cols: [['symbol', 'Perp', 'l c-tok'], ['funding', 'Funding', ''], ['openInterest', 'Open interest', 'c-mc'], showOi && ['oiChange24h', 'OI 24 h', '']].filter(Boolean),
        notes: rows0.length && !showOi ? ['OI 24 h: collecting history'] : [],
        rows: () => rows0.filter((x) => { const t = x.asset && ctx.idx.byId.get(x.asset); return matches(q, t && t.name, x.symbol, x.exchange); }),
        row: (x) => {
          // Only the API's own mapping makes a row a link; a bare symbol can match the wrong token.
          const known = x.asset ? ctx.idx.byId.get(x.asset) : null;
          const t = known ? { ...known } : { id: x.asset || null, symbol: x.symbol, name: x.symbol, chains: [x.chain || x.exchange || '?'] };
          const venue = x.exchange ? venueName(x.exchange) : '';
          const f = derivFunding(x);
          const oi = !isNum(x.openInterest) ? dash() : x.openInterestUnit && x.openInterestUnit !== 'USD'
            ? `<span data-tip="In the venue's own units (${esc(x.openInterestUnit)})">${compact(+x.openInterest)}</span>` : money(+x.openInterest);
          // Engine rows carry the venue's own contract symbol; sample rows only the base.
          const contract = x.exchange ? x.symbol : x.symbol + '-PERP';
          const sub = known || !x.exchange ? [contract, venue].filter(Boolean).join(' · ') : venue;
          return `<tr${x.asset ? ` data-id="${esc(x.asset)}"` : ''}${rowLink(t)}><td class="l c-tok">${withBadges(tokCell(ctx, t, sub), visBadge(x))}</td><td class="${f > 0 ? 'up' : f < 0 ? 'down' : 'flat'}">${f == null ? dash() : funding(f)}</td><td class="c-mc">${oi}</td>${showOi ? `<td class="${dir(x.oiChange24h)}">${pct(x.oiChange24h)}</td>` : ''}</tr>`;
        },
        val: (x, k) => (k === 'symbol' ? String(x.symbol).toLowerCase() : x[k]),
        empty: emptyHTML('No derivatives yet.', 'Funding and open interest appear once a venue reports them.'),
      };
    },
    nfts: () => {
      // Engine rows carry numbers and a status; sample rows carry preformatted strings.
      const live = rows0.some((n) => n.kind === 'nft');
      const showCh = has(rows0, (n) => n.change24h);
      const st = nftStatus;
      const young = st && st.chains?.length && (st.sales24h ?? 0) < 50;
      return {
        cols: [['name', 'Collection', 'l c-tok'], ['chain', 'Chain', 'c-extra'], ['floor', 'Sale floor', ''], ['volume24h', 'Volume 24 h', 'c-vol'],
          live && ['sales24h', 'Sales', 'c-mc'], showCh && ['change24h', '24 h', 'c-24']].filter(Boolean),
        notes: [live && 'Sale floor: the low end of recent sales seen by your node, not a listing floor',
          rows0.length && !showCh && '24 h change: collecting history', young && 'Young node: few sales seen yet'].filter(Boolean),
        rows: () => rows0.filter((x) => matches(q, x.name || x.collection, x.symbol, x.chain, x.chainName)),
        row: (n) => {
          const name = n.name || n.collection || (n.address ? n.address.slice(0, 10) + '…' : '');
          const chain = n.chainName || chainName(n.chain || '');
          const link = n.kind === 'nft' && n.id ? ` class="click" data-href="${esc(nftHref(n.id))}" tabindex="0"` : '';
          const sub = [n.symbol, n.seeded && !n.sales24h ? 'no sales seen yet' : ''].filter(Boolean).join(' · ');
          const vol = n.kind === 'nft' ? (n.sales24h ? ethUsdHTML(n.volume24hEth, n.volume24h) : dash())
            : isNum(n.volume24h) ? money(+n.volume24h) : n.volume24h ? esc(n.volume24h) : dash();
          const floor = n.kind === 'nft' ? ethUsdHTML(n.floor, n.floorUsd) : n.floor ? esc(n.floor) : dash();
          return `<tr${link}><td class="l c-tok"><div class="tok">${kp('nft:' + (n.chain || '') + ':' + (n.address || name), 'tag', 28)}<div class="nm"><b>${esc(name)}</b><span>${esc(sub || chain)}</span></div></div></td>` +
            `<td class="c-extra">${esc(chain)}</td><td>${n.floor == null && n.kind === 'nft' ? `<span class="muted small">${n.sales24h ? 'needs 3 sales' : dash()}</span>` : floor}</td><td class="c-vol">${vol}</td>` +
            `${live ? `<td class="c-mc n">${cnt(n.sales24h ?? 0)}${n.washSales24h ? ` <span class="muted small" data-tip="Wash-like trades left out" tabindex="0">+${cnt(n.washSales24h)}</span>` : ''}</td>` : ''}` +
            `${showCh ? `<td class="c-24 ${dir(n.change24h)}">${pct(n.change24h)}</td>` : ''}</tr>`;
        },
        val: (n, k) => (k === 'name' ? String(n.name || n.collection || '').toLowerCase() : k === 'chain' ? String(n.chainName || n.chain || '')
          : k === 'floor' || k === 'volume24h' ? (isNum(n[k]) ? +n[k] : parseFloat(String(n[k]).replace(/,/g, ''))) : n[k]),
        empty: `<div class="empty-state quiet"><b>No NFT sales seen yet.</b>Your node reads marketplace sales from chain logs.${st ? collectingHTML(st) : ''}</div>`,
        after: live && st ? `<details class="collecting"><summary>What your node collects</summary>${collectingHTML(st)}</details>` : '',
      };
    },
    exchanges: () => ({
      cols: [['name', 'Exchange', 'l c-tok'], ['volume24h', 'Volume', ''], ['markets', 'Markets', 'c-mc'], has(rows0, (e) => e.trustScore) && ['trustScore', 'Trust', 'c-extra']].filter(Boolean),
      notes: rows0.length && !has(rows0, (e) => e.trustScore) ? ['Trust: not scored yet'] : [],
      rows: () => rows0.filter((x) => matches(q, x.name, x.kind, x.chain)),
      row: (e) => `<tr class="click" data-href="${esc(href('exchanges', {}, { x: e.id }))}" tabindex="0"><td class="l c-tok"><div class="tok">${exMark(e.name, e.logo, 28)}<div class="nm"><b>${esc(e.name)}</b><span>${esc(e.kind)}${e.chain ? ' · ' + esc(e.chain) : ''}${visBadge(e) ? `<span class="bdg">${visBadge(e)}</span>` : ''}</span></div></div></td><td>${money(e.volume24h)}${unverifiedVolume(e)}</td><td class="c-mc n">${cnt(e.markets ?? 0)}</td>${has(rows0, (x) => x.trustScore) ? `<td class="c-extra">${scoreHTML(e.trustScore, e.trustWhy)}</td>` : ''}</tr>`,
      val: (e, k) => (k === 'name' ? String(e.name).toLowerCase() : e[k]),
      empty: emptyHTML('No exchanges yet.', 'Venues appear as your node reads them.'),
    }),
  };
}

function tabsHTML(ctx, d) {
  const moreOn = MORE.find((m) => m[0] === d.tab);
  return `<div class="tabsbar"><div class="tabs" id="tabs" role="tablist" aria-label="Lists">` + TABS.map(([id, label]) => {
    const c = id === 'watch' ? `<sup class="n">${ctx.watch.size}</sup>` : '';
    return `<a class="tab" role="tab" href="${href('markets', { tab: id })}" aria-selected="${d.tab === id}"${d.tab === id ? '' : ' tabindex="-1"'}>${label}${c}</a>`;
  }).join('') + `<button class="tab" id="morebtn" role="tab" aria-haspopup="menu" aria-expanded="false" aria-selected="${!!moreOn}"${moreOn ? '' : ' tabindex="-1"'}>${moreOn ? moreOn[1] : 'More'}${icon('down')}</button><span class="ind"></span></div></div>`;
}

function html(ctx, d) {
  const M = models(ctx, d);
  const model = TOKEN_TABS.has(d.tab) ? M.tokens() : M[d.tab]();
  const so = sort && sort.tab === d.tab ? sort : null;
  // Token tabs come sorted from the server (across pages); the rest sort what is loaded.
  const rows = model.server ? model.rows() : sortRows(model.rows(), so, model.val);
  const filter = d.cat || d.chain;
  const st = d.pager.state;
  const fcount = st.done ? `${cnt(rows.length)} tokens` : `${cnt(rows.length)}+ tokens`;
  const notes = model.notes.length ? `<div class="note-row">${model.notes.map((n) => `<span>${esc(n)}</span>`).join('')}</div>` : '';
  const empty = !rows.length && !d.list.length;
  const main =
    pulse(d.all) +
    hero(d.global, d.fg) + tabsHTML(ctx, d) +
    (filter ? `<div class="filter"><a class="chip" href="#/" aria-label="Clear filter ${esc(filter)}" style="background:var(--acc-soft);color:var(--acc-ink)">${esc(filter)}${icon('x', 'i-s')}</a><span class="n">${fcount}</span></div>` : '') +
    notes + (HIDING.has(d.tab) ? hiddenControl(d.tab) : '') + promoted(ctx, d) +
    `<div class="tw" id="tw" role="tabpanel">${empty ? model.empty : tableHTML({ cols: model.cols, rows, row: model.row, sort: so, cls: model.cls || '', empty: model.empty, caption: 'Markets' })}</div>` +
    (empty ? '' : moreHTML(st, d.tab, d.pager.limit)) + (model.after || '');
  return { title: d.tab === 'all' ? 'Markets' : (TABS.concat(MORE).find((x) => x[0] === d.tab) || [])[1], main, side: socialSide(ctx, d.social) };
}

/** The paid promoted token: a labelled card above the token list, never a row in it (DESIGN §8). One promoted item
 * per screen, so the side panel's pinned post yields to it. */
function promoted(ctx, d) {
  if (!TOKEN_TABS.has(d.tab)) return '';
  const live = (d.extras || []).find((x) => x.slot === 'promoted-token' && x.token && tokId(x.token));
  if (!live || !ctx.takePromo()) return '';
  const t = live.token;
  return `<a class="promo-card" href="${esc(tokHref(t))}" style="${hue(tokSeed(t))}">${tokMark(t, 36)}<b>${esc(t.name)} <span class="muted" style="font-weight:500">${esc(t.symbol)}</span></b><span class="promo-l">Promoted</span><span class="t2">${t.price != null ? esc(money(t.price)) + ' · ' : ''}${esc(chainName(t.chain))}</span></a>`;
}

function mount(ctx, d) {
  const band = document.getElementById('band');
  if (band) drawBand(band, d.all);
  if (focusAfter) { /** @type {HTMLElement|null} */ (document.querySelector(focusAfter))?.focus(); focusAfter = ''; }
  return null;
}

function click(ctx, e, t) {
  let el;
  if ((el = t.closest('[data-hidden]'))) {
    toggleHidden(el.dataset.hidden);
    focusAfter = `[data-hidden="${el.dataset.hidden}"]`;
    ctx.reload();
    return;
  }
  if ((el = t.closest('[data-sort]'))) {
    const tab = tabOf(ctx.route);
    const cur = sort && sort.tab === tab ? sort : null;
    const n = nextSort(cur, el.dataset.sort);
    sort = n ? { tab, ...n } : null;
    focusAfter = `[data-sort="${el.dataset.sort}"]`;
    // Token lists sort on the server so the order holds across pages: load page 1 again.
    if (TOKEN_TABS.has(tab)) ctx.reload(); else { ctx.rerender(); }
    return;
  }
  if ((el = t.closest('[data-more]'))) {
    const tab = tabOf(ctx.route);
    const so = sort && sort.tab === tab ? sort : null;
    const pager = listPager(ctx.api, tab, { cat: ctx.route.query.cat, chain: ctx.route.query.chain, so, note: (items) => ctx.noteTokens(items) });
    const p = pager.more();
    focusAfter = '[data-more]';
    ctx.rerender();
    p.then(() => { focusAfter = '[data-more]'; ctx.rerender(); }, () => { ctx.toast('Could not load more rows.', true); ctx.rerender(); });
    return;
  }
  if ((el = t.closest('#morebtn'))) {
    const tab = tabOf(ctx.route);
    ctx.cached('more-counts', async () => ({})).then((c) => {
      ctx.openPop(el, '<div class="menu" role="menu">' + MORE.map(([id, label]) =>
        `<a role="menuitem" href="${href('markets', { tab: id })}"${tab === id ? ' aria-current="true"' : ''} style="display:flex;justify-content:space-between;gap:20px;padding:9px 12px;font-weight:530;font-size:14px">${label}<span class="muted n">${c[id] ?? ''}</span></a>`).join('') + '</div>', 'left');
    });
  }
}

export default {
  load, html, mount, click,
  onWatch(ctx) { if (tabOf(ctx.route) === 'watch') ctx.rerender(); else { const s = document.querySelector('#tabs [href$="markets/watch"] sup'); if (s) s.textContent = String(ctx.watch.size); } },
  onResize(ctx) { const band = document.getElementById('band'); if (band && ctx.idx.byId.size) drawBand(band, [...ctx.idx.byId.values()].filter((t) => t.rank)); },
};
