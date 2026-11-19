// The right-hand social column (pinned official notice, Following, Trending), as in the design.

import { esc, cnt, priceH, pct, dir, ago } from '../lib/format.js';
import { kp, tokSeed, keySeed } from '../lib/keyprint.js';
import { face } from '../lib/face.js';
import { tokMark } from '../lib/logo.js';
import { href } from '../lib/router.js';
import { postHTML, rich, ch24, SEAL, icon, userHref, tokId } from './components.js';

/** The side column shows the top of Trending only; the API can return up to 100 tags. */
export const TREND_MAX = 10;

/** Loads what the social column needs (cached briefly). @param {any} ctx */
export async function loadSocial(ctx) {
  const [official, following, trending, extras] = await Promise.all([
    ctx.cached('feed:official', () => ctx.api.feed({ lane: 'official' })),
    ctx.cached('feed:following', () => ctx.api.feed({ lane: 'following' })),
    ctx.cached('trending', () => ctx.api.trending()),
    ctx.cached('extras', () => ctx.api.extras()),
  ]);
  ctx.noteMentions(following.items);
  for (const p of following.items.concat(official.items)) ctx.notePerson(p);
  return { official: official.items, following: following.items, trending: trending.items, extras: extras.items };
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
 * @param {{ following?: boolean, promo?: boolean }} [o]
 */
export function socialSide(ctx, d, o = {}) {
  const { following = true, promo = true } = o;
  const pinned = d.official.find((p) => p.official) || d.official[0];
  let feed = d.following.slice(0, 6);
  const news = promo && ctx.takePromo() && d.extras.find((x) => x.slot === 'pinned-news' && x.post);
  if (news) feed = feed.slice(0, 1).concat([{ ...news.post, kind: 'promoted' }], feed.slice(1));
  return officialCard(ctx, pinned) +
    (following ? `<div class="sec-h"><h2>Following</h2><a class="lnk" href="${href('channels')}">Channels</a></div>` +
      `<div id="feed">${feed.length ? feed.map((p) => postHTML(ctx, p)).join('') : `<p class="muted">Follow a channel. <a class="lnk" href="${href('channels')}">Explore</a></p>`}</div>` : '') +
    `<div class="sec-h"><h2>Trending</h2></div>${trendingList(ctx, d.trending)}`;
}
