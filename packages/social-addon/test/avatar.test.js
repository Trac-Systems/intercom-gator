import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAvatar } from '@gator/social';
import { main } from '../src/cli.js';
import { call, network, until } from './helpers.js';

// cwebp -q 50 output for a 96×96 gradient (simple lossy WebP).
const WEBP = 'UklGRtYAAABXRUJQVlA4IMoAAACwBwCdASpgAGAAPtFosFMoJaSoIOgBABoJYwaB3szGq6iks9Ruv2APtHBlJn////lq/////4u/////7s/////6Bf////vAAP7wtrT/49f6Y4eTvs8JC8Vi0vTTietXzMnnZ4mmRmQ8gcGf1KT420QiYFMhk5Qg544nj41+3ZyJhQ5gkbvWI3Xo2u2ENmfJMr70lSckzt9BPA7Bq8z7Q1tB9eWEFfkfHr/3SbvRKpbsJeIDX+UVhi1FH0bXcVOflS9/iwj+1wd7AAAA';
const hash = parseAvatar(WEBP).hash;

test('agents set, keep and remove the avatar inside their signed card', async t => {
  const net = await network(t);
  const alice = await net.addon({ agentPosting: true }), bob = await net.addon();
  const set = await call(alice, 'profile', { set: { handle: 'alice', avatar: WEBP } });
  assert.equal(set.isError, false);
  assert.equal(set.value.card.avatar, hash);
  assert.equal(JSON.parse(readFileSync(join(alice.status().dataDir, 'config.json'), 'utf8')).card.avatar, WEBP);
  const seen = await until(async () => (await call(bob, 'profile', { key: alice.publicKey })).value.profile.avatar);
  assert.equal(seen, hash);
  // Omitted keeps the image; a file path is read by the add-on; '' removes it.
  assert.equal((await call(alice, 'profile', { set: { handle: 'alice', bio: 'kept' } })).value.card.avatar, hash);
  const file = join(alice.status().dataDir, 'face.webp');
  writeFileSync(file, Buffer.from(WEBP, 'base64'));
  assert.equal((await call(alice, 'profile', { set: { handle: 'alice', avatarFile: file } })).value.card.avatar, hash);
  for (const [set, pattern] of [
    [{ handle: 'alice', avatar: Buffer.from('GIF89a').toString('base64') }, /96×96 WebP or PNG/],
    [{ handle: 'alice', avatarFile: 'face.webp' }, /absolute/],
    [{ handle: 'alice', avatarFile: file, avatar: WEBP }, /not both/],
  ]) {
    const result = await call(alice, 'profile', { set });
    assert.equal(result.isError, true);
    assert.match(result.value.error, pattern);
  }
  const removed = await call(alice, 'profile', { set: { handle: 'alice', avatar: '' } });
  assert.equal(removed.value.card.avatar, undefined);
  assert.equal(alice.social.profile(alice.publicKey).avatar, undefined);
});

test('the owner card refuses an avatar that does not fit before saving it', async t => {
  const net = await network(t);
  const addon = await net.addon();
  const { socialClient } = await import('../src/client.js');
  const client = socialClient(addon.status().dataDir);
  // A valid 96×96 PNG of about 5 KB: valid on its own, too large for a 4 KiB card.
  const { crc32, deflateSync } = await import('node:zlib');
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1');
    data.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length); return b; };
  const raw = Buffer.alloc(97 * 96 * 3);
  let x = 1;
  for (let i = 0; i < 4800; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; raw[i + Math.floor(i / 288) + 1] = x >>> 24; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(96, 0); ihdr.writeUInt32BE(96, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  assert.ok(parseAvatar(png) && png.length > 3000, String(png.length));
  const result = await client.card({ handle: 'dana', avatar: png.toString('base64') });
  assert.deepEqual(result, { sent: false, error: 'The avatar does not fit into the signed card; use a smaller image' });
  const config = join(addon.status().dataDir, 'config.json');
  assert.equal(existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')).card : undefined, undefined);
});

test('gator-social card --avatar stores the image in the saved card', async t => {
  const net = await network(t);
  const dir = join(net.dir, 'offline');
  const file = join(net.dir, 'face.webp');
  writeFileSync(file, Buffer.from(WEBP, 'base64'));
  const out = [];
  const io = { stdout: { write: s => out.push(s) }, stderr: { write: s => out.push(s) } };
  assert.equal(await main(['card', '--data', dir, '--handle', 'carol', '--avatar', file], io), 0);
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).card.avatar, WEBP);
  writeFileSync(file, 'not an image');
  await assert.rejects(main(['card', '--data', dir, '--handle', 'carol', '--avatar', file], io), /96×96/);
});
