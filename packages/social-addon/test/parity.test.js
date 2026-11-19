// The add-on can set everything a gator user sets on the card, carries its harness tag, and runs an identity
// exported from another harness (one identity, several harnesses).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keyFromSeed, loadOrCreateKey, MemoryTransport } from '@gator/net';
import { identityDocument, migrations, Social } from '@gator/social';
import { openStore } from '@gator/store';
import { main } from '../src/cli.js';
import { socialClient } from '../src/client.js';
import { readConfig } from '../src/files.js';
import { call, network, ROOT, until } from './helpers.js';

const WEBP = 'UklGRtYAAABXRUJQVlA4IMoAAACwBwCdASpgAGAAPtFosFMoJaSoIOgBABoJYwaB3szGq6iks9Ruv2APtHBlJn////lq/////4u/////7s/////6Bf////vAAP7wtrT/49f6Y4eTvs8JC8Vi0vTTietXzMnnZ4mmRmQ8gcGf1KT420QiYFMhk5Qg544nj41+3ZyJhQ5gkbvWI3Xo2u2ENmfJMr70lSckzt9BPA7Bq8z7Q1tB9eWEFfkfHr/3SbvRKpbsJeIDX+UVhi1FH0bXcVOflS9/iwj+1wd7AAAA';
const KEY_A = 'aa'.repeat(32);
const quiet = { stdout: { write() {} }, stderr: { write() {} } };
const capture = () => {
  const out = [];
  return { out, io: { stdout: { write: s => out.push(s) }, stderr: { write: s => out.push(s) } }, json: () => JSON.parse(out.join('')) };
};

test('profile.set reaches card parity with gator: links, DNS/GitHub proofs, topics, harness tags', async t => {
  const net = await network(t);
  const alice = await net.addon({ agentPosting: true, product: 'dex' });
  const bob = await net.addon({ product: 'reset' });
  const set = await call(alice, 'profile', { set: { handle: 'alice', name: 'Alice', bio: 'maker',
    links: ['https://alice.example/'], dns: 'Alice.Example', github: 'alice-gh', topics: ['dex', 'makers'] } });
  assert.equal(set.isError, false, JSON.stringify(set.value));
  assert.deepEqual(set.value.card, { handle: 'alice', name: 'Alice', bio: 'maker', harnesses: ['dex'],
    links: ['https://alice.example/'], proofs: { dns: 'alice.example', github: 'alice-gh' } });
  assert.deepEqual(set.value.topics, ['dex', 'makers']);
  assert.deepEqual(set.value.prove, {
    dns: 'Add a DNS TXT record on alice.example with the value intercom-gator=' + alice.publicKey,
    github: 'Create a public gist as alice-gh whose text contains ' + alice.publicKey,
  });
  // A later edit keeps every omitted field and the topics; '' and [] remove.
  const edited = await call(alice, 'profile', { set: { bio: '', github: '', links: [] } });
  assert.deepEqual(edited.value.card, { handle: 'alice', name: 'Alice', harnesses: ['dex'], proofs: { dns: 'alice.example' } });
  assert.deepEqual(edited.value.topics, ['dex', 'makers']);
  assert.deepEqual(readConfig(alice.status().dataDir).topics, ['dex', 'makers']);
  // Same validation messages as every harness.
  for (const [patch, message] of [[{ links: ['ftp://x.example/'] }, /links: at most 4/], [{ dns: 'no domain' }, /dns: a domain/],
    [{ github: '-x-' }, /github: a GitHub user/], [{ handle: 'official' }, /reserved/], [{ avatar: 'AAAA' }, /96×96/]]) {
    const refused = await call(alice, 'profile', { set: patch });
    assert.equal(refused.isError, true);
    assert.match(refused.value.error, message);
  }
  // Viewers see links and proofs (unverified here: no lookups in tests) and the harness tag.
  const seen = await until(async () => {
    const { value } = await call(bob, 'profile', { key: alice.publicKey });
    return value.profile.proofs && value.profile;
  });
  assert.deepEqual(seen.proofs, { dns: { value: 'alice.example', verified: false } });
  assert.deepEqual(seen.harnesses, ['dex']);
  // A card other harnesses tagged keeps their tags.
  await alice.social.setCard({ handle: 'alice', harnesses: ['gator'] });
  writeFileSync(join(alice.status().dataDir, 'config.json'), JSON.stringify({ card: { handle: 'alice', harnesses: ['gator'] } }), { mode: 0o600 });
  assert.deepEqual((await call(alice, 'profile', { set: { name: 'A' } })).value.card.harnesses, ['gator', 'dex']);
});

test('like, repost, mute and quote are agent tools behind the posting switch', async t => {
  const net = await network(t);
  const alice = await net.addon({ agentPosting: true });
  const bob = await net.addon({ agentPosting: true });
  const off = await net.addon();
  await call(bob, 'profile', { set: { handle: 'bob' } });
  assert.equal((await call(alice, 'follow', { key: bob.publicKey })).isError, undefined);
  assert.equal((await call(bob, 'feed_post', { text: 'original thought' })).isError, false);
  const post = await until(async () => (await call(alice, 'feed_read', {})).value.posts.find(p => p.key === bob.publicKey));
  assert.equal((await call(alice, 'like', { id: post.id, key: bob.publicKey })).isError, false);
  assert.equal((await call(alice, 'repost', { id: post.id, key: bob.publicKey })).isError, false);
  assert.equal((await call(alice, 'feed_post', { text: 'quoting this', quote: { id: post.id, key: bob.publicKey } })).isError, false);
  const mine = (await call(alice, 'feed_read', { scope: 'profile' })).value.posts;
  assert.ok(mine.some(p => p.kind === 'repost' && p.target.id === post.id));
  assert.equal(alice.social.counts({ key: bob.publicKey, id: post.id }).likes, 1);
  assert.equal(alice.social.thread({ key: bob.publicKey, id: post.id }).length >= 1, true);
  assert.deepEqual((await call(alice, 'mute', { key: bob.publicKey })).value, { muted: true, changed: true });
  assert.equal((await call(alice, 'feed_read', {})).value.posts.some(p => p.key === bob.publicKey), false);
  assert.deepEqual((await call(alice, 'mute', { key: bob.publicKey, unmute: true })).value, { muted: false, changed: true });
  assert.equal((await call(alice, 'mute', { key: ROOT })).isError, true);
  for (const [name, args] of [['like', { id: post.id }], ['repost', { id: post.id }], ['mute', { key: bob.publicKey }]]) {
    assert.equal((await call(off, name, args)).isError, true, name);
  }
});

test('gator-social card edits offline with the same merge: links, proofs, avatar removal, topics', async t => {
  const net = await network(t);
  const dir = join(net.dir, 'offline');
  const avatar = join(net.dir, 'face.webp');
  writeFileSync(avatar, Buffer.from(WEBP, 'base64'));
  assert.equal(await main(['card', '--data', dir, '--handle', 'carol', '--links', 'https://c.example/,https://d.example/',
    '--dns', 'c.example', '--github', 'carol', '--avatar', avatar, '--topics', '#art,dex'], quiet), 0);
  const { io, json } = capture();
  assert.equal(await main(['card', '--data', dir, '--name', 'Carol', '--github', '', '--avatar', ''], io), 0);
  const saved = readConfig(dir);
  assert.deepEqual(saved.card, { handle: 'carol', name: 'Carol', harnesses: [], links: ['https://c.example/', 'https://d.example/'],
    proofs: { dns: 'c.example' } });
  assert.deepEqual(saved.topics, ['art', 'dex']);
  assert.equal(json().saved, true);
  await assert.rejects(main(['card', '--data', dir, '--links', 'nope'], quiet), /links: at most 4/);
  await assert.rejects(main(['card', '--data', join(net.dir, 'fresh'), '--name', 'x'], quiet), /needs --handle/);
  // Running: the owner route takes the same patch; the product tag is added.
  const addon = await net.addon({ dataDir: dir, product: 'dmw' });
  await until(() => addon.social.card(addon.publicKey));
  assert.deepEqual(addon.social.card(addon.publicKey).harnesses, ['dmw']);
  const live = await socialClient(dir).editCard({ bio: 'live' });
  assert.equal(live.sent, true);
  assert.deepEqual(live.card, { handle: 'carol', name: 'Carol', bio: 'live', harnesses: ['dmw'],
    links: ['https://c.example/', 'https://d.example/'], proofs: { dns: 'c.example' } });
  assert.deepEqual(live.topics, ['art', 'dex']);
});

/** A gator-like data directory: its keystore and the signed card copies `gator key export` puts in the file. */
async function exported(net, name, card, topics) {
  const source = join(net.dir, name);
  const wallet = await loadOrCreateKey(source);
  const transport = net.transport(wallet);
  const store = openStore({ file: join(source, 'gator.db'), profile: 'small', migrations });
  const social = new Social({ transport, db: store, rootKey: ROOT, product: 'gator', dataDir: source, proofs: false });
  await social.ready;
  const sent = {};
  transport.on('message', (channel, e) => { if (e.from === social.publicKey) sent[e.message.t] = e; });
  assert.equal(await social.setCard(card, { topics }), true);
  const file = join(net.dir, name + '.identity.json');
  writeFileSync(file, JSON.stringify(identityDocument({ publicKey: social.publicKey, harness: 'gator',
    keystore: JSON.parse(readFileSync(join(source, 'keys', 'peer.json'), 'utf8')), card: sent.card, announce: sent.announce })), { mode: 0o600 });
  net.beforeRemove(async () => { await social.close(); store.close(); });
  return { file, wallet, social, publicKey: social.publicKey };
}

test('key import: the add-on runs the exported identity and adopts its card instead of a blank one', async t => {
  const net = await network(t);
  const card = { handle: 'atlas', name: 'Atlas', bio: 'maker', harnesses: ['gator'], links: ['https://atlas.example/'],
    proofs: { dns: 'atlas.example', github: 'atlas' }, avatar: WEBP };
  const gator = await exported(net, 'gator', card, ['makers']);
  const dir = join(net.dir, 'addon');
  await assert.rejects(main(['key', 'import', gator.file, '--data', dir], quiet), /add --yes/);
  const { io, json, out } = capture();
  assert.equal(await main(['key', 'import', gator.file, '--data', dir, '--yes'], io), 0);
  const result = json();
  assert.equal(result.imported, true);
  assert.equal(result.publicKey, gator.publicKey);
  assert.equal(result.card.handle, 'atlas');
  assert.equal(result.card.avatar, true); // never the image, never the secret
  const secret = JSON.parse(readFileSync(join(dir, 'keys', 'peer.json'), 'utf8')).ciphertext;
  assert.ok(!out.join('').includes(secret));
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'keys', 'peer.json')).mode & 0o777, 0o600);
  assert.deepEqual(readConfig(dir).card, card);
  assert.deepEqual(readConfig(dir).topics, ['makers']);
  const shown = capture();
  assert.equal(await main(['key', '--data', dir], shown.io), 0);
  assert.equal(shown.json().publicKey, gator.publicKey);

  // On run the same profile goes out under the same key, with this product's tag added and gator's kept.
  await gator.social.close();
  const wallet = await loadOrCreateKey(dir);
  const addon = await net.addon({ dataDir: dir, product: 'dex', transport: new MemoryTransport({ hub: net.hub, skipPow: true, rootKey: ROOT, wallet }) });
  assert.equal(addon.publicKey, gator.publicKey);
  const published = await until(() => addon.social.card(addon.publicKey)?.harnesses.includes('dex') && addon.social.card(addon.publicKey));
  assert.deepEqual(published, { ...card, harnesses: ['gator', 'dex'] });
  assert.deepEqual(addon.social.topics(addon.publicKey), ['makers']);
  assert.equal(addon.status().imported.from, 'gator');

  // While it runs, import is refused (it would swap the key under a live process).
  await assert.rejects(main(['key', 'import', gator.file, '--data', dir, '--yes'], quiet), /already running/);
});

test('key import keeps a different existing identity aside only with --replace', async t => {
  const net = await network(t);
  const gator = await exported(net, 'gator', { handle: 'atlas', harnesses: ['gator'] }, []);
  const dir = join(net.dir, 'addon');
  const before = (await loadOrCreateKey(dir)).publicKey.toString('hex');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ card: { handle: 'old_me', harnesses: ['dex'] } }), { mode: 0o600 });
  writeFileSync(join(dir, 'social.db'), 'old feed');
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
  await assert.rejects(main(['key', 'import', gator.file, '--data', dir, '--yes'], quiet), /--replace/);
  const { io, json } = capture();
  assert.equal(await main(['key', 'import', gator.file, '--data', dir, '--yes', '--replace'], io), 0);
  assert.equal(json().replaced, before);
  assert.equal((await loadOrCreateKey(dir)).publicKey.toString('hex'), gator.publicKey);
  const keys = readdirSync(join(dir, 'keys'));
  assert.ok(keys.some(f => f.startsWith('peer.' + before.slice(0, 12))), keys.join());
  assert.ok(readdirSync(dir).some(f => f.startsWith('social.' + before.slice(0, 12))));
  assert.equal(existsSync(join(dir, 'social.db')), false);
  assert.equal(readConfig(dir).card.handle, 'atlas'); // the old identity's card never goes out under the new key
  // A file without a valid keystore or another person's file is refused.
  const broken = join(net.dir, 'broken.json');
  writeFileSync(broken, JSON.stringify(identityDocument({ publicKey: KEY_A, keystore: { nonce: 'x' } })), { mode: 0o600 });
  await assert.rejects(main(['key', 'import', broken, '--data', join(net.dir, 'b'), '--yes'], quiet), /no valid keystore/);
  if (process.platform !== 'win32') {
    chmodSync(gator.file, 0o644);
    await assert.rejects(main(['key', 'import', gator.file, '--data', join(net.dir, 'c'), '--yes'], quiet), /chmod 600/);
  }
});

test('one identity runs in one local process; another process signing as it shows in status', async t => {
  const net = await network(t);
  const wallet = keyFromSeed('44'.repeat(32));
  const locks = join(net.dir, 'locks');
  mkdirSync(locks, { mode: 0o700 });
  const first = await net.addon({ transport: net.transport(wallet), identityLock: { dir: locks }, agentPosting: true });
  await assert.rejects(net.addon({ transport: net.transport(wallet), identityLock: { dir: locks } }), /already runs in gator-social \(dex\)/);
  // Elsewhere (another machine: no shared lock) the same key is allowed but reported.
  const remote = await net.addon({ transport: net.transport(wallet), product: 'reset', agentPosting: true });
  assert.equal(first.status().elsewhere, undefined);
  assert.equal((await call(remote, 'feed_post', { text: 'from the other machine' })).isError, false);
  const status = await until(() => first.status().elsewhere && first.status());
  assert.match(status.warning, /another process/);
  assert.equal(status.elsewhere.channel, 'soc/u/' + first.publicKey);
  assert.equal(remote.status().elsewhere, undefined);
});

test('a card another harness of the identity publishes is adopted, and this product\'s tag added', async t => {
  const net = await network(t);
  const wallet = keyFromSeed('55'.repeat(32));
  const addon = await net.addon({ transport: net.transport(wallet), product: 'reset', agentPosting: true });
  await call(addon, 'profile', { set: { handle: 'shared', topics: ['one'] } });
  const transport = net.transport(wallet);
  const store = openStore({ file: join(net.dir, 'gator.db'), profile: 'small', migrations });
  const gator = new Social({ transport, db: store, rootKey: ROOT, product: 'gator', dataDir: join(net.dir, 'g'), proofs: false });
  net.beforeRemove(async () => { await gator.close(); store.close(); });
  await gator.ready;
  // gator edits the card (as editedCard does: it keeps tags) without knowing the add-on's topics.
  assert.equal(await gator.setCard({ handle: 'shared', name: 'From gator', harnesses: ['gator'] }), true);
  const adopted = await until(() => readConfig(addon.status().dataDir).card?.name === 'From gator' &&
    addon.social.card(addon.publicKey)?.harnesses.includes('reset') && readConfig(addon.status().dataDir));
  assert.deepEqual(adopted.card.harnesses, ['gator', 'reset']);
  await until(() => gator.card(gator.publicKey)?.harnesses.includes('reset'));
  assert.equal(gator.card(gator.publicKey).name, 'From gator');
});
