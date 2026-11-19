import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import { startAddon } from '../src/addon.js';
import { call, ROOT, until } from './helpers.js';

// Real Hyperswarm on a local HyperDHT testnet: own keys, real PoW, signatures and owner-only checks.
test('standalone mode: own key, posts reach a follower over Hyperswarm', { timeout: 120_000 }, async t => {
  const testnet = await createTestnet(3);
  const dir = await mkdtemp(join(import.meta.dirname, 'scratch-'));
  const running = [];
  t.after(async () => {
    for (const addon of running.reverse()) await addon.close();
    await testnet.destroy();
    await rm(dir, { recursive: true, force: true });
  });
  const start = async name => {
    const addon = await startAddon({ dataDir: join(dir, name), bootstrap: testnet.bootstrap, rootKey: ROOT,
      product: 'gator', agentPosting: true, proofs: false, profile: 'small', identityLock: { dir: join(dir, 'locks') } });
    running.push(addon);
    return addon;
  };
  const a = await start('a');
  const b = await start('b');
  assert.equal(a.mode, 'standalone');
  for (const filename of ['peer.json', 'swarm.json']) {
    const keyFile = join(dir, 'a', 'keys', filename);
    assert.ok(existsSync(keyFile));
    if (process.platform !== 'win32') assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  }
  assert.notEqual(a.publicKey, b.publicKey);

  assert.equal((await call(b, 'follow', { key: a.publicKey })).value.changed, true);
  await until(() => a.transport.peerCount() > 0 && b.transport.peerCount() > 0, { timeout: 60_000, step: 100 });
  let sent = 0;
  const post = await until(async () => {
    // Retry until b's subscription to a's channel is connected (topic discovery takes a moment).
    // Distinct texts: near-duplicates are refused, and the rate limit allows 10 posts per 10 minutes.
    if (sent++ < 8) await call(a, 'feed_post', { text: 'standalone hello ' + randomUUID() });
    return (await call(b, 'feed_read', {})).value.posts.find(p => p.key === a.publicKey);
  }, { timeout: 60_000, step: 1000 });
  assert.match(post.untrustedText, /^standalone hello [0-9a-f-]{36}$/);

  // The identity survives a restart.
  const key = a.publicKey;
  await a.close();
  running.splice(running.indexOf(a), 1);
  const again = await start('a');
  assert.equal(again.publicKey, key);
});
