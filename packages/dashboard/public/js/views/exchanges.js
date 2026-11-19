// Exchanges: CEX and DEX venues your node reads, with volume, markets, reporters and trust.
// Paged (500 a page, the API maximum); sorting applies to the loaded rows.

import { esc, money, pct, dir, cnt } from '../lib/format.js';
import { kp } from '../lib/keyprint.js';
import { exMark } from '../lib/logo.js';
import { matches } from '../lib/text.js';
import { createPager, pagerCache } from '../lib/pager.js';
import { tableHTML, sortRows, nextSort, scoreHTML, moreHTML, emptyHTML } from '../ui/components.js';
import { loadSocial, socialSide } from '../ui/side.js';
import { hiddenControl, hiddenKey, includeFor, noteHidden, toggleHidden, unverifiedVolume, visBadge } from '../lib/listmeta.js';

const ui = { kind: '' };
let sort = { k: 'volume24h', dir: -1 };
let focusMore = false;
const PAGE = 500;
const pagers = pagerCache(60000);
const isNum = (x) => x != null && x !== '' && Number.isFinite(+x);
const pagerFor = (ctx, kind) => pagers.get('ex:' + kind + hiddenKey('ex'), () => createPager(async (offset, limit) => {
  const r = await ctx.api.exchanges({ kind: kind || undefined, limit, offset, ...includeFor('ex') });
  if (offset === 0) noteHidden('ex', r.hidden);
  return r;
}, { limit: PAGE, idOf: (e) => e.id ?? e.name }));

async function load(ctx) {
  const pager = pagerFor(ctx, ui.kind);
  const [, social] = await Promise.all([pager.state.pages ? null : pager.more(), loadSocial(ctx)]);
  return { pager, items: pager.state.items, social };
}

function html(ctx, d, route) {
  let rows = d.items.filter((e) => matches(ctx.q, e.name, e.kind, e.chain));
  rows = sortRows(rows, sort, (e, k) => (k === 'name' ? String(e.name).toLowerCase() : e[k]));
  const total = d.items.reduce((s, e) => s + (isNum(e.volume24h) ? +e.volume24h : 0), 0);
  const showCh = d.items.some((e) => isNum(e.change24h));
  const scored = d.items.some((e) => isNum(e.trustScore));
  const hi = route.query.x;
  const table = tableHTML({
    cls: 't-ex', sort, caption: 'Exchanges',
    cols: [['name', 'Exchange', 'l c-tok'], ['volume24h', 'Volume 24 h', ''], showCh && ['change24h', '24 h', 'c-24'], ['markets', 'Markets', 'c-mk'], ['reporters', 'Reporters', 'c-rep'], scored && ['trustScore', 'Trust', 'c-extra']].filter(Boolean),
    rows,
    row: (e) => `<tr id="ex-${esc(e.id)}"${hi === e.id ? ' class="flash"' : ''}><td class="l c-tok"><div class="tok">${exMark(e.name, e.logo, 28)}<div class="nm"><b title="${esc(e.name)}">${esc(e.name)}</b><span>${esc(e.kind)}${e.chain ? ' · ' + esc(e.chain) : ''}${visBadge(e) ? `<span class="bdg">${visBadge(e)}</span>` : ''}</span></div></div></td>` +
      `<td>${money(e.volume24h)}${unverifiedVolume(e)}</td>${showCh ? `<td class="c-24 ${dir(e.change24h)}">${pct(e.change24h)}</td>` : ''}<td class="c-mk n">${cnt(e.markets ?? 0)}</td><td class="c-rep n" data-tip="Agents that reported this venue in the last hour" tabindex="0">${cnt(e.reporters ?? 0)}</td>${scored ? `<td class="c-extra">${scoreHTML(e.trustScore, e.trustWhy)}</td>` : ''}</tr>`,
    empty: 'No match.',
  });
  const notes = [!showCh && d.items.length && '24 h volume change: collecting history', !scored && d.items.length && 'Trust: not scored yet; it needs 3 markets with a comparable price'].filter(Boolean);
  const seg = [['', 'All'], ['CEX', 'CEX'], ['DEX', 'DEX']];
  const st = d.pager.state;
  const sub = d.items.length ? `${money(total)} volume in 24 h across ${cnt(d.items.length)}${st.done ? '' : '+'} venues` : '';
  const main = `<div class="page-h"><div><h1>Exchanges</h1>${sub ? `<span class="sub n">${sub}</span>` : ''}</div>` +
    `<span class="seg3" role="group" aria-label="Kind">${seg.map(([k, l]) => `<button data-kind="${k}" aria-pressed="${ui.kind === k}">${l}</button>`).join('')}</span></div>` +
    (notes.length ? `<div class="note-row">${notes.map((n) => `<span>${esc(n)}</span>`).join('')}</div>` : '') +
    hiddenControl('ex') +
    (d.items.length ? `<div class="tw">${table}</div>` + moreHTML(st, 'ex', PAGE)
      : emptyHTML(ui.kind ? `No ${ui.kind} venues yet.` : 'No exchanges yet.', 'Venues appear as your node reads them.'));
  return { title: 'Exchanges', main, side: socialSide(ctx, d.social) };
}

function mount(ctx, d, route) {
  if (route.query.x) document.getElementById('ex-' + route.query.x)?.scrollIntoView({ block: 'center' });
  if (focusMore) { /** @type {HTMLElement|null} */ (document.querySelector('[data-more]'))?.focus(); focusMore = false; }
  return null;
}

function click(ctx, e, t) {
  let b;
  // The API filters by kind, so each kind is its own paged list.
  if ((b = t.closest('[data-kind]'))) { ui.kind = b.dataset.kind; ctx.reload(); return; }
  if (t.closest('[data-hidden]')) { toggleHidden('ex'); ctx.reload(); return; }
  if ((b = t.closest('[data-sort]'))) { sort = nextSort(sort, b.dataset.sort); ctx.rerender(); document.querySelector(`[data-sort="${b.dataset.sort}"]`)?.focus(); return; }
  if (t.closest('[data-more]')) {
    const p = pagerFor(ctx, ui.kind).more();
    focusMore = true; ctx.rerender();
    p.then(() => { focusMore = true; ctx.rerender(); }, () => { ctx.toast('Could not load more rows.', true); ctx.rerender(); });
  }
}

export default { load, html, mount, click };
