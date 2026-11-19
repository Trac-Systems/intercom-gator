// Portfolio: total, holdings (from watched addresses + manual), watched addresses, alerts.

import { esc, money, pct, dir, grp, amount, priceH, priceTxt, ago, shortAddr } from '../lib/format.js';
import { kp, hue, tokSeed } from '../lib/keyprint.js';
import { tokMark } from '../lib/logo.js';
import { addressKind } from '../lib/text.js';
import { icon, tokCell, tableHTML, sortRows, nextSort, tokHref, rowLink } from '../ui/components.js';
import { loadSocial, socialSide } from '../ui/side.js';

let sort = { k: 'value', dir: -1 };

async function load(ctx) {
  const [pf, al, social] = await Promise.all([ctx.api.portfolio(), ctx.cached('alerts', () => ctx.api.alerts(), 5000), loadSocial(ctx)]);
  return { pf, alerts: al.items, social };
}

function alertText(a) {
  return a.op === 'move' ? `${a.symbol} moves ${a.value}% in 1 h` : `${a.symbol} ${a.op} ${priceTxt(a.value)}`;
}

function html(ctx, d, route) {
  const pf = d.pf;
  const known = [...ctx.idx.byId.values()].sort((a, b) => (a.rank || 999) - (b.rank || 999));
  const rows = sortRows(pf.holdings, sort, (h, k) => (k === 'name' ? String(h.symbol).toLowerCase() : h[k] ?? 0));
  const table = tableHTML({
    cls: 't-pf', sort, caption: 'Holdings',
    cols: [['name', 'Token', 'l c-tok'], ['amount', 'Amount', 'c-amt'], ['price', 'Price', 'c-px'], ['value', 'Value', ''], ['change24h', '24 h', 'c-24'], [null, '<span class="vh">Remove</span>', 'c-rm']],
    rows,
    row: (h) => {
      const t = ctx.idx.byId.get(h.asset) || { id: h.asset, symbol: h.symbol, name: h.name || h.symbol, chains: ['?'], logo: h.logo };
      return `<tr data-id="${esc(t.id)}"${rowLink(t)} style="${hue(tokSeed(t))}"><td class="l c-tok">${tokCell(ctx, t, t.symbol).replace('<span>' + esc(t.symbol), '<span><span class="mamt n">' + amount(h.amount) + ' </span>' + esc(t.symbol) + (h.source === 'manual' ? '<span class="src-m"> · manual</span>' : ''))}</td><td class="n c-amt">${amount(h.amount)}</td><td class="c-px">${h.price != null ? priceH(h.price) : '—'}</td><td class="n" style="font-weight:620">${h.value != null ? '$' + grp(h.value, 2) : '—'}</td><td class="c-24 ${dir(h.change24h)}">${pct(h.change24h)}</td>` +
        `<td class="c-rm">${h.source === 'manual' ? `<button class="ibtn rm" data-rmh="${esc(h.asset)}" aria-label="Remove ${esc(h.symbol)}">${icon('x')}</button>` : ''}</td></tr>`;
    },
    empty: 'Nothing here yet. Add a holding or watch an address.',
  });
  const addrs = pf.addresses.length ? `<ul class="addr-l">${pf.addresses.map((a) => `<li>${kp('addr:' + a.address, 'tag', 32)}<b>${esc(a.label || a.chain)}</b><span class="val n">${a.value != null ? '$' + grp(a.value, 2) : '<span class="muted">reading…</span>'}</span><button class="ibtn" data-rma="${esc(a.id)}" aria-label="Stop watching ${esc(a.label || a.address)}">${icon('x')}</button><span class="key" title="${esc(a.address)}">${esc(a.chain)} · ${esc(shortAddr(a.address))}</span></li>`).join('')}</ul>` : '<p class="muted">No addresses watched.</p>';
  const alerts = d.alerts.length ? `<ul class="al-l">${d.alerts.map((a) => {
    const t = ctx.idx.byId.get(a.asset);
    return `<li>${t ? tokMark(t.logo ? t : { ...t, logo: a.logo }, 36) : '<span></span>'}<b>${a.asset ? `<a class="rowlink" href="${esc(tokHref(t || { id: a.asset }))}">${esc(alertText(a))}</a>` : esc(alertText(a))}</b>${a.hit ? `<span class="hit">Fired ${esc(ago(a.hit))} ago</span>` : '<span></span>'}<button class="ibtn" data-rmal="${esc(a.id)}" aria-label="Delete alert ${esc(alertText(a))}">${icon('x')}</button><span class="t2 n">now ${t ? priceTxt(t.price) : '—'} · set ${esc(ago(a.created))} ago</span></li>`;
  }).join('')}</ul>` : '<p class="muted">No alerts. Set one from a token page.</p>';
  const prefill = route.query.add || '';
  const main =
    `<div class="page-h"><h1>Portfolio</h1></div>` +
    `<div class="pv-total"><span class="big n">$${grp(pf.value || 0, 2)}</span>${pf.holdings.length && pf.change24h != null && Number.isFinite(+pf.change24h) ? `<span class="n ${dir(pf.change24h)}" style="font-weight:620;font-size:15px">${pct(pf.change24h)} <span class="muted" style="font-weight:500;font-size:13px">24 h</span></span>` : ''}</div>` +
    `<div class="tw">${table}</div>` +
    `<form class="addform" id="addh" novalidate><div class="frow"><div><label class="lbl2" for="h-tok">Add a holding</label><input class="inp-t" id="h-tok" list="h-toks" placeholder="Token, e.g. ETH" autocomplete="off"><datalist id="h-toks">${known.map((t) => `<option value="${esc(t.symbol)}">${esc(t.name)}</option>`).join('')}</datalist></div>` +
    `<div><label class="lbl2" for="h-amt">Amount</label><input class="inp-t n" id="h-amt" inputmode="decimal" placeholder="0.00" autocomplete="off"></div><button class="btn" type="submit">${icon('plus')}Add</button></div><p class="err" id="h-err" hidden></p></form>` +
    `<section class="sec" aria-labelledby="ad-h"><div class="sec-h"><h2 id="ad-h">Watched addresses</h2></div>${addrs}` +
    `<form class="addform" id="adda" novalidate><div class="frow"><div style="flex:3 1 260px"><label class="lbl2" for="a-addr">Address</label><input class="inp-t mono" id="a-addr" placeholder="0x…, Solana or Bitcoin address" value="${esc(prefill)}" autocomplete="off" spellcheck="false"></div>` +
    `<div><label class="lbl2" for="a-lbl">Label</label><input class="inp-t" id="a-lbl" placeholder="Optional" maxlength="40" autocomplete="off"></div><button class="btn" type="submit">${icon('plus')}Watch</button></div><p class="hint2">Read-only. Your node reads balances; no keys are ever asked for.</p><p class="err" id="a-err" hidden></p></form></section>` +
    `<section class="sec" aria-labelledby="al-h"><div class="sec-h"><h2 id="al-h">Alerts</h2></div>${alerts}</section>`;
  return { title: 'Portfolio', main, side: socialSide(ctx, d.social) };
}

function mount(ctx, d, route) {
  const fh = document.getElementById('addh'), fa = document.getElementById('adda');
  const err = (id, m) => { const e = document.getElementById(id); e.hidden = !m; e.textContent = m || ''; };
  const onH = async (ev) => {
    ev.preventDefault();
    const s = /** @type {HTMLInputElement} */ (document.getElementById('h-tok')).value.trim().replace(/^\$/, '').toUpperCase();
    const amt = Number(/** @type {HTMLInputElement} */ (document.getElementById('h-amt')).value.replace(/[,\s]/g, ''));
    const t = ctx.idx.bySym.get(s);
    if (!t) return err('h-err', 'Pick a token from the list.');
    if (!(amt > 0)) return err('h-err', 'Enter an amount above 0.');
    try { await ctx.api.portfolioOp({ op: 'add-holding', asset: t.id, amount: amt }); ctx.toast(`${amount(amt)} ${t.symbol} added.`); ctx.reload(); }
    catch (x) { err('h-err', /** @type {Error} */ (x).message); }
  };
  const onA = async (ev) => {
    ev.preventDefault();
    const a = /** @type {HTMLInputElement} */ (document.getElementById('a-addr')).value.trim();
    const label = /** @type {HTMLInputElement} */ (document.getElementById('a-lbl')).value.trim();
    if (!addressKind(a)) return err('a-err', 'That does not look like an EVM, Solana or Bitcoin address.');
    try { await ctx.api.portfolioOp({ op: 'add-address', address: a, label }); ctx.toast('Watching the address.'); location.hash = '#/portfolio'; ctx.reload(); }
    catch (x) { err('a-err', /** @type {Error} */ (x).message); }
  };
  fh?.addEventListener('submit', onH); fa?.addEventListener('submit', onA);
  if (route.query.add) document.getElementById('a-lbl')?.focus();
  return () => { fh?.removeEventListener('submit', onH); fa?.removeEventListener('submit', onA); };
}

async function click(ctx, e, t) {
  let b;
  try {
    if ((b = t.closest('[data-rmh]'))) { await ctx.api.portfolioOp({ op: 'remove-holding', asset: b.dataset.rmh }); ctx.reload(); return; }
    if ((b = t.closest('[data-rma]'))) { await ctx.api.portfolioOp({ op: 'remove-address', id: b.dataset.rma }); ctx.reload(); return; }
    if ((b = t.closest('[data-rmal]'))) { await ctx.api.removeAlert(b.dataset.rmal); ctx.invalidate('alerts'); ctx.toast('Alert deleted.'); ctx.reload(); return; }
    if ((b = t.closest('[data-sort]'))) { sort = nextSort(sort, b.dataset.sort); ctx.rerender(); }
  } catch (x) { ctx.toast(/** @type {Error} */ (x).message, true); }
}

export default { load, html, mount, click, money };
