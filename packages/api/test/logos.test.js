import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { httpClient } from '../src/client.js';
import { fixture } from './fixtures.js';

// 64×64 PNG container: signature, IHDR, an (empty) IDAT and IEND. Only the header is ever decoded.
const chunk = (type, data) => Buffer.concat([Buffer.from([0, 0, 0, data.length]), Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'),
  chunk('IHDR', Buffer.from('00000040000000400806000000', 'hex')), chunk('IDAT', Buffer.alloc(4)), chunk('IEND', Buffer.alloc(0))]);

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host: '127.0.0.1:' + port, ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('logos: rows name a local image once fetched; /img serves it immutable, same-origin only, without credentials', async t => {
  let now = Date.now();
  const fetched = [];
  const app = await fixture(t).start('logos', { clock: () => now, fetch: async url => {
    fetched.push(String(url));
    if (String(url).startsWith('https://raw.githubusercontent.com/trustwallet/assets/')) return new Response(PNG);
    return new Response('{}', { status: 503 });
  } });
  const api = httpClient(app.dataDir);
  const first = (await api('GET', '/chains')).items.find(c => c.chain === 'ethereum');
  assert.equal(first.logo, null, 'never waits for the network');
  assert.equal(fetched.length, 0);
  // Every chain on the list was queued; the job takes one at a time, one request per host per second.
  app.engine.logos.stop();
  for (let ref = ''; ref !== null && !app.engine.logos.chain('ethereum');) {
    now += 1000;
    ref = await app.engine.logos.fetchNext();
  }
  assert.ok(fetched.some(url => /\/[0-9a-f]{40}\/blockchains\/ethereum\/info\/logo\.png$/.test(url)));
  const logo = (await api('GET', '/chains')).items.find(c => c.chain === 'ethereum').logo;
  assert.match(logo, /^\/img\/[0-9a-f]{64}\.png$/);

  const served = await get(app.port, logo);
  assert.equal(served.status, 200);
  assert.deepEqual(served.body, PNG);
  assert.equal(served.headers['content-type'], 'image/png');
  assert.equal(served.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(served.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(served.headers['x-content-type-options'], 'nosniff');
  assert.equal(served.headers['set-cookie'], undefined);
  assert.equal((await get(app.port, logo, { 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal((await get(app.port, logo, { 'sec-fetch-site': 'cross-site' })).status, 404);
  assert.equal((await get(app.port, logo.replace('.png', '.webp'))).status, 404);
  assert.equal((await get(app.port, '/img/' + 'a'.repeat(64) + '.png')).status, 404);
  assert.equal((await get(app.port, '/img/' + 'a'.repeat(64) + '.svg')).status, 404);
  assert.equal((await get(app.port, logo, { host: 'evil.example' })).status, 403);

  // The dashboard's own PNG icons are static files too.
  const icon = await get(app.port, '/favicon-32.png');
  assert.equal(icon.status, 200);
  assert.equal(icon.headers['content-type'], 'image/png');

  // Token rows and the token page carry the same field (null while not fetched yet).
  const btc = await api('GET', '/assets/bitcoin:native');
  assert.ok(Object.hasOwn(btc, 'logo'));
  assert.equal(app.engine.logos.demanded.has('asset:bitcoin:native'), true);
});
