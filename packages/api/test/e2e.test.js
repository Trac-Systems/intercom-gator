import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMemoryHub, MemoryTransport } from '@gator/net';
import { fixture } from './fixtures.js';
import { httpClient } from '../src/client.js';
import { readToken } from '../src/local.js';

async function until(fn) {
  const end = Date.now() + 5000;
  while (!await fn()) {
    if (Date.now() >= end) assert.fail('Timed out waiting for signed delivery');
    await delay(15);
  }
}

test('three daemons converge on fixture prices, follow a signed feed and accept only root notices', async t => {
  const f = fixture(t), hub = createMemoryHub(), apps = [];
  for (let i = 0; i < 3; i++) {
    const app = await f.start('peer' + i, { transport: opts => new MemoryTransport({ ...opts, hub,
      wallet: i === 2 ? f.root : opts.wallet, skipPow:true }) });
    apps.push(app);
  }
  const [a,b,root] = apps, clients = apps.map(app => httpClient(app.dataDir,{ owner:true }));
  const [A,B] = clients;
  const reserved = { card: { handle: 'official' } };
  await assert.rejects(A('PUT', '/settings', {}, reserved), /invalid profile card/);
  await clients[2]('PUT', '/settings', {}, reserved);
  assert.equal((await clients[2]('GET', '/me')).handle, '@official');
  await until(() => apps.every(app => app.transport.peerCount() === 2));
  await B('POST','/follow',{},{ key:a.transport.publicKey });
  await a.social.setCard({ handle:'alpha',harnesses:['gator'] });
  // Wait for the newly joined author channel to finish its signed handshake.
  const card = JSON.parse(a.store.reader.prepare("SELECT envelope FROM social_outbox WHERE slot='card'").get().envelope);
  await until(() => {
    if (b.social.profile(a.transport.publicKey)?.handle === 'alpha') return true;
    a.transport.rebroadcast(card);
    return false;
  });
  const post = await A('POST','/posts',{},{ text:'One locally observed $BTC price.' });
  await until(async () => (await B('GET','/feed')).items.some(p => p.id === post.id && p.key === a.transport.publicKey));
  for (const app of apps) await app.engine.scheduler.jobs.get('cex:bitstamp').run();
  await until(async () => {
    const details = await Promise.all(clients.map(c => c('GET','/assets/BTC')));
    return details.every(d => d.price === 123.1 && d.trust === 'yellow' && d.why.reporters === 3);
  });
  const detail = await B('GET','/assets/BTC');
  assert.equal(detail.why.spotCheck.ok,true);
  assert.ok(detail.why.sources.some(s => s.venue === 'Bitstamp'));
  const control = new AbortController();
  const stream = await fetch('http://127.0.0.1:' + b.port + '/api/v1/stream',{ signal:control.signal,
    headers:{ Authorization:'Bearer ' + readToken(b.dataDir) } });
  const reader = stream.body.getReader();
  const timer = setTimeout(() => control.abort(),5000);
  try {
    await reader.read();
    let signed;
    root.transport.once('message',(_channel,e) => { signed = e; });
    const notice = { v:1,t:'notice',text:'Root announcement',severity:'info' };
    assert.equal(root.transport.send('soc/official',notice),true);
    const invalid = { ...signed, id:randomUUID(), message:{ ...notice,text:'Forged announcement' } };
    for (const app of apps) app.transport.emit('message','soc/official',invalid);
    assert.equal(a.transport.send('soc/official',notice),false);
    await until(async () => (await Promise.all(clients.map(c => c('GET','/feed',{ lane:'official' }))))
      .every(feed => feed.items.length === 1 && feed.items[0].text === notice.text && feed.items[0].key === f.release.rootKey));
    let wire = '';
    while (!wire.includes('event: notice')) wire += new TextDecoder().decode((await reader.read()).value);
    assert.match(wire,/Root announcement/);
  } finally { clearTimeout(timer); control.abort(); await reader.cancel().catch(() => {}); }
  for (const [i,app] of apps.entries()) {
    await app.social.writeAgentFiles();
    await app.intel.refreshMarket();
    for (const file of ['social/official.md','social/following.md','social/mentions.md','social/directory.md','market/briefing.md']) {
      const contents = await readFile(join(app.dataDir,'agent',file),'utf8');
      assert.ok(contents.length > 0);
      if (file === 'social/official.md') { assert.match(contents,/Root announcement/); assert.doesNotMatch(contents,/Forged/); }
    }
    assert.deepEqual(await clients[i]('GET','/extras'),{ items:[], slots:[] });
  }
});
