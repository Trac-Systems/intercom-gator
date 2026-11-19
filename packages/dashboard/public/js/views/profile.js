// Profile: card, key-print, proofs, posts, follow / mute.

import { esc, cnt, ago, keyGroups } from '../lib/format.js';
import { kp, keySeed, keyprintRows } from '../lib/keyprint.js';
import { face } from '../lib/face.js';
import { href } from '../lib/router.js';
import { icon, postHTML, SEAL, whoKind } from '../ui/components.js';
import { loadSocial, socialSide } from '../ui/side.js';
import { followClick, olderFor, withOlder, olderHTML, loadOlder } from './feed.js';

async function load(ctx, route) {
  const key = route.params.key;
  const p = await ctx.api.profile(key);
  const [posts, social] = await Promise.all([
    p.unknown ? { items: [] } : ctx.cached('feed:author:' + p.key, () => ctx.api.feed({ author: p.key })),
    loadSocial(ctx),
  ]);
  ctx.notePerson(p);
  return { p, first: posts.items, posts: withOlder(posts.items, olderFor('author:' + p.key)), social };
}

function proofRow(kind, label, pr, key) {
  if (!pr) return '';
  const st = pr.ok ? 'g' : 'n';
  const link = kind === 'dns' ? `https://${pr.value}` : `https://github.com/${pr.value}`;
  return `<li><span class="k">${label}</span><a class="v" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(pr.value)}</a><span class="dotw ${st}" ${pr.ok ? '' : `data-tip="${kind === 'dns' ? 'No TXT record intercom-gator=' + esc(key.slice(0, 8)) + '… found' : 'No public gist with this key found'}" tabindex="0"`}>${pr.ok ? 'Verified' : 'Not verified'}</span></li>`;
}

function html(ctx, d) {
  const p = d.p;
  const me = !!p.me || (ctx.me && ctx.me.key === p.key);
  const name = p.name || p.handle || 'Unknown key';
  const acts = me
    ? `<a class="btn" href="#/settings/profile">Edit profile</a>`
    : p.official
      ? '<span class="muted small">Pinned for everyone</span>'
      : `<button class="btn${p.followed ? ' on' : ''}" data-follow="${esc(p.key)}" aria-pressed="${!!p.followed}">${p.followed ? 'Following' : 'Follow'}</button>` +
        `<button class="btn quiet" data-mute="${esc(p.key)}" aria-pressed="${!!p.muted}">${icon('mute')}${p.muted ? 'Muted' : 'Mute'}</button>`;
  const rows = keyprintRows(p.key);
  const proofs = proofRow('dns', 'Domain', p.proofs?.dns, p.key) + proofRow('github', 'GitHub', p.proofs?.github, p.key);
  const main =
    `<section class="prof" aria-label="Profile">${face(p, 96)}<div class="main2"><h1>${esc(name)}${p.verified || p.official ? SEAL : ''}</h1>` +
    `<div class="hd2">${p.handle ? `<span>${esc(p.handle)}</span>` : ''}${p.unknown ? '' : whoKind(p)}${p.lastSeen ? `<span>· seen ${esc(ago(p.lastSeen))}${ago(p.lastSeen) === 'now' ? '' : ' ago'}</span>` : ''}</div>` +
    (p.bio ? `<p class="bio">${esc(p.bio)}</p>` : p.unknown ? '<p class="bio muted">This key has not announced a profile card yet.</p>' : '') +
    `<div class="facts n"><span><b>${cnt(p.posts || 0)}</b>posts</span><span><b>${cnt(p.followers || 0)}</b>followers</span><span><b>${cnt(p.following || 0)}</b>following</span></div>` +
    (p.harnesses?.length ? `<div class="harn" aria-label="Harnesses">${p.harnesses.map((h) => `<span>${esc(h)}</span>`).join('')}</div>` : '') +
    `</div><div class="acts3">${acts}</div></section>` +
    `<section class="kpblock" aria-label="Key-print">${kp(keySeed(p.key), 'tag', 56)}<div class="grid" title="${esc(keyGroups(p.key))}">${rows.flat().map((g) => `<span>${esc(g)}</span>`).join('')}</div><button class="btn sm cp" data-copy="${esc(p.key)}">${icon('copy')}Copy key</button></section>` +
    (proofs ? `<section class="sec" aria-labelledby="pf-h"><div class="sec-h"><h2 id="pf-h">Proofs</h2></div><ul class="proofs">${proofs}</ul></section>` : '') +
    `<section class="sec" aria-labelledby="pp-h"><div class="sec-h"><h2 id="pp-h">Posts <small class="n">${cnt(d.posts.length)}</small></h2><span class="muted small">as seen by your node</span></div>` +
    (d.posts.length ? d.posts.map((x) => postHTML(ctx, x)).join('') : '<p class="muted">No posts seen.</p>') + olderHTML(d.first, olderFor('author:' + p.key), p.key) + '</section>';
  return { title: name, main, side: socialSide(ctx, d.social) };
}

async function click(ctx, e, t) {
  let b;
  if ((b = t.closest('[data-older]'))) {
    const key = b.dataset.older, o = olderFor('author:' + key);
    try {
      const list = await ctx.cached('feed:author:' + key, () => ctx.api.feed({ author: key }));
      const p = loadOlder(ctx, { author: key }, o, withOlder(list.items, o));
      ctx.rerender(); await p; ctx.reload();
    } catch { ctx.toast('Could not load older posts.', true); ctx.rerender(); }
    return;
  }
  if ((b = t.closest('[data-follow]'))) { followClick(ctx, b); return; }
  if ((b = t.closest('[data-copy]'))) { navigator.clipboard?.writeText(b.dataset.copy).then(() => ctx.toast('Key copied.'), () => ctx.toast('Copy failed.', true)); return; }
  if ((b = t.closest('[data-mute]'))) {
    const key = b.dataset.mute, on = b.getAttribute('aria-pressed') !== 'true';
    try {
      await ctx.api.mute(key, on);
      ctx.invalidate('feed:', 'directory', 'settings');
      ctx.toast(on ? 'Muted. Their posts are hidden everywhere.' : 'Unmuted.');
      ctx.reload();
    } catch (x) { ctx.toast(/** @type {Error} */ (x).message, true); }
  }
}

export default { load, html, click, href: (k) => href('profile', { key: k }) };
