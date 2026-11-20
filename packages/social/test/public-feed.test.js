import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import { createMemoryHub, MemoryTransport } from '@gator/net';
import { Social } from '../src/index.js';
import { DAY, HOUR } from '../src/policy.js';
import { fixture } from './fixture.js';

const latest = social => social.timeline({ scope: 'latest' });
const owner = peer => 'soc/u/' + peer.publicKey;
const post = (peer, text, overrides) => peer.envelope(owner(peer), { t: 'post', v: 1, text }, overrides);
const share = (sender, original) => sender.deliver(sender.envelope('soc/all', { t: 'share', v: 1, original }));
const shares = hub => hub.envelopes.filter(e => e.message.t === 'share');
function clock(t, hub) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return async ms => { hub.now += ms; t.mock.timers.tick(ms); await turn(); };
}

test('post mirrors its exact signed envelope, replays both slots daily and survives a failed public send', async t => {
  const { peer, hub } = await fixture(t);
  const a = await peer(), b = await peer();
  assert.ok(await a.social.post('First signed post'));
  const original = hub.envelopes.find(e => e.message.t === 'post');
  const [wrapper] = shares(hub);
  assert.equal(wrapper.channel, 'soc/all');
  assert.deepEqual(wrapper.message.original, original);
  assert.equal(latest(b.social)[0].id, original.id);
  assert.deepEqual(b.social.timeline(), []);
  const outbox = a.db.prepare('SELECT slot,envelope FROM social_outbox ORDER BY slot');
  assert.deepEqual(outbox.all().map(r => [r.slot, JSON.parse(r.envelope)]),
    [['post/' + original.id, original], ['share/' + original.id, wrapper]]);
  hub.now += DAY;
  await a.social.maintain();
  assert.deepEqual(hub.resends, [original, wrapper]);
  hub.now += 6 * DAY + 1;
  await a.social.maintain();
  assert.deepEqual(outbox.all(), []);
  const send = a.net.send.bind(a.net);
  for (const [text, failure] of [['Refused', () => false], ['Offline', () => { throw new Error('offline'); }]]) {
    a.net.send = (channel, message) => channel === 'soc/all' ? failure() : send(channel, message);
    assert.ok(await a.social.post(text));
  }
  assert.equal(outbox.all().length, 2);
  assert.ok(outbox.all().every(row => row.slot.startsWith('post/')));
});

test('shared posts use the original author for freshness, mutes, dedup, near-duplicates and rate', async t => {
  const { peer, hub } = await fixture(t);
  const b = await peer({ limits: { rates: { posts: 2 } } });
  const a = hub.peer(), other = hub.peer(), relay1 = hub.peer(), relay2 = hub.peer();
  const first = post(a, 'Prices are moving this morning');
  share(relay1, first);
  share(relay2, first);
  share(relay2, post(a, first.message.text + '!'));
  share(relay1, post(a, 'An independent update'));
  share(relay2, post(a, 'Over the author budget'));
  share(relay1, post(other, 'Stale original', { ts: hub.now - 30 * DAY - 1 }));
  share(relay1, post(other, 'Future original', { ts: hub.now + 300001 }));
  share(relay1, post(other, 'Boundary', { ts: hub.now - 30 * DAY }));
  const rows = latest(b.social);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.text), ['An independent update', first.message.text, 'Boundary']);
  assert.equal(rows[1].copies, 2);
  assert.deepEqual(b.db.prepare('SELECT DISTINCT inbound_lane FROM posts').all().map(r => r.inbound_lane), ['public']);
  b.social.mute(a.publicKey);
  const muted = post(a, 'Muted before receipt');
  hub.now += HOUR;
  share(relay1, muted);
  assert.deepEqual(latest(b.social).map(r => r.key), [other.publicKey]);
  b.social.unmute(a.publicKey);
  assert.ok(!latest(b.social).some(r => r.id === muted.id));
});

test('public receipt, row and byte limits protect followed and root history before strangers', async t => {
  const { peer, hub, root } = await fixture(t);
  const b = await peer({ limits: { laneRows: 4, laneBytes: 3500, laneRate: 3 } });
  const followed = hub.peer(), outsider = hub.peer(), forwarder = hub.peer();
  await b.social.follow(followed.publicKey);
  share(forwarder, post(followed, 'Followed'));
  share(forwarder, post(root, 'Root'));
  share(forwarder, post(outsider, 'Excess'));
  assert.deepEqual(new Set(latest(b.social).map(r => r.text)), new Set(['Followed', 'Root']));
  const admitted = b.db.prepare("SELECT count(*) n FROM social_inbound WHERE lane='public'");
  assert.equal(admitted.get().n, 3);
  share(forwarder, post(root, 'Over the global rate'));
  assert.equal(admitted.get().n, 3);
  assert.equal(latest(b.social).length, 2);
  hub.now += 600000;
  share(forwarder, post(root, 'New window'));
  assert.ok(latest(b.social).some(r => r.text === 'New window'));
  assert.equal(admitted.get().n, 1);
  const usage = b.db.prepare("SELECT n,bytes FROM social_lane_usage WHERE lane='public'").get();
  assert.ok(usage.n <= 4 && usage.bytes <= 3500);
  const tiny = await peer({ limits: { laneBytes: 500 } });
  share(forwarder, post(outsider, 'A post exceeding this local byte budget'));
  assert.deepEqual(latest(tiny.social), []);
  assert.ok(tiny.db.prepare("SELECT bytes FROM social_lane_usage WHERE lane='public'").get().bytes <= 500);
});

test('Latest includes visible posts and reposts across lanes, with Following row shape and stable ties', async t => {
  const { peer, hub, root } = await fixture(t);
  const a = await peer(), b = await peer();
  await b.social.follow(a.key);
  await a.social.post('Followed');
  const [known] = b.social.timeline();
  assert.deepEqual(latest(b.social), [known]);
  await b.social.post('Mine');
  await b.social.reply(known, 'Reply outside Latest');
  await b.social.repost(known);
  const stranger = hub.peer();
  share(stranger, post(stranger, 'Public only'));
  const product = 'soc/p/gator';
  root.deliver(root.envelope(product, { t: 'post', v: 1, text: 'Product' }));
  root.deliver(root.envelope('soc/official', { t: 'notice', v: 1, text: 'Notice outside Latest' }));
  hub.now++;
  await a.social.post('Newest');
  const all = latest(b.social);
  assert.equal(all.length, 6);
  assert.equal(all[0].text, 'Newest');
  assert.ok(all.some(r => r.t === 'repost') && all.some(r => r.channel === product));
  assert.ok(all.every(r => ['post', 'repost'].includes(r.t)));
  const pages = [];
  while (pages.length < all.length) {
    const batch = b.social.timeline({ scope: 'latest', limit: 2, before: pages.at(-1) });
    assert.equal(batch.length, 2);
    pages.push(...batch);
  }
  assert.deepEqual(pages, all);
  assert.deepEqual(b.social.timeline({ scope: 'latest', before: hub.now }), all.slice(1));
  b.social.mute(a.key);
  assert.deepEqual(new Set(latest(b.social).map(r => r.text)), new Set(['Mine', 'Public only', 'Product']));
});

test('a peer subscribed only to legacy channels exchanges ordinary owner posts in both directions', async t => {
  const { peer, hub } = await fixture(t);
  const modern = await peer(), legacy = hub.peer();
  const policy = key => ({ verifySignature: true, ownerWriteOnly: true, ownerKey: key, maxReceiveBytes: 4096 });
  await legacy.join(owner(legacy), policy(legacy.publicKey));
  await legacy.join(owner(modern.net), policy(modern.key));
  assert.ok(await modern.social.follow(legacy.publicKey));
  const heard = [];
  legacy.on('message', (_, e) => heard.push(e));
  assert.ok(await modern.social.post('New author'));
  assert.equal(heard.length, 1);
  assert.deepEqual(heard[0].message, { t: 'post', v: 1, text: 'New author' });
  assert.deepEqual(shares(hub).at(-1).message.original, heard[0]);
  assert.ok(legacy.send(owner(legacy), { t: 'post', v: 1, text: 'Old author' }));
  assert.ok(modern.social.timeline().some(p => p.key === legacy.publicKey && p.text === 'Old author'));
  assert.ok(!legacy.channels().includes('soc/all'));
});

test('a want elicits at most 20 recent visible owner posts, with durable want and answer cooldowns', async t => {
  const { peer, hub, root } = await fixture(t);
  const advance = clock(t, hub);
  t.mock.method(Math, 'random', () => 0);
  const generous = { limits: { rates: { posts: 100 } } };
  const a = await peer(generous), muted = hub.peer(), old = hub.peer();
  share(old, post(old, 'Older than a week', { ts: hub.now - 7 * DAY - 1 }));
  const expected = [];
  for (let i = 0; i < 25; i++) {
    hub.now++;
    assert.ok(await a.social.post('Story ' + i));
    expected.unshift(shares(hub).at(-1).message.original.id);
  }
  share(muted, post(muted, 'Muted before catch-up'));
  a.social.mute(muted.publicKey);
  root.deliver(root.envelope('soc/p/gator', { t: 'post', v: 1, text: 'Root product on a different lane' }));
  const start = shares(hub).length;
  const b = await peer(generous);
  const wants = () => hub.envelopes.filter(e => e.from === b.key && e.message.t === 'want').length;
  assert.equal(wants(), 1);
  assert.deepEqual(latest(b.social), []);
  const ask = body => b.net.send('soc/all', { t: 'want', v: 1, ...body });
  ask({});
  await advance(1999);
  assert.equal(shares(hub).length, start);
  await advance(1);
  assert.deepEqual(shares(hub).slice(start).map(e => e.message.original.id), expected.slice(0, 20));
  assert.deepEqual(latest(b.social).map(r => r.id), expected.slice(0, 20));
  assert.deepEqual(b.social.timeline(), []);
  await a.social.close();
  a.social = new Social(a.args);
  await a.social.ready;
  await b.social.close();
  b.social = new Social(b.args);
  await b.social.ready;
  assert.equal(wants(), 2, 'only the explicit extra want; restart did not send another');
  const lastTs = latest(b.social)[0].ts;
  await advance(600000 - 1);
  ask({});
  await advance(2000);
  assert.equal(shares(hub).length, start + 20);
  ask({ since: lastTs });
  await advance(2000);
  assert.deepEqual(shares(hub).slice(start + 20).map(e => e.message.original.id), expected.slice(0, 1));
  await advance(30 * 60000);
  const before = wants();
  await b.social.close();
  b.social = new Social(b.args);
  await b.social.ready;
  assert.equal(wants(), before + 1);
});

test('three holders suppress shares heard after the same want, including shares in its arrival millisecond', async t => {
  const { peer, hub } = await fixture(t);
  const advance = clock(t, hub);
  const holders = [await peer(), await peer(), await peer()];
  await advance(12001); // All outstanding startup requests have completed with no posts.
  const author = hub.peer(), originals = ['A', 'B', 'C', 'D'].map(text => post(author, text));
  for (const e of originals) share(author, e);
  for (const p of holders) assert.equal(latest(p.social).length, originals.length);
  const start = shares(hub).length;
  const delays = [0, 0.5, 0.9999];
  t.mock.method(Math, 'random', () => delays.shift() ?? 0);
  const b = await peer();
  // Immediately after the want, one original arrives again on the public lane.
  share(author, originals[0]);
  await advance(2000);
  await advance(5000);
  await advance(5000);
  const answers = shares(hub).slice(start);
  assert.equal(answers.length, originals.length - 1);
  assert.deepEqual(new Set(answers.map(e => e.message.original.id)), new Set(originals.slice(1).map(e => e.id)));
  assert.deepEqual(new Set(latest(b.social).map(r => r.id)), new Set(originals.map(e => e.id)));
  assert.ok(answers.every(e => e.from !== author.publicKey && e.message.original.from === author.publicKey));
  for (const p of [...holders, b]) {
    assert.equal(p.db.prepare("SELECT count(*) n FROM social_outbox WHERE slot LIKE 'share/%'").get().n, 0);
  }
});

test('catch-up on the native memory transport reaches a late peer with real signatures and PoW', async t => {
  const { peer, root } = await fixture(t);
  const hub = createMemoryHub();
  const native = () => new MemoryTransport({ hub, rootKey: root.publicKey });
  const a = await peer({ clock: Date.now }, native());
  assert.ok(await a.social.post('Published before the second node joined'));
  const original = latest(a.social)[0];
  const b = await peer({ clock: Date.now }, native());
  const deadline = Date.now() + 20000;
  while (!latest(b.social).length && Date.now() < deadline) await delay(50);
  assert.equal(latest(b.social)[0]?.id, original.id);
  assert.deepEqual(b.social.timeline(), []);
});

test('agent Latest contains the newest 50 and replay pruning keeps exactly 100 share/post pairs', async t => {
  const { peer, hub, dir } = await fixture(t);
  const a = await peer({ limits: { rates: { posts: 100 } } });
  for (let i = 0; i < 101; i++) {
    hub.now += i === 100 ? HOUR : 1;
    assert.ok(await a.social.post('Item ' + i));
  }
  await a.social.maintain();
  const slots = prefix => a.db.prepare('SELECT slot FROM social_outbox WHERE slot LIKE ? ORDER BY slot')
    .all(prefix + '/%').map(r => r.slot.slice(prefix.length + 1));
  assert.equal(slots('post').length, 100);
  assert.deepEqual(slots('share'), slots('post'));
  await a.social.writeAgentFiles(dir);
  const file = await readFile(join(dir, 'social', 'latest.md'), 'utf8');
  const rows = file.split('\n').filter(line => line.startsWith('> '));
  assert.equal(rows.length, 50);
  assert.match(rows[0], /Item 100$/);
  assert.match(rows.at(-1), /Item 51$/);
});
