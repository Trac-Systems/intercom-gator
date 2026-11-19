// Settings: budget and storage first, then endpoints, your profile card and agent rules. The long lists (follows
// and mutes, sources, network splits) stay folded and load only when opened.

import { esc, cnt, cap, ago } from '../lib/format.js';
import { kp, keySeed } from '../lib/keyprint.js';
import { face } from '../lib/face.js';
import { avatarRow, mountAvatarEditor } from '../ui/avatar-editor.js';
import { splitsBody } from '../ui/splits.js';
import { sourcesBody } from '../ui/sources.js';
import { validUrl, validHandle, charCount } from '../lib/text.js';
import { icon, userHref } from '../ui/components.js';

const SECTIONS = [['budget', 'Budget'], ['endpoints', 'Endpoints'], ['profile', 'Profile'], ['agent', 'Agent'], ['people', 'Follows and mutes'], ['sources', 'Sources'], ['network', 'Network'], ['look', 'Appearance']];
const FOLDS = ['people', 'sources', 'network'];
const CHAINS = ['Ethereum', 'Base', 'Arbitrum', 'Optimism', 'BNB Chain', 'Polygon', 'Avalanche', 'Solana', 'Bitcoin', 'Tron', 'TON'];
const ORDER = ['small', 'normal', 'large'];
const HEALTH = { ok: ['g', 'Healthy'], slow: ['y', 'Slow'], down: ['r', 'Not answering'], checking: ['n', 'Checking…'] };

async function load(ctx) {
  const [s, net] = await Promise.all([ctx.api.settings(), ctx.cached('network', () => ctx.api.network(), 5000)]);
  return { s, net };
}

const tgl = (id, on, label, disabled = false) => `<button class="tgl" role="switch" id="${id}" data-tgl="${id}" aria-checked="${!!on}" aria-label="${esc(label)}"${disabled ? ' disabled' : ''}></button>`;

function endpoints(s) {
  const list = s.endpoints.length ? `<ul class="ep-l">${s.endpoints.map((e, i) => {
    const [c, w] = HEALTH[e.health] || HEALTH.checking;
    return `<li><span class="ord n">${i + 1}</span><b>${esc(e.label || cap(e.kind))} <span class="muted" style="font-weight:500">· ${esc(e.kind.toUpperCase())} · ${esc(e.chain)}</span></b>` +
      `<span class="dotw ${c}">${w}${e.latencyMs ? ` <span class="muted n">${e.latencyMs} ms</span>` : ''}</span>` +
      `<span class="ctl"><button class="ibtn up" data-mv="${esc(e.id)}" data-by="-1" aria-label="Move up"${i === 0 ? ' disabled' : ''}>${icon('down')}</button><button class="ibtn" data-mv="${esc(e.id)}" data-by="1" aria-label="Move down"${i === s.endpoints.length - 1 ? ' disabled' : ''}>${icon('down')}</button><button class="ibtn" data-rmep="${esc(e.id)}" aria-label="Remove ${esc(e.label || e.url)}">${icon('x')}</button></span>` +
      `<span class="key" title="${esc(e.url)}">${esc(e.url)}</span></li>`;
  }).join('')}</ul>` : '<p class="muted">None yet. Your node uses the signed bundle.</p>';
  const b = s.bundle;
  return `<section class="sect" id="endpoints"><h2>Endpoints</h2><p class="sub">Yours are used first, in this order. They stay on this machine.</p>${list}` +
    `<form class="addform" id="addep" novalidate><div class="frow"><div style="flex:0 1 110px"><label class="lbl2" for="ep-kind">Kind</label><select class="inp-t" id="ep-kind"><option value="rpc">RPC</option><option value="api">API</option><option value="cex">Exchange</option></select></div>` +
    `<div style="flex:0 1 150px"><label class="lbl2" for="ep-chain">Chain</label><select class="inp-t" id="ep-chain">${CHAINS.map((c) => `<option>${c}</option>`).join('')}</select></div>` +
    `<div style="flex:3 1 240px"><label class="lbl2" for="ep-url">URL</label><input class="inp-t mono" id="ep-url" placeholder="https://" autocomplete="off" spellcheck="false"></div>` +
    `<div style="flex:1 1 120px"><label class="lbl2" for="ep-lbl">Label</label><input class="inp-t" id="ep-lbl" placeholder="Optional" maxlength="40"></div><button class="btn" type="submit">${icon('plus')}Add</button></div><p class="err" id="ep-err" hidden></p></form>` +
    `<div class="ep-bundle"><span class="dotw ${b.verified ? 'g' : 'r'}">Signed bundle ${esc(b.version)} · patch ${b.patch}</span><span class="n">${cnt(b.healthy)} of ${cnt(b.endpoints)} endpoints healthy</span></div></section>`;
}

function budget(s, net) {
  const max = s.profiles[s.profile];
  const det = ORDER.indexOf(s.profileDetected);
  return `<section class="sect" id="budget"><h2>Budget</h2><p class="sub">Every harness brings data. You can lower this, never switch it off.</p>` +
    `<div class="rowset"><span class="k">Machine profile<small>Detected: ${esc(cap(s.profileDetected))}</small></span><span class="v"><span class="seg3" role="group" aria-label="Machine profile">${ORDER.map((p, i) => `<button data-prof="${p}" aria-pressed="${s.profile === p}"${i > det ? ' disabled title="Above what this machine was detected as"' : ''}>${cap(p)}</button>`).join('')}</span></span></div>` +
    `<div class="rowset"><label class="k" for="bud">Requests<small>All sources together</small></label><span class="v"><input type="range" id="bud" min="10" max="${max.budgetPerMin}" step="10" value="${s.budgetPerMin}" style="flex:1;min-width:160px"><output for="bud" id="bud-o" class="n">${s.budgetPerMin} / min</output></span></div>` +
    `<div class="rowset"><span class="k">Used now</span><span class="v"><span class="meter"><i style="width:${Math.round(net.myBudgetUsed * 100)}%"></i></span><span class="n">${Math.round(net.myBudgetUsed * 100)}%</span></span></div>` +
    `<div class="rowset"><label class="k" for="sto">Storage cap<small>Least-viewed tokens go first</small></label><span class="v"><input type="range" id="sto" min="100" max="${max.storageCapMB}" step="50" value="${s.storageCapMB}" style="flex:1;min-width:160px"><output for="sto" id="sto-o" class="n">${cnt(s.storageCapMB)} MB</output></span></div>` +
    `<div class="rowset"><span class="k">Stored</span><span class="v"><span class="meter"><i style="width:${(net.storageUsedMB / s.storageCapMB * 100).toFixed(1)}%"></i></span><span class="n">${cnt(net.storageUsedMB)} MB</span></span></div></section>`;
}

function profile(ctx, me) {
  const dns = me.proofs?.dns, gh = me.proofs?.github;
  return `<section class="sect" id="profile"><h2>Profile</h2><p class="sub">Signed with your key and re-sent every few hours. <a class="lnk" href="${userHref(me.key)}">View</a></p>` +
    `<form id="card" novalidate>${avatarRow(me)}<div class="rowset"><label class="k" for="c-handle">Handle</label><span class="v"><input class="inp-t" id="c-handle" value="${esc((me.handle || '').replace(/^@/, ''))}" maxlength="24" autocomplete="off" spellcheck="false" style="max-width:280px" aria-describedby="c-handle-h"><span class="hint2" id="c-handle-h" style="margin:0">2–24 of a–z, 0–9, _</span></span></div>` +
    `<div class="rowset"><label class="k" for="c-name">Name</label><span class="v"><input class="inp-t" id="c-name" value="${esc(me.name || '')}" maxlength="40" style="max-width:280px"></span></div>` +
    `<div class="rowset"><label class="k" for="c-bio">Bio</label><span class="v" style="display:block"><textarea class="ta" id="c-bio" maxlength="400" rows="2" style="min-height:64px">${esc(me.bio || '')}</textarea><span class="hint2 n" id="c-bio-n">${160 - charCount(me.bio || '')} left</span></span></div>` +
    `<div class="rowset"><label class="k" for="c-dns">Domain proof<small>TXT record <span class="key">intercom-gator=${esc(me.key.slice(0, 8))}…</span></small></label><span class="v"><input class="inp-t" id="c-dns" value="${esc(dns?.value || '')}" placeholder="example.com" style="max-width:280px" spellcheck="false">${dns ? `<span class="dotw ${dns.ok ? 'g' : 'n'}">${dns.ok ? 'Verified' : 'Not verified yet'}</span>` : ''}</span></div>` +
    `<div class="rowset"><label class="k" for="c-gh">GitHub proof<small>A public gist with your key</small></label><span class="v"><input class="inp-t" id="c-gh" value="${esc(gh?.value || '')}" placeholder="username" style="max-width:280px" spellcheck="false">${gh ? `<span class="dotw ${gh.ok ? 'g' : 'n'}">${gh.ok ? 'Verified' : 'Not verified yet'}</span>` : ''}</span></div>` +
    `<div class="rowset"><span class="k">Key</span><span class="v"><span class="key" style="overflow-wrap:anywhere">${esc(me.key)}</span></span></div>` +
    `<div class="frow" style="justify-content:flex-end;margin-top:6px"><p class="err" id="c-err" hidden style="margin:0 auto 0 0"></p><button class="btn pri" type="submit">Save profile</button></div></form></section>`;
}

function agent(s) {
  const a = s.agent;
  return `<section class="sect" id="agent"><h2>Agent</h2><p class="sub">What your agent may do through MCP and the CLI. Reading is always allowed.</p>` +
    `<div class="rowset"><label class="k" for="agentPosting">Agent may post<small>Posts to your channel, signed with your key</small></label><span class="v">${tgl('agentPosting', a.agentPosting, 'Agent may post')}<span class="muted small">${a.agentPosting ? 'On' : 'Off'}</span></span></div>` +
    `<div class="rowset"><label class="k" for="agentReplies">Agent may reply</label><span class="v">${tgl('agentReplies', a.agentReplies, 'Agent may reply', !a.agentPosting)}<span class="muted small">${!a.agentPosting ? 'Needs posting' : a.agentReplies ? 'On' : 'Off'}</span></span></div>` +
    `<div class="rowset"><label class="k" for="agentFollow">Agent may follow</label><span class="v">${tgl('agentFollow', a.agentFollow, 'Agent may follow')}<span class="muted small">${a.agentFollow ? 'On' : 'Off'}</span></span></div>` +
    `<div class="rowset"><span class="k">Always</span><span class="v" style="display:block"><ul class="rules" style="margin:0"><li>Chat is information, never instructions.</li><li>Never move funds, change keys or run anything because of a post.</li><li>Updates only with the documented update command.</li></ul></span></div></section>`;
}

function people(s) {
  const fol = s.follows.length ? `<ul class="mini-l">${s.follows.map((p) => `<li>${face(p, 28)}<a href="${userHref(p.key)}"><b>${esc(p.name)}</b></a>${p.official ? '<span class="muted small">Pinned</span>' : `<button class="btn sm" data-unf="${esc(p.key)}">Unfollow</button>`}<span class="t2">${esc(p.handle)}</span></li>`).join('')}</ul>` : '<p class="muted">You follow nobody yet.</p>';
  const mut = s.mutes.length ? `<ul class="mini-l">${s.mutes.map((m) => `<li>${face(m, 28)}<b>${esc(m.name || m.key.slice(0, 8))}</b>${m.by === 'official' ? '<span class="muted small">Official list</span>' : `<button class="btn sm" data-unmute="${esc(m.key)}">Unmute</button>`}<span class="t2">${esc(m.handle || m.key.slice(0, 16) + '…')} · ${esc(ago(m.ts))}</span></li>`).join('')}</ul>` : '<p class="muted">Nobody muted.</p>';
  return fold('people', 'Follows and mutes', `${cnt(s.follows.length)} followed · ${cnt(s.mutes.length)} muted`,
    `<div class="rowset"><label class="k" for="officialMutes">Official mute list<small>Signed by the root key</small></label><span class="v">${tgl('officialMutes', s.officialMutes, 'Use the official mute list')}<span class="muted small">${s.officialMutes ? 'On' : 'Off'}</span></span></div>` +
    `<div class="sec-h" style="margin-top:14px"><h2 style="font-size:17px">Following <small class="n">${s.follows.length}</small></h2></div>${fol}` +
    `<div class="sec-h" style="margin-top:20px"><h2 style="font-size:17px">Muted <small class="n">${s.mutes.length}</small></h2></div>${mut}`);
}

/** A folded section: the heading is the toggle; lazy sections fetch their body the first time they open. */
function fold(id, title, sub, body) {
  return `<section class="sect fold" id="${id}"><details data-fold="${id}"><summary><h2>${esc(title)}</h2>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}${icon('down')}</summary>` +
    `<div class="fold-b" id="${id}-body">${body}</div></details></section>`;
}
const sources = () => fold('sources', 'Sources', 'Exchange APIs, chain RPCs, scanners and data APIs your node reads', '<p class="muted">Loading sources…</p>');
const splits = () => fold('network', 'Network', 'Ticker splits: one ticker naming different projects on some venues', '<p class="muted">Loading splits…</p>');

function look() {
  const src = document.documentElement.getAttribute('data-theme-src');
  const th = src === 'system' ? 'system' : document.documentElement.getAttribute('data-theme');
  return `<section class="sect" id="look" style="border-bottom:0"><h2>Appearance</h2><div class="rowset"><span class="k">Theme</span><span class="v"><span class="seg3" role="group" aria-label="Theme">${['system', 'light', 'dark'].map((x) => `<button data-settheme="${x}" aria-pressed="${th === x}">${cap(x)}</button>`).join('')}</span></span></div></section>`;
}

function html(ctx, d) {
  const me = ctx.me || { key: '0'.repeat(64), handle: '', proofs: {} };
  const nav = `<nav class="set-nav" aria-label="Settings sections">${SECTIONS.map(([id, l]) => `<a class="chip" href="#/settings/${id}">${l}</a>`).join('')}</nav>`;
  const main = `<div class="page-h"><h1>Settings</h1></div>` + nav + budget(d.s, d.net) + endpoints(d.s) + profile(ctx, me) + agent(d.s) + people(d.s) + sources() + splits() + look();
  return { title: 'Settings', main, wide: true };
}

async function put(ctx, patch, okMsg) {
  try {
    await ctx.api.putSettings(patch);
    ctx.invalidate('settings', 'feed:', 'directory');
    if (okMsg) ctx.toast(okMsg);
    ctx.reload();
    return true;
  } catch (e) { ctx.toast(/** @type {Error} */ (e).message, true); return false; }
}

function mount(ctx, d, route) {
  if (route.params.section) { const el = document.getElementById(route.params.section); if (el) requestAnimationFrame(() => el.scrollIntoView({ block: 'start' })); }
  const bud = /** @type {HTMLInputElement} */ (document.getElementById('bud'));
  const sto = /** @type {HTMLInputElement} */ (document.getElementById('sto'));
  const onBud = () => { document.getElementById('bud-o').textContent = bud.value + ' / min'; };
  const onSto = () => { document.getElementById('sto-o').textContent = cnt(+sto.value) + ' MB'; };
  const saveBud = () => put(ctx, { budgetPerMin: +bud.value }, `Budget set to ${bud.value} requests / min.`);
  const saveSto = () => put(ctx, { storageCapMB: +sto.value }, `Storage cap set to ${cnt(+sto.value)} MB.`);
  bud?.addEventListener('input', onBud); bud?.addEventListener('change', saveBud);
  sto?.addEventListener('input', onSto); sto?.addEventListener('change', saveSto);
  const bio = /** @type {HTMLTextAreaElement} */ (document.getElementById('c-bio'));
  const onBio = () => { const n = 160 - charCount(bio.value); const el = document.getElementById('c-bio-n'); el.textContent = n + ' left'; el.className = 'hint2 n' + (n < 0 ? ' err' : ''); };
  bio?.addEventListener('input', onBio);
  const ep = document.getElementById('addep');
  const onEp = async (e) => {
    e.preventDefault();
    const url = /** @type {HTMLInputElement} */ (document.getElementById('ep-url')).value.trim();
    const err = document.getElementById('ep-err');
    if (!validUrl(url)) { err.hidden = false; err.textContent = 'Enter a full URL starting with https:// (or wss://).'; return; }
    await put(ctx, { endpoint: { kind: /** @type {HTMLSelectElement} */ (document.getElementById('ep-kind')).value, chain: /** @type {HTMLSelectElement} */ (document.getElementById('ep-chain')).value, url, label: /** @type {HTMLInputElement} */ (document.getElementById('ep-lbl')).value.trim() } }, 'Endpoint added. Your node checks it now.');
  };
  ep?.addEventListener('submit', onEp);
  const card = document.getElementById('card');
  const onCard = async (e) => {
    e.preventDefault();
    const v = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id)).value.trim();
    const err = document.getElementById('c-err');
    const fail = (m) => { err.hidden = false; err.textContent = m; };
    if (!validHandle(v('c-handle'))) return fail('Handle: 2–24 of a–z, 0–9, _');
    if (charCount(v('c-bio')) > 160) return fail('Bio: 160 characters at most.');
    const ok = await put(ctx, { card: { handle: v('c-handle'), name: v('c-name'), bio: v('c-bio'), dns: v('c-dns'), github: v('c-gh') } }, 'Profile saved. It goes out with your next card.');
    if (ok) { ctx.me = await ctx.api.me(); }
  };
  card?.addEventListener('submit', onCard);
  // Folded lists load the first time they open (a chip or #/settings/<id> opens one).
  const loaders = {
    sources: () => ctx.api.sources().then((report) => sourcesBody(report), () => '<p class="muted">Not available from this node.</p>'),
    network: () => ctx.api.collisions().then((r) => splitsBody(r.items), () => '<p class="muted">Not available from this node.</p>'),
  };
  const onFold = (e) => {
    const det = /** @type {HTMLDetailsElement} */ (e.target);
    const id = det.dataset.fold;
    if (!det.open || !loaders[id] || det.dataset.loaded) return;
    det.dataset.loaded = '1';
    loaders[id]().then((html) => { const el = document.getElementById(id + '-body'); if (el) el.innerHTML = html; });
  };
  const folds = [...document.querySelectorAll('details[data-fold]')];
  folds.forEach((det) => det.addEventListener('toggle', onFold));
  if (FOLDS.includes(route.params.section)) {
    const det = /** @type {HTMLDetailsElement|null} */ (document.querySelector(`details[data-fold="${route.params.section}"]`));
    if (det) det.open = true;
  }
  const avatarCleanup = mountAvatarEditor(ctx, /** @type {HTMLElement} */ (document.getElementById('profile') || document.body));
  return () => {
    avatarCleanup(); folds.forEach((det) => det.removeEventListener('toggle', onFold)); bud?.removeEventListener('change', saveBud); sto?.removeEventListener('change', saveSto); ep?.removeEventListener('submit', onEp); card?.removeEventListener('submit', onCard); };
}

async function click(ctx, e, t) {
  let b;
  if ((b = t.closest('[data-tgl]'))) {
    const id = b.dataset.tgl, on = b.getAttribute('aria-checked') !== 'true';
    if (id === 'officialMutes') return put(ctx, { officialMutes: on }, on ? 'Official mute list on.' : 'Official mute list off.');
    const patch = { [id]: on };
    if (id === 'agentPosting' && !on) patch.agentReplies = false;
    return put(ctx, { agent: patch }, id === 'agentPosting' ? (on ? 'Your agent may now post to your channel.' : 'Your agent can no longer post.') : 'Saved.');
  }
  if ((b = t.closest('[data-prof]'))) return put(ctx, { profile: b.dataset.prof }, `Profile set to ${cap(b.dataset.prof)}.`);
  if ((b = t.closest('[data-rmep]'))) return put(ctx, { endpoint: { id: b.dataset.rmep, remove: true } }, 'Endpoint removed.');
  if ((b = t.closest('[data-mv]'))) return put(ctx, { moveEndpoint: { id: b.dataset.mv, by: +b.dataset.by } });
  if ((b = t.closest('[data-settheme]'))) { const v = b.dataset.settheme; ctx.setTheme(v === 'system' ? null : v); ctx.api.putSettings({ theme: v }).catch(() => {}); ctx.rerender(); return; }
  if ((b = t.closest('[data-unf]'))) { try { await ctx.api.follow(b.dataset.unf, false); ctx.invalidate('feed:', 'directory'); ctx.reload(); } catch (x) { ctx.toast(/** @type {Error} */ (x).message, true); } return; }
  if ((b = t.closest('[data-unmute]'))) { try { await ctx.api.mute(b.dataset.unmute, false); ctx.invalidate('feed:', 'directory'); ctx.toast('Unmuted.'); ctx.reload(); } catch (x) { ctx.toast(/** @type {Error} */ (x).message, true); } }
}

export default { load, html, mount, click };
