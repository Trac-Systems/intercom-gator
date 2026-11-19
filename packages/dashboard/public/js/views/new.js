// New tokens: age, liquidity, one risk chip per row. The launch spotlight (paid) sits above the
// list, labelled, and never changes its order. The list is paged (100 rows a page).

import { esc, money, pct, dir, cnt, ageMinutes, chainName } from '../lib/format.js';
import { kp, hue, tokSeed } from '../lib/keyprint.js';
import { tokMark } from '../lib/logo.js';
import { href } from '../lib/router.js';
import { matches } from '../lib/text.js';
import { flagSet, isClean } from '../lib/flags.js';
import { createPager, pagerCache } from '../lib/pager.js';
import { priceCell, flagChip, tableHTML, sortRows, nextSort, pmHTML, tokHref, tokId, rowLink, moreHTML, emptyHTML, dash } from '../ui/components.js';
import { loadSocial, socialSide } from '../ui/side.js';
import { hiddenControl, hiddenKey, includeFor, nameFlagChips, nameTip, noteHidden, shortAsset, toggleHidden, unnamed, visBadge } from '../lib/listmeta.js';

const ui = { chain: '', clean: false };
let sort = null;
let focusMore = false;
const PAGE = 100;
const pagers = pagerCache(60000);
const pagerFor = (ctx) => pagers.get('new' + hiddenKey('new'), () => createPager(async (offset, limit) => {
  const r = await ctx.api.newTokens({ limit, offset, ...includeFor('new') });
  if (offset === 0) noteHidden('new', r.hidden);
  ctx.noteTokens(r.items || []);
  return r;
}, { limit: PAGE }));

const isNum = (x) => x != null && x !== '' && Number.isFinite(+x);

async function load(ctx) {
  const pager = pagerFor(ctx);
  const [, extras, social] = await Promise.all([
    pager.state.pages ? null : pager.more(),
    ctx.cached('extras', () => ctx.api.extras()),
    loadSocial(ctx),
  ]);
  return { pager, items: pager.state.items, extras: extras.items, social };
}

function html(ctx, d) {
  const chains = [...new Set(d.items.map((t) => t.chain).filter(Boolean))];
  const showHold = d.items.some((t) => isNum(t.holders));
  const showCh = d.items.some((t) => isNum(t.change));
  let rows = d.items.filter((t) => (!ui.chain || t.chain === ui.chain) && (!ui.clean || isClean(flagSet(t.flags, t.riskFlags))) && matches(ctx.q, t.name, t.symbol, t.chain));
  rows = sortRows(rows, sort, (t, k) => (k === 'name' ? String(t.name).toLowerCase() : k === 'ageMin' ? (t.ageMin ?? ageMinutes(t.age)) : t[k]));
  // Claim the one promoted spot per screen only when there is something to show.
  const live = d.extras.find((x) => x.slot === 'spotlight' && x.token && tokId(x.token));
  const spot = live && ctx.takePromo() ? live : null;
  const promo = spot ? `<a class="promo-card" href="${esc(tokHref(spot.token))}" style="${hue(tokSeed(spot.token))}">${tokMark(spot.token, 36)}<b>${esc(spot.token.name)} <span class="muted" style="font-weight:500">${esc(spot.token.symbol)}</span></b><span class="promo-l">Promoted</span><span class="t2">${esc(spot.text || 'Launch spotlight')} · ${esc(spot.token.chain)}</span></a>` : '';
  const name = (t) => {
    // Discoveries without a registry entry have no name yet: show the short address, never a 60-char id.
    if (unnamed(t)) return 'Unnamed · ' + esc(shortAsset(t.id));
    const n = t.name && t.name !== t.id ? t.name : t.symbol || String(t.id || '').replace(/^[^:]*:(.{6}).*(.{4})$/, '$1…$2');
    return esc(n);
  };
  const table = tableHTML({
    cls: 't-new', sort, caption: 'New tokens',
    cols: [['name', 'Token', 'l c-tok'], ['ageMin', 'Age', 'c-age'], ['price', 'Price', 'c-price'], showCh && ['change', 'Change', 'c-24'], ['liquidity', 'Liquidity', 'c-liq'], showHold && ['holders', 'Holders', 'c-hold'], [null, 'Risk', 'l c-flags']].filter(Boolean),
    rows,
    row: (t) => {
      const nm = tokId(t) ? `<a class="rowlink" href="${esc(tokHref(t))}">${name(t)}</a>` : name(t);
      const sub = [t.symbol, chainName(t.chain)].filter(Boolean).map(esc).join(' · ');
      return `<tr data-id="${esc(t.id)}"${rowLink(t)} style="${hue(tokSeed(t))}"><td class="l c-tok"><div class="tok">${tokMark(t, 28)}<div class="nm"><b title="${esc(t.name || t.id)}">${nm}</b><span>${sub}${pmHTML(ctx, t)}<span class="bdg">${unnamed(t) ? `<span class="nflag q" data-tip="${esc(nameTip(t))}">unnamed</span>` : ''}${nameFlagChips(t)}${visBadge(t)}</span></span><div class="mflags">${flagChip(t)}</div></div></div></td>` +
        `<td class="c-age muted n">${esc(t.age || '')}</td><td class="c-price">${priceCell(t.price, t, showCh ? t.change : null)}</td>${showCh ? `<td class="c-24 ${dir(t.change)}">${pct(t.change)}</td>` : ''}<td class="c-liq">${isNum(t.liquidity) ? money(t.liquidity) : dash()}</td>${showHold ? `<td class="c-hold n">${isNum(t.holders) ? cnt(t.holders) : dash()}</td>` : ''}<td class="l c-flags">${flagChip(t)}</td></tr>`;
    },
    empty: ui.clean ? 'Nothing without flags in the loaded rows.' : 'No match.',
  });
  const st = d.pager.state;
  const sub = !d.items.length ? '' : st.done ? `${cnt(d.items.length)} first seen in the last 24 h` : `${cnt(d.items.length)}+ first seen in the last 24 h`;
  const main = `<div class="page-h"><div><h1>New</h1>${sub ? `<span class="sub n">${sub}</span>` : ''}</div></div>` +
    (d.items.length
      ? `<div class="newbar"><div class="chips scroll" role="group" aria-label="Chain"><button class="chip" data-chain="" aria-pressed="${!ui.chain}">All chains</button>${chains.map((c) => `<button class="chip" data-chain="${esc(c)}" aria-pressed="${ui.chain === c}">${esc(chainName(c))}</button>`).join('')}</div>` +
        `<button class="chip" data-clean aria-pressed="${ui.clean}" style="flex:none">No flags only</button></div>` +
        hiddenControl('new') + promo + `<div class="tw">${table}</div>` + moreHTML(st, 'new', PAGE)
      : hiddenControl('new') + promo + emptyHTML('No new tokens yet.', 'New pools show up here as your node discovers them.'));
  return { title: 'New', main, side: socialSide(ctx, d.social, { promo: false }) };
}

function mount() {
  if (focusMore) { /** @type {HTMLElement|null} */ (document.querySelector('[data-more]'))?.focus(); focusMore = false; }
  return null;
}

function click(ctx, e, t) {
  let b;
  if ((b = t.closest('[data-chain]'))) { ui.chain = b.dataset.chain; ctx.rerender(); return; }
  if (t.closest('[data-clean]')) { ui.clean = !ui.clean; ctx.rerender(); return; }
  if (t.closest('[data-hidden]')) { toggleHidden('new'); ctx.reload(); return; }
  if ((b = t.closest('[data-sort]'))) { sort = nextSort(sort, b.dataset.sort); ctx.rerender(); document.querySelector(`[data-sort="${b.dataset.sort}"]`)?.focus(); return; }
  if (t.closest('[data-more]')) {
    const p = pagerFor(ctx).more();
    focusMore = true; ctx.rerender();
    p.then(() => { focusMore = true; ctx.rerender(); }, () => { ctx.toast('Could not load more rows.', true); ctx.rerender(); });
  }
}

export default { load, html, mount, click, href: () => href('new') };
