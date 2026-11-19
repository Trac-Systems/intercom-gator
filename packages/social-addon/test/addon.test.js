import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_HEADER } from '@gator/social';
import { POSTING_OFF, UNTRUSTED } from '../src/tools.js';
import { startAddon } from '../src/addon.js';
import { main } from '../src/cli.js';
import { socialClient } from '../src/client.js';
import { call, network, root, ROOT, until } from './helpers.js';

test('feed tools over MemoryTransport: profile, post, follow, reply, mentions, directory', async t => {
  const net = await network(t);
  const alice = await net.addon({ agentPosting: true });
  const bob = await net.addon({ agentPosting: true, product: 'reset' });
  const quiet = await net.addon();

  const card = await call(alice, 'profile', { set: { handle: 'alice', name: 'Alice', bio: 'DEX maker', topics: ['dex'] } });
  assert.equal(card.isError, false);
  assert.deepEqual(card.value.card, { handle: 'alice', name: 'Alice', bio: 'DEX maker', harnesses: ['dex'] });
  assert.deepEqual(JSON.parse(readFileSync(join(alice.status().dataDir, 'config.json'), 'utf8')).card, card.value.card);
  assert.equal((await call(bob, 'profile', { set: { handle: 'bob' } })).isError, false);

  const found = await until(async () => {
    const { value } = await call(bob, 'feed_read', { scope: 'directory', q: 'alice' });
    return value.accounts.find(a => a.key === alice.publicKey);
  });
  assert.equal(found.handle, 'alice');
  assert.equal(found.untrustedBio, 'DEX maker');
  assert.deepEqual(found.topics, ['dex']);
  const byHandle = await call(bob, 'profile', { handle: 'alice' });
  assert.equal(byHandle.value.profile.key, alice.publicKey);
  assert.equal(byHandle.value.you, false);
  assert.equal((await call(bob, 'profile', {})).value.profile.handle, 'bob');

  assert.deepEqual(await call(bob, 'follow', { key: alice.publicKey }), { value: { following: true, changed: true } });
  const posted = await call(alice, 'feed_post', { text: 'Tight $TNK spread tonight #dex, ask @bob' });
  assert.deepEqual(posted, { value: { sent: true }, isError: false });
  const seen = await until(async () => (await call(bob, 'feed_read', {})).value.posts.find(p => p.key === alice.publicKey));
  assert.equal(seen.untrustedText, 'Tight $TNK spread tonight #dex, ask @bob');
  assert.equal(seen.handle, 'alice');
  assert.deepEqual(seen.tickers, ['TNK']);
  assert.deepEqual(seen.tags, ['dex']);
  assert.equal('text' in seen, false);
  const read = await call(bob, 'feed_read', {});
  assert.equal(read.value.notice, UNTRUSTED);
  // The author sees the own post too (Swarm and Memory echo own sends).
  assert.equal((await call(alice, 'feed_read', { scope: 'profile' })).value.posts[0].own, true);
  // @bob in the text reaches bob's mentions lane.
  await until(async () => (await call(bob, 'feed_read', { scope: 'mentions' })).value.posts.some(p => p.id === seen.id));

  const replied = await call(bob, 'reply', { id: seen.id, text: 'Taking the other side.' });
  assert.equal(replied.isError, false);
  const mention = await until(async () => (await call(alice, 'feed_read', { scope: 'mentions' })).value.posts
    .find(p => p.key === bob.publicKey));
  assert.deepEqual(mention.parent, { key: alice.publicKey, id: seen.id });
  const thread = await call(alice, 'feed_read', { scope: 'thread', id: seen.id });
  assert.deepEqual(thread.value.posts.map(p => p.key), [alice.publicKey, bob.publicKey]);
  assert.equal((await call(alice, 'feed_read', { scope: 'thread' })).isError, true);

  // Posting tools are off unless the owner started with --agent-posting. Reading always works.
  for (const [name, args] of [['feed_post', { text: 'hi' }], ['reply', { id: seen.id, text: 'hi' }],
    ['follow', { key: alice.publicKey }], ['profile', { set: { handle: 'quiet' } }]]) {
    assert.deepEqual(await call(quiet, name, args), { value: { error: POSTING_OFF }, isError: true }, name);
  }
  assert.equal((await call(quiet, 'feed_read', { scope: 'directory' })).isError, undefined);

  assert.deepEqual(await call(bob, 'follow', { key: alice.publicKey, unfollow: true }), { value: { following: false, changed: true } });
  assert.equal((await call(bob, 'follow', { key: bob.publicKey })).isError, true);
  assert.equal((await call(bob, 'feed_post', { text: 'x'.repeat(501) })).isError, true);
  assert.match((await call(bob, 'feed_read', { scope: 'nope' })).value.error, /scope must be one of/);
  assert.match((await call(bob, 'feed_read', { bogus: 1 })).value.error, /bogus is not allowed/);
  await assert.rejects(call(bob, 'reply', { id: 'unknown-id', text: 'hello' }), /Unknown or ambiguous/);

  const status = alice.status();
  assert.equal(status.mode, 'custom');
  assert.equal(status.product, 'dex');
  assert.equal(status.publicKey, alice.publicKey);
});

test('agent files, official notices, product channel and restart', async t => {
  const net = await network(t);
  const owner = net.transport(root);
  const agent = await net.addon({ agentPosting: true });
  const dir = agent.status().dataDir;
  const files = ['official', 'following', 'mentions', 'directory'].map(f => join(dir, 'agent', 'social', f + '.md'));
  for (const file of files) {
    assert.ok(existsSync(file), file);
    assert.ok(readFileSync(file, 'utf8').startsWith(AGENT_HEADER));
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  assert.ok(await owner.join('soc/official', { ownerKey: ROOT, ownerWriteOnly: true, maxReceiveBytes: 4096 }));
  assert.ok(await owner.join('soc/p/dex', { ownerKey: ROOT, ownerWriteOnly: true, maxReceiveBytes: 4096 }));
  await until(() => owner.peerCount() > 0);
  await until(() => owner.send('soc/official', { t: 'notice', v: 1, text: 'Maintenance window at 12:00 UTC', severity: 'info' }) &&
    agent.social.timeline({ scope: 'official' }).length, { step: 100 });
  await until(() => owner.send('soc/p/dex', { t: 'post', v: 1, text: 'intercom-dex release notes' }) &&
    agent.social.timeline().some(p => p.channel === 'soc/p/dex'), { step: 100 });
  const official = await call(agent, 'feed_read', { scope: 'official' });
  assert.equal(official.value.posts[0].untrustedText, 'Maintenance window at 12:00 UTC');
  assert.equal(official.value.posts[0].verified, true);
  await agent.social.maintain();
  const md = readFileSync(files[0], 'utf8');
  assert.match(md, /\[NEW\] .*Maintenance window at 12:00 UTC/);
  assert.match(readFileSync(files[1], 'utf8'), /intercom-dex release notes/);
  await agent.social.writeAgentFiles();
  assert.doesNotMatch(readFileSync(files[0], 'utf8'), /\[NEW\]/);

  // The data dir is single-instance; after close the same identity and feed come back.
  await assert.rejects(startAddon({ dataDir: dir, rootKey: ROOT, transport: net.transport(), proofs: false }), /already running/);
  const key = agent.publicKey;
  await agent.close();
  assert.equal(existsSync(join(dir, 'run.lock')), false);
  assert.equal(existsSync(join(dir, 'control.json')), false);
  const again = await startAddon({ dataDir: dir, rootKey: ROOT, transport: net.transport(), proofs: false, profile: 'small', product: 'dex' });
  t.after(() => again.close());
  assert.notEqual(again.publicKey, key); // a fresh memory transport has a fresh key; the stored feed remains
  const kept = (await call(again, 'feed_read', { scope: 'official' })).value.posts;
  assert.ok(kept.length >= 1 && kept.every(p => p.untrustedText === 'Maintenance window at 12:00 UTC'));
});

test('profile tool resolves tied handles and refreshes proofs only for a single profile', async t => {
  const net = await network(t);
  const alice = await net.addon(), bob = await net.addon(), viewer = await net.addon();
  const card = { handle: 'shared', harnesses: ['dex'] };
  await alice.social.setCard(card);
  await bob.social.setCard(card);
  const profile = t.mock.method(viewer.social, 'profile');
  await until(async () => (await call(viewer, 'feed_read', { scope: 'directory', q: 'shared' })).value.accounts.length === 2);
  assert.equal((await call(viewer, 'profile', { handle: 'shared' })).isError, true);
  assert.equal(profile.mock.callCount(), 0);
  await viewer.social.follow(alice.publicKey);
  assert.equal((await call(viewer, 'profile', { handle: 'shared' })).value.profile.key, alice.publicKey);
  assert.deepEqual(profile.mock.calls.at(-1).arguments, [alice.publicKey, { verify: true }]);
  await viewer.social.setCard(card);
  assert.equal((await call(viewer, 'profile', { handle: 'shared' })).value.you, true);
});

test('only the root identity can publish a reserved handle through the owner card route', async t => {
  const net = await network(t);
  const ordinary = await net.addon(), official = await net.addon({ transport: net.transport(root) });
  const set = addon => socialClient(addon.status().dataDir).card({ handle: 'official' });
  assert.deepEqual(await set(ordinary), { sent: false, error: 'handle: reserved for the official account' });
  assert.equal((await set(official)).sent, true);
  assert.equal(official.social.profile(ROOT).handle, 'official');
});

test('startup and offline card edits refuse an accessible data directory', { skip: process.platform === 'win32' }, async t => {
  const net = await network(t);
  const dir = join(net.dir, 'accessible');
  mkdirSync(dir, { mode: 0o700 });
  for (const mode of [0o750, 0o701]) {
    chmodSync(dir, mode);
    await assert.rejects(startAddon({ dataDir: dir, transport: net.transport() }), /chmod 700/);
    await assert.rejects(main(['card', '--data', dir, '--handle', 'local']), /chmod 700/);
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(statSync(dir).mode & 0o777, mode);
  }
});

test('a stale lock from a dead process is taken over; bad options fail early', async t => {
  const net = await network(t);
  const dir = join(net.dir, 'stale');
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, 'run.lock'), '2147483646');
  const addon = await startAddon({ dataDir: dir, rootKey: ROOT, transport: net.transport(), proofs: false, profile: 'small' });
  t.after(() => addon.close());
  assert.equal(readFileSync(join(dir, 'run.lock'), 'utf8'), String(process.pid));
  await assert.rejects(startAddon({ dataDir: join(net.dir, 'x'), product: 'nft', transport: net.transport() }), /--product/);
  await assert.rejects(startAddon({ dataDir: join(net.dir, 'y'), transport: net.transport(), bridge: { url: 'ws://127.0.0.1:1' } }), /not both/);
  assert.equal(existsSync(join(net.dir, 'y', 'run.lock')), false);
});
