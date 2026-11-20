import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { checkBridgeUrl, startAddon } from '../src/addon.js';
import { main } from '../src/cli.js';
import { socialClient } from '../src/client.js';
import { ROOT, ROOT_SEED, until } from './helpers.js';

const HOST = 'ab'.repeat(32);
const TOKEN = 'test-bridge-token-' + 'c'.repeat(16);
const rootPrivate = createPrivateKey({ format: 'der', type: 'pkcs8',
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(ROOT_SEED, 'hex')]) });
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
function rootFrame(channel, message, ts = Date.now()) {
  const e = { id: ROOT + ':' + ts, channel, from: ROOT, origin: ROOT, ts, message };
  const sig = sign(null, Buffer.from(canonical({ kind: 'sidechannel_message_v1', ...e })), rootPrivate).toString('hex');
  return { type: 'sidechannel_message', ...e, sig, ttl: 2, relayedBy: null };
}

/** A minimal SC-Bridge host (the protocol intercom-dex and RESET peers speak). */
async function fakeHost(t) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => wss.once('listening', resolve));
  const host = { joined: new Set(), sent: [], sessions: [], peer: HOST, url: `ws://127.0.0.1:${wss.address().port}` };
  wss.on('connection', socket => {
    if (host.offline) return socket.terminate();
    const joined = host.joined = new Set(), subscribed = new Set();
    host.sessions.push({ socket, joined, subscribed });
    if (host.holdHello) return;
    socket.send(JSON.stringify({ type: 'hello', peer: host.peer, requiresAuth: true }));
    socket.on('message', data => {
      const m = JSON.parse(data);
      const reply = body => socket.send(JSON.stringify({ id: m.id, ...body }));
      if (m.type === 'auth') return reply(m.token === TOKEN ? { type: 'auth_ok' } : { type: 'error', error: 'Unauthorized' });
      if (m.type === 'subscribe' || m.type === 'unsubscribe') {
        for (const ch of m.channels) {
          if (m.type === 'subscribe') subscribed.add(ch);
          else subscribed.delete(ch);
        }
        return reply({ type: 'subscribed', channels: [...subscribed] });
      }
      if (m.type === 'join') {
        if (m.channel === host.refuseChannel) return reply({ type: 'error', error: 'Join denied' });
        joined.add(m.channel);
        return reply({ type: 'joined', channel: m.channel, announced: true });
      }
      if (m.type === 'leave') {
        subscribed.delete(m.channel);
        joined.delete(m.channel);
        return reply({ type: 'left', channel: m.channel, ok: true });
      }
      if (m.type === 'send') { host.sent.push({ channel: m.channel, message: m.message }); return reply({ type: 'sent', channel: m.channel }); }
      if (m.type === 'stats') return reply({ type: 'stats', connectionCount: 3 });
    });
  });
  host.push = frame => {
    for (const { socket, subscribed } of host.sessions) {
      if (wss.clients.has(socket) && subscribed.has(frame.channel)) socket.send(JSON.stringify(frame));
    }
  };
  t.after(() => new Promise(resolve => { for (const s of wss.clients) s.terminate(); wss.close(resolve); }));
  return host;
}

async function scratch(t) {
  const dir = await mkdtemp(join(import.meta.dirname, 'scratch-'));
  const cleanups = [];
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
  const tokenFile = join(dir, 'bridge-token');
  writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
  return { dir, tokenFile, beforeRemove: fn => cleanups.push(fn) };
}

test('bridge mode uses the host peer key over SC-Bridge', async t => {
  const host = await fakeHost(t);
  const { dir, tokenFile, beforeRemove } = await scratch(t);
  const addon = await startAddon({ dataDir: join(dir, 'data'), bridge: { url: host.url, tokenFile }, rootKey: ROOT,
    product: 'reset', agentPosting: true, proofs: false, profile: 'small' });
  beforeRemove(() => addon.close());
  assert.equal(addon.mode, 'bridge');
  assert.equal(addon.publicKey, HOST);
  assert.equal(existsSync(join(dir, 'data', 'keys')), false); // no own key in bridge mode
  assert.deepEqual([...host.joined].sort(), ['soc/all', 'soc/dir', 'soc/official', 'soc/p/reset', 'soc/pr/reset',
    'soc/r/' + HOST, 'soc/u/' + HOST].sort());
  await until(() => addon.status().peers === 3);

  const post = await addon.tools.find(x => x.name === 'feed_post').call({ text: 'RESET round 12 is live' });
  assert.equal(post.value.sent, true);
  assert.match(post.value.note, /Bridge mode/);
  await until(() => host.sent.some(e => e.message.t === 'post'));
  assert.deepEqual(host.sent.at(-1), { channel: 'soc/u/' + HOST, message: { t: 'post', v: 1, text: 'RESET round 12 is live' } });

  host.push(rootFrame('soc/official', { t: 'notice', v: 1, text: 'Signed by root' }));
  host.push({ ...rootFrame('soc/official', { t: 'notice', v: 1, text: 'Forged' }), sig: '00'.repeat(64) });
  const read = await until(async () => {
    const { value } = await addon.tools.find(x => x.name === 'feed_read').call({ scope: 'official' });
    return value.posts.length && value;
  });
  assert.deepEqual(read.posts.map(p => p.untrustedText), ['Signed by root']);
});

test('bridge failures: wrong token, readable token file, remote ws URL', async t => {
  const host = await fakeHost(t);
  const { dir, tokenFile } = await scratch(t);
  const bad = join(dir, 'bad-token');
  writeFileSync(bad, 'wrong-token', { mode: 0o600 });
  await assert.rejects(startAddon({ dataDir: join(dir, 'a'), bridge: { url: host.url, tokenFile: bad }, rootKey: ROOT }),
    /Bridge connection failed/);
  assert.equal(existsSync(join(dir, 'a', 'run.lock')), false);
  if (process.platform !== 'win32') {
    const open = join(dir, 'open-token');
    writeFileSync(open, TOKEN, { mode: 0o644 });
    await assert.rejects(startAddon({ dataDir: join(dir, 'b'), bridge: { url: host.url, tokenFile: open }, rootKey: ROOT }), /chmod 600/);
  }
  assert.throws(() => checkBridgeUrl('ws://192.0.2.1:9000'), /ws:\/\/127\.0\.0\.1/);
  assert.equal(checkBridgeUrl('wss://peer.example:9000/'), 'wss://peer.example:9000/');
  assert.equal(checkBridgeUrl('ws://127.0.0.1:49222'), 'ws://127.0.0.1:49222/');
  await assert.rejects(main(['run', '--data', join(dir, 'c'), '--bridge', 'ws://192.0.2.1:1', '--token-file', tokenFile]), /--bridge must be/);
  await assert.rejects(main(['run', '--bridge', host.url]), /go together/);
  await assert.rejects(main(['run', '--bridge', host.url, '--token-file', 'relative']), /absolute/);
  await assert.rejects(main(['run', '--product', 'nft']), /--product/);
  await assert.rejects(main(['mcp', '--agent-posting']), /does not apply/);
  await assert.rejects(main(['frobnicate']), /Unknown command/);
});

test('`gator-social run --bridge … --mcp` end to end through the CLI', async t => {
  const host = await fakeHost(t);
  const { dir, tokenFile } = await scratch(t);
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  let out = '', err = '';
  stdout.on('data', c => { out += c; });
  stderr.on('data', c => { err += c; });
  const run = main(['run', '--data', join(dir, 'cli'), '--product', 'dmw', '--bridge', host.url, '--token-file', tokenFile,
    '--agent-posting', '--profile', 'small', '--mcp'], { stdin, stdout, stderr, signals: false });
  await until(() => err.includes('gator-social running'));
  assert.match(err, /"mode":"bridge"/);
  assert.match(err, new RegExp(HOST));
  stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'feed_post', arguments: { text: 'gm from the matter world' } } }) + '\n');
  const answer = await until(() => out.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(l => l.id === 1));
  assert.equal(JSON.parse(answer.result.content[0].text).sent, true);
  assert.ok(host.joined.has('soc/p/dmw'));
  // The status command reaches the running process through its control API.
  const status = new PassThrough();
  let statusText = '';
  status.on('data', c => { statusText += c; });
  assert.equal(await main(['status', '--data', join(dir, 'cli')], { stdout: status }), 0);
  assert.equal(JSON.parse(statusText).product, 'dmw');
  stdin.end(); // MCP input closed: the process shuts down cleanly.
  assert.equal(await run, 0);
  assert.equal(existsSync(join(dir, 'cli', 'run.lock')), false);
  assert.equal(host.joined.size, 0);
});

test('the bin as a child process stops when its parent closes stdin', { timeout: 60_000 }, async t => {
  const { spawn } = await import('node:child_process');
  const host = await fakeHost(t);
  const { dir, tokenFile, beforeRemove } = await scratch(t);
  const data = join(dir, 'child');
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'gator-social.js'), 'run', '--data', data,
    '--product', 'dex', '--bridge', host.url, '--token-file', tokenFile, '--profile', 'small', '--exit-on-stdin-close'],
  { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GATOR_IDENTITY_LOCKS: join(dir, 'locks') } });
  let out = '';
  child.stdout.on('data', c => { out += c; });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  beforeRemove(async () => {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    await exited;
  });
  await until(() => out.includes('gator-social running'), { timeout: 30_000 });
  assert.ok(existsSync(join(data, 'run.lock')));
  assert.ok(existsSync(join(data, 'control.json')));
  child.stdin.end();
  assert.equal(await exited, 0);
  assert.equal(existsSync(join(data, 'run.lock')), false);
  assert.equal(existsSync(join(data, 'control.json')), false);
});

test('run keeps serving its local feed and restores subscriptions on a new bridge connection', async t => {
  const host = await fakeHost(t);
  const { dir, tokenFile, beforeRemove } = await scratch(t);
  const data = join(dir, 'lost'), stdin = new PassThrough(), client = socialClient(data);
  const run = main(['run', '--data', data, '--bridge', host.url, '--token-file', tokenFile,
    '--profile', 'small', '--agent-posting', '--exit-on-stdin-close'],
    { stdin, stdout: new PassThrough(), stderr: new PassThrough(), signals: false });
  beforeRemove(async () => { stdin.end(); await run; });
  await until(() => existsSync(join(data, 'control.json')));
  const remove = 'ef'.repeat(32);
  for (const key of [ROOT, remove]) assert.equal((await client.call('follow', { key })).value.changed, true);
  const read = async () => (await client.call('feed_read', {})).value.posts.map(p => p.untrustedText);
  const post = text => rootFrame('soc/u/' + ROOT, { v: 1, t: 'post', text });
  host.push(post('Before reconnect'));
  await until(async () => (await read()).includes('Before reconnect'));
  const expected = new Set(host.joined);
  expected.delete('soc/u/' + remove);

  host.offline = true;
  host.sessions[0].socket.terminate();
  await until(async () => (await client.status()).channels === 0);
  assert.deepEqual(await read(), ['Before reconnect']);
  assert.equal((await client.call('feed_post', { text: 'Offline send' })).value.sent, false);
  assert.equal((await client.call('follow', { key: remove, unfollow: true })).value.changed, true);
  host.offline = false;
  await until(async () => (await client.status()).channels === expected.size);
  assert.equal(host.sessions.length, 2);
  assert.deepEqual(host.sessions[1].subscribed, expected);
  assert.deepEqual(host.sessions[1].joined, expected);
  host.push(post('After reconnect'));
  await until(async () => (await read()).includes('After reconnect'));
  assert.deepEqual(await read(), ['After reconnect', 'Before reconnect']);
  assert.equal((await client.call('feed_post', { text: 'Online send' })).value.sent, true);
  await until(() => host.sent.at(-1)?.message.text === 'Online send');
  assert.equal(host.sent.some(row => row.message.text === 'Offline send'), false);
  stdin.end();
  assert.equal(await run, 0);
  assert.equal(existsSync(join(data, 'run.lock')), false);
});

test('recovery rejects a different peer identity and retries an incomplete channel restore', async t => {
  const host = await fakeHost(t);
  const { dir, tokenFile, beforeRemove } = await scratch(t);
  const addon = await startAddon({ dataDir: dir, bridge: { url: host.url, tokenFile }, rootKey: ROOT, proofs: false });
  beforeRemove(() => addon.close());
  const wanted = new Set(addon.transport.channels());
  host.peer = 'cd'.repeat(32);
  host.sessions[0].socket.terminate();
  await until(() => host.sessions[1]?.socket.readyState === WebSocket.CLOSED);
  assert.equal(host.sessions[1].subscribed.size, 0);
  assert.equal(addon.status().channels, 0);

  host.peer = HOST;
  host.refuseChannel = 'soc/dir';
  await until(() => host.sessions[2]?.socket.readyState === WebSocket.CLOSED);
  assert.ok(host.sessions[2].joined.size > 0);
  assert.equal(addon.status().channels, 0);
  host.refuseChannel = null;
  await until(() => addon.status().channels === wanted.size);
  assert.deepEqual(host.sessions[3].joined, wanted);
  assert.equal(addon.publicKey, HOST);
});

test('shutdown cancels a reconnect during the replacement handshake', async t => {
  const host = await fakeHost(t);
  const { dir, tokenFile, beforeRemove } = await scratch(t);
  const addon = await startAddon({ dataDir: dir, bridge: { url: host.url, tokenFile }, rootKey: ROOT, proofs: false });
  beforeRemove(() => addon.close());
  host.holdHello = true;
  host.sessions[0].socket.terminate();
  await until(() => host.sessions.length === 2);
  await addon.close();
  await until(() => host.sessions[1].socket.readyState === WebSocket.CLOSED);
  assert.equal(existsSync(join(dir, 'run.lock')), false);
});
