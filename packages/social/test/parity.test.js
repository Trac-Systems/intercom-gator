import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createMemoryHub, keyFromSeed, MemoryTransport } from '@gator/net';
import { cardProblem, cleanTopics, editCard, identityDocument, lockIdentity, migrations, proofSteps,
  readIdentityDocument, Social, withHarness } from '../src/index.js';

const ROOT = keyFromSeed('11'.repeat(32)).publicKey.toString('hex');
const KEY = 'ab'.repeat(32);
const scratch = t => {
  const dir = mkdtempSync(join(tmpdir(), 'gator-parity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
async function until(check, timeout = 5000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('Timed out waiting');
    await delay(10);
  }
}
function db() {
  const conn = new DatabaseSync(':memory:');
  for (const m of migrations) m.up(conn);
  return conn;
}
async function node(t, hub, wallet, product = 'gator') {
  const transport = new MemoryTransport({ hub, skipPow: true, rootKey: ROOT, ...(wallet && { wallet }) });
  const social = new Social({ transport, db: db(), rootKey: ROOT, product, dataDir: scratch(t), proofs: false });
  t.after(async () => { await social.close(); await transport.close(); });
  await social.ready;
  return social;
}

test('editCard merges an edit into the newest card with one rule set for every harness', () => {
  const old = { handle: 'atlas', name: 'Atlas', bio: 'maker', harnesses: ['gator'], links: ['https://a.example/'],
    proofs: { dns: 'a.example', github: 'atlas' } };
  // Omitted fields keep; the harness tag is added, never replacing the others.
  assert.deepEqual(editCard(old, { bio: 'new' }, { key: KEY, harness: 'dex' }),
    { ...old, bio: 'new', harnesses: ['gator', 'dex'] });
  // '' or null removes; whitespace counts as empty; dns is lowercased without the final dot.
  assert.deepEqual(editCard(old, { name: '', bio: '  ', links: [], github: null, dns: 'B.Example.' }, { key: KEY, harness: 'gator' }),
    { handle: 'atlas', harnesses: ['gator'], proofs: { dns: 'b.example' } });
  assert.deepEqual(editCard(old, { proofs: { github: 'other' } }, { key: KEY }).proofs, { dns: 'a.example', github: 'other' });
  // No card yet: the default handle every harness uses.
  assert.equal(editCard(null, {}, { key: KEY, harness: 'reset' }).handle, 'peer_' + KEY.slice(0, 12));
  // Handles are taken as typed and validated, never rewritten.
  assert.equal(cardProblem(editCard(null, { handle: '@Atlas' }, { key: KEY })), 'handle: 2–24 of a–z, 0–9, _');
  assert.deepEqual(withHarness(['gator', 'gator', 'bad tag'], 'dex'), ['gator', 'dex']);
  assert.equal(withHarness(Array.from({ length: 12 }, (_, i) => 'h' + i), 'dex').length, 12);
  assert.throws(() => editCard(old, [], { key: KEY }), /profile edit/);
});

test('cardProblem names the broken field; topics and proof steps are shared too', () => {
  const card = { handle: 'atlas', harnesses: ['gator'] };
  assert.equal(cardProblem(card, { key: KEY, rootKey: ROOT }), null);
  assert.equal(cardProblem({ ...card, handle: 'Bad Handle' }), 'handle: 2–24 of a–z, 0–9, _');
  assert.equal(cardProblem({ ...card, handle: 'official' }, { key: KEY, rootKey: ROOT }), 'handle: reserved for the official account');
  assert.equal(cardProblem({ ...card, handle: 'official' }, { key: ROOT, rootKey: ROOT }), null);
  assert.equal(cardProblem({ ...card, name: 'x'.repeat(81) }), 'name: one line, at most 80 characters');
  assert.equal(cardProblem({ ...card, bio: 'x'.repeat(161) }), 'bio: at most 160 characters');
  assert.equal(cardProblem({ ...card, links: ['ftp://x.example/'] }), 'links: at most 4 http(s) URLs');
  assert.equal(cardProblem({ ...card, links: Array(5).fill('https://x.example/') }), 'links: at most 4 http(s) URLs');
  assert.match(cardProblem({ ...card, links: Array(4).fill('https://x.example/'), bio: 'see https://y.example' }), /4 links/);
  assert.equal(cardProblem({ ...card, proofs: { dns: 'not a domain' } }), 'dns: a domain name such as example.com');
  assert.equal(cardProblem({ ...card, proofs: { github: '-bad-' } }), 'github: a GitHub user name');
  assert.match(cardProblem({ ...card, avatar: 'AAAA' }), /96×96/);
  assert.deepEqual(cleanTopics('#dex, makers ,dex'), ['dex', 'makers']);
  assert.throws(() => cleanTopics(['a', 'b', 'c', 'd', 'e', 'f']), /at most 5/);
  assert.deepEqual(proofSteps(KEY, { dns: 'a.example', github: 'atlas' }), {
    dns: 'Add a DNS TXT record on a.example with the value intercom-gator=' + KEY,
    github: 'Create a public gist as atlas whose text contains ' + KEY,
  });
});

test('one identity per local process: the identity lock refuses a second holder and takes over stale locks', t => {
  const dir = join(scratch(t), 'locks');
  const release = lockIdentity(KEY, { dir, harness: 'gator', dataDir: '/data/a' });
  assert.throws(() => lockIdentity(KEY, { dir, harness: 'gator-social (dex)' }), /already runs in gator \(pid \d+, data \/data\/a\)/);
  const other = lockIdentity('cd'.repeat(32), { dir });
  release();
  lockIdentity(KEY, { dir })(); // free again
  other();
  // A lock of another live process is refused; one left by a process that died is taken over.
  const file = join(dir, createHash('sha256').update('intercom-gator/identity-lock/v1\n' + KEY).digest('hex').slice(0, 32) + '.lock');
  writeFileSync(file, JSON.stringify({ pid: 999999, harness: 'gator', dataDir: '/data/b', token: 'x' }));
  assert.throws(() => lockIdentity(KEY, { dir, isAlive: () => true }), /already runs in gator \(pid 999999/);
  const taken = lockIdentity(KEY, { dir, isAlive: () => false });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, process.pid);
  taken();
  assert.equal(existsSync(file), false);
});

test('setCard keeps the identity\'s directory topics; own cards from another process are reported', async t => {
  const hub = createMemoryHub();
  const wallet = keyFromSeed('22'.repeat(32));
  const gator = await node(t, hub, wallet, 'gator');
  const addon = await node(t, hub, wallet, 'dex');
  const events = [];
  addon.on('own-card', event => events.push(event));
  const elsewhere = [];
  addon.on('elsewhere', event => elsewhere.push(event));
  assert.equal(addon.identityElsewhere(), null);

  assert.equal(await gator.setCard({ handle: 'atlas', harnesses: ['gator'] }, { topics: ['makers'] }), true);
  // The other process of this identity stores the card and hears that it came from elsewhere.
  const heard = await until(() => events.find(e => !e.sent && e.card?.handle === 'atlas'));
  assert.deepEqual(heard.card, { handle: 'atlas', harnesses: ['gator'] });
  await until(() => addon.topics(addon.publicKey)?.length);
  assert.deepEqual(addon.topics(addon.publicKey), ['makers']);
  assert.equal(elsewhere.length, 1);
  assert.equal(addon.identityElsewhere().channel.startsWith('soc/'), true);
  assert.equal(addon.identityElsewhere(-1), null);
  // Its own sends never count as "elsewhere"; a card update without topics keeps the directory topics.
  assert.equal(gator.identityElsewhere(), null);
  assert.equal(await addon.setCard({ handle: 'atlas', harnesses: ['gator', 'dex'] }), true);
  assert.ok(events.some(e => e.sent && e.card.harnesses.includes('dex')));
  assert.deepEqual(addon.topics(addon.publicKey), ['makers']);
  await until(() => gator.card(gator.publicKey)?.harnesses.includes('dex'));
  assert.deepEqual(gator.topics(gator.publicKey), ['makers']);
  assert.ok(gator.identityElsewhere());
});

test('identity file: signed card copies verify for the key, a forged copy is dropped', async t => {
  const hub = createMemoryHub();
  const wallet = keyFromSeed('33'.repeat(32));
  const social = await node(t, hub, wallet);
  const sent = [];
  social.transport.on('message', (channel, e) => { if (e.from === social.publicKey) sent.push(e); });
  await social.setCard({ handle: 'atlas', name: 'Atlas', harnesses: ['gator'], links: ['https://atlas.example/'],
    proofs: { dns: 'atlas.example' } }, { topics: ['makers'] });
  const card = sent.find(e => e.message.t === 'card'), announce = sent.find(e => e.message.t === 'announce');
  const doc = identityDocument({ publicKey: social.publicKey, keystore: { nonce: 'n' }, card, announce, harness: 'gator' });
  const read = readIdentityDocument(JSON.stringify(doc), ROOT);
  assert.deepEqual(read.card, { handle: 'atlas', name: 'Atlas', harnesses: ['gator'], links: ['https://atlas.example/'],
    proofs: { dns: 'atlas.example' } });
  assert.deepEqual(read.topics, ['makers']);
  assert.equal(read.from, 'gator');
  const forged = { ...doc, card: { ...card, message: { ...card.message, handle: 'mallory' } }, announce: undefined };
  assert.equal(readIdentityDocument(JSON.stringify(forged), ROOT).card, null);
  const other = identityDocument({ publicKey: KEY, keystore: {}, card, announce });
  assert.equal(readIdentityDocument(JSON.stringify(other), ROOT).card, null);
  assert.throws(() => readIdentityDocument('{"format":"x"}', ROOT), /Not an identity file/);
  assert.throws(() => readIdentityDocument('nope', ROOT), /Not an identity file/);
});

test('identity locks only reclaim a PID that the OS reports missing', t => {
  const dir = scratch(t), file = join(dir, createHash('sha256').update('intercom-gator/identity-lock/v1\n' + KEY).digest('hex').slice(0, 32) + '.lock');
  const pid = 123456;
  const record = JSON.stringify({ pid, harness: 'test' });
  writeFileSync(file, record);
  let code = 'EPERM';
  t.mock.method(process, 'kill', (requested, signal) => {
    assert.equal(requested, pid);
    assert.equal(signal, 0);
    throw Object.assign(new Error('process query'), { code });
  });
  for (const probe of ['EPERM', 'UNKNOWN']) {
    code = probe;
    assert.throws(() => lockIdentity(KEY, { dir }), /already runs/);
    assert.equal(readFileSync(file, 'utf8'), record);
  }
  code = 'ESRCH';
  const release = lockIdentity(KEY, { dir });
  release();
  assert.equal(existsSync(file), false);
});
