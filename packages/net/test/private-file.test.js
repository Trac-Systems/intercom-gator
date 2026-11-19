import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { openPrivateRead } from '../src/private-file.js';
import { loadOrCreateKey, loadOrCreateSwarmKeyPair } from '../src/keys.js';

test('Windows keystores reload from regular files and reject a junction at keys/', async t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'gator-win-keys-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // All native dependencies have loaded for the host before exercising the win32 storage path.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    const data = join(root, 'data');
    const peer = await loadOrCreateKey(data), swarm = loadOrCreateSwarmKeyPair(data);
    assert.deepEqual((await loadOrCreateKey(data)).publicKey, peer.publicKey);
    assert.deepEqual(loadOrCreateSwarmKeyPair(data).publicKey, swarm.publicKey);
    const linked = join(root, 'linked');
    fs.mkdirSync(linked);
    fs.symlinkSync(join(data, 'keys'), join(linked, 'keys'), 'junction');
    await assert.rejects(loadOrCreateKey(linked), /plain file or directory/);
    assert.throws(() => loadOrCreateSwarmKeyPair(linked), /plain file or directory/);
  } finally { Object.defineProperty(process, 'platform', platform); }
});

test('Windows credential reads reject mismatched 64-bit file IDs and close the handle', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'gator-private-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'fixture');
  fs.writeFileSync(file, 'fixture');
  const { lstatSync, fstatSync } = fs;
  // These two distinct IDs compare equal if rounded to JS numbers.
  const id = 2n ** 53n;
  t.mock.method(fs, 'lstatSync', (path, options) => {
    const stat = lstatSync(path, options);
    if (path === file) stat.ino = id;
    return stat;
  });
  let descriptor;
  t.mock.method(fs, 'fstatSync', (fd, options) => {
    descriptor = fd;
    const stat = fstatSync(fd, options);
    stat.ino = id + 1n;
    return stat;
  });
  assert.throws(() => openPrivateRead(file, 'win32'), /identity changed/);
  assert.throws(() => fstatSync(descriptor), { code: 'EBADF' });
});

test('Windows refuses a reparse-tagged directory entry even when lstat reports a normal file', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'gator-reparse-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'fixture');
  fs.writeFileSync(file, 'fixture');
  const { opendirSync } = fs;
  t.mock.method(fs, 'opendirSync', path => {
    if (path !== root) return opendirSync(path);
    return { readSync: () => ({ name: basename(file), isSymbolicLink: () => true }), closeSync() {} };
  });
  assert.throws(() => openPrivateRead(file, 'win32'), /reparse points/);
});
