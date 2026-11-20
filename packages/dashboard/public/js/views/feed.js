// Feed: Latest (everyone, the default) / Following / Official / Mentions, compose with a 500-character counter.

import { esc, cnt } from '../lib/format.js';
import { kp, keySeed } from '../lib/keyprint.js';
import { face } from '../lib/face.js';
import { href } from '../lib/router.js';
import { postHTML, userHref, SEAL, emptyHTML } from '../ui/components.js';
import { composeHTML, wireCompose } from '../ui/compose.js';
import { loadSocial, officialCard, trendingList } from '../ui/side.js';

/** Feed lanes in tab order; the first is the default (`#/feed`). */
export const LANES = [['latest', 'Latest'], ['following', 'Following'], ['official', 'Official'], ['mentions', 'Mentions']];
/** The lane a route asks for; no lane or an unknown one opens the first (Latest). @param {string} [lane] */
export function laneOf(lane) { return LANES.some((l) => l[0] === lane) ? /** @type {string} */ (lane) : LANES[0][0]; }
const EMPTY = {
  latest: ['No posts yet.', 'New posts from everyone on gator show up here.'],
  following: ['Nobody you follow has posted yet.', ''],
  official: ['No official posts yet.', ''],
  mentions: ['No mentions yet.', ''],
};
export const FEED_PAGE = 100; // the API's feed maximum

/**
 * Older posts below a feed's first page, paged with the API's ?before=<ts> cursor.
 * The first page stays in ctx.cached (live updates invalidate it); older pages are kept per list.
 */
const older = new Map();
export function olderFor(key) {
  if (!older.has(key)) older.set(key, { items: [], done: false, loading: false });
  return older.get(key);
}
/** First page + older pages, without repeats. */
export function withOlder(first, o) {
  const seen = new Set(first.map((p) => p.key + '/' + p.id));
  return first.concat(o.items.filter((p) => !seen.has(p.key + '/' + p.id)));
}
/** Can there be older posts? @param {any[]} first @param {{done:boolean}} o */
export function hasOlder(first, o) { return first.length >= FEED_PAGE && !o.done; }
export function olderHTML(first, o, id) {
  if (!hasOlder(first, o)) return '';
  return `<div class="more-row"><button class="btn sm" data-older="${esc(id)}"${o.loading ? ' disabled aria-busy="true"' : ''}>${o.loading ? 'Loading…' : 'Show older posts'}</button></div>`;
}
/** Load the next older page. @param {any} ctx @param {Record<string,string>} q @param {any[]} all posts shown now */
export async function loadOlder(ctx, q, o, all) {
  if (o.loading || o.done) return;
  const last = all[all.length - 1];
  if (!last) { o.done = true; return; }
  o.loading = true;
  try {
    const r = await ctx.api.feed({ ...q, before: last.ts, limit: FEED_PAGE });
    for (const p of r.items) ctx.notePerson(p);
    o.items.push(...r.items);
    if (r.items.length < FEED_PAGE) o.done = true;
  } finally { o.loading = false; }
}

async function load(ctx, route) {
  const lane = laneOf(route.params.lane);
  const [list, social, dir, extras] = await Promise.all([
    ctx.cached('feed:' + lane, () => ctx.api.feed({ lane })),
    loadSocial(ctx),
    ctx.cached('directory:', () => ctx.api.directory()),
    ctx.cached('extras', () => ctx.api.extras()),
  ]);
  for (const p of list.items) ctx.notePerson(p);
  for (const p of dir.items) ctx.notePerson(p);
  return { lane, first: list.items, items: withOlder(list.items, olderFor('lane:' + lane)), social, dir: dir.items, extras: extras.items };
}

function whoToFollow(ctx, people) {
  const list = people.filter((p) => !p.followed && !p.official && !p.muted).slice(0, 3);
  if (!list.length) return '';
  return `<div class="sec-h"><h2>Who to follow</h2><a class="lnk" href="${href('channels')}">Explore</a></div><ul class="mini-l">` + list.map((p) =>
    `<li>${face(p, 28)}<a href="${userHref(p.key)}"><b>${esc(p.name || p.handle || p.key.slice(0, 8))}</b></a><button class="btn sm" data-follow="${esc(p.key)}" aria-pressed="false">Follow</button><span class="t2">${[p.handle ? esc(p.handle) : '', p.product ? 'product' : p.agent ? 'agent' : 'human', cnt(p.followers ?? 0) + ((p.followers ?? 0) === 1 ? ' follower' : ' followers')].filter(Boolean).join(' · ')}</span></li>`).join('') + '</ul>';
}

function html(ctx, d) {
  let items = d.items;
  if ((d.lane === 'latest' || d.lane === 'following') && ctx.takePromo()) {
    const news = d.extras.find((x) => x.slot === 'pinned-news' && x.post);
    if (news && items.length) items = items.slice(0, 1).concat([{ ...news.post, kind: 'promoted' }], items.slice(1));
  }
  const tabs = `<div class="tabsbar lanes"><div class="tabs" role="tablist" aria-label="Feed">${LANES.map(([id, label]) =>
    `<a class="tab" role="tab" href="${href('feed', { lane: id })}" aria-selected="${d.lane === id}"${d.lane === id ? '' : ' tabindex="-1"'}>${label}</a>`).join('')}<span class="ind"></span></div></div>`;
  const [empty, emptySub] = EMPTY[d.lane];
  const o = olderFor('lane:' + d.lane);
  const main = `<div class="feedwrap"><div class="page-h" style="margin-bottom:0"><h1>Feed</h1></div>${tabs}` +
    (d.lane !== 'official' ? composeHTML(ctx, { id: 'cmp', placeholder: 'Post to your channel', button: 'Post', label: 'New post' }) : '') +
    `<div id="timeline">${items.length ? items.map((p) => postHTML(ctx, p)).join('') : `<div class="empty-state quiet"><b>${empty}</b>${emptySub}${d.lane === 'following' ? `<a class="lnk" href="${href('channels')}">Explore channels</a>` : ''}</div>`}</div>${olderHTML(d.first, o, d.lane)}</div>`;
  const pinned = d.social.official.find((p) => p.official);
  const side = (d.lane === 'official' ? '' : officialCard(ctx, pinned)) + whoToFollow(ctx, d.dir) + `<div class="sec-h"><h2>Trending</h2></div>${trendingList(ctx, d.social.trending)}`;
  return { title: 'Feed', main, side, pv: 'markets' };
}

function mount(ctx, d) {
  return wireCompose(/** @type {HTMLFormElement} */ (document.getElementById('cmp')), async (text) => {
    try {
      const p = await ctx.api.publish(text);
      ctx.invalidate('feed:');
      const tl = document.getElementById('timeline');
      if (tl) { tl.querySelector('.empty-state')?.remove(); tl.insertAdjacentHTML('afterbegin', postHTML(ctx, p)); tl.firstElementChild?.classList.add('flash'); }
      ctx.toast('Posted to your channel.');
    } catch (e) { ctx.toast('Not posted: ' + /** @type {Error} */ (e).message, true); throw e; }
  });
}

export async function followClick(ctx, b) {
  const key = b.dataset.follow, on = b.getAttribute('aria-pressed') !== 'true';
  b.setAttribute('aria-pressed', String(on)); b.textContent = on ? 'Following' : 'Follow'; b.classList.toggle('on', on);
  try { await ctx.api.follow(key, on); ctx.invalidate('feed:', 'directory', 'profile:', 'settings'); }
  catch (e) { b.setAttribute('aria-pressed', String(!on)); b.textContent = !on ? 'Following' : 'Follow'; b.classList.toggle('on', !on); ctx.toast(/** @type {Error} */ (e).message, true); }
}

function click(ctx, e, t) {
  const b = t.closest('[data-follow]');
  if (b) { followClick(ctx, b); return; }
  const m = t.closest('[data-older]');
  if (m) {
    const lane = m.dataset.older, o = olderFor('lane:' + lane);
    ctx.cached('feed:' + lane, () => ctx.api.feed({ lane })).then((list) => {
      const p = loadOlder(ctx, { lane }, o, withOlder(list.items, o).filter((x) => x.kind !== 'promoted'));
      ctx.rerender();
      return p;
    }).then(() => ctx.reload(), () => { ctx.toast('Could not load older posts.', true); ctx.rerender(); });
  }
}

export default { load, html, mount, click };
export { SEAL };
