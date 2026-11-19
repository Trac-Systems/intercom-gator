import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import PeerWallet from 'trac-wallet';
import { keyFromSeed, loadOrCreateKey, loadOrCreateSwarmKeyPair } from '../src/keys.js';
import { SwarmTransport } from '../src/swarm.js';
import { joinPolicy, policyFor } from '../src/policy.js';

test('a raw Ed25519 seed signs identically to Node and verifies through PeerWallet', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  const wallet = keyFromSeed(seed.toString('hex'));
  const message = Buffer.from('sidechannel wallet interoperability');
  assert.equal(wallet.publicKey.toString('base64url'), publicKey.export({ format: 'jwk' }).x);
  assert.ok(wallet.sign(message).equals(sign(null, message, privateKey)));
  assert.ok(PeerWallet.verify(wallet.sign(message), message, wallet.publicKey));
  assert.ok(verify(null, message, publicKey, wallet.sign(message)));
  assert.throws(() => keyFromSeed('a'.repeat(63)));
});

test('exclusive, private, reloadable PeerWallet keystore; corrupt files are preserved', async t => {
  const dir = mkdtempSync(join(import.meta.dirname, 'identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'keys', 'peer.json');
  const [first, second] = await Promise.all([loadOrCreateKey(dir), loadOrCreateKey(dir)]);
  assert.ok(first.publicKey.equals(second.publicKey));
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  const stored = readFileSync(file, 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(stored)).sort(), ['ciphertext', 'nonce', 'salt']);
  const peer = new PeerWallet();
  peer.importFromFile(file);
  const challenge = randomBytes(48);
  assert.ok(first.verify(peer.sign(challenge), challenge));
  assert.ok(first.sign(challenge).equals(second.sign(challenge)));
  writeFileSync(file, 'broken');
  await assert.rejects(loadOrCreateKey(dir), /Invalid peer keystore/);
  assert.equal(readFileSync(file, 'utf8'), 'broken');
});

test('all social and data channels have their designated owners, byte caps and work', () => {
  const rootKey = randomBytes(32).toString('hex');
  const author = randomBytes(32).toString('hex');
  for (const [channel, bytes, difficulty, owner] of [
    ['soc/official', 4096, undefined, rootKey], ['soc/p/gator', 4096, undefined, rootKey],
    ['soc/u/' + author, 4096, undefined, author], ['soc/pr/dmw', 2048, 12],
    ['soc/r/' + author, 2048, 12], ['soc/dir', 4096, 16],
    ['gator/new', 8192, 16], ['gator/pools/1', 8192, 10],
    ['gator/meta', 8192, 10], ['gator/ctl', 65536, undefined, rootKey],
    ...Array.from({ length: 16 }, (_, i) => ['gator/px/' + i, 16384, 8]),
  ]) {
    const p = policyFor(channel, { rootKey });
    assert.equal(p.verifySignature, true);
    assert.equal(p.ownerKey, owner);
    assert.equal(!!p.ownerWriteOnly, !!owner);
    assert.equal(p.maxReceiveBytes, bytes);
    assert.equal(p.powDifficulty, difficulty);
    assert.equal(p.powBitsPerKiB, channel.startsWith('gator/px/') ? 1 : undefined);
  }
  const policy = joinPolicy('soc/u/' + author, {
    ownerKey: rootKey, ownerWriteOnly: false, verifySignature: false, maxReceiveBytes: 60_000,
  });
  assert.deepEqual(policy, policyFor('soc/u/' + author));
  for (const name of ['gator/px/16', 'soc/u/no-key', 'soc/official/foo', ' soc/official', 'soc/pr/']) {
    assert.throws(() => policyFor(name));
  }
});

test('two processes starting in the same empty data directory keep one identity', async t => {
  const dir = mkdtempSync(join(import.meta.dirname, 'concurrent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const moduleUrl = new URL('../src/keys.js', import.meta.url).href;
  const script = `
    const { loadOrCreateKey } = await import(process.argv[1]);
    const wallet = await loadOrCreateKey(process.argv[2]);
    process.stdout.write(wallet.sign(Buffer.from('concurrent startup')).toString('hex'));
  `;
  const run = () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, moduleUrl, dir]);
  const [first, second] = await Promise.all([run(), run()]);
  assert.equal(first.stdout.length, 128);
  assert.ok(first.stdout === second.stdout);
  assert.deepEqual([first.stderr, second.stderr], ['', '']);
});

test('the swarm key pair is separate, private, plain, persistent and agreed on by concurrent starts', async t => {
  const dir = mkdtempSync(join(import.meta.dirname, 'swarm-key-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const identity = await loadOrCreateKey(dir);
  const moduleUrl = new URL('../src/keys.js', import.meta.url).href;
  const script = `
    const { loadOrCreateSwarmKeyPair } = await import(process.argv[1]);
    process.stdout.write(loadOrCreateSwarmKeyPair(process.argv[2]).publicKey.toString('hex'));
  `;
  const run = () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, moduleUrl, dir]);
  const runs = await Promise.all([run(), run(), run()]);
  assert.deepEqual(runs.map(r => r.stderr), ['', '', '']);
  assert.equal(new Set(runs.map(r => r.stdout)).size, 1);
  const pair = loadOrCreateSwarmKeyPair(dir);
  assert.equal(pair.publicKey.toString('hex'), runs[0].stdout);
  assert.ok(!pair.publicKey.equals(identity.publicKey));
  // It is a working Ed25519 pair, as Hyperswarm's Noise handshake needs.
  assert.ok(keyFromSeed(pair.secretKey.subarray(0, 32).toString('hex')).publicKey.equals(pair.publicKey));
  const file = join(dir, 'keys', 'swarm.json');
  assert.deepEqual(readdirSync(join(dir, 'keys')).sort(), ['peer.json', 'swarm.json']);
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'keys')).mode & 0o777, 0o700);
  }
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort(), ['publicKey', 'secretKey']);
  // The transport picks it up from dataDir; an explicit pair must not be the signing key.
  const transport = new SwarmTransport({ dataDir: dir, wallet: identity, bootstrap: [] });
  assert.equal(transport.swarmPublicKey, runs[0].stdout);
  assert.equal(transport.publicKey, identity.publicKey.toString('hex'));
  await transport.close();
  assert.throws(() => new SwarmTransport({ dataDir: dir, wallet: identity, bootstrap: [],
    swarmKeyPair: { publicKey: identity.publicKey, secretKey: identity.secretKey } }), /must not be the signing key/);
  const corrupt = JSON.stringify({ publicKey: runs[0].stdout, secretKey: 'ab'.repeat(64) });
  writeFileSync(file, corrupt);
  assert.throws(() => loadOrCreateSwarmKeyPair(dir), /Invalid swarm keystore/);
  assert.equal(readFileSync(file, 'utf8'), corrupt);
});
