import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fixture } from './fixtures.js';
import { loadConfig, patchConfig, rpcEndpoints, storageCapBytes } from '../src/config.js';
import { PROFILE_LIMITS } from '@gator/store';
import { verifyRelease } from '../src/bundle.js';

test('release verification binds the data to an independently pinned key', async t => {
  const { release } = fixture(t);
  assert.equal((await verifyRelease(release)).digest.length, 64);
  await assert.rejects(verifyRelease({ dir: release.dir }), /signature/);
  writeFileSync(join(release.dir, 'bundle.sig'), '');
  await assert.rejects(verifyRelease(release), /signature/);
});

test('the release hands the engine its extension and its shipped patch snapshot path, outside the digest', async t => {
  const shipped = await verifyRelease();
  assert.equal(shipped.digest, '2e7fd025868071e3a31a8dc5f6b8041f7e9a359dbacffc00bb43db39e721a7bb');
  assert.equal(shipped.extensions.v, 1);
  assert.ok(shipped.snapshot.endsWith(join('data', 'patches', shipped.digest + '.json')));
  const f = fixture(t);
  const plain = await verifyRelease(f.release);
  assert.equal(plain.extensions, null);
  assert.equal(plain.snapshot, join(f.release.dir, 'patches', plain.digest + '.json'));
  // A broken extension is ignored with a warning; the signed data and its digest are unaffected.
  const warnings = [];
  t.mock.method(process, 'emitWarning', line => warnings.push(line));
  writeFileSync(join(f.release.dir, 'release-extensions.json'), '{"v":2}');
  const broken = await verifyRelease(f.release);
  assert.equal(broken.extensions, null);
  assert.equal(broken.digest, plain.digest);
  assert.match(warnings.join(), /Release extensions ignored/);
  const app = await f.start('a');
  assert.equal(app.engine.patches.snapshot, plain.snapshot);
  assert.equal(app.engine.patches.status().snapshot.result, 'none');
  assert.equal(app.engine.patches.digest(), plain.digest);
});

test('config caps resource usage and gives private RPC endpoints priority', async t => {
  const f = fixture(t), release = await verifyRelease(f.release);
  const { config } = loadConfig(f.dir, { profile: 'small' });
  assert.equal(config.agent.agentPosting, false);
  const next = patchConfig(config, { endpoint: { chain: 'Ethereum', url: 'https://rpc.example.org' } }, 'small');
  assert.deepEqual(rpcEndpoints(release, next), { ethereum: ['https://rpc.example.org'] });
  assert.throws(() => patchConfig(config, { budgetPerMin: 0 }, 'small'), /budget out of range/);
  assert.throws(() => patchConfig(config, { profile: 'large' }, 'small'), /profile can only be lowered/);
  assert.throws(() => patchConfig(config, { theme: 'dark', endpoint: { url: 'file:///tmp' } }, 'small'), /bad url/);
  assert.equal(config.theme, 'system');
});

test('a saved cap above a lowered profile ceiling is clamped at load, new requests stay strict', t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, 'config.json'), JSON.stringify({ profile: 'small', storageCapMB: 4096, budgetPerMin: 99999 }));
  const { config } = loadConfig(f.dir);
  assert.ok(config.storageCapMB <= 1500 && config.storageCapMB >= 100);
  assert.ok(config.budgetPerMin < 99999);
  assert.throws(() => patchConfig(config, { storageCapMB: 4096 }, 'small'), /storage out of range/);
});

test('v0.1.4 storage raise: a saved old default follows the new one, a cap the user picked stays', t => {
  const f = fixture(t);
  const detected = loadConfig(f.dir).detected;
  const old = { small: 150, normal: 400, large: 1024 }[detected];
  writeFileSync(join(f.dir, 'config.json'), JSON.stringify({ profile: detected, storageCapMB: old }));
  assert.equal(loadConfig(f.dir).config.storageCapMB, PROFILE_LIMITS[detected].storeBudgetMB);
  writeFileSync(join(f.dir, 'config.json'), JSON.stringify({ profile: detected, storageCapMB: 700 }));
  assert.equal(loadConfig(f.dir).config.storageCapMB, 700);
});

test('the storage cap never takes more than half of the free disk', () => {
  const MiB = 1024 ** 2;
  assert.equal(storageCapBytes(10240, 100 * MiB, 100_000 * MiB), 10240 * MiB);
  assert.equal(storageCapBytes(10240, 100 * MiB, 4000 * MiB), 2100 * MiB);
  assert.equal(storageCapBytes(10240, 100 * MiB, NaN), 10240 * MiB);
});

test('patchFeed in config.json is kept as a boolean and stays absent by default', t => {
  const f = fixture(t);
  assert.equal(loadConfig(f.dir).config.patchFeed, undefined);
  writeFileSync(join(f.dir, 'config.json'), JSON.stringify({ patchFeed: false }));
  assert.equal(loadConfig(f.dir).config.patchFeed, false);
  assert.equal(patchConfig(loadConfig(f.dir).config, { patchFeed: 'yes' }, 'small').patchFeed, false);
});
