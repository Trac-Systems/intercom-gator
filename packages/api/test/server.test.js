import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { loadOrCreateSwarmKeyPair } from '@gator/net';
import { fixture } from './fixtures.js';
import { httpClient } from '../src/client.js';
import { CREDENTIALS, readToken, serverProof } from '../src/local.js';
import { priceCaveat } from '../src/routes.js';
import { createApi } from '../../dashboard/public/js/api.js';

test('a daemon owner can disable the GitHub patch source at startup', async t => {
  const saved = process.env.GATOR_PATCH_FEED;
  process.env.GATOR_PATCH_FEED = 'false';
  t.after(() => {
    if (saved === undefined) delete process.env.GATOR_PATCH_FEED;
    else process.env.GATOR_PATCH_FEED = saved;
  });
  const calls = [];
  const app = await fixture(t).start('feed-off', { fetch: async url => {
    calls.push(String(url));
    return new Response(null, { status: 404 });
  } });
  await app.engine.patches.feed.check();
  const { patches } = await httpClient(app.dataDir)('GET', '/network');
  assert.equal(patches.feed.result, 'disabled');
  assert.equal(patches.feed.nextCheck, null);
  assert.equal(patches.feed.lastFetch, null);
  assert.ok(calls.every(url => !url.startsWith('https://raw.githubusercontent.com/')));
});

test('loopback sign-in, Host, origin, CSP, body limits, private credentials and exact paths', async t => {
  const app = await fixture(t).start('api');
  // The in-memory transport needs no network key. Exercise the static routes with both key files on disk.
  loadOrCreateSwarmKeyPair(app.dataDir);
  const origin = 'http://127.0.0.1:' + app.port;
  const get = (path, init) => fetch(origin + path,init);
  const token = readToken(app.dataDir), login = readToken(app.dataDir,'dashboard-token');
  const headers = { Authorization: 'Bearer ' + token };
  const shell = await get('/');
  assert.match(shell.headers.get('content-security-policy'), /script-src 'self';/);
  assert.match(await shell.text(), /<!doctype html>/i);
  assert.equal((await get('/js/main.js')).status,200);
  const denied = await get('/api/v1/me');
  assert.equal(denied.status,401);
  assert.deepEqual(await denied.json(), { error: 'not signed in' });
  const guard = await new Promise((ok,fail) => {
    const req = request(origin + '/api/v1/me',{ headers: { Host: 'foreign.example:' + app.port,...headers } },res => { res.resume(); ok(res.statusCode); });
    req.on('error',fail); req.end();
  });
  assert.equal(guard,403);
  assert.equal((await get('/mcp',{ headers: { origin:'https://foreign.example',...headers } })).status,403);
  assert.equal((await get('/auth?t=incorrect',{ redirect:'manual' })).status,401);
  // The long-lived owner token is never a URL credential; sign-in uses one-time tickets.
  assert.equal((await get('/auth?t=' + login,{ redirect:'manual' })).status,401);
  const browser = cookie => ({ cookie,'x-gator':'1' });
  const agentLogin = await get('/auth?t=' + token,{ redirect:'manual' });
  assert.equal(agentLogin.status,303);
  const agentCookie = agentLogin.headers.get('set-cookie').split(';')[0];
  assert.equal(agentCookie.split('=')[0],'gator_session_' + app.port);
  assert.equal((await get('/api/v1/me',{ headers:browser(agentCookie) })).status,200);
  assert.equal((await get('/api/v1/settings',{ method:'PUT',headers:{ ...browser(agentCookie),'content-type':'application/json' },
    body:JSON.stringify({ agentPosting:true }) })).status,403);
  const mint = credential => get('/api/v1/login-ticket',{ method:'POST',body:'{}',
    headers:{ Authorization:'Bearer ' + credential,'content-type':'application/json' } });
  assert.equal((await mint(token)).status,403);
  const { ticket, expiresInSec } = await (await mint(login)).json();
  assert.equal(expiresInSec,60);
  const auth = await get('/auth?t=' + ticket,{ redirect:'manual' });
  assert.equal(auth.status,303);
  assert.equal(auth.headers.get('location'),'/');
  assert.match(auth.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await get('/auth?t=' + ticket,{ redirect:'manual' })).status,401);
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  assert.equal((await get('/api/v1/me',{ headers:browser(cookie) })).status,200);
  // R-APP-10: cookie requests need X-Gator, must not be cross-site, and only this port's cookie name counts.
  assert.equal((await get('/api/v1/me',{ headers:{ cookie } })).status,403);
  assert.equal((await get('/api/v1/me',{ headers:{ ...browser(cookie),'sec-fetch-site':'same-site' } })).status,403);
  assert.equal((await get('/api/v1/me',{ headers:browser(cookie.replace('_' + app.port + '=','_7420=')) })).status,401);
  assert.equal((await get('/api/v1/me',{ headers:browser(cookie.replace('_' + app.port + '=','=')) })).status,401);
  // EventSource cannot send headers: the read-only stream takes the cookie alone, but never cross-site.
  const control = new AbortController();
  assert.equal((await get('/api/v1/stream',{ headers:{ cookie },signal:control.signal })).status,200);
  control.abort();
  assert.equal((await get('/api/v1/stream',{ headers:{ cookie,'sec-fetch-site':'same-site' } })).status,403);
  for (const path of ['/api/v1/missing','/api/v1/me/extra','/keys/peer.json','/keys/swarm.json']) {
    const res = await get(path,{ headers });
    assert.equal(res.status,404);
    assert.deepEqual(await res.json(), { error:'no route' });
  }
  assert.equal((await get('/api/v1/posts',{ method:'POST',headers,body:'{}' })).status,415);
  const h = { ...headers,'content-type':'application/json' };
  for (const [body, status] of [['{',400],['[]',400],['x'.repeat(65537),413]]) {
    assert.equal((await get('/api/v1/posts',{ method:'POST',headers:h,body })).status,status);
  }
  for (const name of ['api-token','dashboard-token','stop-token','config.json','keys/peer.json','keys/swarm.json']) {
    if (process.platform !== 'win32') assert.equal(statSync(join(app.dataDir,name)).mode & 0o077,0);
  }
});

test('server proof before any bearer, stop credential scope, side-effect-free GETs and price caveats', async t => {
  const app = await fixture(t).start('guards');
  const origin = 'http://127.0.0.1:' + app.port;
  const nonce = randomBytes(24).toString('base64url');
  // R-APP-11: the daemon proves each credential with an HMAC bound to its port.
  for (const [kind,file] of Object.entries(CREDENTIALS)) {
    const { proof } = await (await fetch(origin + '/proof?kind=' + kind + '&nonce=' + nonce)).json();
    assert.equal(proof,serverProof(readToken(app.dataDir,file),kind,app.port,nonce));
  }
  for (const query of ['kind=agent&nonce=short','kind=root&nonce=' + nonce,'nonce=' + nonce]) {
    assert.equal((await fetch(origin + '/proof?' + query)).status,400);
  }
  // A squatter on the expected port, and one relaying the real daemon's answer, never see a bearer.
  const seen = [];
  const listen = async handler => {
    const server = createServer(async (req,res) => { seen.push(req.headers.authorization); handler(req,res); });
    await new Promise(ok => server.listen(0,'127.0.0.1',ok));
    t.after(() => new Promise(ok => { server.closeAllConnections(); server.close(ok); }));
    return server.address().port;
  };
  const fake = await listen((req,res) => res.end(JSON.stringify({ proof:'a'.repeat(64) })));
  const relay = await listen(async (req,res) => res.end(await (await fetch(origin + req.url)).text()));
  for (const port of [fake,relay]) {
    for (const credential of ['agent','owner','stop']) {
      await assert.rejects(httpClient(app.dataDir,{ port,credential })('GET','/me'),/No credential was sent/);
    }
  }
  assert.ok(seen.length >= 6 && seen.every(header => header === undefined),String(seen));
  // R-APP-06: the stop credential works on the stop route only.
  const stop = readToken(app.dataDir,'stop-token');
  for (const [method,path] of [['GET','/api/v1/me'],['PUT','/api/v1/settings'],['POST','/api/v1/login-ticket'],['POST','/mcp']]) {
    const res = await fetch(origin + path,{ method,headers:{ Authorization:'Bearer ' + stop,'content-type':'application/json' },
      body:method === 'GET' ? undefined : '{}' });
    assert.equal(res.status,401,path);
  }
  const agent = httpClient(app.dataDir);
  await assert.rejects(agent('POST','/stop',{},{}),/stop credential required/);
  // R-APP-10: GET /briefing does not record a read; POST does.
  const briefingFile = join(app.dataDir, 'agent', 'market', 'briefing.md');
  const readAt = Math.floor(app.clock() / 1000) - 5;
  utimesSync(briefingFile, readAt, readAt - 1);
  app.store.setSetting('intel:briefing:lastRead',5);
  const preview = await agent('GET','/briefing');
  assert.ok(preview.since >= readAt * 1000 && preview.since <= preview.at);
  assert.equal(app.store.getSetting('intel:briefing:lastRead'),5);
  await app.intel.refreshMarket();
  assert.ok(app.store.getSetting('intel:briefing:lastRead') >= preview.since);
  const facts = await agent('POST','/briefing',{},{});
  assert.equal(app.store.getSetting('intel:briefing:lastRead'),facts.at);
  // GET .../risk never runs a check (no RPC budget); POST does.
  const evm = app.engine.registry.token('ethereum','0x' + 'b'.repeat(40),{ symbol:'TKN',name:'Token',decimals:18 });
  let checks = 0;
  app.intel.risk.checkRisk = async asset => { checks++; return { asset,at:1,method:'stub',flags:{} }; };
  assert.equal((await agent('GET','/assets/' + evm.id + '/risk')).risk,null);
  assert.equal(checks,0);
  assert.equal((await agent('POST','/assets/' + evm.id + '/risk',{},{})).risk.method,'stub');
  assert.equal(checks,1);
  // R-APP-01: every non-green price answer carries a plain caveat.
  assert.match((await agent('GET','/assets/BTC/price')).caveat,/No USD price/);
  await app.engine.scheduler.jobs.get('cex:bitstamp').run();
  const price = await agent('GET','/assets/BTC/price');
  assert.notEqual(price.trust,'green');
  assert.match(price.caveat,/^Low trust/);
  assert.equal((await agent('GET','/assets/BTC')).caveat,price.caveat);
  assert.ok('supply' in (await agent('GET','/assets/BTC')), 'asset details carry supply provenance (null when unknown)');
  assert.equal(priceCaveat('green',1),null);
  assert.match(priceCaveat('red',1),/Do not act/);
});

test('dashboard and agent routes, mutations, validation, moderation and persisted settings', async t => {
  const f = fixture(t), app = await f.start('node', { nfts: true });
  const agent = httpClient(app.dataDir), owner = httpClient(app.dataDir,{ owner:true });
  const dash = createApi({ base:'http://127.0.0.1:' + app.port + '/api/v1', fetch: (url, options) =>
    fetch(url,{ ...options,headers: { ...options.headers,Authorization:'Bearer ' + readToken(app.dataDir,'dashboard-token') } }) });
  assert.equal(await dash.probe(),'live');
  const id = 'bitcoin:native', me = await dash.me();
  assert.equal(me.key,app.transport.publicKey);
  assert.equal(me.profile,'small');
  for (const route of ['markets','categories','chains','derivatives','nfts','new','trending','exchanges','directory','feed',
    'watchlist','alerts','extras','assets/' + id + '/posts','assets/' + id + '/markets']) {
    assert.ok(Array.isArray((await agent('GET','/' + route)).items),route);
  }
  // NFT collections (the trimmed fixture bundle keeps the Ethereum seed list) and the sources report: host names only.
  const nfts = await agent('GET','/nfts',{ limit:3 });
  assert.equal(nfts.items.length,3);
  assert.deepEqual([nfts.items[0].kind,nfts.items[0].floorKind,nfts.items[0].sales24h],['nft','sale',0]);
  assert.equal(nfts.status.chains[0].chain,'ethereum');
  assert.equal((await agent('GET','/nfts/' + nfts.items[0].id)).sales.length,0);
  await assert.rejects(agent('GET','/nfts/ethereum:0x' + '1'.repeat(40)),/unknown collection|404/);
  const sources = await agent('GET','/sources');
  assert.deepEqual(sources.groups.map(g => g.id),['cex','rpc','scanners','nft','data']);
  assert.doesNotMatch(JSON.stringify(sources),/https?:\/\//);
  assert.equal((await agent('GET','/assets/BTC')).contract,null);
  assert.equal((await agent('GET','/assets/BTC')).id,id);
  assert.equal((await agent('GET','/search',{ q:'BTC' })).tokens[0].id,id);
  assert.deepEqual((await agent('GET','/assets/BTC/candles',{ tf:'1m',limit:5000 })).candles,[]);
  assert.equal((await agent('GET','/fear-greed')).history30d.length,30);
  const network = await agent('GET','/network');
  assert.equal(network.peers,0);
  assert.deepEqual(network.patches, (await agent('GET','/settings')).bundle.patches);
  assert.equal(network.patches.feed.lastFetch, null);
  assert.ok(network.patches.feed.nextCheck > app.clock());
  assert.ok(sources.groups.flatMap(group => group.items).some(source => source.name === 'Bundle updates (GitHub)'));
  // This node counts itself as an active agent even before any report or post.
  assert.ok(network.agents24h >= 1);
  assert.ok(Array.isArray((await agent('GET','/global')).gas));
  assert.ok(Array.isArray((await agent('GET','/movers')).gainers));
  await assert.rejects(agent('POST','/posts',{},{ text:'unsupported' }),/posting is disabled/);
  await assert.rejects(agent('PUT','/settings',{},{ agentPosting:true }),/owner session/);
  await assert.rejects(owner('PUT','/settings',{},{ budgetPerMin:0 }),/budget out of range/);
  await assert.rejects(owner('POST','/posts',{},{ text:' ' }),/empty/);
  await assert.rejects(owner('POST','/posts',{},{ text:'😀'.repeat(501) }),/too long/);
  await assert.rejects(owner('PUT','/settings',{},{ card:{ handle:'@bad' } }),/handle:/);
  await assert.rejects(owner('POST','/replies',{},{ text:'hi' }),/parent required/);
  await assert.rejects(owner('POST','/mute',{},{ key:app.release.rootKey }),/cannot be muted/);
  const s = await dash.putSettings({ theme:'dark', budgetPerMin:30, agent:{ agentPosting:true, agentReplies:true, agentFollow:true },
    endpoint:{ chain:'Ethereum',kind:'rpc',url:'https://custom.example.org/path' }, card:{ handle:'local_test',bio:'Testing' } });
  assert.equal(s.theme,'dark');
  assert.equal(app.engine.budget.limit,30);
  assert.equal(app.engine.rpc.chains.get('ethereum')[0].user,true);
  assert.equal((await dash.me()).handle,'@local_test');
  const post = await agent('POST','/posts',{},{ text:'Looking at $BTC and #charts' });
  const target = { key:post.key,id:post.id };
  assert.deepEqual(post.tickers,[{ sym:'BTC',asset:id }]);
  const reply = await agent('POST','/replies',{},{ text:'Local reply',parent:target });
  assert.equal((await agent('GET','/posts/' + post.key + '/' + reply.id)).parents[0].id,post.id);
  assert.equal((await agent('GET','/posts/' + post.key + '/' + post.id)).replies[0].id,reply.id);
  assert.equal((await agent('GET','/feed',{ asset:id })).items[0].id,post.id);
  assert.equal((await agent('GET','/trending')).items.find(t => t.tag === '$BTC').posts,1);
  for (const [route,field] of [['likes','liked'],['reposts','reposted']]) {
    assert.equal((await owner('POST','/' + route,{},{ target }))[field],true);
    assert.equal((await owner('POST','/' + route,{},{ target,undo:true }))[field],false);
  }
  const key = 'a'.repeat(64);
  assert.equal((await agent('POST','/follow',{},{ key })).followed,true);
  assert.equal((await owner('POST','/mute',{},{ key })).muted,true);
  assert.ok((await dash.settings()).mutes.find(m => m.key === key));
  await owner('POST','/unmute',{},{ key });
  await owner('POST','/unfollow',{},{ key });
  assert.deepEqual((await dash.setWatch(id,true)).items,[id]);
  assert.deepEqual((await dash.setWatch(id,false)).items,[]);
  assert.equal((await dash.portfolioOp({ op:'add-holding',asset:id,amount:0.00000001 })).holdings[0].amount,1e-8);
  assert.deepEqual((await dash.portfolioOp({ op:'remove-holding',asset:id })).holdings,[]);
  const addresses = (await dash.portfolioOp({ op:'add-address',address:'0x' + 'a'.repeat(40) })).addresses;
  assert.equal(addresses.length,1);
  assert.deepEqual((await dash.portfolioOp({ op:'remove-address',id:addresses[0].id })).addresses,[]);
  for (const op of ['above','below','move']) {
    const added = await dash.addAlert({ asset:id,op,value:12 });
    assert.equal(added.items[0].op,op);
    assert.deepEqual((await dash.removeAlert(added.items[0].id)).items,[]);
  }
  const { agent: rules } = JSON.parse(readFileSync(join(app.dataDir,'config.json')));
  assert.equal(rules.agentPosting,true);
  await app.close();
  const restarted = await f.start('node');
  assert.equal(restarted.config.theme,'dark');
  assert.equal(restarted.config.agent.agentPosting,true);
  assert.equal(restarted.transport.publicKey,me.key);
});

test('feed and follows resolve handle ties locally and only a profile view requests proof refresh', async t => {
  const app = await fixture(t).start('handles');
  const owner = httpClient(app.dataDir, { owner: true });
  const first = 'a'.repeat(64), second = 'b'.repeat(64), handle = 'shared';
  const db = app.store.writer;
  const insert = db.prepare('INSERT INTO profiles(key, handle, card, ts, card_id) VALUES(?,?,?,?,?)');
  for (const key of [first, second]) insert.run(key, handle, JSON.stringify({ handle, harnesses: [] }), app.clock(), key);
  const profile = t.mock.method(app.social, 'profile');
  const follow = key => owner('POST', '/follow', {}, { key });
  await assert.rejects(follow('@shared'), { status: 409 });
  await assert.rejects(follow('@missing'), { status: 404 });
  assert.deepEqual((await owner('GET', '/directory')).items.map(p => p.key), [app.release.rootKey]);
  db.prepare('UPDATE profiles SET verified=? WHERE key=?').run('{"github":true}', second);
  assert.equal((await follow('@shared')).key, second);
  await follow(first);
  assert.equal((await owner('POST', '/unfollow', {}, { key: '@shared' })).key, second);
  assert.equal((await follow('@shared')).key, first); // followed takes precedence over verified
  await owner('PUT', '/settings', {}, { card: { handle } });
  const post = await owner('POST', '/posts', {}, { text: 'Local author' });
  assert.equal((await owner('GET', '/feed', { author: '@shared' })).items[0].id, post.id);
  const refreshes = () => profile.mock.calls.filter(c => c.arguments[1]?.verify).map(c => c.arguments[0]);
  assert.deepEqual(refreshes(), []);
  assert.equal((await owner('GET', '/profiles/' + first)).key, first);
  assert.deepEqual(refreshes(), [first]);
});

test('SSE carries signed posts, observed prices and exactly one persistent alert hit, on green trust only', async t => {
  const app = await fixture(t).start('events');
  const owner = httpClient(app.dataDir,{ owner:true });
  const controller = new AbortController();
  const stream = await fetch('http://127.0.0.1:' + app.port + '/api/v1/stream',{
    headers: { Authorization:'Bearer ' + readToken(app.dataDir) }, signal:controller.signal });
  assert.match(stream.headers.get('content-type'),/text\/event-stream/);
  const reader = stream.body.getReader();
  try {
    await reader.read();
    await owner('POST','/alerts',{},{ asset:'bitcoin:native',op:'above',value:100 });
    await owner('POST','/posts',{},{ text:'SSE round trip' });
    await app.engine.scheduler.jobs.get('cex:bitstamp').run();
    await owner('GET','/global');
    let wire = '';
    const until = async (...types) => {
      while (!types.every(type => wire.includes('event: ' + type))) {
        const timeout = AbortSignal.timeout(3000);
        const abort = () => controller.abort();
        timeout.addEventListener('abort',abort,{ once:true });
        try { wire += new TextDecoder().decode((await reader.read()).value); }
        finally { timeout.removeEventListener('abort',abort); }
      }
    };
    const events = () => wire.trim().split('\n\n').filter(f => f.startsWith('event:')).map(frame => {
      const [type,data] = frame.split('\n'); return [type.slice(7),JSON.parse(data.slice(6))];
    });
    await until('price','post');
    const observed = events().find(e => e[0] === 'price')[1];
    assert.equal(observed.id,'bitcoin:native');
    assert.equal(observed.price,123.1);
    assert.notEqual(observed.trust,'green');
    assert.equal(events().find(e => e[0] === 'post')[1].text,'SSE round trip');
    // R-APP-01: a price above the threshold but not green neither fires the alert nor uses it up.
    assert.equal(events().filter(e => e[0] === 'alert').length,0);
    assert.equal((await owner('GET','/alerts')).items[0].hit,null);
    for (let i = 0; i < 2; i++) app.engine.emit('price',{ asset:'bitcoin:native',price:123.1,change24h:null,change1h:null,trust:'green' });
    await until('alert');
    await owner('GET','/global');
    assert.equal(events().filter(e => e[0] === 'alert').length,1);
    assert.equal(events().find(e => e[0] === 'alert')[1].trust,'green');
    assert.ok((await owner('GET','/alerts')).items[0].hit);
  } finally { controller.abort(); await reader.cancel().catch(() => {}); }
});


test('HTTP mirrors use owner priority, charge each fallback, and back off a failing source', async t => {
  const seen = [];
  const app = await fixture(t).start('mirrors', { fetch: async url => {
    const endpoint = new URL(url);
    seen.push(endpoint);
    return endpoint.hostname === 'broken.example' ? new Response('',{ status:503 })
      : Response.json([{ market:'BTC/USD',last:'123.1',volume:'100' }]);
  } });
  const owner = httpClient(app.dataDir,{ owner:true });
  for (const url of ['https://working.example/base','https://broken.example/base']) {
    await owner('PUT','/settings',{},{ endpoint:{ kind:'cex',label:'bitstamp',url } });
  }
  const used = app.engine.budget.used;
  await app.engine.scheduler.jobs.get('cex:bitstamp').run();
  assert.deepEqual(seen.map(u => u.hostname),['broken.example','working.example']);
  assert.ok(seen.every(u => u.pathname === '/base/api/v2/ticker/'));
  assert.equal(app.engine.budget.used - used,2);
  assert.deepEqual((await owner('GET','/settings')).endpoints.map(e => e.health),['down','ok']);
  assert.equal((await owner('GET','/assets/BTC/price')).price,123.1);
});

test('extras resolve one verified purchase and expire without moving the rankings', async t => {
  const { createExtrasVerifier, contentHash } = await import('../../engine/src/intel/extras.js');
  const app = await fixture(t).start('extras');
  const api = httpClient(app.dataDir);
  const rankings = await api('GET','/markets');
  let now = app.clock();
  const sec = Math.floor(now / 1000), assetId = 'bitcoin:native';
  const addr = '0x' + '1'.repeat(40), word = n => BigInt(n).toString(16).padStart(64,'0');
  const verifier = createExtrasVerifier({ bundle:{ paidExtras:{ ethereum:addr } }, now:() => now, rpc:{
    async call(_chain,_method,[tx]) {
      const slot = ['promoted-token','pinned-news','spotlight'][Number(BigInt('0x' + tx.data.slice(10)))];
      if (slot === 'pinned-news') return '0x' + word(32) + word(0);
      return '0x' + [32,1,7,addr,contentHash(slot,{ assetId }),sec - 1,sec + 60,100].map(word).join('');
    },
  } });
  await verifier.refresh();
  app.intel.extras = verifier;
  // One live item per slot: the promoted token and the spotlight both run (pinned news has none).
  const extra = await api('GET','/extras');
  assert.deepEqual(extra.items.map(x => x.slot),['promoted-token','spotlight']);
  assert.ok(extra.items.every(x => x.label === 'Promoted' && x.token.id === assetId));
  assert.equal((await api('GET','/extras',{ slot:'spotlight' })).items.length,1);
  assert.deepEqual(await api('GET','/markets'),rankings);
  assert.deepEqual(await api('GET','/feed',{ lane:'official' }),{ items:[] });
  now = (sec + 60) * 1000;
  assert.deepEqual(await api('GET','/extras'),{ items:[], slots:[] });
});

test('a store over its cap is pruned within a minute, not at the next hourly run', async t => {
  t.mock.timers.enable({ apis:['setInterval'] });
  const app = await fixture(t).start('budget');
  let pruned = 0;
  app.store.onPrune(() => { pruned++; });
  t.mock.timers.tick(60_000);
  assert.equal(pruned, 0, 'under the cap nothing is pruned');
  app.config.storageCapMB = 0.01;
  t.mock.timers.tick(60_000);
  assert.equal(pruned, 1);
});

test('hourly maintenance prunes the store and replaces the social and market files', async t => {
  t.mock.timers.enable({ apis:['setInterval'] });
  let now = Date.now();
  const app = await fixture(t).start('hourly',{ clock:() => now });
  await app.social.post('Hourly file check');
  let pruned = 0;
  app.store.onPrune(() => { pruned++; });
  now += 3_600_000;
  t.mock.timers.tick(3_600_000);
  assert.equal(pruned,1);
  // Both service timers serialize file writes. Wait for the timer output itself.
  const deadline = Date.now() + 3000;
  for (;;) {
    const social = readFileSync(join(app.dataDir,'agent/social/following.md'),'utf8');
    const intel = readFileSync(join(app.dataDir,'agent/market/briefing.md'),'utf8');
    if (social.includes('Hourly file check') && intel.includes(new Date(now).toISOString())) break;
    assert.ok(Date.now() < deadline,'hourly agent files were not replaced');
    await new Promise(resolve => setTimeout(resolve,10));
  }
});

test('a browser session survives a daemon restart on the same port and ends when the credential changes', async t => {
  const f = fixture(t);
  const first = await f.start('restart');
  const port = first.port, base = 'http://127.0.0.1:' + port;
  const login = readToken(first.dataDir, CREDENTIALS.owner);
  const { ticket } = await (await fetch(base + '/api/v1/login-ticket', { method: 'POST', body: '{}',
    headers: { Authorization: 'Bearer ' + login, 'content-type': 'application/json' } })).json();
  const cookie = (await fetch(base + '/auth?t=' + ticket, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
  const me = () => fetch(base + '/api/v1/me', { headers: { cookie, 'x-gator': '1' } });
  assert.equal((await me()).status, 200);
  await first.close();
  const second = await f.start('restart', { port });
  assert.equal((await me()).status, 200);
  await second.close();
  // A rotated owner credential ends existing sessions.
  const file = join(second.dataDir, CREDENTIALS.owner);
  writeFileSync(file, randomBytes(32).toString('base64url'), { mode: 0o600 });
  await f.start('restart', { port });
  assert.equal((await me()).status, 401);
});

test('price events reach the stream coalesced per coin (newest value, first-seen order) in bounded batches', async t => {
  const app = await fixture(t).start('price-batches');
  const controller = new AbortController();
  const stream = await fetch('http://127.0.0.1:' + app.port + '/api/v1/stream',{
    headers: { Authorization:'Bearer ' + readToken(app.dataDir) }, signal:controller.signal });
  const reader = stream.body.getReader();
  t.after(() => controller.abort());
  await reader.read();
  // 600 coins, each reported twice in one synchronous burst (one rebuild): only the newest of each is sent.
  for (const round of [1, 2]) for (let i = 0; i < 600; i++) app.events.emit('price',{ asset:'coin-' + i, price:String(round * 1000 + i) });
  let wire = '', chunks = 0;
  while ((wire.match(/event: price/g) ?? []).length < 600) {
    const { value } = await reader.read();
    wire += new TextDecoder().decode(value);
    chunks++;
  }
  const prices = wire.trim().split('\n\n').filter(f => f.startsWith('event: price')).map(f => JSON.parse(f.split('\n')[1].slice(6)));
  assert.equal(prices.length, 600);
  assert.deepEqual(prices.map(p => p.asset), Array.from({ length:600 },(_, i) => 'coin-' + i));
  assert.ok(prices.every((p, i) => p.price === String(2000 + i)), 'the newest price of each coin');
  assert.ok(chunks >= 2, 'more than one batch for 600 coins');
});
