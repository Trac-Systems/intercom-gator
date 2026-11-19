import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { BridgeTransport, MemoryTransport, createMemoryHub, keyFromSeed } from '../src/index.js';

async function fakeBridge(t, { requiresAuth = true, binary = false } = {}) {
  const wallet = keyFromSeed(randomBytes(32).toString('hex'));
  const token = randomBytes(24).toString('hex');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const host = {
    publicKey: wallet.publicKey.toString('hex'), token, url: 'ws://127.0.0.1:' + server.address().port,
    requests: [], subscribed: new Set(), dropped: new Set(),
    push(frame) {
      const json = JSON.stringify(frame);
      host.socket.send(binary ? Buffer.from(json) : json);
    },
  };
  server.on('connection', socket => {
    host.socket = socket;
    let authed = !requiresAuth;
    host.push({ type: 'hello', peer: binary ? Uint8Array.from(wallet.publicKey) : wallet.publicKey,
      requiresAuth, entryChannel: null, filter: 'example' });
    socket.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      host.requests.push(msg.type);
      assert.ok(Number.isSafeInteger(msg.id));
      const reply = (type, fields) => host.push({ id: msg.id, type, ...fields });
      if (msg.type === 'auth') {
        authed = msg.token === token;
        return reply(authed ? 'auth_ok' : 'error');
      }
      if (!authed) return reply('error');
      const channel = msg.channel;
      switch (msg.type) {
        case 'clear_filter': return reply('filter_set', { filter: '' });
        case 'stats': return reply('stats', { connectionCount: 4, channels: ['host-only'] });
        case 'subscribe':
        case 'unsubscribe':
          for (const name of msg.channels) {
            if (msg.type === 'subscribe') host.subscribed.add(name);
            else host.subscribed.delete(name);
          }
          return reply('subscribed', { channels: [...host.subscribed] });
        case 'join':
          if (host.dropped.has(channel)) return;
          if (channel === 'test/denied') return reply('error', { error: 'Join denied.' });
          return reply('joined', { channel, announced: true });
        case 'send':
          if (msg.message.denied) return reply('error', { error: 'Send denied.' });
          host.sent = msg.message;
          return reply('sent', { channel });
        case 'leave':
          host.subscribed.delete(channel);
          return reply('left', { channel, ok: true });
        default: assert.fail('Unexpected bridge request: ' + msg.type);
      }
    });
  });
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  return host;
}

test('bridge authenticates, subscribes, maps signed events, sends and leaves', { timeout: 5000 }, async t => {
  const host = await fakeBridge(t);
  const transport = new BridgeTransport({ url: host.url, token: host.token });
  t.after(() => transport.close());
  const peerCount = once(transport, 'peer');
  const data = 'gator/meta';
  const membership = transport.join(data);
  assert.ok(await transport.ready);
  assert.equal(transport.publicKey, host.publicKey);
  assert.deepEqual(await peerCount, [4]);
  assert.ok(await membership);
  assert.ok(await transport.join(data));
  assert.equal(transport.peerCount(), 4);
  assert.deepEqual(transport.channels(), [data]);
  assert.deepEqual(host.requests, ['auth', 'clear_filter', 'stats', 'subscribe', 'join']);
  assert.ok(host.subscribed.has(data));

  const hub = createMemoryHub();
  const source = new MemoryTransport({ hub });
  const relay = new MemoryTransport({ hub });
  t.after(() => Promise.all([source.close(), relay.close()]));
  await source.join(data);
  await relay.join(data);
  const admitted = once(relay, 'message');
  assert.ok(source.send(data, { t: 'claim', v: 1, value: 'abc' }));
  const [, { pow, ...envelope }] = await admitted;
  assert.equal(pow.difficulty, 10);
  // A managed host's event: the canonical fields plus its own verdict and relay annotation.
  const sample = { ...envelope, type: 'sidechannel_message', relayedBy: null, verified: true };
  const delivered = [];
  transport.on('message', (channel, env) => delivered.push([channel, env]));
  const received = once(transport, 'message');
  host.push({ ...sample, channel: 'host-only' });
  host.push({ ...sample, message: { text: 'x'.repeat(8193) } });
  host.push({ ...sample, verified: false, message: { ...sample.message, value: 'unverified' } });
  host.push(sample);
  await received;
  assert.deepEqual(delivered, [[data, envelope]]);
  assert.equal(transport.rebroadcast(delivered[0][1]), false);

  assert.ok(transport.send(data, sample.message));
  assert.equal(transport.send(data, { text: 'x'.repeat(8193) }), false);
  const denial = once(transport, 'send-error');
  assert.ok(transport.send(data, { denied: true }));
  assert.deepEqual(await denial, [data]);
  assert.deepEqual(host.sent, sample.message);
  assert.ok(await transport.leave(data));
  assert.equal(host.subscribed.has(data), false);
  assert.equal(transport.send(data, sample.message), false);
  assert.deepEqual(transport.channels(), []);
  host.push(sample); // Empty host subscription means wildcard, so local membership must filter it.
  assert.equal(await transport.join('test/denied'), false);
  assert.equal(host.subscribed.has('test/denied'), false);
  assert.equal(delivered.length, 1);
  await transport.close();
  assert.equal(transport.peerCount(), 0);
  assert.equal(await transport.join(data), false);
});

test('bridge rejects incorrect credentials without creating memberships or sending application data', { timeout: 5000 }, async t => {
  const host = await fakeBridge(t);
  const client = new BridgeTransport({ url: host.url, token: randomBytes(24).toString('hex') });
  assert.equal(await client.join('gator/new'), false);
  assert.equal(await client.ready, false);
  assert.equal(client.publicKey, '');
  assert.deepEqual(host.requests, ['auth']);
  await client.close();
});

test('binary JSON frames, auth-free hosts, and disconnect during join settle outstanding operations', { timeout: 5000 }, async t => {
  const host = await fakeBridge(t, { requiresAuth: false, binary: true });
  const client = new BridgeTransport({ url: host.url });
  assert.ok(await client.ready);
  assert.ok(await client.join('gator/new'));
  assert.equal(client.publicKey, host.publicKey);
  assert.equal(host.requests.includes('auth'), false);
  host.dropped.add('gator/meta');
  const queuedJoin = client.join('gator/meta');
  await once(host.socket, 'message'); // subscription was sent; interrupt the pending operation
  host.socket.terminate();
  assert.equal(await queuedJoin, false);
  await client.close();
  assert.deepEqual(client.channels(), []);
  assert.equal(client.peerCount(), 0);
});

test('bridge emits close exactly once, whoever closes the socket, so callers can reconnect', { timeout: 5000 }, async t => {
  const host = await fakeBridge(t);
  const closes = [];
  const track = transport => {
    const seen = [];
    closes.push(seen);
    transport.on('close', info => seen.push(info));
    return transport;
  };

  // The host goes away: not requested, every operation settles, a later close() adds nothing.
  const dropped = track(new BridgeTransport({ url: host.url, token: host.token }));
  assert.ok(await dropped.join('gator/new'));
  const lost = once(dropped, 'close');
  host.socket.close(1001);
  assert.deepEqual(await lost, [{ requested: false, code: 1001 }]);
  assert.equal(dropped.peerCount(), 0);
  assert.deepEqual(dropped.channels(), []);
  assert.equal(dropped.send('gator/new', { t: 'post', v: 1 }), false);
  assert.equal(await dropped.join('gator/new'), false);
  await dropped.close();
  assert.equal(closes[0].length, 1);

  // Reconnect the way a caller would: a new transport on the same host, channels joined again.
  const again = track(new BridgeTransport({ url: host.url, token: host.token }));
  assert.ok(await again.join('gator/new'));
  assert.equal(again.publicKey, host.publicKey);

  // Our own close: requested, emitted before close() resolves, idempotent.
  let emittedFirst = false;
  again.once('close', () => { emittedFirst = true; });
  await Promise.all([again.close(), again.close()]);
  assert.ok(emittedFirst);
  await again.close();
  assert.equal(closes[1].length, 1);
  assert.equal(closes[1][0].requested, true);

  // Closed while still connecting, and closed by a failed authentication.
  const early = track(new BridgeTransport({ url: host.url, token: host.token }));
  await early.close();
  assert.equal(closes[2].length, 1);
  assert.equal(closes[2][0].requested, true);
  assert.equal(await early.ready, false);
  const refused = track(new BridgeTransport({ url: host.url, token: randomBytes(24).toString('hex') }));
  // ready settles false from the socket's close handler, so 'close' has already been emitted.
  assert.equal(await refused.ready, false);
  assert.equal(closes[3].length, 1);
  await refused.close();
  assert.equal(closes[3].length, 1);
  assert.equal(closes[3][0].requested, false);
});
