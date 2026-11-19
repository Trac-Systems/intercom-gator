import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bundleDigest, loadBundle, signBundle } from '@gator/bundle';
import { createMemoryHub, MemoryTransport } from '@gator/net';
import { openStore } from '@gator/store';
import { Engine, migrations } from '@gator/engine';
import { seedPublicKey } from '../../engine/src/patches/root.js';
import { main } from '../src/cli.js';

async function until(check, what) {
  const deadline = performance.now() + 8000;
  while (!check()) {
    if (performance.now() > deadline) assert.fail('Timed out waiting for ' + what);
    await delay(10);
  }
}

test('root patch signs against the effective digest and root publish delivers it over gator/ctl', async t => {
  const dir = mkdtempSync(join(import.meta.dirname, 'root-'));
  const seed = randomBytes(32), seedHex = seed.toString('hex'), rootKey = seedPublicKey(seed);
  const hub = createMemoryHub();
  let engine, store;
  t.after(async () => {
    try { await engine?.stop(); store?.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  // A small release signed by an ephemeral root (fixture seam, like createGator's options.release).
  const bundle = structuredClone(loadBundle());
  bundle.exchanges = bundle.exchanges.filter(e => e.id === 'bitstamp');
  bundle.tokens.tokens = bundle.tokens.tokens.filter(x => ['bitcoin:native', 'ethereum:native'].includes(x.id));
  for (const x of bundle.tokens.tokens) x.links = [];
  bundle.chains = bundle.chains.filter(c => ['bitcoin', 'ethereum'].includes(c.id));
  bundle.paidExtras = Object.fromEntries(bundle.chains.map(c => [c.id, bundle.paidExtras?.[c.id] ?? '']));
  bundle.dex.evm = bundle.dex.evm.filter(c => c.chain === 'ethereum');
  const source = join(dir, 'release');
  mkdirSync(source);
  for (const [name, value] of Object.entries(bundle)) writeFileSync(join(source, name + '.json'), JSON.stringify(value));
  writeFileSync(join(source, 'bundle.sig'), signBundle(bundleDigest(bundle), seed));
  const release = { dir: source, rootKey };
  const releaseDigest = bundleDigest(bundle);
  const eth = bundle.chains.findIndex(c => c.id === 'ethereum');

  const seedFile = join(dir, 'root.seed');
  writeFileSync(seedFile, seedHex + '\n', { mode: 0o600 });
  const opsFile = join(dir, 'ops.json');
  const out = join(dir, 'patch.json');
  const data = join(dir, 'node');
  mkdirSync(data, { mode: 0o700 });
  const lines = [];
  const published = [];
  const io = { log: line => lines.push(line), release, linger: 20,
    transport: o => {
      const transport = new MemoryTransport({ hub, wallet: o.wallet, rootKey: o.rootKey, skipPow: true });
      transport.on('message', (channel, envelope) => { if (channel === 'gator/ctl') published.push(envelope); });
      return transport;
    } };

  // A running node on the same network, storing its chain in the data directory the root tool reads.
  store = openStore({ file: join(data, 'gator.db'), migrations, profile: 'small' });
  engine = new Engine({ bundle: loadBundle({ dir: source, rootPubKeyHex: rootKey }), store, backgroundJobs: [],
    transport: new MemoryTransport({ hub, rootKey, skipPow: true }),
    rpcConfig: { fetch: async () => new Response('{}', { status: 503 }) }, patches: { rootKey, log: () => {} } });
  await engine.start();

  writeFileSync(opsFile, JSON.stringify([
    { op: 'replace', path: `/chains/${eth}/endpoints/0/url`, value: 'https://rpc.root-tool.example/eth' }]));
  await main(['--data', data, 'root', 'patch', '--ops', opsFile, '--seed-file', seedFile, '--out', out], io);
  const first = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(first), ['t', 'v', 'seq', 'patch']);
  assert.equal(first.patch.baseDigest, releaseDigest);
  assert.deepEqual(JSON.parse(lines.at(-1)), { seq: first.seq, baseDigest: releaseDigest,
    newDigest: first.patch.newDigest, ops: 1, chain: 0, stored: 'ok', out });

  await main(['root', 'publish', '--seed-file', seedFile, '--patch', out, '--wait', '5'], io);
  assert.equal(JSON.parse(lines.at(-1)).sent, true);
  await until(() => engine.patches.head === first.patch.newDigest, 'the first patch on the node');
  assert.ok(engine.rpc.chains.get('ethereum').some(e => e.url === 'https://rpc.root-tool.example/eth'));

  // The next patch is built on the node's stored chain (read-only while the node runs).
  writeFileSync(opsFile, JSON.stringify([
    { op: 'replace', path: `/chains/${eth}/endpoints/1/url`, value: 'https://rpc.root-tool-2.example/eth' }]));
  await main(['--data', data, 'root', 'patch', '--ops', opsFile, '--seed-file', seedFile, '--out', out], io);
  const second = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(second.patch.baseDigest, first.patch.newDigest);
  assert.ok(second.seq > first.seq);
  await main(['root', 'publish', '--seed-file', seedFile, '--patch', out, '--wait', '5'], io);
  await until(() => engine.patches.head === second.patch.newDigest, 'the second patch on the node');
  assert.equal(engine.patches.chain.length, 2);

  const feedFile = join(dir, 'feed.json');
  const exportFeed = () => main(['root', 'feed', '--data', data, '--out', feedFile], io);
  await exportFeed();
  const exported = readFileSync(feedFile, 'utf8');
  assert.deepEqual(JSON.parse(exported), { v: 1, release: releaseDigest, envelopes: published });
  assert.equal(JSON.parse(lines.at(-1)).envelopes, 2);

  // Older databases retained only the inner message. An exact re-delivery can restore its signed copy.
  store.writer.prepare('UPDATE engine_patches SET envelope=NULL WHERE seq=?').run(first.seq);
  await assert.rejects(exportFeed(), /Missing signed envelope/);
  assert.equal(readFileSync(feedFile, 'utf8'), exported);
  engine.receive('gator/ctl', published[0]);
  await exportFeed();
  assert.equal(readFileSync(feedFile, 'utf8'), exported);

  const forged = { ...published[1], message: { ...second, seq: second.seq + 1 } };
  store.writer.prepare('UPDATE engine_patches SET envelope=? WHERE seq=?').run(JSON.stringify(forged), second.seq);
  await assert.rejects(exportFeed(), /Invalid stored patch envelope/);
  assert.equal(readFileSync(feedFile, 'utf8'), exported);

  // A freshly published release-based patch replaces both older links in the export.
  await main(['root', 'patch', '--data', data, '--ops', opsFile, '--seed-file', seedFile, '--from-release', '--out', out], io);
  const rebase = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(rebase.patch.baseDigest, releaseDigest);
  await main(['root', 'publish', '--seed-file', seedFile, '--patch', out, '--wait', '5'], io);
  await until(() => engine.patches.seq === rebase.seq, 'the cumulative patch on the node');
  await exportFeed();
  assert.deepEqual(JSON.parse(readFileSync(feedFile, 'utf8')), { v: 1, release: releaseDigest, envelopes: [published.at(-1)] });

  // Receiver rules run before signing: a private endpoint is refused locally.
  writeFileSync(opsFile, JSON.stringify([
    { op: 'replace', path: `/chains/${eth}/endpoints/2/url`, value: 'https://192.168.1.20/rpc' }]));
  await assert.rejects(main(['--data', data, 'root', 'patch', '--ops', opsFile, '--seed-file', seedFile], io),
    /Receivers would reject this patch: url \(host\)/);

  // Wrong, malformed and group-readable seed files fail without echoing any content.
  const other = join(dir, 'other.seed');
  const otherHex = randomBytes(32).toString('hex');
  writeFileSync(other, otherHex, { mode: 0o600 });
  const errors = [];
  for (const [file, pattern] of [[other, /does not belong to the root key/]]) {
    await assert.rejects(main(['root', 'patch', '--ops', opsFile, '--seed-file', file, '--data', data], io),
      e => { errors.push(e.message); return pattern.test(e.message); });
    await assert.rejects(main(['root', 'publish', '--patch', out, '--seed-file', file], io),
      e => { errors.push(e.message); return pattern.test(e.message); });
  }
  const malformed = join(dir, 'bad.seed');
  writeFileSync(malformed, seedHex.slice(0, 63) + 'z', { mode: 0o600 });
  await assert.rejects(main(['root', 'publish', '--patch', out, '--seed-file', malformed], io),
    e => { errors.push(e.message); return /64 hex characters/.test(e.message); });
  if (process.platform !== 'win32') {
    chmodSync(seedFile, 0o644);
    await assert.rejects(main(['root', 'publish', '--patch', out, '--seed-file', seedFile], io),
      e => { errors.push(e.message); return /chmod 600/.test(e.message); });
  }

  // The seed never appears in output, errors or the patch file, and publish leaves no temporary directory behind.
  for (const text of [...lines, ...errors, readFileSync(out, 'utf8')]) {
    assert.ok(!text.includes(seedHex) && !text.includes(seedHex.slice(0, 63)) && !text.includes(otherHex), text);
  }
  assert.deepEqual(readdirSync(dir).sort(), ['bad.seed', 'feed.json', 'node', 'ops.json', 'other.seed', 'patch.json', 'release', 'root.seed']);
});
