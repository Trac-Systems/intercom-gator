import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile, readdir, mkdir, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Social, migrations, AGENT_HEADER } from '../src/index.js';
import { DAY, HOUR } from '../src/policy.js';
import { Hub } from './hub.js';

const msg = (t, body) => ({ t, v: 1, ...body });
const card = (handle, extra) => ({ handle, harnesses: ['dex'], ...extra });
async function fixture(t) {
  const hub = new Hub();
  const root = hub.peer();
  const dir = await mkdtemp(join(import.meta.dirname, 'scratch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const peers = [];
  t.after(async () => {
    for (const p of peers) { await p.social.close(); await p.net.close(); p.db.close(); }
  });
  async function peer(opts = {}, net = hub.peer()) {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    for (const m of migrations) m.up(db);
    const args = { transport: net, db, rootKey: root.publicKey, dataDir: join(dir, net.publicKey),
      clock: () => hub.now, proofs: false, ...opts };
    const social = new Social(args);
    await social.ready;
    const p = { social, net, db, key: net.publicKey, args };
    peers.push(p);
    return p;
  }
  return { hub, root, dir, peer };
}

test('profile discovery, subscriptions, posts, cross-channel interactions and unfollow', async t => {
  const { hub, peer } = await fixture(t);
  const a = await peer(), b = await peer({ product: ['dex', 'dmw'] }), c = await peer();
  assert.equal(b.net.channels().length, 8);
  assert.equal(b.net.policies.get('soc/dir').powDifficulty, 16);
  assert.equal(b.net.policies.get('soc/r/' + b.key).powDifficulty, 12);
  assert.equal(b.net.policies.get('soc/u/' + b.key).ownerKey, b.key);
  await a.social.setCard(card('atlas', { name: 'Atlas Smith', bio: 'Market news' }), { topics: ['market'] });
  await b.social.setCard(card('bea'));
  await c.social.setCard(card('curator'));
  assert.equal(b.social.directory({ q: 'SMITH' })[0].key, a.key);
  assert.equal(b.social.timeline({ scope: 'directory' }).length, 3);
  assert.ok(await b.social.follow(a.key));
  assert.equal(await b.social.follow(a.key), false);
  assert.equal(b.social.profile(a.key).following, true);
  await c.social.follow(b.key);
  const mentions = [];
  c.social.on('mention', row => mentions.push(row));
  assert.ok(await a.social.post('Observing $eth #markets with @curator.'));
  const [post] = b.social.timeline();
  assert.ok(post && post.key === a.key);
  assert.deepEqual(post.tags, ['markets']);
  assert.deepEqual(post.tickers, [{ sym: 'ETH' }]);
  assert.deepEqual(mentions.map(p => p.id), [post.id]);
  assert.equal(c.social.timeline({ scope: 'mentions' })[0].id, post.id);
  assert.equal(c.social.timeline().length, 0);
  hub.now++;
  assert.ok(await b.social.reply(post.id, 'What was the opening price?'));
  const [reply] = a.social.timeline({ scope: 'mentions' });
  assert.equal(c.social.timeline()[0].id, reply.id);
  assert.equal(a.social.thread(reply.id)[0].id, post.id);
  assert.equal(a.social.thread(post.id)[1].parent.id, post.id);
  assert.ok(await b.social.like(post.id));
  assert.ok(await b.social.like(post.id));
  assert.ok(await b.social.repost(post.id));
  assert.equal(c.social.timeline().find(p => p.t === 'repost').original.id, post.id);
  assert.deepEqual(a.social.counts(post.id), { likes: 1, replies: 1, reposts: 1 });
  assert.deepEqual(b.social.counts(post.id), a.social.counts(post.id));
  assert.ok(await b.social.unfollow(a.key));
  assert.ok(!b.net.channels().includes('soc/u/' + a.key));
  assert.ok(b.net.channels().includes('soc/official'));
  assert.ok(b.social.timeline().every(row => row.key === b.key));
  assert.equal(b.social.timeline({ scope: 'profile', key: a.key, before: hub.now, limit: 1 })[0].id, post.id);
});

test('ingress validates genuine Intercom signatures, lane ownership, sizes, times, and official notice schema', async t => {
  const { hub, root, peer } = await fixture(t);
  const a = await peer({}, root), b = await peer(), outsider = hub.peer();
  let notices = 0;
  b.social.on('notice', () => notices++);
  const good = root.envelope('soc/official', msg('notice', { text: 'Release published', severity: 'info' }));
  const inject = (e, lane = e.channel) => b.net.emit('message', lane, e);
  inject({ ...good, message: { ...good.message, text: 'tampered' } });
  inject(outsider.envelope('soc/official', good.message, { from: root.publicKey }));
  inject(outsider.envelope('soc/official', good.message));
  inject(root.envelope('soc/official', { ...good.message, paid: true }));
  inject(root.envelope('soc/official', msg('post', { text: 'Sponsored' })));
  inject(root.envelope('soc/official', good.message, { ts: hub.now + HOUR }));
  inject(root.envelope('soc/official', good.message, { padding: 'a'.repeat(4400) }));
  inject(good, 'soc/dir');
  inject(root.envelope('soc/dir', msg('announce', { card: card('fake'), topics: [], channel: 'soc/u/' + b.key })));
  assert.equal(b.social.directory().length, 0);
  assert.equal(notices, 0);
  inject(good);
  inject(good);
  assert.equal(notices, 1);
  assert.equal(b.social.timeline({ scope: 'official' })[0].copies, 2);
  assert.equal(a.net.send('soc/p/gator', msg('post', { text: 'Product release' })), true);
  assert.equal(b.social.timeline({ scope: 'official' }).length, 1);
  assert.ok(await b.social.reply(b.social.timeline().find(p => p.text === 'Product release').id, 'How do I upgrade?'));
  assert.ok(hub.envelopes.some(e => e.channel === 'soc/pr/gator' && e.message.t === 'reply'));
});

test('per-author budgets and near-duplicate checks survive replay, concurrent sends and restart', async t => {
  const { hub, peer } = await fixture(t);
  const a = await peer(), b = await peer({ limits: { rates: { posts: 2, likes: 1 }, windowMs: 1000, nearDuplicateMs: 1000 } });
  await b.social.follow(a.key);
  const post = text => a.net.send('soc/u/' + a.key, msg('post', { text }));
  post('The price of this asset reached a new local high today.');
  post('The price of this asset reached a new local high today!!!');
  post('The price of this asset reached a new local high today!');
  post('Volume increased.');
  post('An extra post.');
  assert.equal(b.social.timeline().length, 2);
  const first = hub.envelopes.find(e => e.message.t === 'post');
  hub.now += 1100;
  a.net.rebroadcast(first);
  assert.equal(b.social.timeline().find(row => row.id === first.id).copies, 2);
  post('An extra post.');
  assert.equal(b.social.timeline().length, 3);
  const sent = await Promise.all(['alpha', 'beta', 'gamma'].map(s => b.social.post(s)));
  assert.deepEqual(sent, [true, true, false]);
  const target = { key: a.key, id: first.id };
  const [ref] = b.social.timeline({ scope: 'profile', key: b.key });
  assert.ok(await b.social.like(target));
  assert.equal(await b.social.like({ key: b.key, id: ref.id }), false);
  await b.social.close();
  b.social = new Social(b.args);
  await b.social.ready;
  assert.ok(b.net.channels().includes(first.channel));
  assert.equal(await b.social.post('delta'), false);
  assert.equal(b.social.profile(a.key), null);
  hub.now += DAY + 1;
  a.net.rebroadcast(first);
  assert.equal(b.social.timeline().find(row => row.id === first.id).copies, 3);
});

test('signed root settings take effect live and persist; owner and root mutes filter history and counts', async t => {
  const { root, peer } = await fixture(t);
  const admin = await peer({}, root), a = await peer(), b = await peer();
  await b.social.follow(a.key);
  const ctl = (type, body) => root.send('soc/official', msg(type, body));
  const settings = { seq: 8, pow: { reply: 200, directory: -5 }, caps: { reply: 99999, owner: -20 },
    rates: { posts: 3, likes: 500 }, relayTtl: 999 };
  assert.ok(ctl('net', settings));
  await b.social.follow(admin.key); // Wait for live channel reconfiguration.
  assert.equal(b.social.networkSettings().pow.reply, 16);
  assert.equal(b.net.policies.get('soc/u/' + a.key).maxReceiveBytes, 1024);
  assert.equal(b.net.policies.get('soc/dir').powDifficulty, 12);
  assert.equal(b.net.ttl, 8);
  ctl('net', { seq: 7, relayTtl: 2 });
  ctl('net', { seq: 99, rates: { unknown: 200 } });
  assert.equal(b.social.networkSettings().seq, 8);
  await a.social.setCard(card('author'));
  await a.social.post('Visible news.');
  assert.equal(b.social.timeline().length, 1);
  await b.social.post('My post.');
  const local = b.social.timeline({ scope: 'profile', key: b.key })[0];
  await a.social.like({ key: b.key, id: local.id });
  ctl('mutes', { seq: 3, add: [a.key], remove: [] });
  assert.equal(b.social.timeline().length, 1);
  assert.equal(b.social.counts(local.id).likes, 0);
  assert.equal(b.social.directory().length, 0);
  b.social.setUseRootMutes(false);
  assert.equal(b.social.timeline().length, 2);
  assert.equal(b.social.counts(local.id).likes, 1);
  b.social.mute(a.key);
  b.social.setUseRootMutes(true);
  ctl('mutes', { seq: 4, add: [], remove: [a.key] });
  ctl('mutes', { seq: 2, add: [a.key], remove: [] });
  assert.equal(b.social.profile(a.key).muted, true);
  b.social.unmute(a.key);
  assert.equal(b.social.profile(a.key).muted, false);
  await b.social.close();
  b.social = new Social(b.args);
  await b.social.ready;
  assert.equal(b.social.networkSettings().seq, 8);
  assert.equal(b.net.policies.get('soc/r/' + b.key).powDifficulty, 16);
});

test('signed outbox rebroadcast reaches late followers; files track arrivals, replace atomically and protect official', async t => {
  const { dir, root, hub, peer } = await fixture(t);
  const a = await peer(), admin = await peer({}, root);
  await a.social.setCard(card('atlas', { bio: 'Atlas & friends' }));
  await a.social.post('Earlier than subscription.');
  const first = hub.envelopes.find(e => e.message.t === 'post');
  const late = await peer();
  await late.social.follow(a.key);
  hub.now += 6 * HOUR;
  await a.social.maintain();
  assert.deepEqual(hub.resends.map(e => e.message.t), ['card']);
  assert.equal(late.social.profile(a.key).handle, 'atlas');
  await late.social.writeAgentFiles(dir);
  hub.now += 18 * HOUR;
  await a.social.maintain();
  assert.ok(hub.resends.some(e => e.id === first.id && e.sig === first.sig));
  assert.equal(late.social.directory()[0].key, a.key);
  assert.equal(late.social.timeline()[0].ts, first.ts);
  root.send('soc/official', msg('notice', { text: 'Version two is ready' }));
  root.send('soc/official', msg('notice', { text: 'Paid placement', paid: true }));
  await late.social.writeAgentFiles(dir);
  const file = name => readFile(join(dir, 'social', name + '.md'), 'utf8');
  for (const name of ['following', 'mentions', 'directory', 'official']) assert.ok((await file(name)).startsWith(AGENT_HEADER + '\n'));
  assert.match(await file('following'), /\[NEW\].*Earlier than subscription/);
  assert.match(await file('directory'), /\[NEW\].*@atlas/);
  assert.match(await file('official'), /\[NEW\].*Version two/);
  assert.doesNotMatch(await file('official'), /Paid placement|Earlier than subscription/);
  await late.social.writeAgentFiles(dir);
  assert.doesNotMatch(await file('following'), /\[NEW\]/);
  assert.equal((await readdir(join(dir, 'social'))).length, 4);
  assert.ok(admin.social.timeline({ scope: 'official' }).length);
});

test('small, normal and large profiles cap concurrent follows and preserve state after failed joins', async t => {
  const { peer } = await fixture(t);
  for (const [profile, cap] of Object.entries({ small: 100, normal: 200, large: 200 })) {
    const a = await peer({ limits: { profile } });
    const keys = Array.from({ length: cap + 1 }, (_, i) => i.toString(16).padStart(64, '0'));
    const join = a.net.join.bind(a.net);
    a.net.join = async () => false;
    await assert.rejects(a.social.follow(keys[0]), /join failed/);
    assert.equal(a.db.prepare('SELECT count(*) n FROM follows').get().n, 0);
    a.net.join = join;
    const outcomes = await Promise.allSettled(keys.map(k => a.social.follow(k)));
    assert.equal(outcomes.filter(r => r.status === 'fulfilled' && r.value).length, cap);
    assert.match(outcomes.at(-1).reason.message, /cap/);
    assert.equal(a.net.channels().length, cap + 6);
    await a.social.unfollow(keys[0]);
    await a.social.follow(keys.at(-1));
    assert.equal(a.net.channels().length, cap + 6);
  }
});

test('directory is bounded, older signed cards never replace new ones and unchanged cards survive 30 days', async t => {
  const { hub, peer } = await fixture(t);
  const viewer = await peer({ limits: { directoryCap: 2 } });
  const a = await peer(), b = await peer(), c = await peer();
  await a.social.setCard(card('atlas'));
  const old = hub.envelopes.find(e => e.message.t === 'announce' && e.from === a.key);
  hub.now++;
  await a.social.setCard(card('atlas2'));
  hub.now++;
  await b.social.setCard(card('bravo'));
  hub.now++;
  await c.social.setCard(card('charlie'));
  assert.deepEqual(viewer.social.directory().map(row => row.handle), ['charlie', 'bravo']);
  assert.equal(viewer.social.profile(a.key), null);
  assert.equal(a.social.profile(a.key).handle, 'atlas2');
  hub.now += 35 * DAY;
  const late = await peer();
  await late.social.follow(a.key);
  await a.social.maintain();
  assert.equal(late.social.profile(a.key).handle, 'atlas2');
  assert.deepEqual(late.social.directory().map(r => r.handle), ['atlas2']);
  a.net.deliver(old);
  assert.equal(late.social.profile(a.key).handle, 'atlas2');
});

test('proofs verify TXT chunks and public gists owned by the claimed account; stale results cannot badge a new claim', async t => {
  const { hub, peer } = await fixture(t);
  const a = await peer();
  const requests = [];
  let resolveOld, started;
  const checking = new Promise(r => { started = r; });
  let gistOwner = 'alice';
  const opts = { proofs: {
    async resolveTxt(domain) {
      if (domain === 'old.example') {
        started();
        return new Promise(r => { resolveOld = r; });
      }
      return domain === 'valid.example' ? [['intercom-', 'gator=' + a.key]] : [['other']];
    },
    async fetch(url, options) {
      assert.equal(options.redirect, 'error');
      const path = new URL(url);
      assert.equal(path.origin, 'https://api.github.com');
      requests.push(path.pathname);
      const gist = { id: 'cafe', public: true, owner: { login: gistOwner } };
      return Response.json(path.pathname.startsWith('/users/') ? [gist] :
        { ...gist, files: { 'proof.txt': { content: 'intercom-gator=' + a.key } } });
    }
  } };
  const observer = await peer(opts);
  await observer.social.follow(a.key);
  await a.social.setCard(card('atlas', { proofs: { dns: 'old.example' } }));
  await checking;
  hub.now++;
  await a.social.setCard(card('atlas', { proofs: { dns: 'invalid.example' } }));
  resolveOld([['intercom-gator=' + a.key]]);
  assert.deepEqual(await observer.social.verifyProofs(a.key), { dns: false });
  assert.equal(observer.social.profile(a.key).verified, false);
  hub.now++;
  await a.social.setCard(card('atlas', { proofs: { dns: 'valid.example', github: 'alice' } }));
  assert.deepEqual(await observer.social.verifyProofs(a.key), { dns: true, github: true });
  assert.ok(observer.social.profile(a.key).verified);
  assert.deepEqual(new Set(requests), new Set(['/users/alice/gists', '/gists/cafe']));
  gistOwner = 'somebody-else';
  assert.deepEqual(await observer.social.verifyProofs(a.key), { dns: true, github: false });
  hub.now++;
  await a.social.setCard(card('atlas'));
  assert.equal(observer.social.profile(a.key).verified, false);
});

test('agent files contain only the newest 100, safely quote multiline text, and checkpoint only completed writes', async t => {
  const { dir, root, hub, peer } = await fixture(t);
  const admin = await peer({}, root);
  for (let i = 0; i < 106; i++) {
    const e = root.envelope('soc/official', msg('notice', { text: 'Item ' + i }), { id: 'n' + String(i).padStart(3, '0') });
    root.deliver(e);
  }
  const page = admin.social.timeline({ scope: 'official', limit: 100 });
  const tail = admin.social.timeline({ scope: 'official', limit: 100, before: page.at(-1) });
  assert.equal(page.length, 100);
  assert.equal(tail.length, 6);
  assert.equal(tail[0].text, 'Item 5');
  await admin.social.writeAgentFiles(dir);
  const official = join(dir, 'social', 'official.md');
  const contents = await readFile(official, 'utf8');
  assert.equal(contents.match(/^> /gm).length, 100);
  assert.equal(contents.match(/\[NEW\]/g).length, 100);
  assert.ok(contents.indexOf('Item 105') < contents.indexOf('Item 104'));
  assert.doesNotMatch(contents, / — Item 5$/m);
  hub.now++;
  root.send('soc/official', msg('notice', { text: 'First line\n# fake heading\n<fake>' }));
  const lastPath = join(dir, 'social', 'directory.md');
  await unlink(lastPath);
  await mkdir(lastPath);
  await assert.rejects(admin.social.writeAgentFiles(dir));
  await rmdir(lastPath);
  await admin.social.writeAgentFiles(dir);
  const recovered = await readFile(official, 'utf8');
  assert.match(recovered, /\[NEW\].*First line \\# fake heading \\<fake\\>/);
  assert.equal(recovered.match(/\[NEW\]/g).length, 1);
  assert.deepEqual((await readdir(join(dir, 'social'))).sort(), ['directory.md', 'following.md', 'mentions.md', 'official.md']);
});

test('reposts authenticate embedded originals, explicit quotes and nested reply references survive lane copies', async t => {
  const { hub, peer } = await fixture(t);
  const a = await peer(), b = await peer(), c = await peer();
  await b.social.follow(a.key);
  await c.social.follow(a.key);
  await a.social.post('First story.');
  const first = b.social.timeline()[0];
  await b.social.post('My take on this.', { quote: { key: first.key, id: first.id } });
  assert.equal(b.social.timeline({ scope: 'profile', key: b.key })[0].quote.id, first.id);
  await b.social.reply(first, 'Another observation.');
  const reply = a.social.thread(first).find(p => p.t === 'reply');
  assert.ok(await a.social.repost(reply));
  assert.equal(c.social.timeline().find(p => p.t === 'repost').original.message.text, reply.text);
  const canonical = hub.envelopes.find(e => e.id === first.id);
  const forged = a.net.envelope('soc/u/' + a.key, msg('repost', { target: { key: a.key, id: first.id },
    original: { ...canonical, message: msg('post', { text: 'Unwitnessed replacement' }) } }));
  a.net.deliver(forged);
  assert.equal(c.social.timeline().filter(p => p.t === 'repost').length, 1);
  const evilMention = a.net.envelope('soc/r/' + c.key, msg('mention', { original: canonical }));
  a.net.deliver(evilMention);
  assert.deepEqual(c.social.timeline({ scope: 'mentions' }), []);
});

test('maintenance expires ordinary history while retaining official notices and handles unsupported rebroadcast', async t => {
  const { hub, peer, root } = await fixture(t);
  const a = await peer(), admin = await peer({}, root);
  await a.social.setCard(card('atlas'));
  await a.social.post('Temporary post');
  root.send('soc/official', msg('notice', { text: 'Permanent notice' }));
  hub.now += 31 * DAY;
  a.net.rebroadcast = () => false;
  await a.social.maintain();
  assert.deepEqual(a.social.timeline().map(p => p.text), ['Permanent notice']);
  assert.equal(a.db.prepare("SELECT count(*) n FROM social_outbox WHERE slot LIKE 'post/%'").get().n, 0);
  assert.equal(a.db.prepare('SELECT count(*) n FROM social_seen').get().n, 0);
  assert.ok(admin.social.timeline({ scope: 'official' }).length);
});

test('a lowered machine profile restores only the active cap and retains saved subscriptions', async t => {
  const { peer } = await fixture(t);
  const a = await peer({ limits: { profile: 'large' } });
  const keys = Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(64, '0'));
  await Promise.all(keys.map(key => a.social.follow(key)));
  await a.social.close();
  a.social = new Social({ ...a.args, limits: { profile: 'small' } });
  await a.social.ready;
  assert.equal(a.net.channels().length, 106);
  assert.ok(!a.net.channels().includes('soc/u/' + keys[100]));
  assert.equal(a.db.prepare('SELECT count(*) n FROM follows').get().n, 101);
  await a.social.unfollow(keys[0]);
  assert.ok(a.net.channels().includes('soc/u/' + keys[100]));
  assert.equal(a.net.channels().length, 106);
});

test('signed echoes share one canonical reply and reject conflicting contents and extra envelope ids', async t => {
  const { hub, peer } = await fixture(t);
  const a = await peer(), b = await peer();
  await a.social.follow(b.key);
  await a.social.post('Originating story.');
  const parent = a.social.timeline()[0];
  await b.social.reply({ key: a.key, id: parent.id }, 'A measured response.');
  const echo = hub.envelopes.find(e => e.channel === 'soc/r/' + a.key && e.message.t === 'reply');
  const original = a.social.thread(parent.id).find(row => row.t === 'reply');
  assert.equal(original.copies, 2);
  for (let i = 0; i < 8; i++) b.net.deliver(b.net.envelope(echo.channel, { ...echo.message, text: i % 2 ? echo.message.text : 'Different body.' }));
  const after = a.social.thread(parent.id).find(row => row.t === 'reply');
  assert.equal(after.copies, 2);
  assert.equal(after.text, original.text);
  assert.equal(a.social.counts(parent.id).replies, 1);
  b.net.rebroadcast(echo);
  assert.equal(a.social.thread(parent.id).find(row => row.t === 'reply').copies, 3);
});

test('store handle uses WAL reader and writer, registers pruning and releases only social resources', async t => {
  const dir = await mkdtemp(join(import.meta.dirname, 'wal-'));
  const filename = join(dir, 'peer.db');
  const writer = new DatabaseSync(filename);
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
  for (const m of migrations) m.up(writer);
  const reader = new DatabaseSync(filename, { readOnly: true });
  let prune;
  const db = { writer, reader, profile: 'small',
    onPrune(fn) { prune = fn; return () => { prune = null; }; },
    transaction(fn) {
      writer.exec('BEGIN IMMEDIATE');
      try { const result = fn(writer); writer.exec('COMMIT'); return result; }
      catch (err) { writer.exec('ROLLBACK'); throw err; }
    }
  };
  const hub = new Hub(), net = hub.peer();
  await net.join('host-owned', {});
  const social = new Social({ db, transport: net, dataDir: dir, rootKey: net.publicKey, clock: () => hub.now, proofs: false });
  t.after(async () => {
    await social.close();
    reader.close();
    writer.close();
    await rm(dir, { recursive: true, force: true });
  });
  await social.ready;
  assert.equal(social.followCap, 100);
  await social.setCard(card('reader'));
  await social.post('Signed and committed.');
  assert.equal(social.timeline()[0].handle, 'reader');
  assert.equal(reader.prepare('SELECT count(*) n FROM posts').get().n, 1);
  db.transaction(() => prune(writer, { now: hub.now + 31 * DAY }));
  assert.deepEqual(social.timeline(), []);
  await social.close();
  assert.deepEqual(net.channels(), ['host-owned']);
  assert.equal(prune, null);
  assert.equal(reader.prepare('SELECT count(*) n FROM profiles').get().n, 1);
});

test('hourly scheduler publishes snapshots and stops on close', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { peer, hub } = await fixture(t);
  const a = await peer();
  await a.social.post('Scheduled snapshot.');
  hub.now += HOUR;
  t.mock.timers.tick(HOUR);
  await a.social.follow('1'.repeat(64)); // Queued after the actual maintenance callback.
  const path = join(a.args.dataDir, 'agent', 'social', 'following.md');
  assert.match(await readFile(path, 'utf8'), /\[NEW\].*Scheduled snapshot/);
  await a.social.close();
  await unlink(path);
  t.mock.timers.tick(2 * HOUR);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('follow persistence failures restore transport membership in both directions', async t => {
  const { peer } = await fixture(t);
  const a = await peer(), b = await peer();
  const channel = 'soc/u/' + b.key;
  a.db.exec("CREATE TRIGGER reject_follow BEFORE INSERT ON follows BEGIN SELECT RAISE(ABORT,'cannot persist'); END");
  await assert.rejects(a.social.follow(b.key), /cannot persist/);
  assert.ok(!a.net.channels().includes(channel));
  a.db.exec('DROP TRIGGER reject_follow');
  await a.social.follow(b.key);
  a.db.exec("CREATE TRIGGER reject_unfollow BEFORE DELETE ON follows BEGIN SELECT RAISE(ABORT,'cannot persist'); END");
  await assert.rejects(a.social.unfollow(b.key), /cannot persist/);
  assert.ok(a.net.channels().includes(channel));
  assert.equal(a.db.prepare('SELECT count(*) n FROM follows').get().n, 1);
});

test('ambiguous outgoing handles prefer followed, then verified keys and leave ties unresolved', async t => {
  const { peer } = await fixture(t);
  const local = await peer(), a = await peer(), b = await peer();
  await a.social.setCard(card('shared'));
  await b.social.setCard(card('shared'));
  assert.equal(local.social.resolveHandle('shared'), null);
  local.db.prepare('UPDATE profiles SET verified=? WHERE key=?').run(JSON.stringify({ dns: true }), b.key);
  assert.equal(local.social.resolveHandle('shared'), b.key);
  await local.social.follow(a.key);
  assert.equal(local.social.resolveHandle('shared'), a.key);
  await local.social.follow(b.key);
  assert.equal(local.social.resolveHandle('shared'), b.key);
  await local.social.post('hello @shared');
  assert.equal(b.social.timeline({ scope: 'mentions' }).length, 0); // sender has no card yet
});

test('proof requests share a rolling hourly budget and honor GitHub cooldown across restarts', async t => {
  const { hub, peer } = await fixture(t);
  const a = await peer(), b = await peer();
  let calls = 0, github = 0;
  const view = await peer({ proofs: {
    resolveTxt: async () => { calls++; return []; },
    fetch: async url => {
      calls++;
      github++;
      if (url.includes('/users/')) return Response.json([{ owner: { login: 'alice' }, public: true, id: 'ca' }]);
      return new Response(null, { status: 429, headers: { 'retry-after': '7200' } });
    }
  } });
  await a.social.setCard(card('atlas', { proofs: { github: 'alice' } }));
  await b.social.setCard(card('bravo', { proofs: { dns: 'test.example' } }));
  await view.social.verifyProofs(a.key);
  assert.equal(github, 2);
  for (let i = 0; i < 60; i++) await view.social.verifyProofs(b.key);
  assert.equal(calls, 60);
  await view.social.close();
  view.social = new Social(view.args);
  await view.social.ready;
  await view.social.verifyProofs(b.key);
  assert.equal(calls, 60);
  hub.now += HOUR;
  await view.social.verifyProofs(b.key);
  await view.social.verifyProofs(a.key);
  assert.equal(calls, 61);
  assert.equal(github, 2);
  hub.now += HOUR;
  await view.social.verifyProofs(a.key);
  assert.equal(github, 4);
});

test('root notices expire at the signed boundary and revocations survive reordered delivery and restart', async t => {
  const { hub, root, dir, peer } = await fixture(t);
  const observer = await peer(), stranger = hub.peer();
  const notice = (text, extra = {}, ts = hub.now) =>
    root.envelope('soc/official', msg('notice', { text, ...extra }), { ts });
  const revoke = (sender, id) => sender.deliver(sender.envelope('soc/official', msg('revoke', { id })));
  const timeline = () => observer.social.timeline({ scope: 'official' }).map(r => r.text);
  const old = notice('Archive', {}, hub.now - 7 * DAY - 1);
  const fresh = notice('Release', { expires: hub.now + 1000 });
  const withdrawn = notice('Withdrawn');
  const reordered = notice('Never shown');
  root.deliver(old);
  root.deliver(fresh);
  root.deliver(withdrawn);
  root.deliver(notice('Expired before arrival', { expires: hub.now }));
  root.deliver(notice('Invalid time', { expires: -5 }));
  revoke(stranger, fresh.id);
  assert.deepEqual(timeline(), ['Withdrawn', 'Release', 'Archive']);
  await observer.social.repost({ key: root.publicKey, id: withdrawn.id });
  revoke(root, withdrawn.id);
  revoke(root, reordered.id);
  await observer.social.writeAgentFiles(dir);
  const body = await readFile(join(dir, 'social', 'official.md'), 'utf8');
  assert.match(body, /\[NEW\].*Release/);
  assert.doesNotMatch(body, /\[NEW\].*Archive|Withdrawn/);
  assert.ok(observer.social.timeline().every(row => row.t !== 'repost'));
  hub.now += 1000;
  assert.deepEqual(timeline(), ['Archive']);
  assert.deepEqual(observer.social.thread({ key: root.publicKey, id: fresh.id }), []);
  await observer.social.close();
  observer.social = new Social(observer.args);
  await observer.social.ready;
  hub.now += 2 * DAY;
  for (const e of [withdrawn, reordered, fresh]) root.deliver(e);
  assert.deepEqual(timeline(), ['Archive']);
});

test('row and byte ceilings evict by local receipt and keep separate budgets for directory and owner traffic', async t => {
  const { hub, peer } = await fixture(t);
  const author = await peer();
  for (const limits of [{ laneRows: 4 }, { laneBytes: 2600 }]) {
    const viewer = await peer({ limits });
    await viewer.social.follow(author.key);
    const sent = [];
    for (const text of ['First receipt', 'Second receipt', 'Third receipt', 'Fourth receipt', 'Last receipt']) {
      hub.now++;
      const e = author.net.envelope('soc/u/' + author.key, msg('post', { text }), { ts: hub.now - sent.length * 100 });
      sent.push(e);
      author.net.deliver(e);
      const usage = viewer.db.prepare("SELECT n,bytes FROM social_lane_usage WHERE lane='owner'").get();
      assert.ok(usage.n <= viewer.social.limits.laneRows && usage.bytes <= viewer.social.limits.laneBytes);
    }
    const remaining = viewer.social.timeline({ scope: 'profile', key: author.key }).map(p => p.id);
    assert.ok(remaining.length > 0 && remaining.length < sent.length);
    assert.deepEqual(remaining, sent.slice(-remaining.length).map(e => e.id));
    const newcomer = await peer();
    await newcomer.social.setCard(card('newcomer'));
    assert.equal(viewer.social.directory({ q: 'newcomer' })[0].key, newcomer.key);
    assert.equal(viewer.social.timeline({ scope: 'profile', key: author.key }).length, remaining.length);
  }
});

test('the wire reply budget includes mention wrappers, persists across restarts and recovers at the window boundary', async t => {
  const { hub, peer } = await fixture(t);
  const viewer = await peer({ limits: { laneRate: 1, windowMs: 1000 } }), sender = await peer();
  await viewer.social.setCard(card('viewer'));
  await sender.social.setCard(card('sender'));
  await sender.social.post('hello @viewer');
  assert.equal(viewer.social.timeline({ scope: 'mentions' }).length, 1);
  assert.equal(viewer.db.prepare("SELECT inbound_lane FROM posts WHERE key=?").get(sender.key).inbound_lane, 'reply');
  await viewer.social.close();
  viewer.social = new Social(viewer.args);
  await viewer.social.ready;
  await sender.social.post('today @viewer');
  assert.equal(viewer.social.timeline({ scope: 'mentions' }).length, 1);
  hub.now += 1000;
  await sender.social.post('goodbye @viewer');
  assert.equal(viewer.social.timeline({ scope: 'mentions' }).length, 2);
});
