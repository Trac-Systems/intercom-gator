import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import createTestnet from 'hyperdht/testnet.js';
import { SwarmTransport, keyFromSeed } from '../src/index.js';

const wallet = () => keyFromSeed(randomBytes(32).toString('hex'));

test('a serving node relays, clients carry the release list, and direct traffic still flows', { timeout: 60_000 }, async t => {
  const net = await createTestnet(3);
  const dir = mkdtempSync(join(import.meta.dirname, 'relay-'));
  const peers = [];
  t.after(async () => {
    try { await Promise.all(peers.map(p => p.close())); }
    finally { await net.destroy(); rmSync(dir, { recursive: true, force: true }); }
  });
  const owner = wallet(), rootKey = owner.publicKey.toString('hex');
  const make = (w, blindRelay) => {
    const p = new SwarmTransport({ dataDir: join(dir, w.publicKey.toString('hex')), wallet: w, bootstrap: net.bootstrap,
      rootKey, blindRelay });
    peers.push(p);
    return p;
  };
  // The relay ships its own key in the release list: a node never relays through itself.
  const relayWallet = wallet();
  const relayDir = join(dir, relayWallet.publicKey.toString('hex'));
  const probe = new SwarmTransport({ dataDir: relayDir, wallet: relayWallet, bootstrap: net.bootstrap, rootKey });
  const relayKey = probe.swarmPublicKey;
  await probe.close();
  const relay = make(relayWallet, { serve: true, defaults: [relayKey] });
  const a = make(owner, { defaults: [relayKey] });
  const b = make(wallet(), { defaults: [relayKey] });
  assert.equal(make(wallet(), null).relayStats(), null, 'off without serve or relays');
  const channel = 'gator/px/7', seen = [];
  b.on('message', (c, e) => { if (c === channel && e.from === a.publicKey) seen.push(e.message.text); });
  for (const p of [relay, a, b]) assert.ok(await p.join(channel));
  for (let i = 0; i < 400 && !(a.peerCount() >= 2 && b.peerCount() >= 2); i++) await delay(25);
  assert.ok(a.peerCount() >= 2 && b.peerCount() >= 2, 'three connected peers');
  assert.equal(relay.relayStats().serving, true);
  assert.deepEqual(relay.relayStats().configured_relays, []);
  assert.deepEqual(a.relayStats().configured_relays, [relayKey]);
  assert.equal(a.relayStats().started, true);
  assert.ok(a.send(channel, { t: 'post', v: 1, text: 'through' }));
  for (let i = 0; i < 400 && !seen.includes('through'); i++) await delay(25);
  assert.ok(seen.includes('through'), 'direct connections pass the relay firewall hook');
  // Root network settings replace the release list; a key given at start would stay.
  const other = randomBytes(32).toString('hex');
  assert.deepEqual(a.setRelays([other]), [other]);
  assert.deepEqual(a.relayStats().configured_relays, [other]);
  assert.throws(() => a.setRelays(['nope']), /Invalid blind relay public key/);
});
