import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { packRelease } from '../../../scripts/release-pack.mjs';

const root = resolve(import.meta.dirname, '../../..');
let temp, name, bytes;
before(() => {
  temp = mkdtempSync(join(tmpdir(), 'gator-release-'));
  name = packRelease(temp);
  bytes = readFileSync(join(temp, name));
});
after(() => { if (temp) rmSync(temp, { recursive: true, force: true }); });

test('packing the same tree twice produces identical versioned assets', () => {
  const version = JSON.parse(execFileSync('git', ['show', 'HEAD:package.json'], { cwd: root })).version;
  assert.equal(name, 'intercom-gator-' + version + '.tgz');
  const other = join(temp, 'second build');
  assert.equal(packRelease(other), name);
  assert.deepEqual(readFileSync(join(other, name)), bytes);
  assert.deepEqual(readFileSync(join(other, 'SHA256SUMS')), readFileSync(join(temp, 'SHA256SUMS')));
  assert.equal(bytes.readUInt32LE(4), 0, 'fixed gzip timestamp');
});

test('SHA256SUMS binds the exact tgz bytes to the asset basename', () => {
  const expected = createHash('sha256').update(bytes).digest('hex');
  assert.equal(readFileSync(join(temp, 'SHA256SUMS'), 'utf8'), expected + '  ' + name + '\n');
});

test('the unpacked release contains the complete runtime and only its distribution files', () => {
  const archive = join(temp, name);
  const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trimEnd()
    .split(/\r?\n/).filter(path => !path.endsWith('/'));
  const tracked = execFileSync('git', ['ls-tree', '-rz', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8' }).split('\0');
  const expected = tracked.filter(path => [
    /^(LICENSE\.md|SKILL\.md|package(-lock)?\.json|bin\/gator\.js)$/,
    /^packages\/[^/]+\/(package\.json|src\/.+\.js)$/,
    /^packages\/(bundle\/data|dashboard\/public|net\/vendor)\//,
    /^packages\/social-addon\/bin\/gator-social\.js$/,
  ].some(pattern => pattern.test(path)));
  assert.deepEqual(files.toSorted(), expected.toSorted());
  for (const path of ['packages/bundle/data/bundle.sig', 'packages/api/src/cli.js',
    'packages/dashboard/public/index.html', 'packages/net/vendor/intercom-sidechannel/LICENSE.md']) {
    assert.ok(files.includes(path), path);
  }
  const app = join(temp, 'unpacked app');
  mkdirSync(app);
  execFileSync('tar', ['-xzf', archive, '-C', app]);
  const bin = statSync(join(app, 'bin/gator.js'));
  assert.equal(bin.mtimeMs, 0);
  if (process.platform !== 'win32') assert.equal(bin.mode & 0o755, 0o755);
  const lock = JSON.parse(readFileSync(join(app, 'package-lock.json')));
  for (const path of Object.keys(lock.packages).filter(path => /^packages\/[^/]+$/.test(path))) {
    const manifest = JSON.parse(readFileSync(join(app, path, 'package.json')));
    assert.equal(manifest.version, lock.packages[path].version);
    assert.ok(files.includes(path + '/' + manifest.main));
  }
});
