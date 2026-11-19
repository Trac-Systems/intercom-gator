import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { paths, rewrites, sha256, upstream } from '../scripts/vendor-sync.mjs';

const dir = new URL('../vendor/intercom-sidechannel/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('VENDOR.json', dir)));
const checkout = process.env.INTERCOM_CHECKOUT ?? resolve(import.meta.dirname, '../../../../intercom-wt-gator');
const commit = '5fd766902346192b8cdfd250b71bc0bdf3a0c6ed';
// Git blob of features/sidechannel/index.js in release 0.0.11.
const releaseBlob = '2e3c01455dc5f1d2ce941f35a31eb0e37d92e36b';

const gitBlob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

test('the five vendored files reverse to the pinned Intercom blobs', () => {
  assert.equal(manifest.commit, commit);
  assert.deepEqual(Object.keys(manifest.files).sort(), [...paths].sort());
  assert.deepEqual(paths.toSorted(), ['channel-options.js', 'index.js', 'managed.js', 'pow.js', 'seen.js']);
  for (const [name, hashes] of Object.entries(manifest.files)) {
    const bytes = readFileSync(new URL(name, dir));
    assert.equal(sha256(bytes), hashes.vendoredSha256, name);
    let restored = bytes.toString('utf8');
    for (const [before, after] of rewrites) restored = restored.replaceAll(after, before);
    assert.equal(sha256(restored), hashes.upstreamSha256, name);
    // The release module is unmodified 0.0.11; the opt-in behaviour lives in managed.js.
    if (name === 'index.js') assert.equal(gitBlob(Buffer.from(restored)), releaseBlob);
    if (process.env.INTERCOM_CHECKOUT || existsSync(checkout)) {
      assert.deepEqual(Buffer.from(restored), upstream(checkout, commit, 'features/sidechannel/' + name), name);
    }
  }
});
