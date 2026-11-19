import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import createTestnet from 'hyperdht/testnet.js';
import PeerWallet from 'trac-wallet';
import { MemoryTransport, SwarmTransport, createMemoryHub, keyFromSeed } from '../src/index.js';
import { receivedEnvelope } from '../src/sidechannel-transport.js';
import { ManagedSidechannel } from '../vendor/intercom-sidechannel/managed.js';

const newWallet = () => keyFromSeed(randomBytes(32).toString('hex'));
const post = text => ({ t: 'post', v: 1, text });

async function until(check, description, ms = 8000) {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() >= deadline) assert.fail('Timed out waiting for ' + description);
    await delay(10);
  }
}

for (const kind of ['Swarm', 'Memory']) {
  test(kind + 'Transport echoes a successful send with no peers and nothing else', { timeout: 60_000 }, async t => {
    const net = kind === 'Swarm' ? await createTestnet(3) : null;
    const dir = mkdtempSync(join(import.meta.dirname, 'solo-'));
    const wallet = newWallet();
    const solo = net
      ? new SwarmTransport({ dataDir: dir, wallet, bootstrap: net.bootstrap })
      : new MemoryTransport({ wallet });
    t.after(async () => {
      try {
        await solo.close();
      } finally {
        await net?.destroy();
        rmSync(dir, { recursive: true, force: true });
      }
    });
    const seen = [];
    solo.on('message', (...args) => seen.push(args));
    assert.ok(await solo.join('gator/new'));
    assert.ok(await solo.join('soc/official'));
    assert.equal(solo.peerCount(), 0);
    assert.ok(solo.send('gator/new', post('alone')));
    assert.equal(seen.length, 1);
    const [channel, echo] = seen[0];
    assert.equal(channel, 'gator/new');
    assert.equal(echo.from, solo.publicKey);
    assert.deepEqual(echo.message, post('alone'));
    assert.equal(echo.pow.difficulty, 16);
    assert.ok(PeerWallet.verify(Buffer.from(echo.sig, 'hex'), Buffer.from(JSON.stringify({
      channel: echo.channel, from: echo.from, id: echo.id, kind: 'sidechannel_message_v1',
      message: { t: 'post', text: 'alone', v: 1 }, origin: echo.origin, ts: echo.ts,
    })), wallet.publicKey));
    echo.message.text = 'listener edits stay local';
    // Failed sends emit nothing: not joined, not the owner, oversize for the policy.
    assert.equal(solo.send('gator/meta', post('not joined')), false);
    assert.equal(solo.send('soc/official', post('not the root key')), false);
    assert.equal(solo.send('gator/new', post('x'.repeat(9000))), false);
    assert.equal(seen.length, 1);
    await delay(50);
    assert.equal(seen.length, 1);
  });
}

test('peers joining a channel on an existing connection answer each other without waiting out retries', async t => {
  const hub = createMemoryHub();
  const a = new MemoryTransport({ hub, skipPow: true });
  const b = new MemoryTransport({ hub, skipPow: true });
  t.after(() => Promise.all([a.close(), b.close()]));
  assert.ok(await a.join('gator/new'));
  assert.ok(await b.join('gator/new'));
  await until(() => a.peerCount() === 1 && b.peerCount() === 1, 'connection');
  // b rejects a's first open; a then waits on a retry timer when b's own open arrives.
  assert.ok(await a.join('gator/meta'));
  await delay(150);
  assert.ok(await b.join('gator/meta'));
  const inbox = [];
  b.on('message', (_, env) => { if (env.from === a.publicKey) inbox.push(env); });
  const started = performance.now();
  await until(() => {
    if (!inbox.length) a.send('gator/meta', post('opened'));
    return inbox.length > 0;
  }, 'the late channel to open', 1500);
  assert.ok(performance.now() - started < 1500);
});

test('own sends queue behind a backpressured session and arrive in order', async t => {
  const hub = createMemoryHub();
  const a = new MemoryTransport({ hub, skipPow: true });
  const b = new MemoryTransport({ hub, skipPow: true });
  t.after(() => Promise.all([a.close(), b.close()]));
  assert.ok(await a.join('gator/new'));
  assert.ok(await b.join('gator/new'));
  const inbox = [];
  b.on('message', (_, env) => inbox.push(env.message.text));
  await until(() => {
    if (!inbox.length) a.send('gator/new', post('probe'));
    return inbox.length > 0;
  }, 'an open session');
  // Memory streams are object-mode Duplexes with a high-water mark of 16 frames.
  const burst = Array.from({ length: 48 }, (_, i) => 'burst ' + i);
  for (const text of burst) assert.ok(a.send('gator/new', post(text)));
  await until(() => inbox.length === burst.length + 1, 'the whole burst');
  assert.deepEqual(inbox.slice(1), burst);
});

async function swarmPair(t) {
  const net = await createTestnet(3);
  const dir = mkdtempSync(join(import.meta.dirname, 'pair-'));
  const owner = newWallet();
  const rootKey = owner.publicKey.toString('hex');
  const peers = [owner, newWallet()].map(wallet => new SwarmTransport({
    dataDir: join(dir, wallet.publicKey.toString('hex')), wallet, bootstrap: net.bootstrap, rootKey }));
  t.after(async () => {
    try {
      await Promise.all(peers.map(peer => peer.close()));
    } finally {
      await net.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  return peers;
}

test('back-to-back 16 KiB px frames over HyperDHT all arrive, in order', { timeout: 60_000 }, async t => {
  const [a, b] = await swarmPair(t);
  const px = 'gator/px/3';
  assert.ok(await a.join(px));
  assert.ok(await b.join(px));
  const inbox = [];
  b.on('message', (_, env) => inbox.push(env.message.text));
  await until(() => {
    if (!inbox.length) a.send(px, post('probe'));
    return inbox.length > 0;
  }, 'an open px session', 20_000);
  // Each frame is just under the channel's 16 KiB cap; the first one already backpressures the stream.
  const burst = Array.from({ length: 8 }, (_, i) => String(i).padEnd(15_500, '.'));
  for (const text of burst) assert.ok(a.send(px, post(text)));
  await until(() => inbox.length === burst.length + 1, 'the whole burst', 20_000);
  assert.deepEqual(inbox.slice(1), burst);
});

test('a send right after a remote leave and rejoin over HyperDHT reaches the peer', { timeout: 60_000 }, async t => {
  const [a, b] = await swarmPair(t);
  const official = 'soc/official';
  assert.ok(await a.join(official));
  assert.ok(await b.join(official));
  const inbox = [];
  b.on('message', (_, env) => inbox.push(env.message.text));
  await until(() => {
    if (!inbox.length) a.send(official, post('first'));
    return inbox.length > 0;
  }, 'an open session', 20_000);
  for (let round = 0; round < 3; round++) {
    assert.ok(await b.leave(official));
    assert.ok(a.send(official, post('while away ' + round)));
    await delay(200);
    assert.ok(await b.join(official));
    // b's open is still in flight: a holds the closed session the leave left behind.
    assert.ok(a.send(official, post('rejoined ' + round)));
    await until(() => inbox.includes('rejoined ' + round), 'the first send after rejoin ' + round);
  }
  assert.ok(!inbox.some(text => text.startsWith('while away')));
});

test('HyperDHT connections use the swarm keys while signatures and owner checks use the identities', { timeout: 60_000 }, async t => {
  // Every session the managed sidechannel opens records the transport key of the connection it runs on.
  const remoteKeys = new Set();
  const open = ManagedSidechannel.prototype._openChannelForConnection;
  t.mock.method(ManagedSidechannel.prototype, '_openChannelForConnection', function (connection, ...rest) {
    if (connection.remotePublicKey) remoteKeys.add(connection.remotePublicKey.toString('hex'));
    return open.call(this, connection, ...rest);
  });
  const [a, b] = await swarmPair(t);
  for (const peer of [a, b]) assert.notEqual(peer.swarmPublicKey, peer.publicKey);
  const official = 'soc/official';
  const own = 'soc/u/' + b.publicKey;
  for (const channel of [official, own]) {
    assert.ok(await a.join(channel));
    assert.ok(await b.join(channel));
  }
  const atA = [];
  const atB = [];
  a.on('message', (_, env) => { if (env.from !== a.publicKey) atA.push(env); });
  b.on('message', (_, env) => { if (env.from !== b.publicKey) atB.push(env); });
  await until(() => {
    if (!atB.length) a.send(official, post('root notice'));
    if (!atA.length) b.send(own, post('my own channel'));
    return atA.length > 0 && atB.length > 0;
  }, 'owner-only posts both ways', 20_000);
  assert.equal(atB[0].from, a.publicKey);
  assert.equal(atA[0].from, b.publicKey);
  assert.equal(b.send(official, post('not the root')), false);
  assert.equal(a.send(own, post('not the owner')), false);
  assert.deepEqual([...remoteKeys].sort(), [a.swarmPublicKey, b.swarmPublicKey].sort());
  for (const identity of [a.publicKey, b.publicKey]) assert.ok(!remoteKeys.has(identity));
});

test('relayed copies carry no relayedBy stamp naming the relaying identity', async t => {
  const relayed = [];
  const receive = ManagedSidechannel.prototype._receiveManaged;
  t.mock.method(ManagedSidechannel.prototype, '_receiveManaged', function (entry, connection, frame, policy) {
    if (frame?.payload?.message?.t === 'post' && frame.payload.ttl < 3) relayed.push(frame.payload);
    return receive.call(this, entry, connection, frame, policy);
  });
  const hub = createMemoryHub();
  const peers = [0, 1, 2].map(() => new MemoryTransport({ hub, skipPow: true }));
  t.after(() => Promise.all(peers.map(peer => peer.close())));
  for (const peer of peers) assert.ok(await peer.join('gator/new'));
  const [a, b, c] = peers;
  const got = new Set();
  for (const peer of [b, c]) peer.on('message', (_, env) => { if (env.from === a.publicKey) got.add(peer); });
  await until(() => {
    if (got.size < 2) a.send('gator/new', post('relay me'));
    return got.size === 2;
  }, 'both receivers');
  await until(() => relayed.length > 0, 'a relayed copy');
  for (const frame of relayed) {
    assert.equal(Object.hasOwn(frame, 'relayedBy'), false);
    assert.equal(frame.from, a.publicKey);
  }
});

test('received envelopes keep the verified fields and only the metadata needed to rebroadcast', () => {
  const content = { kind: 'sidechannel_message_v1', id: 'k:1:x', channel: 'gator/new', from: 'a'.repeat(64),
    origin: 'a'.repeat(64), ts: 1, message: { t: 'post', v: 1, text: 'hi' }, verified: true };
  const wire = { type: 'sidechannel', ...content, verified: undefined, kind: undefined, ttl: 2, relayedBy: 'b'.repeat(64),
    sig: 'C'.repeat(128), pow: { nonce: 7, difficulty: 10, extra: 'x' }, padding: 'x'.repeat(100) };
  assert.deepEqual(receivedEnvelope(content, wire), { type: 'sidechannel', id: 'k:1:x', channel: 'gator/new',
    from: 'a'.repeat(64), origin: 'a'.repeat(64), ts: 1, message: content.message, ttl: 2, sig: 'c'.repeat(128),
    pow: { nonce: 7, difficulty: 10 } });
  assert.equal(receivedEnvelope({ ...content, verified: false }, wire), null);
  assert.equal(receivedEnvelope(content, { ...wire, sig: undefined }), null);
  assert.equal(receivedEnvelope({ ...content, message: null }, wire), null);
  const { origin, ...noOrigin } = content;
  const bare = receivedEnvelope({ ...noOrigin, origin: null }, { sig: 'c'.repeat(128) });
  assert.deepEqual(Object.keys(bare), ['type', 'id', 'channel', 'from', 'ts', 'message', 'sig']);
});
