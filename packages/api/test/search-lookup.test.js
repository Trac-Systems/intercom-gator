import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures.js';
import { httpClient } from '../src/client.js';

test('GET /search: a full unknown EVM address starts the by-address lookup and answers with its status', async t => {
  let reads = 0;
  const app = await fixture(t).start('lookup', { async fetch(url, options) {
    if (!options?.body) return new Response('{}', { status: 503 });
    const req = JSON.parse(options.body), list = [req].flat();
    const out = list.map(({ id, method }) => { reads++; return method === 'eth_getCode' ? { jsonrpc: '2.0', id, result: '0x' }
      : { jsonrpc: '2.0', id, error: { code: -32601, message: 'unexpected' } }; });
    return Response.json(Array.isArray(req) ? out : out[0]);
  } });
  const agent = httpClient(app.dataDir), wallet = '0x' + '7'.repeat(40);
  // Partial addresses, names and the dashboard's typing reads (lookup=0) start nothing.
  assert.equal((await agent('GET', '/search', { q: wallet.slice(0, 30) })).lookup, null);
  assert.equal((await agent('GET', '/search', { q: 'bitcoin' })).lookup, null);
  assert.equal((await agent('GET', '/search', { q: wallet, lookup: '0' })).lookup, null);
  assert.equal(reads, 0);
  const started = (await agent('GET', '/search', { q: wallet })).lookup;
  assert.equal(started.state, 'queued');
  assert.equal(started.message, 'Looking this address up on 1 chain…');
  await app.engine.addTokens.lookupsIdle();
  const done = (await agent('GET', '/search', { q: wallet, lookup: '0' })).lookup;
  assert.equal(done.state, 'no-contract');
  assert.match(done.message, /^No contract at this address on any of the 1 chain\./);
  assert.equal(reads, 1);
  // Searching it again is answered from the cache.
  assert.equal((await agent('GET', '/search', { q: wallet })).lookup.state, 'no-contract');
  assert.equal(reads, 1);
});
