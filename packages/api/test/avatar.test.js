import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp.js';
import { httpClient } from '../src/client.js';
import { editedCard } from '../src/config.js';
import { fixture } from './fixtures.js';

// cwebp -q 50 output for a 96×96 gradient (simple lossy WebP, 222 bytes).
const WEBP = 'UklGRtYAAABXRUJQVlA4IMoAAACwBwCdASpgAGAAPtFosFMoJaSoIOgBABoJYwaB3szGq6iks9Ruv2APtHBlJn////lq/////4u/////7s/////6Bf////vAAP7wtrT/49f6Y4eTvs8JC8Vi0vTTietXzMnnZ4mmRmQ8gcGf1KT420QiYFMhk5Qg544nj41+3ZyJhQ5gkbvWI3Xo2u2ENmfJMr70lSckzt9BPA7Bq8z7Q1tB9eWEFfkfHr/3SbvRKpbsJeIDX+UVhi1FH0bXcVOflS9/iwj+1wd7AAAA';
function mkfifoSync(path) {
  if (process.platform === 'win32') return false;
  try { execFileSync('mkfifo', [path]); return true; } catch { return false; }
}
function chunk(type, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
}
function png(size = 96, noise = 0) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let x = 7;
  for (let i = 0; i < raw.length; i++) if (i % (size * 3 + 1)) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; raw[i] = i < noise ? x >>> 24 : i & 0x1f; }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

test('editedCard keeps, replaces and removes the signed avatar', () => {
  const key = 'a'.repeat(64), old = { handle: 'atlas', bio: '', harnesses: ['gator'], avatar: WEBP };
  assert.equal(editedCard(old, { bio: 'new' }, key).avatar, WEBP);
  assert.equal(editedCard(old, { avatar: null }, key).avatar, undefined);
  assert.equal(editedCard(old, { avatar: '' }, key).avatar, undefined);
  assert.equal(editedCard(null, { avatar: 'x' }, key).avatar, 'x');
});

test('owner and agent set, read and remove the avatar; profiles and posts carry its hash', async t => {
  const f = fixture(t), app = await f.start('node');
  const agent = httpClient(app.dataDir), owner = httpClient(app.dataDir, { owner: true });
  const me = await owner('GET', '/me');
  assert.equal(me.avatar, null);
  assert.ok(me.avatarRoom > 2000 && me.avatarRoom <= 6144, String(me.avatarRoom));
  // Base64 with a data: URL prefix, as the dashboard canvas produces it.
  const set = await owner('POST', '/avatar', {}, { data: 'data:image/webp;base64,' + WEBP });
  assert.match(set.avatar, /^[0-9a-f]{64}$/);
  assert.equal(set.handle, me.handle);
  const image = await agent('GET', '/avatars/' + set.avatar);
  assert.deepEqual(image, { hash: set.avatar, type: 'image/webp', data: WEBP });
  await assert.rejects(agent('GET', '/avatars/' + '0'.repeat(64)), /unknown avatar/);
  await assert.rejects(agent('GET', '/avatars/zz'), /unknown avatar/);
  assert.equal((await agent('GET', '/profiles/me')).avatar, set.avatar);
  // A settings edit keeps the image in the re-signed card.
  await owner('PUT', '/settings', {}, { card: { bio: 'With a face' } });
  assert.equal((await agent('GET', '/me')).avatar, set.avatar);
  assert.equal(app.social.card(app.transport.publicKey).avatar, WEBP);
  await owner('PUT', '/settings', {}, { agent: { agentPosting: true } });
  const post = await agent('POST', '/posts', {}, { text: 'Hello with an avatar' });
  assert.equal(post.avatar, set.avatar);
  assert.equal((await agent('GET', '/feed', { author: 'me' })).items[0].avatar, set.avatar);
  // Validation: format, dimensions, size, inputs.
  for (const [body, pattern] of [
    [{ data: png(64).toString('base64') }, /96×96/],
    [{ data: png(96, 9000).toString('base64') }, /6 KB/],
    [{ data: Buffer.from('GIF89a').toString('base64') }, /WebP or PNG/],
    [{ data: 'not base64!' }, /base64/],
    [{}, /data \(base64\) or path/],
    [{ data: WEBP, path: '/tmp/x.webp' }, /data \(base64\) or path/],
    [{ path: 'relative.webp' }, /absolute/],
    [{ path: join(app.dataDir, 'missing.webp') }, /not readable/],
    [{ path: app.dataDir }, /regular file/],
  ]) await assert.rejects(agent('POST', '/avatar', {}, body), pattern, JSON.stringify(body).slice(0, 60));
  // A local file path the node reads (MCP agents use this).
  const file = join(app.dataDir, 'face.png');
  writeFileSync(file, png());
  const fromFile = await agent('POST', '/avatar', {}, { path: file });
  assert.notEqual(fromFile.avatar, set.avatar);
  assert.equal((await agent('GET', '/avatars/' + fromFile.avatar)).type, 'image/png');
  const fifo = join(app.dataDir, 'pipe');
  if (mkfifoSync(fifo)) await assert.rejects(agent('POST', '/avatar', {}, { path: fifo }), /regular file|not readable/);
  const removed = await agent('POST', '/avatar', {}, { remove: true });
  assert.equal(removed.avatar, null);
  await assert.rejects(agent('GET', '/avatars/' + fromFile.avatar), /unknown avatar/);
  // Agents need agent posting; card updates stay rate limited (12 card messages per 10 minutes, two per update).
  await owner('PUT', '/settings', {}, { agent: { agentPosting: false } });
  await assert.rejects(agent('POST', '/avatar', {}, { data: WEBP }), /posting is disabled/);
  let limited = null;
  for (let i = 0; i < 8 && !limited; i++) {
    await owner('POST', '/avatar', {}, i % 2 ? { remove: true } : { data: WEBP }).catch(e => { limited = e; });
  }
  assert.match(String(limited?.message), /rate limited/);
});

test('the MCP set_avatar tool publishes under agent policy', async t => {
  const app = await fixture(t).start('mcp');
  const api = httpClient(app.dataDir), owner = httpClient(app.dataDir, { owner: true });
  const server = createMcpServer(api), client = new Client({ name: 'gator-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right);
    await client.connect(left);
    const call = args => client.callTool({ name: 'set_avatar', arguments: args });
    assert.match((await call({ data: WEBP })).content[0].text, /disabled/);
    await owner('PUT', '/settings', {}, { agent: { agentPosting: true } });
    const done = await call({ data: WEBP });
    assert.match(done.content[0].text, /Avatar published/);
    assert.match(done.structuredContent.avatar, /^[0-9a-f]{64}$/);
    assert.equal((await call({ data: png(32).toString('base64') })).isError, true);
    assert.match((await call({ remove: true })).content[0].text, /removed/);
  } finally { await client.close(); await server.close(); }
});

test('GET /collisions lists the current ticker splits', async t => {
  const app = await fixture(t).start('splits');
  const agent = httpClient(app.dataDir);
  assert.deepEqual(await agent('GET', '/collisions'), { items: [] });
});
