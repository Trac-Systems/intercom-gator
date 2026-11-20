// intercom-gator dashboard — boot, router, shell (nav, search, tooltips, popovers, live updates).

import { createApi, urlOptions } from './api.js';
import { parse, href, navKey } from './lib/router.js';
import { esc, cnt, priceH, priceParts, pct, dir, money, ago, fgLabel } from './lib/format.js';
import { kp, brandSVG, tokSeed, keySeed } from './lib/keyprint.js';
import { face, watchAvatars } from './lib/face.js';
import { tokMark } from './lib/logo.js';
import { tickers } from './lib/text.js';
import { icon, ch24, loadingHTML, errorHTML, flagPop, tokId } from './ui/components.js';
import { ribbon } from './ui/ribbon.js';

import markets from './views/markets.js';
import token from './views/token.js';
import newTokens from './views/new.js';
import exchanges from './views/exchanges.js';
import feed from './views/feed.js';
import thread from './views/thread.js';
import profile from './views/profile.js';
import channels from './views/channels.js';
import portfolio from './views/portfolio.js';
import settings from './views/settings.js';
import nft from './views/nft.js';
import notfound from './views/notfound.js';

const VIEWS = { markets, token, nft, new: newTokens, exchanges, feed, post: thread, profile, channels, portfolio, settings, notfound };

const $ = (s, r = document) => /** @type {HTMLElement} */ (r.querySelector(s));
const $$ = (s, r = document) => /** @type {HTMLElement[]} */ ([...r.querySelectorAll(s)]);
const reduced = () => matchMedia('(prefers-reduced-motion:reduce)').matches;
const narrow = () => matchMedia('(max-width:999px)').matches;

const opts = urlOptions(location.search);
if (opts.still) {
  // Screenshot / test mode: keep the last script error on <html> so headless runs can read it.
  addEventListener('error', (e) => { document.documentElement.dataset.err = String(e.message); });
  addEventListener('unhandledrejection', (e) => { document.documentElement.dataset.err = String(e.reason?.stack || e.reason); });
}
const api = createApi({ demo: opts.demo, still: opts.still });

/* ---------------- context shared by all views ---------------- */
const cache = new Map();
const ctx = {
  api,
  /** @type {import('./lib/router.js').Route} */ route: parse(location.hash),
  idx: { byId: new Map(), bySym: new Map() },
  /** handle → person (for @mentions) */ people: new Map(),
  /** symbol → posts mentioning it (from your feed) */ mentions: new Map(),
  watch: new Set(),
  me: null,
  network: null,
  canPost: true,
  q: '',
  promoUsed: false,
  /** At most one promoted item per screen: the first caller gets it. */
  takePromo() { if (ctx.promoUsed) return false; ctx.promoUsed = true; return true; },
  /** @template T @param {string} key @param {() => Promise<T>} fn @param {number} [ttl] @returns {Promise<T>} */
  cached(key, fn, ttl = 30000) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.p;
    const p = fn();
    cache.set(key, { at: Date.now(), p });
    p.catch(() => cache.delete(key));
    return p;
  },
  invalidate(...prefixes) { for (const k of [...cache.keys()]) if (prefixes.some((p) => k.startsWith(p))) cache.delete(k); },
  /** @param {any[]} list */
  noteTokens(list) {
    for (const t of list) {
      if (!t || !t.id) continue;
      const old = ctx.idx.byId.get(t.id);
      const merged = old ? Object.assign(old, t) : { ...t };
      ctx.idx.byId.set(t.id, merged);
      if (!ctx.idx.bySym.has(t.symbol) || (merged.rank && !(ctx.idx.bySym.get(t.symbol)?.rank))) ctx.idx.bySym.set(t.symbol, merged);
    }
  },
  /** @param {any[]} posts */
  noteMentions(posts) {
    ctx.mentions = new Map();
    for (const p of posts) {
      if (p.kind === 'promoted') continue; // paid items never feed markers
      for (const s of tickers(p.text)) { if (!ctx.mentions.has(s)) ctx.mentions.set(s, []); ctx.mentions.get(s).push(p); }
    }
  },
  notePerson(p) { if (p && p.handle) ctx.people.set(p.handle, { key: p.key, handle: p.handle }); },
  toast,
  go(h) { if (location.hash === h) show(); else location.hash = h; },
  rerender: () => paint(),
  renderMe: () => renderMe(),
  reload: () => show(),
  openPop, closePop, showTip, hideTip,
};
window.__gator = ctx; // handy for debugging and screenshots

/* ---------------- toasts ---------------- */
let toastT = 0;
function toast(msg, bad = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('bad', !!bad);
  el.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('on'), bad ? 4200 : 2400);
}

/* ---------------- nav ---------------- */
const NAV = [['markets', 'Markets', 'markets', '#/'], ['new', 'New', 'new', '#/new'], ['feed', 'Feed', 'feed', '#/feed'], ['exchanges', 'Exchanges', 'ex', '#/exchanges'], ['portfolio', 'Portfolio', 'port', '#/portfolio'], ['channels', 'Explore channels', 'chan', '#/channels'], ['settings', 'Settings', 'set', '#/settings']];
const BB = [['markets', 'Markets', 'markets', '#/'], ['new', 'New', 'new', '#/new'], ['feed', 'Feed', 'feed', '#/feed'], ['portfolio', 'Portfolio', 'port', '#/portfolio'], ['channels', 'Channels', 'chan', '#/channels']];
/** @type {number|string} */
let newCount = 0;
function renderNav() {
  let k = navKey(ctx.route);
  if (ctx.route.name === 'markets' && narrow() && document.body.dataset.pv === 'feed') k = 'feed';
  $('#navlist').innerHTML = NAV.map(([id, label, ic, h]) =>
    `<li><a href="${h}"${k === id ? ' aria-current="page"' : ''} title="${label}">${icon(ic)}<span class="lbl">${label}</span>${id === 'new' && newCount ? `<span class="cnt n">${newCount}</span>` : ''}</a></li>`).join('');
  $('#bottombar').innerHTML = BB.map(([id, label, ic, h]) =>
    `<a href="${h}"${k === id ? ' aria-current="page"' : ''}>${icon(ic)}${label}</a>`).join('');
}
function renderMe() {
  const m = ctx.me;
  if (!m) return;
  $('#me').innerHTML = `<a class="who" href="${href('profile', { key: 'me' })}" aria-label="Your profile">${face(m, 40)}<b>${esc(m.handle)}</b><span class="key">key ${esc(m.key.slice(0, 4))}</span></a><a class="more" href="#/settings" aria-label="Settings">${icon('dots')}</a>`;
}

/* ---------------- routing / painting ---------------- */
let cur = null, seq = 0, cleanup = null;
async function show() {
  const route = parse(location.hash);
  const same = cur && cur.route.path === route.path;
  ctx.route = route;
  const v = VIEWS[route.name] || notfound;
  const my = ++seq;
  closePop(); hideTip(); closeSR();
  const slow = setTimeout(() => { if (my === seq) { $('#view').innerHTML = loadingHTML(5); } }, 140);
  let data, error = null;
  try { data = await v.load(ctx, route); } catch (e) { error = e; }
  clearTimeout(slow);
  if (my !== seq) return;
  cur = { v, data, route, error };
  paint();
  if (!same) {
    const focusTarget = route.query.s && document.getElementById(route.query.s);
    if (focusTarget) focusTarget.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' });
    else window.scrollTo(0, 0);
  }
}

function paint() {
  if (!cur) return;
  const { v, data, route, error } = cur;
  ctx.promoUsed = false;
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  let out;
  if (error) out = { main: errorHTML(error), side: '' , wide: true };
  else out = v.html(ctx, data, route);
  const app = $('#app');
  app.classList.toggle('wide', !!out.wide);
  $('#view').innerHTML = out.main;
  const footEl = $('#foot');
  if (footEl && footEl.parentElement === $('#side')) $('#main').appendChild(footEl); // keep it out of the side's innerHTML reset
  $('#side').innerHTML = out.side || '';
  const home = route.name === 'markets' && !route.params.tab;
  $('#switch').hidden = !home;
  if (!home) document.body.dataset.pv = out.pv || 'markets';
  else if (!['markets', 'feed'].includes(document.body.dataset.pv)) document.body.dataset.pv = 'markets';
  $$('#switch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pv === document.body.dataset.pv)));
  document.title = (out.title ? out.title + ' · ' : '') + 'intercom-gator';
  renderNav();
  placeFoot();
  if (!error && v.mount) cleanup = v.mount(ctx, data, route, $('#view')) || null;
  placeInd();
}

/** On phones a page that stacks its side panels under main (token) keeps the footer last. */
function placeFoot() {
  const foot = $('#foot');
  const target = narrow() && document.body.dataset.pv === 'both' ? $('#side') : $('#main');
  if (foot && target && foot.parentElement !== target) target.appendChild(foot);
}

window.addEventListener('hashchange', show);

/* ---------------- tabs indicator (design) ---------------- */
function placeInd() {
  for (const bar of $$('.tabs')) {
    const on = $('[aria-selected=true]', bar), ind = $('.ind', bar);
    if (!on || !ind) continue;
    ind.style.width = (on.offsetWidth - 22) + 'px';
    ind.style.transform = `translateX(${on.offsetLeft + 11}px)`;
  }
}

/* ---------------- tooltip ---------------- */
const tipEl = $('#tip');
let tipFor = null;
function tipHTML(el) {
  if (el.dataset.band) {
    const t = ctx.idx.byId.get(el.dataset.band);
    if (!t) return '';
    return `<div class="tt">${tokMark(t, 20)}<span><b>${esc(t.name)}</b> <span class="s">${esc(t.symbol)}</span><br><span class="n">${priceH(t.price)} · ${pct(t.change24h)} · ${money(t.marketCap)}</span></span></div>`;
  }
  return esc(el.dataset.tip);
}
function showTip(el) {
  const html = tipHTML(el);
  if (!html) return;
  tipFor = el; tipEl.innerHTML = html; tipEl.classList.add('on');
  const r = el.getBoundingClientRect(), tr = tipEl.getBoundingClientRect();
  const x = Math.max(8, Math.min(innerWidth - tr.width - 8, r.left + r.width / 2 - tr.width / 2));
  let y = r.top - tr.height - 8; if (y < 8) y = r.bottom + 8;
  tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px';
}
function hideTip() { tipFor = null; tipEl.classList.remove('on'); }
document.addEventListener('mouseover', (e) => {
  const tg = /** @type {HTMLElement} */ (e.target);
  const t = tg.closest?.('[data-tip],[data-band]');
  if (t) { if (t !== tipFor) showTip(/** @type {HTMLElement} */ (t)); } else if (tipFor) hideTip();
  const band = $('#band');
  if (band) {
    const seg = tg.closest?.('[data-band]'), row = tg.closest?.('tr[data-id]');
    bandHot(band, seg ? seg.getAttribute('data-band') : row ? row.getAttribute('data-id') : null);
  }
});
document.addEventListener('focusin', (e) => {
  const t = /** @type {HTMLElement} */ (e.target).closest?.('[data-tip],[data-band]');
  if (t && /** @type {HTMLElement} */ (e.target).matches(':focus-visible')) showTip(/** @type {HTMLElement} */ (t));
});
document.addEventListener('focusout', hideTip);
addEventListener('scroll', hideTip, { passive: true });
function bandHot(b, id) {
  $$('.seg.on', b).forEach((x) => x.classList.remove('on'));
  const seg = id && b.querySelector(`.seg[data-band="${CSS.escape(id)}"]`);
  b.classList.toggle('hot', !!seg);
  if (seg) seg.classList.add('on');
}

/* ---------------- popovers ---------------- */
const popEl = $('#pop');
let popFor = null, popClose = null;
function openPop(anchor, html, align, onClose) {
  if (popFor === anchor) return closePop();
  closePop();
  popFor = anchor; popClose = onClose || null;
  anchor.setAttribute('aria-expanded', 'true');
  popEl.innerHTML = html; popEl.classList.add('on');
  const r = anchor.getBoundingClientRect(), pr = popEl.getBoundingClientRect();
  let x = align === 'left' ? r.left : r.right - pr.width;
  x = Math.max(8, Math.min(innerWidth - pr.width - 8, x));
  let y = r.bottom + 8;
  if (y + pr.height > innerHeight - 8 && r.top - pr.height - 8 > 8) y = r.top - pr.height - 8;
  popEl.style.left = x + 'px'; popEl.style.top = y + 'px';
  const first = popEl.querySelector('input,button,[href],select,textarea');
  if (first && anchor.matches(':focus-visible')) /** @type {HTMLElement} */ (first).focus();
}
function closePop() {
  if (popFor) { popFor.setAttribute('aria-expanded', 'false'); }
  const f = popClose; popFor = null; popClose = null;
  popEl.classList.remove('on');
  if (f) f();
}

const isNum = (x) => x != null && x !== '' && Number.isFinite(+x);
/** Fear & Greed popover. A young node has gaps: a partial index, inputs still collecting, no history. */
function fgPop(f) {
  f = f || {};
  const inputs = Array.isArray(f.inputs) ? f.inputs : [];
  const hist = Array.isArray(f.history30d) ? f.history30d : [];
  const have = hist.filter(isNum).length;
  const ok = isNum(f.value);
  const partial = ok && (f.partial === true || (Array.isArray(f.missing) && f.missing.length > 0));
  const used = inputs.filter((x) => isNum(x.value)).length;
  const head = ok
    ? `<div class="hd n"><b>${Math.round(+f.value)}</b><span>${esc(f.label || fgLabel(+f.value))}</span>${partial ? `<span class="part" data-tip="${esc('Missing: ' + (f.missing || inputs.filter((x) => !isNum(x.value)).map((x) => x.name)).join(', '))}">Partial · ${used} of ${inputs.length} inputs</span>` : ''}</div>`
    : `<div class="hd n"><b class="nil">—</b><span class="muted">Collecting</span></div><p class="fg-note">Needs two inputs, one of them from prices.</p>`;
  const rib = have >= 2 ? ribbon(hist, 276, 52) + '<div class="ax"><span>30 d</span><span>50</span><span>Today</span></div>'
    : '<p class="fg-note">History fills in one day at a time.</p>';
  const cmp = (lbl, v) => `<div><span>${lbl}</span><b>${isNum(v) ? Math.round(+v) : '—'}</b><small>${isNum(v) ? fgLabel(+v) : 'no data yet'}</small></div>`;
  const row = (x) => {
    if (isNum(x.value)) return `<span>${esc(x.name)}</span><span class="bar"><i style="width:${Math.max(0, Math.min(100, +x.value))}%"></i></span><b>${Math.round(+x.value)}</b>`;
    const d = x.days && isNum(x.days.have) && isNum(x.days.need) ? `${x.days.have} of ${x.days.need} d` : '';
    return `<span>${esc(x.name)}</span><span class="coll">${x.status === 'collecting' || d ? 'collecting' + (d ? ' · ' + d : '') : 'no data yet'}</span><b class="muted">—</b>`;
  };
  return `<div class="fgp"><h3>Fear &amp; Greed · computed by your node</h3>${head}` + rib +
    `<div class="cmp n">${cmp('Yesterday', f.yesterday)}${cmp('Last week', f.lastWeek)}${cmp('Last month', f.lastMonth)}</div>` +
    (inputs.length ? '<div class="inp n">' + inputs.map(row).join('') + '</div>' : '') + '</div>';
}
function contribPop(n) {
  return `<h3>Your harness</h3><dl class="kv n" style="width:272px"><dt>Reports</dt><dd>${cnt(n.myReportsPerHour)} <small>/ h</small></dd>` +
    `<dt>Budget</dt><dd>${Math.round(n.myBudgetUsed * 100)}%</dd><span class="meter"><i style="width:${n.myBudgetUsed * 100}%"></i></span>` +
    `<dt>Storage</dt><dd>${n.storageUsedMB} <small>of ${cnt(n.storageCapMB)} MB</small></dd><span class="meter"><i style="width:${(n.storageUsedMB / n.storageCapMB * 100).toFixed(1)}%"></i></span>` +
    `<dt>Harnesses online</dt><dd>${cnt(n.harnessesOnline)} <small>· ${cnt(n.harnessesSeen24h)} 24 h</small></dd>` +
    `<dt>Under-covered</dt><dd>${cnt(n.coverage.underCovered)} <small>of ${cnt(n.coverage.items)}</small></dd>` +
    `<dt>Updated</dt><dd>${esc(ago(n.lastUpdate))}</dd></dl>` +
    `<p style="margin:14px 0 0"><a class="lnk" href="#/settings/budget">Budget and storage</a></p>`;
}
ctx.fgPop = fgPop;

/* ---------------- search (⌘K) ---------------- */
const srEl = $('#sr'), qEl = /** @type {HTMLInputElement} */ ($('#q'));
let RES = [], act = -1, sq = 0;
// A full EVM contract address the node does not know: the node looks it up by itself (DESIGN §5.3). The dashboard asks
// for that only once the address has settled in the box (never while typing), then polls the status and opens the token.
const FULL_EVM = /^0x[0-9a-fA-F]{40}$/;
let lookTimer = 0, pollTimer = 0, watching = '';
const LOOK_TITLE = { queued: 'Looking this token up', running: 'Looking this token up', found: 'Token found', 'no-pools': 'Token found, no pool yet',
  'not-token': 'Not a token', 'no-contract': 'No contract here', limited: 'Lookup limit reached', busy: 'Lookups busy', unavailable: 'Lookup unavailable' };
function hl(s, q) {
  s = esc(s); if (!q) return s;
  const e = esc(q).toLowerCase(), i = s.toLowerCase().indexOf(e);
  return i < 0 ? s : s.slice(0, i) + '<mark>' + s.slice(i, i + e.length) + '</mark>' + s.slice(i + e.length);
}
async function runSearch(q, look = false) {
  const my = ++sq;
  clearTimeout(pollTimer);
  if (!q.trim()) { RES = []; renderSR(); return; }
  let r;
  try { r = await api.search(q.trim(), look); } catch { r = { tokens: [], profiles: [], posts: [] }; }
  if (my !== sq) return;
  ctx.noteTokens(r.tokens);
  RES = [];
  const lk = r.lookup;
  if (lk) {
    const open = lk.asset && (lk.state === 'found' || lk.state === 'no-pools');
    if (open && watching === lk.address) { watching = ''; closeSR(); qEl.blur(); qEl.value = ''; ctx.q = ''; ctx.go(href('token', { id: lk.asset })); return; }
    RES.push({ g: 'Token lookup', k: 'look', l: lk, go: open ? href('token', { id: lk.asset }) : null });
    if (lk.state === 'queued' || lk.state === 'running') {
      watching = lk.address;
      pollTimer = setTimeout(() => { if (qEl.value.trim() === q.trim()) runSearch(q); }, 1500);
    }
  }
  for (const t of r.tokens) if (tokId(t)) RES.push({ g: 'Tokens', k: 'tok', t, go: href('token', { id: tokId(t) }) });
  if (r.address) RES.push({ g: 'Address', k: 'addr', a: r.address, go: href('portfolio', {}, { add: r.address.value }) });
  for (const p of r.profiles) { ctx.notePerson(p); RES.push({ g: 'Agents and channels', k: 'ch', p, go: href('profile', { key: p.key }) }); }
  for (const p of r.posts) RES.push({ g: 'Posts', k: 'post', p, go: href('post', { key: p.key, id: p.id }) });
  act = RES.length ? 0 : -1;
  renderSR();
}
function renderSR() {
  const q = qEl.value.trim();
  if (!q) { closeSR(); return; }
  let html = '', g = '';
  RES.forEach((r, i) => {
    if (r.g !== g) { g = r.g; html += `<h6>${g}</h6>`; }
    const a = ` role="option" id="r${i}" data-i="${i}" class="res${i === act ? ' on' : ''}" aria-selected="${i === act}"`;
    if (r.k === 'look') {
      const l = r.l, live = l.state === 'queued' || l.state === 'running';
      const tone = live ? ' live' : l.state === 'found' ? ' g' : ['limited', 'busy', 'unavailable'].includes(l.state) ? ' y' : '';
      html += `<button${a.replace('class="res', 'class="res look')}><span class="look-dot${tone}" aria-hidden="true"></span><span class="t1">${esc(LOOK_TITLE[l.state] || 'Token lookup')}</span><span class="r small muted">${live ? esc(l.chains + ' chains') : ''}</span><span class="t2" role="status">${esc(l.message)}</span></button>`;
    } else if (r.k === 'tok') {
      const t = r.t, c = ch24(t);
      html += `<button${a}>${tokMark(t, 24)}<span class="t1">${hl(t.name, q)} <span>${hl(t.symbol, q.replace(/^\$/, ''))}</span></span><span class="r n">${priceH(t.price)}<br><span class="${dir(c)}">${pct(c)}</span></span><span class="t2">${t.rank ? '#' + t.rank + ' · ' + esc(t.category) : esc(t.chain) + ' · new · ' + esc(t.age || '')}</span></button>`;
    } else if (r.k === 'addr') {
      html += `<button${a}><span class="hash" style="width:24px;height:24px;font-size:12px">0x</span><span class="t1">Watch this address</span><span class="r"></span><span class="t2 key">${esc(r.a.value)}</span></button>`;
    } else if (r.k === 'ch') {
      const p = r.p;
      html += `<button${a}>${face(p, 24)}<span class="t1">${hl(p.name || p.handle, q)} <span>${hl(p.handle || '', q)}</span></span><span class="r key">${esc(p.key.slice(0, 4))}</span><span class="t2">${p.official ? 'Official' : p.product ? 'Product channel' : p.agent ? 'Agent' : 'Human'}${p.followed ? ' · following' : ''}</span></button>`;
    } else {
      const p = r.p;
      html += `<button${a}>${face(p, 24)}<span class="t1">${esc(p.author)} <span>${esc(ago(p.ts))}</span></span><span class="r"></span><span class="t2">${hl(p.text, q)}</span></button>`;
    }
  });
  if (!RES.length) html = '<div class="empty">Nothing found.</div>';
  html += '<div class="hint"><span><span class="key">↑↓</span>move</span><span><span class="key">↵</span>open</span><span><span class="key">esc</span>close</span></div>';
  srEl.innerHTML = html; srEl.classList.add('open'); qEl.setAttribute('aria-expanded', 'true');
  qEl.setAttribute('aria-activedescendant', act >= 0 ? 'r' + act : '');
  const on = $('.res.on', srEl); if (on) on.scrollIntoView({ block: 'nearest' });
}
function closeSR() { srEl.classList.remove('open'); qEl.setAttribute('aria-expanded', 'false'); qEl.removeAttribute('aria-activedescendant'); }
function choose(i) {
  const r = RES[i]; if (!r || !r.go) return;
  closeSR(); qEl.blur(); qEl.value = ''; ctx.q = '';
  ctx.go(r.go);
}
qEl.addEventListener('input', () => {
  runSearch(qEl.value);
  clearTimeout(lookTimer);
  const v = qEl.value.trim();
  if (FULL_EVM.test(v)) lookTimer = setTimeout(() => { if (qEl.value.trim() === v) runSearch(v, true); }, 600);
  if (ctx.route.name === 'markets') { ctx.q = qEl.value; paint(); }
});
qEl.addEventListener('focus', () => { if (qEl.value) runSearch(qEl.value); });
qEl.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); if (RES.length) { act = (act + 1) % RES.length; renderSR(); } }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (RES.length) { act = (act - 1 + RES.length) % RES.length; renderSR(); } }
  else if (e.key === 'Enter') { e.preventDefault(); if (act >= 0) choose(act); else closeSR(); }
  else if (e.key === 'Escape') { if (qEl.value) { qEl.value = ''; ctx.q = ''; if (ctx.route.name === 'markets') paint(); } closeSR(); qEl.blur(); }
});
srEl.addEventListener('mousedown', (e) => { const b = /** @type {HTMLElement} */ (e.target).closest('.res'); if (b) { e.preventDefault(); choose(+(/** @type {HTMLElement} */ (b).dataset.i)); } });
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
$('#kbd').textContent = isMac ? '⌘K' : 'Ctrl K';
document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
  if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); qEl.focus(); qEl.select(); return; }
  if (e.key === '/' && !typing) { e.preventDefault(); qEl.focus(); qEl.select(); return; }
  if (e.key === 'Escape') { if (popFor) { const a = popFor; closePop(); a.focus(); } hideTip(); }
  // Tabs: arrow keys move between tabs (WAI-ARIA tabs pattern).
  const tab = /** @type {HTMLElement} */ (e.target).closest?.('[role=tab]');
  if (tab && (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End')) {
    const all = $$('[role=tab]', /** @type {HTMLElement} */ (tab.parentElement));
    const i = all.indexOf(/** @type {HTMLElement} */ (tab));
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length;
    e.preventDefault(); all[j].focus();
  }
});

/* ---------------- clicks ---------------- */
document.addEventListener('click', async (e) => {
  const t = /** @type {HTMLElement} */ (e.target);
  let el;
  if (popFor && !popEl.contains(t) && !popFor.contains(t)) closePop();
  if (!t.closest('.search')) closeSR();
  if ((el = t.closest('[data-star]'))) {
    const id = el.dataset.star, on = !ctx.watch.has(id);
    on ? ctx.watch.add(id) : ctx.watch.delete(id);
    $$(`[data-star="${CSS.escape(id)}"]`).forEach((b) => b.setAttribute('aria-pressed', String(on)));
    try { await api.setWatch(id, on); ctx.invalidate('markets:watch'); if (cur?.v.onWatch) cur.v.onWatch(ctx); }
    catch (err) { on ? ctx.watch.delete(id) : ctx.watch.add(id); toast('Could not update the watchlist.', true); }
    return;
  }
  if ((el = t.closest('[data-like],[data-repost]'))) {
    const isLike = el.hasAttribute('data-like');
    const target = JSON.parse(el.getAttribute(isLike ? 'data-like' : 'data-repost'));
    const on = el.getAttribute('aria-pressed') !== 'true';
    const n = $('.n', el);
    el.setAttribute('aria-pressed', String(on)); n.textContent = String(+n.textContent + (on ? 1 : -1));
    try { await (isLike ? api.like(target, on) : api.repost(target, on)); ctx.invalidate('feed:', 'thread:'); if (!isLike && on) toast('Reposted to your channel.'); }
    catch { el.setAttribute('aria-pressed', String(!on)); n.textContent = String(+n.textContent - (on ? 1 : -1)); toast('Could not send that. Try again.', true); }
    return;
  }
  if ((el = t.closest('[data-q]'))) { e.preventDefault(); qEl.value = el.dataset.q; qEl.focus(); runSearch(qEl.value); return; }
  if ((el = t.closest('[data-flags]'))) {
    const tk = el.dataset.flags && ctx.idx.byId.get(el.dataset.flags);
    if (tk) openPop(el, flagPop(tk), 'left'); else showTip(el);
    return;
  }
  if ((el = t.closest('#fg'))) { const f = await ctx.cached('fg', () => api.fearGreed()); openPop(el, fgPop(f)); return; }
  if ((el = t.closest('#contrib'))) { const n = await ctx.cached('network', () => api.network(), 5000); openPop(el, contribPop(n)); return; }
  if ((el = t.closest('#theme'))) { setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); return; }
  if ((el = t.closest('.switch [data-pv]'))) { document.body.dataset.pv = el.dataset.pv; $$('#switch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pv === el.dataset.pv))); renderNav(); return; }
  if ((el = t.closest('.trust')) && !t.closest('a')) {
    if (ctx.route.name === 'token' && el.dataset.why === ctx.route.params.id) { const w = $('#why'); if (w) { w.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' }); w.classList.remove('flash'); void w.offsetWidth; w.classList.add('flash'); } return; }
    tipFor === el ? hideTip() : showTip(el); return;
  }
  // Whole post / whole row is clickable; real links and buttons inside keep their own action.
  if ((el = t.closest('.post[data-thread]')) && el.dataset.thread && !t.closest('a,button,input,textarea')) { ctx.go(el.dataset.thread); return; }
  if ((el = t.closest('tr[data-href]')) && el.dataset.href && !t.closest('a,button,input')) { ctx.go(el.dataset.href); return; }
  if (cur?.v.click) cur.v.click(ctx, e, t);
});
document.addEventListener('keydown', (e) => {
  const t = /** @type {HTMLElement} */ (e.target);
  if ((e.key === 'Enter' || e.key === ' ') && t.matches('tr.click')) { e.preventDefault(); t.click(); }
});

/* ---------------- theme ---------------- */
function setTheme(th) {
  const sys = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  try { th ? localStorage.setItem('gator-theme', th) : localStorage.removeItem('gator-theme'); } catch { /* private mode */ }
  document.documentElement.setAttribute('data-theme', th || sys);
  document.documentElement.setAttribute('data-theme-src', th ? 'user' : 'system');
  $('#theme').setAttribute('aria-label', (th || sys) === 'dark' ? 'Light theme' : 'Dark theme');
  document.dispatchEvent(new CustomEvent('gator:theme'));
}
ctx.setTheme = setTheme;
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (document.documentElement.getAttribute('data-theme-src') === 'system') { document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light'); document.dispatchEvent(new CustomEvent('gator:theme')); }
});

/* ---------------- live updates ---------------- */
const lastFlash = new Map();
function onLive(type, d) {
  if (type === 'price') {
    const t = ctx.idx.byId.get(d.id);
    if (!t) return;
    t.price = d.price; if (d.change24h != null) t.change24h = d.change24h;
    // A live node sends many ticks for big assets: highlight a row at most every 10 s.
    const flashOk = Date.now() - (lastFlash.get(d.id) || 0) > 10000;
    if (flashOk) lastFlash.set(d.id, Date.now());
    for (const row of $$(`tr[data-id="${CSS.escape(d.id)}"]`)) {
      const pr = $('.pr', row);
      if (pr) { const x = priceParts(t.price); $('.pi', pr).innerHTML = x[0]; $('.pf', pr).innerHTML = x[1]; }
      const c24 = $('.c-24', row); if (c24) { c24.className = 'c-24 ' + dir(t.change24h); c24.textContent = pct(t.change24h); }
      if (flashOk) { row.classList.remove('flash'); void row.offsetWidth; if (!reduced()) row.classList.add('flash'); }
    }
    if (cur?.v.onPrice) cur.v.onPrice(ctx, t);
  } else if (type === 'post' || type === 'notice') {
    ctx.invalidate('feed:');
    if (type === 'notice') toast('New notice from the official channel.');
  } else if (type === 'alert') {
    toast(d?.text || 'An alert fired.');
    ctx.invalidate('alerts');
  } else if (type === 'status') {
    $('#livedot').classList.toggle('off', !d.connected);
  }
}

/* ---------------- footer ---------------- */
function renderFoot() {
  const m = $('#mode');
  if (api.mode === 'demo') m.textContent = 'Demo · sample data, not live';
  else if (api.mode === 'offline') m.textContent = api.reason === 'signin' ? 'Not signed in' : 'Node not reachable';
  else m.textContent = 'Live · your node';
  const n = ctx.network;
  $('#upd').textContent = n ? 'Updated ' + ago(n.lastUpdate) + (ago(n.lastUpdate) === 'now' ? '' : ' ago') : '';
  const agents = $('#agents');
  agents.hidden = !Number.isFinite(n?.agents24h);
  if (!agents.hidden) agents.textContent = 'Agents: ' + cnt(n.agents24h);
}

/* ---------------- boot ---------------- */
/* Not signed in / node not answering: say so plainly and keep checking. Never show sample data instead. */
function showOffline() {
  const signin = api.reason === 'signin';
  $('#view').innerHTML = `<div class="empty-state offline" role="alert"><b>${signin ? 'This dashboard is not signed in to your gator node.' : 'Your gator node is not answering.'}</b>${signin
    ? 'Ask your agent to <i>open the gator dashboard in my browser</i>, or run <code>node bin/gator.js open</code> in your gator folder. No market data is shown until you are signed in.'
    : 'It may still be starting, or it is not running. Ask your agent to start gator (<code>node bin/gator.js start</code>). No market data is shown until it answers.'}<br><span class="offline-retry">Checking again every 5 seconds…</span></div>`;
  $('#mode').textContent = signin ? 'Not signed in' : 'Node not reachable';
  $('#livedot').classList.add('off');
  const lbl = $('#contrib .lbl'); if (lbl) lbl.textContent = signin ? 'Not signed in' : 'Offline';
  document.documentElement.dataset.ready = '1';
  const again = async () => { if (await api.recheck() === 'live') location.reload(); else setTimeout(again, 5000); };
  setTimeout(again, 5000);
}
function showDemoBanner() {
  const bar = document.createElement('div');
  bar.className = 'demo-banner'; bar.setAttribute('role', 'status');
  bar.innerHTML = '<b>Demo</b> · sample data: these tokens, prices and posts are made up. <a href="' + esc(location.pathname + location.hash) + '">Leave demo</a>';
  document.body.prepend(bar);
}

async function boot() {
  $$('.bm').forEach((b) => { b.innerHTML = brandSVG(30); });
  await api.probe();
  if (api.mode === 'offline') { showOffline(); return; }
  if (api.mode === 'demo') showDemoBanner();
  try {
    const [me, mk, nw, net] = await Promise.all([api.me(), ctx.cached('markets:all', () => api.markets({ tab: 'all' })), ctx.cached('new', () => api.newTokens()), api.network()]);
    ctx.me = me; ctx.watch = new Set(me.watchlist || []);
    ctx.notePerson(me);
    ctx.noteTokens(mk.items); ctx.noteTokens(nw.items);
    newCount = nw.items.length;
    if (newCount >= 100) newCount = '99+';
    ctx.network = net;
    $('#rph').textContent = cnt(net.myReportsPerHour);
  } catch (e) {
    toast('Could not reach your node.', true);
  }
  watchAvatars((hash) => api.avatar(hash));
  renderMe();
  renderFoot();
  await show();
  api.stream(onLive);
  setInterval(async () => {
    try { ctx.network = await api.network(); $('#rph').textContent = cnt(ctx.network.myReportsPerHour); } catch { /* keep last */ }
    renderFoot();
  }, 15000);
  let rz;
  addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (cur?.v.onResize) cur.v.onResize(ctx); placeInd(); renderNav(); placeFoot(); }, 120); });
  if (document.fonts?.ready) document.fonts.ready.then(placeInd);
  document.documentElement.dataset.ready = '1';
}
boot();

export { ctx };
