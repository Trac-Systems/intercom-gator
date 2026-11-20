// The right-hand social column (pinned official notice, Latest from everyone, Trending), as in the design.

import { esc, cnt, priceH, pct, dir, ago } from '../lib/format.js';
import { kp, tokSeed, keySeed } from '../lib/keyprint.js';
import { face } from '../lib/face.js';
import { tokMark } from '../lib/logo.js';
import { href } from '../lib/router.js';
import { postHTML, rich, ch24, SEAL, icon, userHref, tokId } from './components.js';

/** The side column shows the top of Trending only; the API can return up to 100 tags. */
export const TREND_MAX = 10;

/** The side column's Latest list shows this many posts; "See all" opens the feed's Latest tab. */
export const SIDE_POSTS = 6;

/** Posts from several lists, without repeats (first wins). @param {...any[]} lists */
export function mergePosts(...lists) {
  const seen = new Set(), out = [];
  for (const p of lists.flat()) { const k = p.key + '/' + p.id; if (!seen.has(k)) { seen.add(k); out.push(p); } }
  return out;
}

/** Loads what the social column needs (cached briefly). @param {any} ctx */
export async function loadSocial(ctx) {
  // Following is not fetched here: Latest already holds the newest posts of the people you follow. When the Following
  // lane is cached anyway (feed page), it is added for the token mention pills at no extra request.
  const following = ctx.peek?.('feed:following');
  const [official, latest, trending, extras, fol] = await Promise.all([
    ctx.cached('feed:official', () => ctx.api.feed({ lane: 'official' })),
    // A node without the Latest lane answers 400: the column then shows its empty note, the page still opens.
    ctx.cached('feed:latest', () => ctx.api.feed({ lane: 'latest' })).catch(() => ({ items: [] })),
    ctx.cached('trending', () => ctx.api.trending()),
    ctx.cached('extras', () => ctx.api.extras()),
    following ? following.catch(() => null) : null,
  ]);
  ctx.noteMentions(mergePosts(latest.items, fol ? fol.items : []));
  for (const p of latest.items.concat(official.items)) ctx.notePerson(p);
  return { official: official.items, latest: latest.items, trending: trending.items, extras: extras.items };
}

export function officialCard(ctx, o) {
  if (!o) return '';
  return `<section class="official" id="official" aria-label="Official notice"><div class="lab">${icon('pin')}Pinned · Official</div>` +
    `<a class="who" href="${userHref(o.key)}">${face(o, 36)}<b>${esc(o.author)}${SEAL}</b><span>${esc(o.handle)} · <span class="n">${esc(ago(o.ts))}</span></span></a>` +
    `<p>${rich(ctx, o)}</p></section>`;
}

export function trendingList(ctx, items) {
  if (!items || !items.length) return '<p class="muted small" style="margin:6px 0 0">Nothing trending yet. Tags rise here as posts mention them.</p>';
  return '<ol class="trend">' + items.slice(0, TREND_MAX).map((t, i) => {
    const sym = t.tag[0] === '$' ? t.tag.slice(1) : null;
    const tk0 = sym && ctx.idx.bySym.get(sym);
    const tk = tk0 && tokId(tk0) ? tk0 : null;
    const mark = tk ? tokMark(tk, 26) : '<span class="hash">#</span>';
    const right = tk ? `<span class="r n">${priceH(tk.price)}<span class="${dir(ch24(tk))}">${pct(ch24(tk))}</span></span>` : '<span class="r"></span>';
    const attr = tk ? `href="${esc(href('token', { id: tokId(tk) }))}"` : `href="#/" data-q="${esc(t.tag)}"`;
    return `<li><a ${attr} class="trow"><span class="rk n">${i + 1}</span>${mark}<span><span class="tg">${esc(t.tag)}</span><span class="ps n">${cnt(t.posts)} posts</span></span>${right}</a></li>`;
  }).join('') + '</ol>';
}

/**
 * @param {any} ctx @param {any} d result of loadSocial
 * @param {{ latest?: boolean, promo?: boolean }} [o]
 */
export function socialSide(ctx, d, o = {}) {
  const { latest = true, promo = true } = o;
  const pinned = d.official.find((p) => p.official) || d.official[0];
  let feed = d.latest.slice(0, SIDE_POSTS);
  const news = promo && ctx.takePromo() && d.extras.find((x) => x.slot === 'pinned-news' && x.post);
  if (news) feed = feed.slice(0, 1).concat([{ ...news.post, kind: 'promoted' }], feed.slice(1));
  return officialCard(ctx, pinned) +
    (latest ? `<div class="sec-h"><h2>Latest</h2><a class="lnk" href="${href('feed', { lane: 'latest' })}">See all</a></div>` +
      `<div id="feed">${feed.length ? feed.map((p) => postHTML(ctx, p)).join('') : '<p class="muted">No posts yet. New posts from everyone on gator show up here.</p>'}</div>` : '') +
    `<div class="sec-h"><h2>Trending</h2></div>${trendingList(ctx, d.trending)}`;
}
