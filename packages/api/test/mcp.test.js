import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp.js';
import { httpClient } from '../src/client.js';
import { readToken } from '../src/local.js';
import { fixture } from './fixtures.js';
import { createMemoryHub, MemoryTransport } from '@gator/net';
import { contentHash } from '../../engine/src/intel/extras.js';
import { word } from '../../engine/src/intel/values.js';
import { setTimeout as delay } from 'node:timers/promises';

const expected = ['price','token','search','markets','candles','new_tokens','trending','movers','risk_check',
  'fear_greed','portfolio','alerts','briefing','sentiment','why_trusted','feed_read','feed_post','reply','follow','set_avatar','announce_placement',
  'unfollow','like','repost','mute','directory','profile','profile_set','overview','categories','chains','exchanges','derivatives',
  'focus','focus_list','coverage','token_markets','splits','extras','extras_quote','extras_receipt','watchlist','watch','alert_set','alert_remove','portfolio_watch','portfolio_holding','node_status'];

test('SDK client negotiates all tools, validates schemas and receives structured observations', async t => {
  const app = await fixture(t).start('stdio');
  const api = httpClient(app.dataDir), owner = httpClient(app.dataDir,{ owner:true });
  const server = createMcpServer(api), client = new Client({ name:'gator-test',version:'1' });
  const [left,right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right);
    await client.connect(left);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(),expected.toSorted());
    const call = (name,args = {}) => client.callTool({ name,arguments:args });
    for (const name of ['price','token','candles','sentiment','why_trusted','risk_check']) {
      const result = await call(name,{ asset:'BTC' });
      assert.ok(result.structuredContent,name);
      assert.equal(result.content[0].type,'text');
    }
    for (const name of ['markets','new_tokens','trending','movers','fear_greed','portfolio','alerts','briefing','feed_read']) {
      assert.ok((await call(name)).structuredContent,name);
    }
    assert.equal((await call('token',{ asset:'BTC' })).structuredContent.placement, null);
    const placement = { slot:'spotlight', assetId:'ethereum:0x' + '1'.repeat(40), purchaseId:'0x' + '2'.repeat(64) };
    assert.match((await call('announce_placement', placement)).content[0].text, /No verified live placement/);
    assert.equal((await call('announce_placement', { ...placement, slot:'pinned-news' })).isError, true);
    assert.equal((await call('search',{ q:'BTC' })).structuredContent.tokens[0].symbol,'BTC');
    // R-APP-01: a price that is not green carries a plain caveat, in the structured result and the text.
    await app.engine.scheduler.jobs.get('cex:bitstamp').run();
    const price = await call('price',{ asset:'BTC' });
    assert.equal(price.structuredContent.price,123.1);
    assert.notEqual(price.structuredContent.trust,'green');
    assert.match(price.structuredContent.caveat,/^Low trust/);
    assert.ok(price.content[0].text.includes('Caveat: ' + price.structuredContent.caveat));
    assert.equal((await call('candles',{ asset:'BTC',tf:'what' })).isError,true);
    assert.match((await call('feed_post',{ text:'test' })).content[0].text,/disabled/);
    assert.match((await call('profile_set',{ name:'Agent' })).content[0].text,/posting is disabled/);
    await owner('PUT','/settings',{},{ agent:{ agentPosting:true } });
    assert.match((await call('profile_set',{ topics:['two words'] })).content[0].text,/topics/);
    const card = (await call('profile_set',{ handle:'agent_one', bio:'Local observer', topics:['#markets'] })).structuredContent;
    assert.equal(card.handle,'@agent_one');
    assert.deepEqual(card.topics,['markets']);
    const edited = (await call('profile_set',{ bio:null })).structuredContent;
    assert.equal(edited.bio,'');
    assert.equal(edited.handle,card.handle);
    assert.deepEqual(edited.topics,card.topics);
    const post = (await call('feed_post',{ text:'First tool post' })).structuredContent;
    const parent = { key:post.key,id:post.id };
    assert.match((await call('reply',{ text:'Reply',parent })).content[0].text,/replies are disabled/);
    await owner('PUT','/settings',{},{ agent:{ agentReplies:true, agentFollow:true } });
    assert.deepEqual((await call('reply',{ text:'Reply',parent })).structuredContent.parent,parent);
    assert.equal((await call('follow',{ key:'c'.repeat(64) })).structuredContent.followed,true);
    assert.equal((await call('unfollow',{ key:'c'.repeat(64) })).structuredContent.followed,false);
    assert.equal((await call('like',{ target:parent })).structuredContent.liked,true);
    assert.equal((await call('like',{ target:parent, undo:true })).structuredContent.liked,false);
    assert.equal((await call('mute',{ key:'d'.repeat(64) })).structuredContent.muted,true);
    assert.equal((await call('mute',{ key:'d'.repeat(64), remove:true })).structuredContent.muted,false);
    assert.equal((await call('profile')).structuredContent.key,app.transport.publicKey);
  } finally { await client.close(); await server.close(); }
});

test('every read and local-list tool answers through the MCP client', async t => {
  const app = await fixture(t).start('reads');
  const server = createMcpServer(httpClient(app.dataDir)), client = new Client({ name:'gator-test',version:'1' });
  const [left,right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right);
    await client.connect(left);
    const call = async (name,args = {}) => {
      const result = await client.callTool({ name,arguments:args });
      assert.notEqual(result.isError,true,name + ': ' + result.content?.[0]?.text);
      assert.ok(result.structuredContent,name);
      return result.structuredContent;
    };
    await app.engine.scheduler.jobs.get('cex:bitstamp').run();
    for (const name of ['overview','categories','chains','exchanges','derivatives','splits','extras','watchlist','directory','node_status']) {
      await call(name);
    }
    await call('categories',{ include_hidden:true, limit:5 });
    const pairs = await call('token_markets',{ asset:'BTC', limit:1 });
    assert.ok(Array.isArray(pairs.items) && pairs.items.length <= 1 && pairs.total >= pairs.items.length);
    assert.equal((await call('watch',{ asset:'BTC' })).items.length,1);
    assert.equal((await call('watch',{ asset:'BTC', remove:true })).items.length,0);
    const alerts = await call('alert_set',{ asset:'BTC', op:'above', value:200 });
    const id = alerts.items[0].id;
    assert.equal((await call('alert_remove',{ id })).items.length,0);
    const watched = await call('portfolio_watch',{ address:'0x' + 'a'.repeat(40), label:'treasury' });
    assert.equal(watched.addresses?.length ?? watched.watched?.length ?? 1, 1);
    await call('portfolio_holding',{ asset:'BTC', amount:'0.5' });
    assert.equal((await call('focus',{ asset:'BTC' })).items[0].asset, 'bitcoin:native');
    const list = await call('focus_list');
    assert.equal(list.items[0].expiresAt - list.items[0].addedAt, 168 * 3_600_000);
    const coverage = await call('coverage',{ asset:'BTC' });
    assert.equal(coverage.reporters.lastHour, 1);
    const status = await call('node_status');
    assert.equal(status.focus.items[0].asset,'bitcoin:native');
    assert.equal((await call('focus',{ asset:'BTC', remove:true })).items.length, 0);
    assert.ok('peers' in status && status.sources && status.feedback.includes('/issues'));
    assert.deepEqual(status.patches, app.engine.patches.status());
    const info = client.getInstructions?.() ?? '';
    assert.match(info,/github\.com\/Trac-Systems\/intercom-gator\/issues/);
  } finally { await client.close(); await server.close(); }
});

test('streamable HTTP accepts authenticated SDK clients and always applies agent policy', async t => {
  const app = await fixture(t).start('http');
  const url = new URL('http://127.0.0.1:' + app.port + '/mcp');
  assert.equal((await fetch(url)).status,401);
  for (const credential of ['api-token','dashboard-token']) {
    const client = new Client({ name:'gator-test',version:'1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(url,{ requestInit:{
        headers:{ Authorization:'Bearer ' + readToken(app.dataDir,credential) } } }));
      const res = await client.callTool({ name:'price',arguments:{ asset:'BTC' } });
      assert.equal(res.structuredContent.id,'bitcoin:native');
      const refused = await client.callTool({ name:'feed_post',arguments:{ text:'refused' } });
      assert.equal(refused.isError,true);
      assert.match(refused.content[0].text,/posting is disabled/);
    } finally { await client.close(); }
  }
});

test('agent announcement travels over gator/new and appears on the receiving node’s asset view', async t => {
  const contract = '0x' + 'c'.repeat(40), token = '0x' + 'b'.repeat(40), buyer = '0x' + 'a'.repeat(40);
  const args = { slot: 'spotlight', assetId: 'ethereum:' + token, purchaseId: '0x' + word(42) };
  const hub = createMemoryHub(), apps = fixture(t, { paidExtras: { ethereum: contract } });
  const start = Math.floor(Date.now() / 1000) - 30, end = start + 6 * 3600;
  const options = {
    transport: config => new MemoryTransport({ ...config, hub }),
    async fetch(_url, init) {
      if (!init?.body) return new Response('{}', { status: 404 });
      const { id, method, params } = JSON.parse(init.body);
      let result;
      if (method === 'eth_call' && params[0].to === contract) {
        const live = BigInt('0x' + params[0].data.slice(10)) === 2n;
        const tuple = [args.purchaseId, buyer, contentHash(args.slot, args), start, end, 100];
        result = '0x' + [32, Number(live), ...(live ? tuple : [])].map(word).join('');
      } else if (method === 'eth_getCode' && params[0] === token) result = '0x6000';
      else if (method === 'eth_call' && params[0].data.startsWith('0x82ad56cb')) {
        // aggregate3 of the token's totalSupply and allowance reads.
        result = '0x' + [32, 2, 64, 192, 1, 64, 32, 1000, 1, 64, 32, 0].map(word).join('');
      }
      else return new Response('{}', { status: 404 });
      return Response.json({ jsonrpc: '2.0', id, result });
    },
  };
  const buyerNode = await apps.start('buyer', options), late = await apps.start('receiver', options);
  await Promise.all([buyerNode.intel.settled(), late.intel.settled()]);
  const api = httpClient(late.dataDir), server = createMcpServer(httpClient(buyerNode.dataDir));
  const client = new Client({ name: 'placement-agent', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right);
    await client.connect(left);
    const result = await client.callTool({ name: 'announce_placement', arguments: args });
    assert.deepEqual(result.structuredContent, { ...args, chain: 'ethereum', announced: true }, result.content[0].text);
    // The receiver independently verifies the token through rate-limited RPC reads.
    const deadline = Date.now() + 15_000;
    while (!late.store.getAsset(args.assetId) && Date.now() < deadline) await delay(25);
    assert.ok(late.store.getAsset(args.assetId), 'Receiving node timed out verifying the placement');
    const detail = await api('GET', '/assets/' + encodeURIComponent(args.assetId));
    assert.deepEqual(detail.placement.active, { slot: args.slot, purchaseId: args.purchaseId, chain: 'ethereum',
      label: 'Promoted', until: end * 1000 });
    assert.equal(detail.price, null);
    assert.equal(detail.visibility, 'unconfirmed');
    const { items } = await api('GET', '/extras');
    assert.equal(items.length, 1);
    assert.equal(items[0].token.id, args.assetId);
    assert.equal((await api('GET', '/markets')).items.some(row => row.id === args.assetId), false);
  } finally { await client.close(); await server.close(); }
});
