import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fixture } from './fixtures.js';
import { loadConfig, patchConfig, rpcEndpoints } from '../src/config.js';
import { verifyRelease } from '../src/bundle.js';

test('release verification binds the data to an independently pinned key', async t => {
  const { release } = fixture(t);
  assert.equal((await verifyRelease(release)).digest.length, 64);
  await assert.rejects(verifyRelease({ dir: release.dir }), /signature/);
  writeFileSync(join(release.dir, 'bundle.sig'), '');
  await assert.rejects(verifyRelease(release), /signature/);
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
  assert.ok(config.storageCapMB <= 1024 && config.storageCapMB >= 100);
  assert.ok(config.budgetPerMin < 99999);
  assert.throws(() => patchConfig(config, { storageCapMB: 4096 }, 'small'), /storage out of range/);
});

test('patchFeed in config.json is kept as a boolean and stays absent by default', t => {
  const f = fixture(t);
  assert.equal(loadConfig(f.dir).config.patchFeed, undefined);
  writeFileSync(join(f.dir, 'config.json'), JSON.stringify({ patchFeed: false }));
  assert.equal(loadConfig(f.dir).config.patchFeed, false);
  assert.equal(patchConfig(loadConfig(f.dir).config, { patchFeed: 'yes' }, 'small').patchFeed, false);
});
