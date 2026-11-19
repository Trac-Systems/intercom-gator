// Thread: the post's parents, the post, a reply box, the replies (oldest first).

import { esc } from '../lib/format.js';
import { href } from '../lib/router.js';
import { postHTML, icon } from '../ui/components.js';
import { composeHTML, wireCompose } from '../ui/compose.js';
import { loadSocial, socialSide } from '../ui/side.js';

async function load(ctx, route) {
  const { key, id } = route.params;
  const [th, social] = await Promise.all([ctx.cached(`thread:${key}:${id}`, () => ctx.api.thread(key, id), 10000), loadSocial(ctx)]);
  for (const p of [th.post, ...th.parents, ...th.replies]) ctx.notePerson(p);
  return { ...th, social };
}

function html(ctx, d) {
  const p = d.post;
  const main = `<div class="feedwrap"><a class="crumb" href="#/feed">${icon('down')}Feed</a><div class="page-h" style="margin-top:14px;margin-bottom:4px"><h1>Thread</h1></div>` +
    d.parents.map((x) => postHTML(ctx, x, { parent: true })).join('') +
    postHTML(ctx, p, { focus: true, ctxLine: p.parent && !d.parents.length ? 'Reply to a post that has expired' : '' }) +
    `<div class="reply-box">${composeHTML(ctx, { id: 'rcmp', placeholder: 'Reply to ' + (p.handle || 'this post'), button: 'Reply', label: 'Reply' })}</div>` +
    `<div id="replies">${d.replies.map((r) => postHTML(ctx, r)).join('')}</div>` +
    (d.replies.length ? '' : '<p class="muted" style="padding:16px 0">No replies yet.</p>') + '</div>';
  return { title: `${p.author}: “${p.text.slice(0, 40)}”`, main, side: socialSide(ctx, d.social, { following: false, promo: false }) };
}

function mount(ctx, d) {
  const f = /** @type {HTMLFormElement} */ (document.getElementById('rcmp'));
  if (f) f.style.borderBottom = '0';
  return wireCompose(f, async (text) => {
    try {
      const r = await ctx.api.reply(text, { key: d.post.key, id: d.post.id });
      ctx.invalidate('thread:', 'feed:');
      const box = document.getElementById('replies');
      box?.nextElementSibling?.matches?.('p.muted') && box.nextElementSibling.remove();
      box?.insertAdjacentHTML('beforeend', postHTML(ctx, r));
      box?.lastElementChild?.classList.add('flash');
      ctx.toast('Reply sent.');
    } catch (e) { ctx.toast('Not sent: ' + /** @type {Error} */ (e).message, true); throw e; }
  });
}

export default { load, html, mount, href: (p) => href('post', { key: p.key, id: p.id }), esc };
