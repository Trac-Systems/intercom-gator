import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp.js';
import { httpClient } from '../src/client.js';
import { createRouter } from '../src/routes.js';
import { fixture } from './fixtures.js';
import { keccak256 } from '../../engine/src/intel/keccak.js';
import { selector, word } from '../../engine/src/intel/values.js';

const contract = '0x' + 'c'.repeat(40), token = '0x' + 'e'.repeat(40);
const price = 2300n * 10n ** 18n, buyer = '0x' + 'b'.repeat(40), id = '0x' + word(123);
const txHash = '0x' + word(987), sig = keccak256('Purchased(bytes32,uint8,uint8,address,bytes32,uint256,uint256,uint256)');

function aggregate(values) {
  return '0x' + [32, values.length, ...values.map((_, i) => 32 * values.length + 128 * i),
    ...values.flatMap(value => [1, 64, 32, value])].map(word).join('');
}

test('agent quotes use cached on-chain terms and exact unsigned calldata; receipts distinguish a content match from display', async t => {
  let now = Date.now(), reads = 0, paused = false, receipt = null;
  const start = Math.floor(now / 1000) + 3600, hash = keccak256('gator:spotlight:bitcoin:native');
  const log = { address: contract, topics: [sig, id, '0x' + word(2), '0x' + word(buyer)],
    data: '0x' + [0, hash, start, start + 21600, price].map(word).join('') };
  const app = await fixture(t, { paidExtras: { ethereum: contract } }).start('quote', { clock: () => now,
    async fetch(url, options) {
      if (!options?.body) return new Response('{}', { status: 404 });
      const { id, method, params } = JSON.parse(options.body);
      let result;
      if (method === 'eth_getTransactionReceipt') result = receipt;
      else if (method === 'eth_call' && params[0].to === contract) {
        const active = now >= start * 1000 && params[0].data.endsWith(word(2));
        result = '0x' + [32, Number(active), ...(active ? [log.topics[1], buyer, hash, start, start + 21600, price] : [])].map(word).join('');
      }
      else if (method === 'eth_call' && params[0].data.startsWith('0x82ad56cb')) {
        for (const fn of ['price(uint8)', 'nextStart(uint8)', 'token()', 'paused()']) assert.ok(params[0].data.includes(selector(fn).slice(2)));
        reads++;
        result = aggregate([token, Number(paused), 1, start, 2, start, price, start]);
      } else throw new Error('unexpected RPC');
      return Response.json({ jsonrpc: '2.0', id, result });
    } });
  await app.intel.settled();
  const api = httpClient(app.dataDir);
  const server = createMcpServer(api), client = new Client({ name: 'wallet-fixture', version: '1' });
  const [l, r] = InMemoryTransport.createLinkedPair();
  await server.connect(r); await client.connect(l);
  t.after(async () => { await client.close(); await server.close(); });
  const call = (name, args) => client.callTool({ name, arguments: args });
  const [a, b] = await Promise.all([api('GET','/extras'), api('GET','/extras',{ slot:'spotlight' })]);
  assert.deepEqual(a.slots.map(s => s.price), ['1','2',String(price)]);
  assert.equal(b.slots.length, 1);
  const quote = (await call('extras_quote', { slot:'spotlight', asset:'BTC' })).structuredContent;
  assert.equal(reads, 1);
  assert.equal(quote.contentHash, hash);
  assert.equal(quote.price, String(price));
  assert.equal(quote.nextStart, start * 1000);
  assert.equal(quote.maxStart, (start + 600) * 1000);
  assert.deepEqual(quote.transactions, [
    { chainId: 1, to: token, data: '0x095ea7b3' + word(contract) + word(price), value:'0' },
    { chainId: 1, to: contract, data: selector('buy(uint8,bytes32,uint256,uint256)') + [2, hash, price, start + 600].map(word).join(''), value:'0' },
  ]);
  const post = { key:'a'.repeat(64), id:'news-1' };
  const news = (await call('extras_quote', { slot:'pinned-news', post })).structuredContent;
  assert.equal(news.contentHash, keccak256('gator:pinned-news:' + post.key + ':' + post.id));
  assert.equal((await call('extras_quote', { slot:'pinned-news', post, asset:'BTC' })).isError, true);
  now += 65_000; // the frozen clock would otherwise leave every Ethereum endpoint inside its rate window
  assert.match((await call('extras_receipt', { txHash })).content[0].text,/pending/);
  now += 65_000;
  receipt = { transactionHash: txHash, status:'0x1', logs:[{ ...log, address: token }, log] };
  const got = (await call('extras_receipt', { txHash })).structuredContent;
  assert.equal(got.purchaseId, id);
  assert.equal(got.lane, 0);
  assert.equal(got.start, start * 1000);
  assert.equal(got.end, (start + 21600) * 1000);
  assert.equal(got.contentHashMatch, true);
  assert.equal(got.shown, false);
  assert.match(got.next,/announce_placement/);
  now = start * 1000;
  await app.intel.extras.refresh();
  assert.equal((await call('extras_receipt', { txHash })).structuredContent.shown,true);
  now += 65_000;
  receipt.logs = [{ ...log, topics:[sig,id,'0x' + word(1),'0x' + word(buyer)],
    data:'0x' + [0, '0x' + word(128), start,start+43200,price].map(word).join('') }];
  const unmatched = (await call('extras_receipt', { txHash })).structuredContent;
  assert.equal(unmatched.contentHashMatch,false);
  assert.equal(unmatched.content,null);
  assert.equal(unmatched.next,undefined);
  now += 65_000;
  receipt.logs[0].data = '0x' + [0, news.contentHash, start, start+43200, price].map(word).join('');
  const recovered = await createRouter(app)('POST','/extras/receipt',{}, { txHash });
  assert.equal(recovered.contentHashMatch,true);
  assert.equal(recovered.content.envelopeId,post.id);
  now += 65_000;
  receipt.logs = [{ ...log, address: token }];
  assert.match((await call('extras_receipt', { txHash })).content[0].text,/no Purchased/);
  paused = true;
  assert.match((await call('extras_quote', { slot:'spotlight', asset:'BTC' })).content[0].text,/paused/);
  assert.equal(reads, 2);
});

test('a reverted receipt on another configured chain cannot hide the purchase', async () => {
  const { extrasRoutes } = await import('../src/extras.js');
  const chains = ['ethereum','base'].map(id => ({ id, family:'evm' }));
  const bundle = { chains, paidExtras:{ ethereum:token, base:contract } };
  const log = { address:contract, topics:[sig,id,'0x' + word(0),'0x' + word(buyer)],
    data:'0x' + [0,keccak256('gator:promoted-token:bitcoin:native'),1,86401,price].map(word).join('') };
  const rpc = { publicOnly: { async call(chain) {
    return { transactionHash:txHash, status:chain === 'base' ? '0x1' : '0x0', logs:chain === 'base' ? [log] : [] };
  } } };
  const service = extrasRoutes({ engine:{ bundle, rpc }, clock:Date.now, store:{ getSetting() {} } },
    { extraCandidates:() => [], extras:() => ({ items:[] }) });
  const result = await service.receipt({ txHash });
  assert.equal(result.chain,'base');
  assert.equal(result.purchaseId,id);
});

test('contract terms are read again after a failure: three attempts per read, a failed read is not cached', async () => {
  const { extrasRoutes } = await import('../src/extras.js');
  const bundle = { chains:[{ id:'ethereum', family:'evm', chainId:1 }], paidExtras:{ ethereum:contract } };
  let failures = 0, down = false, reads = 0;
  const answer = call => {
    const s = call.params[0].data.slice(0, 10);
    if (s === selector('token()')) return '0x' + word(token);
    if (s === selector('paused()')) return '0x' + word(0);
    if (s === selector('price(uint8)')) return '0x' + word(price);
    return '0x' + word(Math.floor(Date.now() / 1000));
  };
  const rpc = { publicOnly: { async batch(_chain, calls) {
    reads++;
    if (down || failures-- > 0) throw new Error('endpoint failed');
    return calls.map(answer);
  } } };
  const service = extrasRoutes({ engine:{ bundle, rpc }, clock:Date.now, store:{ getSetting() {} } },
    { extraCandidates:() => [], extras:() => ({ items:[] }) });
  failures = 2;
  assert.equal((await service.list()).slots[0].price, price.toString(), 'the third attempt succeeds');
  assert.equal(reads, 3);
  const fresh = extrasRoutes({ engine:{ bundle, rpc }, clock:Date.now, store:{ getSetting() {} } },
    { extraCandidates:() => [], extras:() => ({ items:[] }) });
  down = true;
  assert.equal((await fresh.list()).slots[0].price, null);
  down = false;
  assert.equal((await fresh.list()).slots[0].price, price.toString(), 'no minute-long cached failure');
});
