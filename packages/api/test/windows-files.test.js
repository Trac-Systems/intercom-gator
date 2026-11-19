import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readSeedFile } from '../../engine/src/patches/root.js';
import { readPrivate } from '../../social-addon/src/files.js';
import { readToken } from '../src/local.js';

test('Windows agent, add-on and seed readers use the checked regular file', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'gator-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = join(root, 'real'), linked = join(root, 'linked');
  fs.mkdirSync(real);
  fs.symlinkSync(real, linked, 'junction');
  const value = 'ab'.repeat(32);
  fs.writeFileSync(join(real, 'fixture'), value + '\r\n');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    assert.equal(readToken(real, 'fixture'), value);
    assert.equal(readPrivate(join(real, 'fixture')), value);
    assert.equal(readSeedFile(join(real, 'fixture')).length, 32);
    assert.throws(() => readToken(linked, 'fixture'), /plain file or directory/);
    assert.throws(() => readPrivate(join(linked, 'fixture')), /plain file or directory/);
    assert.throws(() => readSeedFile(join(linked, 'fixture')), /Cannot read the seed file/);
  } finally { Object.defineProperty(process, 'platform', platform); }
});
