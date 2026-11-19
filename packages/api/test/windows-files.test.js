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

test('Windows doctor reports a junction data directory as unsuitable', async t => {
  const { main } = await import('../src/cli.js');
  const { createServer } = await import('node:net');
  const server = createServer(socket => socket.end());
  await new Promise((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok));
  t.after(() => new Promise(ok => server.close(ok)));
  const root = fs.mkdtempSync(join(tmpdir(), 'gator-doctor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const linked = join(root, 'linked');
  fs.mkdirSync(join(root, 'data'));
  fs.symlinkSync(join(root, 'data'), linked, 'junction');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform'), exitCode = process.exitCode;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    let state;
    await main(['doctor', '--data', linked, '--port', String(server.address().port)], { log: text => { state = JSON.parse(text); } });
    assert.equal(state.privateDirectory, false);
    assert.equal(process.exitCode, 1);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    process.exitCode = exitCode;
  }
});
