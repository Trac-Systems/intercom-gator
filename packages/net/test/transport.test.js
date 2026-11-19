import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import createTestnet from 'hyperdht/testnet.js';
import PeerWallet from 'trac-wallet';
import { MemoryTransport, SwarmTransport, createMemoryHub, keyFromSeed, policyFor } from '../src/index.js';
import { MAX_RELAY_TTL } from '../src/sidechannel-transport.js';

const newWallet = () => keyFromSeed(randomBytes(32).toString('hex'));
const post = text => ({ t: 'post', v: 1, text });

async function until(check, description) {
  const deadline = performance.now() + 8000;
  while (!check()) {
    if (performance.now() >= deadline) assert.fail('Timed out waiting for ' + description);
    await delay(10);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function signedAndMined(envelope, bits) {
  const { id, channel, from, origin, ts, message, sig, pow } = envelope;
  const fields = { id, channel, from, origin, ts, message };
  const base = JSON.stringify(canonical({ ...fields, kind: 'sidechannel_message_v1' }));
  assert.ok(PeerWallet.verify(Buffer.from(sig, 'hex'), Buffer.from(base), Buffer.from(from, 'hex')));
  const work = JSON.stringify(canonical({ ...fields, nonce: pow.nonce }));
  assert.equal(pow.difficulty, bits);
  assert.ok(createHash('sha256').update(work).digest().readUInt16BE() < 2 ** (16 - bits));
}

for (const kind of ['Swarm', 'Memory']) {
  test(kind + 'Transport over two and three peers', { timeout: 60_000 }, async t => {
    const net = kind === 'Swarm' ? await createTestnet(3) : null;
    const hub = createMemoryHub();
    const dir = mkdtempSync(join(import.meta.dirname, 'peers-'));
    const peers = [];
    t.after(async () => {
      try {
        await Promise.all(peers.map(peer => peer.close()));
      } finally {
        await net?.destroy();
        rmSync(dir, { recursive: true, force: true });
      }
    });
    const ownerWallet = newWallet();
    const rootKey = ownerWallet.publicKey.toString('hex');
    function peer(wallet = newWallet(), options = {}) {
      const p = net
        ? new SwarmTransport({ dataDir: join(dir, wallet.publicKey.toString('hex')), wallet,
          bootstrap: net.bootstrap, rootKey, ...options })
        : new MemoryTransport({ hub, wallet, rootKey, ...options });
      peers.push(p);
      return p;
    }

    const a = peer(ownerWallet);
    const listenerWallet = newWallet();
    const b = peer(listenerWallet);
    const data = 'gator/px/7';
    const official = 'soc/official';
    const messages = [];
    b.on('message', (channel, envelope) => {
      assert.equal(envelope.channel, channel);
      messages.push(envelope);
    });
    const find = text => messages.find(e => e.message.text === text);
    const counts = [];
    b.on('peer', count => counts.push(count));
    async function barrier(sender, label) {
      assert.ok(sender.send(data, post(label)));
      await until(() => find(label), label);
    }

    await t.test('two peers discover each other and exchange real signatures and size-scaled PoW', async () => {
      assert.ok(await a.join(data));
      assert.ok(await b.join(data));
      await until(() => a.peerCount() === 1 && b.peerCount() === 1, 'two connected peers');
      assert.ok(counts.includes(1));
      const text = 'o'.repeat(1500);
      const message = post(text);
      assert.ok(a.send(data, message));
      message.text = 'changed after send';
      await until(() => find(text), 'signed observations');
      signedAndMined(find(text), 9);
      const replies = [];
      a.on('message', (_, env) => replies.push(env));
      assert.ok(b.send(data, post('return path')));
      await until(() => replies.length, 'signed return message');
      signedAndMined(replies[0], 8);
    });

    const thirdWallet = newWallet();
    const c = peer(thirdWallet);
    const receivedByThird = [];
    c.on('message', (_, env) => receivedByThird.push(env));
    assert.ok(await c.join(data));
    await until(() => peers.every(p => p.peerCount() === 2), 'three connected peers');

    await t.test('send emits its own complete signed envelope locally exactly once', async () => {
      const own = [];
      const listener = (channel, env) => { if (env.from === a.publicKey) own.push([channel, env]); };
      a.on('message', listener);
      try {
        assert.ok(a.send(data, post('my own copy')));
        assert.equal(own.length, 1, 'emitted synchronously');
        const [channel, echo] = own[0];
        assert.equal(channel, data);
        signedAndMined(echo, 8);
        assert.deepEqual(Object.keys(echo).sort(),
          ['channel', 'from', 'id', 'message', 'origin', 'pow', 'sig', 'ts', 'ttl', 'type']);
        assert.equal(echo.ttl, 3);
        await until(() => find('my own copy') && receivedByThird.some(e => e.id === echo.id), 'remote copies');
        // Receivers rebuild the same envelope from the verified fields; only the hop count may differ.
        const strip = ({ ttl, ...rest }) => rest;
        assert.deepEqual(strip(find('my own copy')), strip(echo));
        await barrier(c, 'after own copy');
        await barrier(b, 'relays settled');
        assert.equal(own.filter(([, e]) => e.id === echo.id).length, 1);
        assert.ok(a.rebroadcast(echo));
        await barrier(c, 'after own replay');
        assert.equal(own.filter(([, e]) => e.id === echo.id).length, 1);
      } finally {
        a.off('message', listener);
      }
    });

    await t.test('setRelayTtl applies the clamped hop count to later sends', async () => {
      assert.throws(() => a.setRelayTtl(1.5), TypeError);
      assert.throws(() => a.setRelayTtl('2'), TypeError);
      assert.equal(a.setRelayTtl(100), MAX_RELAY_TTL);
      assert.equal(a.setRelayTtl(-1), 0);
      const echoes = [];
      const listener = (_, env) => { if (env.from === a.publicKey) echoes.push(env); };
      a.on('message', listener);
      try {
        assert.equal(a.setRelayTtl(1), 1);
        assert.ok(a.send(data, post('one hop')));
        assert.equal(echoes.at(-1).ttl, 1);
        await until(() => find('one hop'), 'one-hop message');
        assert.ok(find('one hop').ttl <= 1);
        assert.equal(a.setRelayTtl(100), MAX_RELAY_TTL);
        assert.ok(a.send(data, post('max hops')));
        assert.equal(echoes.at(-1).ttl, MAX_RELAY_TTL);
        await until(() => find('max hops'), 'max-hop message');
        assert.ok(find('max hops').ttl >= MAX_RELAY_TTL - 1);
      } finally {
        a.off('message', listener);
        a.setRelayTtl(3);
      }
    });

    await t.test('owner-write-only is enforced at both the sender and receiver', async () => {
      assert.ok(await a.join(official));
      assert.ok(await b.join(official));
      // Third peer deliberately configures a different owner on its own node.
      assert.ok(await c.join(official, policyFor(official, { rootKey: c.publicKey })));
      assert.equal(b.send(official, post('denied locally')), false);
      assert.ok(c.send(official, post('denied remotely')));
      await barrier(c, 'after non-owner');
      assert.ok(a.send(official, post('official post')));
      await until(() => find('official post'), 'authorized owner post');
      assert.equal(find('official post').from, a.publicKey);
      assert.equal(find('denied remotely'), undefined);
    });

    await t.test('a receiver drops a bad signature, missing work and an oversized frame', async () => {
      const invalidSig = t.mock.method(thirdWallet, 'sign', () => Buffer.alloc(64));
      try {
        // The managed sender checks its own signature before anything is sent or echoed.
        const ownCopies = receivedByThird.length;
        assert.equal(c.send(data, post('bad signature')), false);
        assert.equal(receivedByThird.length, ownCopies);
        // Skip that local check once so the receivers' own verification is what drops it.
        const verify = t.mock.method(PeerWallet, 'verify', () => true);
        try {
          assert.ok(c.send(data, post('bad signature')));
        } finally {
          verify.mock.restore();
        }
      } finally {
        invalidSig.mock.restore();
      }
      const custom = 'test/work';
      assert.ok(await c.join(custom, { powDifficulty: 0 }));
      assert.ok(await b.join(custom, { powDifficulty: 8 }));
      assert.ok(c.send(custom, post('missing work')));
      // A sender refuses a frame its own channel policy would drop; a looser sender is dropped remotely.
      const oversized = 'x'.repeat(16384);
      assert.equal(a.send(data, post(oversized)), false);
      const sized = 'test/size';
      assert.ok(await c.join(sized, { powDifficulty: 0 }));
      assert.ok(await b.join(sized, { powDifficulty: 0, maxReceiveBytes: 16384 }));
      await until(() => {
        if (!find('size channel open')) c.send(sized, post('size channel open'));
        return find('size channel open');
      }, 'size channel open');
      assert.ok(c.send(sized, post(oversized)));
      // The large frame backpressures the c→b stream; the barrier queues behind it.
      await barrier(c, 'after oversized');
      await barrier(c, 'after invalid signature and work');
      assert.equal(find('bad signature'), undefined);
      assert.equal(find('missing work'), undefined);
      assert.equal(find(oversized), undefined);
    });

    await t.test('a third peer rebroadcasts an unchanged signature once per seen window', async () => {
      await barrier(a, 'repeat this');
      await until(() => receivedByThird.some(e => e.message.text === 'repeat this'), 'third peer copy');
      const original = receivedByThird.find(e => e.message.text === 'repeat this');
      const saved = { ...original, ttl: 0 };
      const copies = () => messages.filter(e => e.id === original.id);
      assert.equal(c.rebroadcast({ ...saved, message: post('edited content') }), false);
      assert.ok(c.rebroadcast(saved));
      await barrier(c, 'first replay barrier');
      assert.equal(copies().length, 1);
      const future = Date.now() + 3 * 3_600_000 + 1;
      const clock = t.mock.method(Date, 'now', () => future);
      try {
        assert.ok(c.rebroadcast(saved));
        await until(() => copies().length === 2, 'replay after expiry');
        assert.ok(copies()[1].ttl > 0);
        assert.equal(copies()[1].sig, saved.sig);
        assert.deepEqual(copies()[1].message, saved.message);
        assert.equal(saved.ttl, 0);
        // Intercom coalesces an immediate repeat of a successful replay for one second.
        assert.equal(c.rebroadcast(saved), false);
        await barrier(c, 'second replay barrier');
        assert.equal(copies().length, 2);
      } finally {
        clock.mock.restore();
      }
    });

    await t.test('leave closes a channel while other traffic continues; rejoin restores delivery', async () => {
      assert.ok(await b.leave(official));
      assert.ok(!b.channels().includes(official));
      assert.equal(await b.leave(official), false);
      assert.ok(a.send(official, post('left behind')));
      await barrier(a, 'still connected');
      assert.equal(find('left behind'), undefined);
      assert.ok(await b.join(official));
      assert.ok(a.send(official, post('rejoined')));
      await until(() => find('rejoined'), 'message after rejoin');
      assert.equal(find('left behind'), undefined);
    });

    if (net) await t.test('the three-hour seen cache survives a peer restart', async () => {
      await barrier(a, 'persist my id');
      await until(() => receivedByThird.some(e => e.message.text === 'persist my id'), 'saved replay');
      const original = receivedByThird.find(e => e.message.text === 'persist my id');
      const seenDir = join(dir, b.publicKey, 'seen');
      assert.ok(readdirSync(seenDir).some(name => /^seen-\d+\.bin$/.test(name)));
      await b.close();
      await until(() => c.peerCount() === 1, 'old listener to disconnect');
      const restored = peer(listenerWallet);
      const inbox = [];
      restored.on('message', (_, env) => inbox.push(env));
      assert.ok(await restored.join(data));
      await until(() => c.peerCount() === 2 && restored.peerCount() === 2, 'restarted listener');
      assert.ok(c.send(data, post('restart ready')));
      await until(() => inbox.some(e => e.message.text === 'restart ready'), 'reopened channels');
      assert.ok(c.rebroadcast(original));
      assert.ok(c.send(data, post('after restart replay')));
      await until(() => inbox.some(e => e.message.text === 'after restart replay'), 'restart barrier');
      assert.equal(inbox.filter(e => e.id === original.id).length, 0);
    });
    if (net) await t.test('a failed seen-directory startup can be retried on the same transport', async () => {
      const seenDir = join(dir, 'retry-seen');
      writeFileSync(seenDir, '');
      const retry = peer(newWallet(), { seenDir });
      await assert.rejects(retry.join('gator/new'), { code: 'EEXIST' });
      unlinkSync(seenDir);
      assert.ok(await retry.join('gator/new'));
      assert.deepEqual(retry.channels(), ['gator/new']);
    });
  });
}

test('MemoryTransport test switches, concurrent channel cap, idempotent join and close', async t => {
  const hub = createMemoryHub();
  const a = new MemoryTransport({ hub, skipPow: true, maxChannels: 1 });
  const b = new MemoryTransport({ hub, skipPow: true });
  t.after(() => Promise.all([a.close(), b.close()]));
  assert.deepEqual(await Promise.all([a.join('soc/dir'), a.join('gator/new')]), [true, false]);
  assert.ok(await a.join('soc/dir'));
  assert.equal(await a.join('soc/dir', { maxReceiveBytes: 1024 }), false);
  assert.ok(await b.join('soc/dir'));
  const inbox = [];
  b.on('message', (_, env) => inbox.push(env));
  assert.ok(a.send('soc/dir', post('quick')));
  await until(() => inbox.length, 'test-mode message');
  assert.equal(inbox[0].pow, undefined);
  assert.match(inbox[0].sig, /^[a-f0-9]{128}$/);
  assert.equal(a.send('unjoined', post('no')), false);
  await Promise.all([a.close(), a.close()]);
  assert.equal(await a.join('soc/dir'), false);
  assert.equal(a.send('soc/dir', post('closed')), false);
  assert.equal(a.peerCount(), 0);
  assert.deepEqual(a.channels(), []);
  await until(() => b.peerCount() === 0, 'peer count on close');
});
