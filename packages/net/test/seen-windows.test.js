import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { basename, join } from 'node:path';
import { SeenCache, openFlags } from '../vendor/intercom-sidechannel/seen.js';

const hour = 3_600_000;
const receipt = n => n.toString(16).padStart(64, '0');

function fixture(t) {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'gator-seen-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'seen');
  t.mock.method(os, 'platform', () => 'win32');
  const cache = () => new SeenCache(20, hour, { directory, maxFileBytes: 64 });
  return { root, directory, cache };
}

test('Windows requires exclusive create; the Darwin and Linux flag tables retain their values', () => {
  assert.deepEqual(openFlags({ O_EXCL: 0x400 }, 'win32', 'x64'), { exclusive: 0x400, safe: 0 });
  assert.throws(() => openFlags({}, 'win32', 'x64'));
  assert.deepEqual(openFlags({}, 'darwin', 'arm64'), { exclusive: 0x800, safe: 0x104 });
  assert.deepEqual(openFlags({}, 'linux', 'arm64'), { exclusive: 0x80, safe: 0x8800 });
  assert.deepEqual(openFlags({}, 'linux', 'x64'), { exclusive: 0x80, safe: 0x20800 });
  assert.deepEqual(openFlags({ O_EXCL: 1, O_NOFOLLOW: 2, O_NONBLOCK: 4 }, 'linux', 'x64'), { exclusive: 1, safe: 6 });
  assert.throws(() => openFlags({}, 'linux', 'mips'));
  assert.throws(() => openFlags({ O_EXCL: 1, O_NOFOLLOW: 2, O_NONBLOCK: 4 }, 'unknown', 'x64'));
});

test('Windows receipts survive compaction, restart, a torn tail and a backwards clock step', t => {
  const { directory, cache } = fixture(t);
  const first = cache(), other = cache();
  try {
    for (const n of [1, 2, 3]) first.remember(receipt(n), 4 * hour);
    assert.throws(() => other.prepare(4 * hour), { code: 'EEXIST' });
  } finally { first.close(); other.close(); }
  const bucket = join(directory, 'seen-4.bin');
  assert.equal(fs.readFileSync(bucket, 'hex'), receipt(2) + receipt(3));
  fs.appendFileSync(bucket, Buffer.alloc(7));
  const next = cache();
  try {
    assert.equal(next.has(receipt(3), 4 * hour), true);
    assert.equal(fs.statSync(bucket).size, 64);
    assert.equal(next.has(receipt(2), hour), true);
    assert.equal(fs.existsSync(bucket), false);
    assert.equal(fs.readFileSync(join(directory, 'seen-1.bin'), 'hex'), receipt(2) + receipt(3));
  } finally { next.close(); }
});

test('Windows compaction closes both the old bucket and its replacement before rename', t => {
  const { cache } = fixture(t);
  const descriptors = new Map();
  const { openSync, closeSync, renameSync } = fs;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    const fd = openSync(file, ...args);
    descriptors.set(fd, file);
    return fd;
  });
  t.mock.method(fs, 'closeSync', fd => {
    descriptors.delete(fd);
    return closeSync(fd);
  });
  let replacements = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (basename(to) === 'seen-1.bin') {
      assert.ok(![...descriptors.values()].some(file => file === from || file === to));
      replacements++;
    }
    return renameSync(from, to);
  });
  const writer = cache();
  try { for (const n of [1, 2, 3]) writer.remember(receipt(n), hour); }
  finally { writer.close(); }
  assert.equal(replacements, 1);
  assert.equal(descriptors.size, 0);
});

test('Windows refuses a junction as its seen directory', t => {
  const { root, directory, cache } = fixture(t);
  const target = join(root, 'target');
  fs.mkdirSync(target);
  fs.symlinkSync(target, directory, 'junction');
  assert.throws(() => cache().prepare(hour), /plain file or directory/);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('Windows creates nested seen directories and refuses a junction below which they would be created', t => {
  const { root } = fixture(t);
  const make = directory => new SeenCache(20, hour, { directory });
  const cache = make(join(root, 'new', 'data', 'seen'));
  try { cache.remember(receipt(1), hour); }
  finally { cache.close(); }
  const target = join(root, 'target'), link = join(root, 'redirected');
  fs.mkdirSync(target);
  fs.symlinkSync(target, link, 'junction');
  for (const dir of [join(link, 'seen'), join(link, 'missing', 'seen')]) {
    assert.throws(() => make(dir).prepare(hour), /plain file or directory/);
  }
  assert.deepEqual(fs.readdirSync(target), []);
});

test('Windows rejects a different open file identity before appending', t => {
  const { directory, cache } = fixture(t);
  const writer = cache(), bucket = join(directory, 'seen-1.bin');
  try {
    writer.remember(receipt(1), hour);
    const { ino } = fs.lstatSync(bucket, { bigint: true });
    const { fstatSync } = fs;
    const mock = t.mock.method(fs, 'fstatSync', (fd, options) => {
      const stat = fstatSync(fd, options);
      if (stat.ino === ino) stat.ino++;
      return stat;
    });
    try { assert.throws(() => writer.remember(receipt(2), hour), /identity changed/); }
    finally { mock.mock.restore(); }
    assert.equal(fs.readFileSync(bucket, 'hex'), receipt(1));
  } finally { writer.close(); }
});

test('Windows leaves an existing bucket intact on an exclusive-create collision', t => {
  const { directory, cache } = fixture(t);
  const writer = cache();
  try {
    writer.prepare(hour);
    const bucket = join(directory, 'seen-1.bin');
    fs.writeFileSync(bucket, Buffer.from(receipt(1), 'hex'));
    assert.throws(() => writer.remember(receipt(2), hour), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(bucket, 'hex'), receipt(1));
  } finally { writer.close(); }
});
