import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import DHT from 'hyperdht';
import Hyperswarm from 'hyperswarm';
import createTestnet from 'hyperdht/testnet.js';
import { keyFromSeed } from '../src/index.js';
import { SidechannelTransport } from '../src/sidechannel-transport.js';
import { relayFaults } from './helpers/blind-relay-faults.js';

const wallet = () => keyFromSeed(randomBytes(32).toString('hex'));

// Every gator channel (official, own social, directory, price data) is a topic on the same Hyperswarm connection
// between two peers, so one relayed connection must carry all of them. B accepts no direct connection at all.
test('a peer that cannot connect directly gets social, directory and data channels through the relay', { timeout: 120_000 }, async t => {
  const net = await createTestnet(3, { host: '127.0.0.1' });
  const dir = mkdtempSync(join(import.meta.dirname, 'relay-ch-'));
  const nodes = [];
  t.after(async () => {
    try { await Promise.all(nodes.map(n => n.transport.close())); }
    finally { await net.destroy(); rmSync(dir, { recursive: true, force: true }); }
  });
  const isolated = DHT.keyPair(), root = wallet(), rootKey = root.publicKey.toString('hex');
  const markers = ['relay-marker-official', 'relay-marker-own', 'relay-marker-dir', 'relay-marker-all', 'relay-marker-px'];
  async function node(w, keyPair, blindRelay, capture = false) {
    const dht = net.createNode({ quickFirewall: false });
    await dht.fullyBootstrapped();
    const n = { swarm: null };
    n.transport = new SidechannelTransport({
      wallet: w, seenDir: join(dir, randomBytes(4).toString('hex')), rootKey, skipPow: true, blindRelay,
      createSwarm: () => (n.swarm = new Hyperswarm({ dht, keyPair, backoffs: [50, 100, 200], jitter: 0 })),
    });
    n.audit = relayFaults(n, isolated.publicKey.toString('hex'), { capture, markers });
    nodes.push(n);
    return n;
  }
  const limits = { directTimeoutMs: 250, relayTimeoutMs: 10_000 };
  const relayKeyPair = DHT.keyPair(), relayKey = relayKeyPair.publicKey.toString('hex');
  const relay = await node(wallet(), relayKeyPair, { serve: true, ...limits }, true);
  const a = await node(root, DHT.keyPair(), { defaults: [relayKey], ...limits });
  const b = await node(wallet(), isolated, { defaults: [relayKey], ...limits });
  // The relay only relays here (it joins an unrelated channel to start), so nothing can reach B through its rebroadcast.
  assert.ok(await relay.transport.join('gator/px/15'));
  const channels = ['soc/official', 'soc/u/' + rootKey, 'soc/dir', 'soc/all', 'gator/px/3'];
  // Publish before B joins. B will receive this signed original inside the public wrapper.
  assert.ok(await a.transport.join('soc/u/' + rootKey));
  let original;
  a.transport.once('message', (_channel, e) => { original = e; });
  assert.ok(a.transport.send('soc/u/' + rootKey, { t: 'post', v: 1, text: 'relay-marker-all' }));
  const got = new Map();
  b.transport.on('message', (channel, envelope) => {
    if (envelope.from === rootKey) got.set(channel, channel === 'soc/all'
      ? envelope.message.original?.message.text : envelope.message.text);
  });
  for (const n of [a, b]) for (const channel of channels) assert.ok(await n.transport.join(channel), channel);
  const deadline = Date.now() + 90_000;
  while (got.size < channels.length && Date.now() < deadline) {
    for (const [i, channel] of channels.entries()) {
      if (!got.has(channel)) a.transport.send(channel, channel === 'soc/all'
        ? { t: 'share', v: 1, original } : { t: 'post', v: 1, text: markers[i] });
    }
    await delay(500);
  }
  assert.deepEqual(channels.map(c => got.get(c)), markers, 'every channel arrived at the isolated peer');
  const bPeers = b.audit().paths.map(p => p.peer);
  assert.ok(bPeers.includes(rootKey) === false, 'identity keys never appear as connection keys');
  assert.ok(b.swarm.connections.size >= 1);
  assert.ok(b.transport.relayStats().relay_connections >= 1, 'B connected through the relay');
  assert.ok(relay.transport.relayStats().pairs_relayed >= 1, 'the relay paired the two peers');
  const audit = relay.audit();
  assert.ok(audit.ciphertextBytes > 0, 'the relay forwarded the traffic');
  assert.equal(audit.plaintextMatches, 0, 'the relay never saw a message in plaintext');
});
