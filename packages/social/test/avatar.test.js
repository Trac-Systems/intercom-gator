import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { Social, migrations, AVATAR_MAX_BYTES } from '../src/index.js';
import { imageInfo, parseAvatar, readAvatarFile } from '../src/avatar.js';
import { isCard, validMessage } from '../src/validate.js';
import { Hub } from './hub.js';

// Real encoder output (cwebp -q 50) of a 96×96 gradient: simple lossy, and VP8X + ALPH + VP8 with transparency.
const LOSSY = 'UklGRtYAAABXRUJQVlA4IMoAAACwBwCdASpgAGAAPtFosFMoJaSoIOgBABoJYwaB3szGq6iks9Ruv2APtHBlJn////lq/////4u/////7s/////6Bf////vAAP7wtrT/49f6Y4eTvs8JC8Vi0vTTietXzMnnZ4mmRmQ8gcGf1KT420QiYFMhk5Qg544nj41+3ZyJhQ5gkbvWI3Xo2u2ENmfJMr70lSckzt9BPA7Bq8z7Q1tB9eWEFfkfHr/3SbvRKpbsJeIDX+UVhi1FH0bXcVOflS9/iwj+1wd7AAAA';
const ALPHA = 'UklGRgYBAABXRUJQVlA4WAoAAAAQAAAAXwAAXwAAQUxQSBYAAAABuYzof0BB2gZM51/+jZiApNz/++9/VlA4IMoAAACwBwCdASpgAGAAPtFosFMoJaSoIOgBABoJYwaB3szGq6iks9Ruv2APtHBlJn////lq/////4u/////7s/////6Bf////vAAP7wtrT/49f6Y4eTvs8JC8Vi0vTTietXzMnnZ4mmRmQ8gcGf1KT420QiYFMhk5Qg544nj41+3ZyJhQ5gkbvWI3Xo2u2ENmfJMr70lSckzt9BPA7Bq8z7Q1tB9eWEFfkfHr/3SbvRKpbsJeIDX+UVhi1FH0bXcVOflS9/iwj+1wd7AAAA';

function chunk(type, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, 'latin1');
  data.copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
}
/** A decodable RGB PNG. `noise` adds incompressible bytes to reach a target size. */
function png({ w = 96, h = 96, extra = [], noise = 0, seed = 1 } = {}) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let x = seed;
  for (let i = 0; i < raw.length; i++) {
    if (i % (w * 3 + 1) === 0) continue;
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    raw[i] = i < noise ? x >>> 24 : (i * 7) & 0x3f;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...extra,
    chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
/** A header-valid lossless WebP (enough for the header checks). */
function vp8l(w = 96, h = 96, pad = 20) {
  const data = Buffer.alloc(5 + pad);
  data[0] = 0x2f;
  data.writeUInt32LE(((w - 1) | ((h - 1) << 14)) >>> 0, 1);
  return riff([['VP8L', data]]);
}
function riff(chunks) {
  const parts = chunks.map(([type, data]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data, Buffer.alloc(data.length & 1)]);
  });
  const body = Buffer.concat(parts);
  const head = Buffer.from('RIFF0000WEBP', 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([head, body]);
}
function vp8x(flags, chunks, w = 96, h = 96) {
  const data = Buffer.alloc(10);
  data[0] = flags;
  data.writeUIntLE(w - 1, 4, 3);
  data.writeUIntLE(h - 1, 7, 3);
  return riff([['VP8X', data], ...chunks]);
}
const lossless = (w = 96, h = 96) => ['VP8L', vp8l(w, h).subarray(20)];

test('avatar images: PNG and WebP by magic bytes, header dimensions and size', () => {
  for (const b64 of [LOSSY, ALPHA]) {
    const image = parseAvatar(b64);
    assert.equal(image.type, 'image/webp');
    assert.equal(image.width, 96);
    assert.match(image.hash, /^[0-9a-f]{64}$/);
  }
  assert.deepEqual(imageInfo(png()), { type: 'image/png', width: 96, height: 96 });
  assert.ok(parseAvatar(png()));
  assert.ok(parseAvatar(vp8l()));
  assert.ok(parseAvatar(vp8x(0x10, [lossless()])), 'VP8L carries its own alpha');
  assert.equal(parseAvatar(vp8x(0, [['ALPH', Buffer.alloc(4)], lossless()])), null);
  assert.ok(parseAvatar(vp8x(0, [lossless(96, 96)])));
  // Dimensions: 96×96 only, and the frame must match the canvas.
  assert.equal(parseAvatar(png({ w: 95 })), null);
  assert.equal(parseAvatar(png({ w: 96, h: 97 })), null);
  assert.equal(parseAvatar(vp8l(128, 128)), null);
  assert.equal(parseAvatar(vp8x(0, [lossless(64, 64)])), null);
  // Refused metadata and animation.
  assert.equal(parseAvatar(png({ extra: [chunk('tEXt', Buffer.from('Comment\0hello'))] })), null);
  assert.equal(parseAvatar(png({ extra: [chunk('eXIf', Buffer.alloc(8))] })), null);
  assert.equal(parseAvatar(png({ extra: [chunk('acTL', Buffer.alloc(8))] })), null);
  assert.equal(parseAvatar(vp8x(0x02, [lossless(96, 96)])), null);
  assert.equal(parseAvatar(vp8x(0x08, [lossless(96, 96), ['EXIF', Buffer.alloc(8)]])), null);
  assert.equal(parseAvatar(vp8x(0x04, [lossless(96, 96)])), null);
  assert.equal(parseAvatar(vp8x(0, [lossless(96, 96), ['XMP ', Buffer.alloc(8)]])), null);
  // Structure: CRC, trailing bytes, RIFF length, other formats.
  const broken = png();
  broken[40] ^= 1;
  assert.equal(parseAvatar(broken), null);
  assert.equal(parseAvatar(Buffer.concat([png(), Buffer.from([0])])), null);
  assert.equal(parseAvatar(Buffer.concat([vp8l(), Buffer.alloc(2)])), null);
  assert.equal(parseAvatar(Buffer.from('ffd8ffe000104a46494600', 'hex')), null);
  assert.equal(parseAvatar(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  // Size: at most 6 KB after encoding.
  const big = png({ noise: 6000 });
  assert.ok(big.length > AVATAR_MAX_BYTES);
  assert.equal(parseAvatar(big), null);
  // Base64: canonical only, so the signed card and the hash agree.
  assert.equal(parseAvatar(LOSSY.slice(0, -1)), null);
  assert.equal(parseAvatar(LOSSY + '\n'), null);
  assert.equal(parseAvatar('data:image/webp;base64,' + LOSSY), null);
  assert.equal(parseAvatar(42), null);
});

test('cards carry an optional avatar; invalid images invalidate the card', () => {
  const author = 'a'.repeat(64), root = 'b'.repeat(64);
  assert.ok(isCard({ handle: 'atlas', harnesses: ['gator'], avatar: LOSSY }, author, root));
  assert.ok(isCard({ handle: 'atlas', harnesses: ['gator'], avatar: png().toString('base64') }, author, root));
  assert.equal(isCard({ handle: 'atlas', harnesses: ['gator'], avatar: vp8l(64, 64).toString('base64') }, author, root), false);
  assert.equal(isCard({ handle: 'atlas', harnesses: ['gator'], avatar: '' }, author, root), false);
  assert.ok(validMessage({ t: 'card', v: 1, handle: 'atlas', harnesses: [], avatar: ALPHA }, author, root));
  assert.ok(validMessage({ t: 'announce', v: 1, channel: 'soc/u/' + author, topics: [],
    card: { handle: 'atlas', harnesses: [], avatar: ALPHA } }, author, root));
});

async function fixture(t) {
  const hub = new Hub();
  const root = hub.peer();
  const dir = await mkdtemp(join(import.meta.dirname, 'scratch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const peers = [];
  t.after(async () => { for (const p of peers) { await p.social.close(); await p.net.close(); p.db.close(); } });
  async function peer(opts = {}) {
    const net = hub.peer(), db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    for (const m of migrations) m.up(db);
    const social = new Social({ transport: net, db, rootKey: root.publicKey, dataDir: join(dir, net.publicKey),
      clock: () => hub.now, proofs: false, ...opts });
    await social.ready;
    const p = { social, net, db, key: net.publicKey };
    peers.push(p);
    return p;
  }
  return { hub, peer };
}

test('avatars travel inside the signed card and announcement and are stored by SHA-256', async t => {
  const { hub, peer } = await fixture(t);
  const a = await peer(), b = await peer();
  const image = parseAvatar(ALPHA);
  assert.ok(await a.social.setCard({ handle: 'atlas', harnesses: ['gator'], avatar: ALPHA }, { topics: ['news'] }));
  // b learns the card from the directory announcement without following a.
  const seen = b.social.profile(a.key);
  assert.equal(seen.avatar, image.hash);
  assert.deepEqual(b.social.directory()[0].avatar, image.hash);
  assert.equal(b.social.avatar(image.hash).base64, ALPHA);
  assert.equal(b.social.avatar(image.hash).type, 'image/webp');
  assert.equal(b.social.avatar('0'.repeat(64)), null);
  assert.equal(b.social.avatar('../etc'), null);
  // The raw signed card keeps the image for re-publishing; readers get the hash only.
  assert.equal(a.social.card(a.key).avatar, ALPHA);
  assert.equal(a.social.profile(a.key).avatar, image.hash);
  const sent = hub.envelopes.filter(e => e.from === a.key);
  assert.deepEqual(sent.map(e => e.message.t), ['card', 'announce']);
  assert.equal(sent[1].message.card.avatar, ALPHA);
  // Removing the avatar falls back to the key-print (no hash).
  hub.now += 1000;
  assert.ok(await a.social.setCard({ handle: 'atlas', harnesses: ['gator'] }, { topics: ['news'] }));
  assert.equal(b.social.profile(a.key).avatar, undefined);
  assert.equal(b.social.avatar(image.hash), null);
});

test('the avatar must fit the 4 KiB card caps and card updates stay rate limited', async t => {
  const { hub, peer } = await fixture(t);
  const a = await peer({ limits: { rates: { cards: 4 } } }), b = await peer();
  const base = { handle: 'atlas', name: 'Atlas', bio: 'Market notes', harnesses: ['gator'] };
  const room = a.social.avatarRoom(base, { topics: ['news'] });
  assert.ok(room > 2000 && room < AVATAR_MAX_BYTES, 'room ' + room);
  // Find a PNG just under the room and one just over it.
  const sized = target => {
    let low = 0, high = 9000, best = null;
    while (low <= high) {
      const mid = (low + high) >> 1, p = png({ noise: mid, seed: target });
      if (p.length <= target) { best = p; low = mid + 1; } else high = mid - 1;
    }
    return best;
  };
  const fits = sized(room), tooBig = png({ noise: 9000 }).length > room ? sized(Math.min(room + 300, AVATAR_MAX_BYTES)) : null;
  assert.ok(fits.length <= room && fits.length > room - 200);
  assert.ok(await a.social.setCard({ ...base, avatar: fits.toString('base64') }, { topics: ['news'] }));
  const delivered = hub.envelopes.filter(e => e.from === a.key);
  assert.equal(delivered.length, 2);
  for (const e of delivered) assert.ok(Buffer.byteLength(JSON.stringify(e)) <= 4096 - 160, 'envelope ' + Buffer.byteLength(JSON.stringify(e)));
  assert.equal(b.social.profile(a.key).avatar, parseAvatar(fits).hash);
  assert.ok(tooBig && tooBig.length > room);
  await assert.rejects(a.social.setCard({ ...base, avatar: tooBig.toString('base64') }, { topics: ['news'] }), RangeError);
  // Two card messages per update; the fourth card message in the window is refused.
  hub.now += 1000;
  assert.ok(await a.social.setCard({ ...base, avatar: LOSSY }, { topics: ['news'] }));
  hub.now += 1000;
  assert.equal(await a.social.setCard({ ...base, avatar: ALPHA }, { topics: ['news'] }), false);
  assert.equal(b.social.profile(a.key).avatar, parseAvatar(LOSSY).hash);
});

test('receivers drop cards whose avatar is not a valid 96×96 image', async t => {
  const { hub, peer } = await fixture(t);
  const a = await peer(), b = await peer();
  await a.social.setCard({ handle: 'atlas', harnesses: ['gator'] });
  const announce = avatar => ({ t: 'announce', v: 1, channel: 'soc/u/' + a.key, topics: [],
    card: { handle: 'mallory', harnesses: [], avatar } });
  hub.now += 1000;
  const bad = a.net.envelope('soc/dir', announce(vp8l(256, 256).toString('base64')));
  b.net.emit('message', bad.channel, bad);
  assert.equal(b.social.profile(a.key).handle, 'atlas');
  assert.equal(b.social.profile(a.key).avatar, undefined);
  hub.now += 1000;
  const good = a.net.envelope('soc/dir', announce(LOSSY));
  b.net.emit('message', good.channel, good);
  assert.equal(b.social.profile(a.key).handle, 'mallory');
  assert.equal(b.social.profile(a.key).avatar, parseAvatar(LOSSY).hash);
});


test('Windows avatar reads require a regular file before opening it', async t => {
  const dir = await mkdtemp(join(import.meta.dirname, 'scratch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'avatar.webp'), image = Buffer.from(ALPHA, 'base64');
  await writeFile(file, image);
  assert.deepEqual(await readAvatarFile(file, 'win32'), image);
  await assert.rejects(readAvatarFile(dir, 'win32'), /regular file/);
});
