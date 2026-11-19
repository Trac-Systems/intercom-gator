import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures.js';
import { httpClient } from '../src/client.js';
import { word } from '../../engine/src/intel/values.js';

const HOUR = 3_600_000;
const address = '0x' + '1'.repeat(40), asset = 'ethereum:' + address;
const abiText = s => '0x' + Buffer.from(s).toString('hex').padEnd(64,'0');
const aggregate = values => '0x' + [32, values.length, ...values.map((_, i) => 32*values.length + 128*i),
  ...values.flatMap(value => [1,64,32,value])].map(word).join('');

test('owner and agent steer the same node; collection imports only missing bars and accounts for real upstream requests', async t => {
  let now = Date.now(), calls = 0;
  const hour = now - now % HOUR, market = 'cex:bitstamp:FOC-USD';
  const app = await fixture(t).start('focus', { clock: () => now, async fetch(url, options) {
    calls++;
    if (String(url).includes('/ohlc/')) {
      return Response.json([hour - 3*HOUR, hour - HOUR].map(ts => ({ timestamp: ts/1000, open:'1',high:'2',low:'1',close:'2' })));
    }
    if (String(url).includes('logo.png')) {
      return new Response(Buffer.from('ffd8ffc0000b080020002001010000ffd9','hex'));
    }
    if (!options?.body) return new Response('', { status: 404 });
    const { id, method, params } = JSON.parse(options.body);
    const result = method === 'eth_getCode' ? '0x6000' : params[0].data.includes('dd62ed3e') ? aggregate([1000,0]) :
      aggregate([abiText('Focus Token'),abiText('FOC'),6,987654321n]);
    return Response.json({ id, jsonrpc:'2.0', result });
  } });
  app.engine.rpc.sleep = async ms => { now += ms; };
  const api = httpClient(app.dataDir), owner = httpClient(app.dataDir,{ owner:true });
  const covered = () => api('GET','/assets/' + asset + '/coverage');
  const before = calls;
  assert.equal((await covered()).registered,false);
  assert.equal(calls,before);
  const [entry] = (await api('POST','/focus',{}, { asset, hours: 3 })).items;
  assert.equal(entry.requests,2);
  const token = app.engine.registry.assets.get(asset);
  app.engine.registry.register({ id:market, exchange:'bitstamp', kind:'cex', base:asset, quote:'fiat:USD', symbol:'FOC/USD' });
  // Within the 3x plausibility band of the venue bars, so the import is accepted.
  app.store.recordPrices([{ asset, price:'3', at:hour-HOUR+1 }]);
  const job = app.engine.scheduler.jobs.get('focus:collect');
  for (let i = 0; i < 4; ++i) { assert.ok(job.ready()); await job.run(); }
  assert.equal(job.ready(), false);
  const [collected] = (await owner('GET','/focus')).items;
  assert.ok(collected.tasks.every(t => t.dueAt === null && t.attempts === 1), JSON.stringify(collected.tasks));
  assert.equal(collected.requests, calls-before);
  assert.equal(collected.requests,5);
  assert.equal(token.totalSupply,987.654321);
  assert.equal(token.symbol,'FOC');
  assert.equal((await covered()).logo,true);
  assert.equal(collected.gathered.nameResolved,true);
  assert.equal(collected.gathered.supplyKnown,true);
  assert.equal(collected.tasks.find(t => t.task === 'history').result.imported,1);
  const bars = app.store.candles({ asset, tf:'1h', limit:10 });
  assert.deepEqual(bars.map(b => [b.ts,b.close]), [[hour-3*HOUR,'2'],[hour-HOUR,'3']]);
  assert.equal(app.intel.placements.state(asset),null);
  assert.equal(app.store.getPrice(asset),undefined);
  assert.equal((await owner('POST','/focus',{}, { asset, remove:true })).items.length,0);
  assert.equal((await api('GET','/focus')).items.length,0);
  assert.equal((await covered()).nameResolved,true);
});

test('coverage counts distinct reporters across base and quote markets at the hour/day boundaries', async t => {
  const now = Date.now();
  const app = await fixture(t).start('coverage', { clock: () => now });
  const focus = 'bitcoin:native', own = app.transport.publicKey, peer = 'b'.repeat(64), old = 'c'.repeat(64);
  const rows = [['cex:one:BTC-USD',focus,'fiat:USD','one'],['dex:ethereum:pool','ethereum:native',focus,'two']];
  for (const [id,base,quote,exchange] of rows)
    app.engine.registry.register({id,base,quote,exchange,kind:id.startsWith('dex')?'dex':'cex'});
  const write = app.store.writer.prepare('INSERT INTO obs(market,reporter,srcTs,at,price) VALUES(?,?,?,?,?)');
  for (const [index,reporter,age] of [[0,own,50],[0,peer,HOUR],[1,peer,5],[1,old,24*HOUR],[0,'d'.repeat(64),24*HOUR+1]])
    write.run(rows[index][0],reporter,now-age,now,'1');
  const data = await httpClient(app.dataDir)('GET','/assets/BTC/coverage');
  assert.deepEqual(data.reporters, { lastHour:2, lastDay:3 });
  assert.equal(data.peers.reporters24h,2);
  assert.equal(data.peers.reporters1h,1);
  assert.equal(data.local.observations24h,1);
  assert.equal(data.freshness.ageMs,5);
  assert.equal(data.observedVenues24h,2);
  assert.equal(data.pools,1);
  assert.deepEqual(data.poolsSeen,[{ market:rows[1][0], venue:'two' }]);
});
