import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { handleRpc, PROTOCOL_VERSIONS, serveMcp } from '../src/mcp.js';
import { socialClient } from '../src/client.js';
import { controlProof } from '../src/control.js';
import { main } from '../src/cli.js';
import { check, POSTING_OFF, SCHEMAS } from '../src/tools.js';
import { network, until } from './helpers.js';

const tools = [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' },
  async call(args) { if (args.fail) throw new Error('boom'); return { value: args }; } }];
const server = { tools, info: { name: 't', version: '1' }, instructions: 'hello' };

test('MCP JSON-RPC: initialize, list, call, errors', async () => {
  const init = await handleRpc(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.instructions, 'hello');
  const future = await handleRpc(server, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
  assert.equal(future.result.protocolVersion, PROTOCOL_VERSIONS[0]);
  assert.equal(await handleRpc(server, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual((await handleRpc(server, { jsonrpc: '2.0', id: 'a', method: 'ping' })).result, {});
  assert.deepEqual((await handleRpc(server, { jsonrpc: '2.0', id: 3, method: 'tools/list' })).result.tools,
    [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }]);
  const ok = await handleRpc(server, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { x: 1 } } });
  assert.deepEqual(JSON.parse(ok.result.content[0].text), { x: 1 });
  assert.equal(ok.result.isError, undefined);
  const failed = await handleRpc(server, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: { fail: true } } });
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /boom/);
  assert.equal((await handleRpc(server, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } })).error.code, -32602);
  assert.equal((await handleRpc(server, { jsonrpc: '2.0', id: 7, method: 'resources/list' })).error.code, -32601);
  assert.equal((await handleRpc(server, { id: 8, method: 'ping' })).error.code, -32600);
  assert.equal((await handleRpc(server, { jsonrpc: '2.0', id: {}, method: 'ping' })).error.code, -32600);
});

async function session(serve) {
  const input = new PassThrough(), output = new PassThrough();
  const lines = [];
  let buffer = '';
  output.on('data', chunk => {
    buffer += chunk;
    for (let at; (at = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(at + 1)) lines.push(JSON.parse(buffer.slice(0, at)));
  });
  const done = serve(input, output);
  let id = 0;
  return {
    lines, done,
    raw: line => input.write(line + '\n'),
    async rpc(method, params) {
      const mine = ++id;
      input.write(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }) + '\n');
      return until(() => lines.find(l => l.id === mine));
    },
    end: () => input.end(),
  };
}

test('MCP stdio framing', async () => {
  const s = await session((input, output) => serveMcp({ ...server, input, output }));
  s.raw('{not json');
  s.raw('[]');
  assert.equal((await s.rpc('ping')).result !== undefined, true);
  assert.deepEqual(s.lines.slice(0, 2).map(l => l.error.code), [-32700, -32600]);
  s.end();
  await s.done;
});

test('control API, client and `gator-social mcp` proxy', async t => {
  const net = await network(t);
  const addon = await net.addon();
  const dir = addon.status().dataDir;
  const client = socialClient(dir);
  const status = await client.status();
  assert.equal(status.publicKey, addon.publicKey);
  assert.equal(status.agentPosting, false);
  assert.deepEqual((await client.call('feed_read', { scope: 'official' })).value.posts, []);
  assert.deepEqual(await client.call('feed_post', { text: 'hi' }), { value: { error: POSTING_OFF }, isError: true });
  await assert.rejects(client.call('nope'), /Unknown tool/);

  // The owner (not the agent) can always publish the profile card.
  assert.deepEqual(await client.card({ handle: 'owner_set' }, ['dex']),
    { sent: true, card: { handle: 'owner_set', harnesses: ['dex'] }, topics: ['dex'] });
  assert.equal(addon.social.profile(addon.publicKey).handle, 'owner_set');
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).card.handle, 'owner_set');
  assert.deepEqual(await client.card({ handle: 'Bad Handle' }), { sent: false, error: 'handle: 2–24 of a–z, 0–9, _' });

  const { port } = JSON.parse(readFileSync(join(dir, 'control.json'), 'utf8'));
  const token = readFileSync(join(dir, 'control-token'), 'utf8').trim();
  const raw = (headers, method = 'GET', path = '/status') => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(await raw({ authorization: 'Bearer ' + token }), 200);
  assert.equal(await raw({ authorization: 'Bearer ' + 'f'.repeat(64) }), 401);
  assert.equal(await raw({ authorization: 'Bearer ' + token, host: 'evil.example:' + port }), 421);
  assert.equal(await raw({ authorization: 'Bearer ' + token, 'content-type': 'text/plain' }, 'POST', '/tools/feed_read'), 415);
  // R-APP-07: two credentials. The control token never reaches owner routes; the owner token never runs tools.
  const ownerToken = readFileSync(join(dir, 'owner-token'), 'utf8').trim();
  assert.notEqual(ownerToken, token);
  const json = { 'content-type': 'application/json' };
  assert.equal(await raw({ authorization: 'Bearer ' + token, ...json }, 'POST', '/owner/card'), 403);
  assert.equal(await raw({ authorization: 'Bearer ' + ownerToken, ...json }, 'POST', '/tools/feed_read'), 403);
  assert.equal(await raw({ authorization: 'Bearer ' + ownerToken }), 200);
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'owner-token')).mode & 0o077, 0);
  // R-APP-11: a listener on the recorded port must prove the token before the client sends it.
  const nonce = 'n'.repeat(32);
  const proof = await (await fetch(`http://127.0.0.1:${port}/proof?kind=owner&nonce=${nonce}`)).json();
  assert.equal(proof.proof, controlProof(ownerToken, 'owner', port, nonce));
  const seen = [];
  const squat = async handler => {
    const server = createServer((req, res) => { seen.push(req.headers.authorization); handler(req, res); });
    await new Promise(ok => server.listen(0, '127.0.0.1', ok));
    t.after(() => new Promise(ok => { server.closeAllConnections(); server.close(ok); }));
    return server.address().port;
  };
  const fakeDir = join(net.dir, 'squatted');
  mkdirSync(fakeDir, { mode: 0o700 });
  for (const file of ['control-token', 'owner-token']) copyFileSync(join(dir, file), join(fakeDir, file));
  const fake = await squat((req, res) => res.end(JSON.stringify({ proof: 'f'.repeat(64) })));
  const relay = await squat(async (req, res) => res.end(await (await fetch(`http://127.0.0.1:${port}${req.url}`)).text()));
  for (const p of [fake, relay]) {
    writeFileSync(join(fakeDir, 'control.json'), JSON.stringify({ port: p }));
    await assert.rejects(socialClient(fakeDir).status(), /No token was sent/);
    await assert.rejects(socialClient(fakeDir).card({ handle: 'x_y' }), /No token was sent/);
  }
  assert.ok(seen.length === 4 && seen.every(h => h === undefined), String(seen));

  const s = await session((input, output) => main(['mcp', '--data', dir], { stdin: input, stdout: output }));
  const init = await s.rpc('initialize', { protocolVersion: '2025-03-26' });
  assert.equal(init.result.serverInfo.name, 'gator-social');
  const listed = (await s.rpc('tools/list')).result.tools;
  assert.deepEqual(listed.map(t => t.name), ['feed_read', 'feed_post', 'reply', 'follow', 'like', 'repost', 'mute', 'profile']);
  assert.deepEqual(listed[0].inputSchema, SCHEMAS.feed_read);
  const read = await s.rpc('tools/call', { name: 'profile', arguments: {} });
  assert.equal(JSON.parse(read.result.content[0].text).profile.handle, 'owner_set');
  const post = await s.rpc('tools/call', { name: 'feed_post', arguments: { text: 'hello' } });
  assert.equal(post.result.isError, true);
  assert.equal(JSON.parse(post.result.content[0].text).error, POSTING_OFF);
  s.end();
  assert.equal(await s.done, 0);

  await addon.close();
  await assert.rejects(socialClient(dir).status(), /not running/);
});

test('argument schema checks', () => {
  assert.equal(check(SCHEMAS.feed_read, {}), null);
  assert.equal(check(SCHEMAS.feed_read, { limit: 101 }), 'arguments.limit is out of range');
  assert.equal(check(SCHEMAS.feed_read, { key: 'ABC' }), 'arguments.key has the wrong format');
  assert.equal(check(SCHEMAS.feed_read, null), 'arguments must be an object');
  assert.equal(check(SCHEMAS.reply, { id: 'x' }), 'arguments.text is required');
  assert.equal(check(SCHEMAS.follow, { key: 'a'.repeat(64), unfollow: 'yes' }), 'arguments.unfollow must be true or false');
  assert.equal(check(SCHEMAS.profile, { set: { handle: 'ok_1', topics: ['a', 'b', 'c', 'd', 'e', 'f'] } }), 'arguments.set.topics must be a list of at most 5');
  assert.equal(check(SCHEMAS.profile, { set: { handle: 'ok_1', topics: ['märkte'] } }), null);
  assert.equal(check(SCHEMAS.feed_post, { text: '😀'.repeat(500) }), null);
  assert.equal(check(SCHEMAS.feed_post, { text: '' }), 'arguments.text has the wrong length');
});
