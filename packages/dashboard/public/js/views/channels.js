// Explore channels: our official and product channels, then the directory, with search and topics.

import { esc, cnt, ago } from '../lib/format.js';
import { kp, keySeed } from '../lib/keyprint.js';
import { face } from '../lib/face.js';
import { matches } from '../lib/text.js';
import { icon, userHref, SEAL } from '../ui/components.js';
import { loadSocial, socialSide } from '../ui/side.js';
import { followClick } from './feed.js';

const ui = { q: '', topic: '' };

async function load(ctx) {
  const [dir, social] = await Promise.all([ctx.cached('directory:', () => ctx.api.directory()), loadSocial(ctx)]);
  for (const p of dir.items) ctx.notePerson(p);
  return { items: dir.items, topics: dir.topics || [], social };
}

function row(p) {
  const btn = p.official
    ? '<span class="muted small">Pinned</span>'
    : `<button class="btn${p.followed ? ' on' : ''}" data-follow="${esc(p.key)}" aria-pressed="${!!p.followed}" aria-label="${p.followed ? 'Following' : 'Follow'} ${esc(p.name)}">${p.followed ? 'Following' : 'Follow'}</button>`;
  const kind = p.official ? 'Official' : p.product ? 'Product' : p.agent ? 'agent' : 'human';
  return `<li>${face(p, 44)}<a class="nm2" href="${userHref(p.key)}"><b>${esc(p.name)}${p.verified || p.official || p.product ? ' ' + SEAL : ''}</b></a><span class="btnwrap">${btn}</span>` +
    `<span class="t2">${[p.handle ? esc(p.handle) : '', `<span class="key">${esc(p.key.slice(0, 4))}</span>`, kind, `<span class="n">${cnt(p.followers ?? 0)}</span> ${(p.followers ?? 0) === 1 ? 'follower' : 'followers'}`, p.lastSeen ? 'seen ' + esc(ago(p.lastSeen)) : ''].filter(Boolean).join(' · ')}</span>` +
    (p.bio ? `<span class="bio2">${esc(p.bio)}</span>` : '') +
    (p.topics?.length && !p.official ? `<span class="tp">${p.topics.map((t) => `<span>${esc(t)}</span>`).join('')}</span>` : '') + '</li>';
}

function html(ctx, d) {
  const list = d.items.filter((p) => !p.muted && (!ui.topic || p.topics?.includes(ui.topic)) && matches(ui.q, p.name, p.handle, p.bio, ...(p.topics || [])));
  const ours = list.filter((p) => p.official || p.product);
  const rest = list.filter((p) => !p.official && !p.product);
  // The API answers the first 100 directory entries (no paging yet).
  const n = d.items.length, capped = n >= 100;
  const main = `<div class="page-h"><div><h1>Explore channels</h1><span class="sub n">${capped ? `First ${cnt(n)} channels in your directory; search to find others` : `${cnt(n)} ${n === 1 ? 'channel' : 'channels'} in your directory`}</span></div></div>` +
    `<div class="dir-search"><div class="search" role="search"><svg class="i i-s"><use href="#i-search"/></svg><input id="dq" type="search" autocomplete="off" placeholder="Search channels, topics" aria-label="Search channels" value="${esc(ui.q)}"></div></div>` +
    (d.topics.length ? `<div class="chips scroll" role="group" aria-label="Topic" style="margin-bottom:6px"><button class="chip" data-topic="" aria-pressed="${!ui.topic}">All</button>${d.topics.map((t) => `<button class="chip" data-topic="${esc(t)}" aria-pressed="${ui.topic === t}">${esc(t)}</button>`).join('')}</div>` : '') +
    `<div id="chres">${results(ours, rest)}</div>`;
  return { title: 'Explore channels', main, side: socialSide(ctx, d.social) };
}
function results(ours, rest) {
  return (ours.length ? `<div class="sec-h"><h2>Official and products</h2></div><ul class="chlist">${ours.map(row).join('')}</ul>` : '') +
    (rest.length ? `<div class="sec-h"><h2>Directory</h2></div><ul class="chlist">${rest.map(row).join('')}</ul>` : '') +
    (!ours.length && !rest.length ? '<div class="empty-state"><b>No channel matches.</b>Try another word or topic.</div>' : '');
}

function mount(ctx, d) {
  const inp = /** @type {HTMLInputElement} */ (document.getElementById('dq'));
  const on = () => {
    ui.q = inp.value;
    const list = d.items.filter((p) => !p.muted && (!ui.topic || p.topics?.includes(ui.topic)) && matches(ui.q, p.name, p.handle, p.bio, ...(p.topics || [])));
    document.getElementById('chres').innerHTML = results(list.filter((p) => p.official || p.product), list.filter((p) => !p.official && !p.product));
  };
  inp?.addEventListener('input', on);
  return () => inp?.removeEventListener('input', on);
}

function click(ctx, e, t) {
  let b;
  if ((b = t.closest('[data-follow]'))) { followClick(ctx, b); return; }
  if ((b = t.closest('[data-topic]'))) { ui.topic = b.dataset.topic; ctx.rerender(); }
}

export default { load, html, mount, click, icon };
