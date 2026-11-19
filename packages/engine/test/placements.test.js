import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadBundle } from '@gator/bundle';
import { openStore } from './store-fixture.js';
import { Engine, migrations } from '../src/index.js';
import { createIntel, contentHash, migrations as intelMigrations } from '../src/intel/index.js';
import { DAY, word } from '../src/intel/values.js';

const epoch = 40 * DAY, own = 'a'.repeat(64), peer = 'b'.repeat(64);
const addr = n => '0x' + n.toString(16).padStart(40, '0');
const hash = n => '0x' + word(n);
const contract = addr(111), token = addr(321), mint = 'GsSth7nh2CX2PkXuDFfyCWR6WMWh5NK7rrFjD1yLzQ6';
const channel = 'gator/new';
const assetId = 'ethereum:' + token;
const message = { t: 'placement', v: 1, chain: 'ethereum', slot: 'promoted-token', assetId, purchaseId: hash(9) };
const spl = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'gator-placements-'));
  const bundle = structuredClone(loadBundle());
  bundle.paidExtras.ethereum = contract;
  const dex = bundle.dex.evm.find(d => d.chain === 'ethereum');
  dex.quoteTokens = dex.quoteTokens.filter(q => q.symbol === 'USDC');
  dex.deployments = dex.deployments.filter(d => d.name === 'Uniswap V2');
  bundle.chains.find(c => c.id === 'ethereum').multicall3 = null;
  const f = { time: epoch, bundle, calls: [], sent: [], code: '0x6000', supply: hash(7), allowance: hash(0), mintOwner: spl, initialized: true, accountSize: 82 };
  f.book = (m = message, end = epoch + DAY) => {
    f.purchase = { ...m, end, digest: contentHash(m.slot, m) };
  };
  f.book();
  const rpc = { async call(chain, method, params) {
    f.calls.push({ chain, method, params });
    if (f.offline) throw new Error('offline');
    if (method === 'eth_call' && params[0].to === contract) {
      assert.equal(chain, 'ethereum');
      const p = f.purchase, i = Number(BigInt('0x' + params[0].data.slice(10)));
      const match = p && i === ['promoted-token', 'pinned-news', 'spotlight'].indexOf(p.slot);
      const tuple = match ? [p.purchaseId, addr(27), p.digest, epoch / 1000, p.end / 1000, 10] : [];
      return '0x' + [32, Number(!!match), ...tuple].map(word).join('');
    }
    if (method === 'eth_getCode') return f.code;
    if (method === 'eth_call' && params[0].data === '0x18160ddd') return f.supply;
    if (method === 'eth_call' && params[0].data.startsWith('0xdd62ed3e')) return f.allowance;
    if (method === 'getMultipleAccounts') {
      assert.equal(chain, 'solana');
      const bytes = Buffer.alloc(f.accountSize);
      bytes[44] = 9;
      bytes[45] = Number(f.initialized);
      return { context: { slot: 12 }, value: [{ owner: f.mintOwner, executable: false, data: [bytes.toString('base64'), 'base64'] }, null] };
    }
    if (f.chainRead) return f.chainRead(chain, method, params);
    throw new Error('unexpected method ' + method);
  } };
  rpc.batch = (chain, calls) => Promise.all(calls.map(({ method, params }) => rpc.call(chain, method, params)));
  f.open = () => {
    f.store = openStore({ file: join(dir, 'node.db'), migrations: [...migrations, ...intelMigrations] });
    const transport = Object.assign(new EventEmitter(), { publicKey: own, channels: () => [channel, 'gator/meta'],
      send(c, m) { f.sent.push([c, m]); return true; } });
    f.engine = new Engine({ bundle, store: f.store, transport, clock: () => f.time, backgroundJobs: [] });
    f.engine.rpc.publicOnly = rpc;
    f.engine.hints.rpc = rpc;
    f.engine.rpc.call = () => { throw new Error('Unexpected private RPC'); };
    f.intel = createIntel({ engine: f.engine, dailyMarket: () => [], sampleGlobal() {} });
    f.receive = (m = message, from = peer) => f.intel.consume(channel, { channel, from, ts: f.time, message: m });
  };
  f.open();
  t.after(async () => { await f.intel.stop(); f.store.close(); rmSync(dir, { force: true, recursive: true }); });
  return f;
}

test('a live preimage adopts the exact token, queues public metadata, and retains it across restart and prune', async t => {
  const f = fixture(t);
  await f.intel.start();
  await f.intel.settled();
  assert.equal(f.store.getAsset(assetId), undefined);
  const ranks = () => f.engine.markets().map(t => [t.id, t.rank, t.trust, t.price]);
  const before = ranks();
  const beforeStanding = f.engine.hints.rank(peer);
  assert.ok(await f.receive());
  assert.equal(f.engine.hints.rank(peer), beforeStanding);
  assert.ok(f.engine.registry.assets.has(assetId));
  assert.equal(f.store.reader.prepare('SELECT publicOnly FROM engine_names WHERE asset=?').get(assetId).publicOnly, 1);
  assert.deepEqual(ranks(), before);
  assert.equal(f.store.getAsset(assetId).rank, null);
  assert.equal(f.store.getAsset(assetId).trust, null);
  assert.equal(f.store.getAsset(assetId).trending, null);
  assert.equal(f.store.getPrice(assetId), undefined);
  const placement = f.intel.placements.state(assetId);
  assert.equal(placement.keepUntil, f.purchase.end + 7 * DAY);
  assert.deepEqual(placement.active, { slot: message.slot, chain: 'ethereum', label: 'Promoted', purchaseId: hash(9), until: f.purchase.end });
  assert.ok((await f.intel.announcePlacement(message)).announced);
  assert.deepEqual(f.sent.at(-1), [channel, message]);
  assert.equal(f.calls.filter(c => c.method === 'eth_getCode').length, 1);
  await f.intel.stop();
  f.store.close();
  f.time = placement.keepUntil - 1;
  f.open();
  await f.intel.start();
  await f.intel.settled();
  f.store.prune({ now: f.time });
  assert.ok(f.engine.registry.assets.has(assetId));
  assert.deepEqual(f.intel.placements.state(assetId), { keepUntil: placement.keepUntil, active: null });
  assert.ok(f.engine.search(token).some(t => t.id === assetId));
  f.time++;
  f.store.prune({ now: f.time });
  assert.equal(f.intel.placements.state(assetId), null);
  assert.equal(f.engine.search(token).length, 0);
});

test('an Ethereum purchase can announce a Solana mint; validation reads finalized mint ownership and initialization', async t => {
  const f = fixture(t), m = { ...message, slot: 'spotlight', assetId: 'solana:' + mint };
  f.book(m);
  assert.ok(await f.receive(m));
  assert.equal(f.engine.registry.assets.get(m.assetId).decimals, 9);
  assert.equal(f.calls.find(c => c.method === 'getMultipleAccounts').params[1].commitment, 'finalized');
  assert.ok((await f.intel.announcePlacement(m)).announced);
  assert.deepEqual(f.sent.at(-1), [channel, m]);
});

test('rejected preimages cost hint standing without registering an asset', async t => {
  for (const failure of ['hash', 'id', 'chain', 'expired', 'code', 'supply', 'nft', 'owner', 'token account', 'uninitialized']) {
    await t.test(failure, async t => {
      const f = fixture(t), m = { ...message };
      if (['owner', 'token account', 'uninitialized'].includes(failure)) { m.assetId = 'solana:' + mint; f.book(m); }
      if (failure === 'hash') f.purchase.digest = hash(18);
      if (failure === 'id') m.purchaseId = hash(20);
      if (failure === 'chain') m.chain = 'solana';
      if (failure === 'expired') f.time = f.purchase.end;
      if (failure === 'code') f.code = '0x';
      if (failure === 'supply') f.supply = '0x';
      if (failure === 'nft') f.allowance = '0x';
      if (failure === 'owner') f.mintOwner = mint;
      if (failure === 'token account') f.accountSize = 165;
      if (failure === 'uninitialized') f.initialized = false;
      const before = f.engine.hints.rank(peer);
      assert.equal(await f.receive(m), false);
      assert.ok(f.engine.hints.rank(peer) < before);
      assert.equal(f.store.getAsset(m.assetId), undefined);
    });
  }
});

for (const mode of ['placement', 'focus']) test(mode + ' seeding admits only a funded EVM pool without inventing a creation tx', async t => {
  const f = fixture(t);
  if (mode === 'focus') f.purchase = null;
  await f.intel.start();
  await f.intel.settled();
  if (mode === 'placement') assert.ok(await f.receive());
  else {
    await f.engine.focus.set(assetId, { hours: 48 });
    assert.equal(f.intel.placements.state(assetId), null);
  }
  const chain = f.engine.registry.chains.get('ethereum'), [quote] = chain.quotes, result = addr(800);
  // Simulate the independent names job filling in the token units before the first factory probe.
  f.engine.registry.registerToken(chain.id, token, { decimals: 6 });
  const observations = [];
  f.engine.publish = rows => observations.push(...rows);
  let reserves = 5;
  f.chainRead = (slug, method, params) => {
    assert.equal(slug, chain.id);
    if (method === 'eth_getBlockByNumber') return { number: '0x10', timestamp: '0x' + (f.time / 1000).toString(16) };
    assert.equal(method, 'eth_call');
    const [{ data, to }, tag] = params;
    if (to === chain.deployments[0].address) {
      assert.equal(tag, '0x10');
      assert.equal(data, '0xe6a43905' + [token, quote].sort().map(word).join(''));
      return hash(result);
    }
    assert.ok(['0x10', 'latest'].includes(tag));
    assert.equal(to, result);
    assert.equal(data, '0x0902f1ac');
    return '0x' + [reserves * 1e6, 2 * reserves * 1e6, 0].map(word).join('');
  };
  const job = f.engine.scheduler.jobs.get('discovery:placement-pools');
  assert.ok(job.ready());
  await job.run();
  assert.equal(f.store.newPools({}).length, 0);
  assert.equal(job.ready(), false);
  f.time += 6 * 3_600_000;
  reserves = 20_000;
  await job.run();
  const [pool] = f.store.newPools({});
  assert.deepEqual([pool.pool, pool.liquidity, pool.tx], [result, 80_000, null]);
  assert.equal(f.engine.registry.markets.get('dex:ethereum:' + result).fromHint, 1);
  assert.equal(observations.length, 1);
  assert.equal(observations[0][1], '2');
  assert.equal(f.store.getSetting('engine-seed/ethereum'), undefined);
  const track = f.engine.scheduler.jobs.get('discovery:placement-state');
  f.time = (mode === 'focus' ? epoch + 2 * DAY : f.purchase.end + 7 * DAY) - 1;
  await track.run();
  assert.equal(observations.length, 2);
  assert.equal(f.calls.at(-1).params[1], 'latest');
  f.time += DAY;
  await track.run();
  assert.equal(observations.length, 2);
});

for (const mode of ['placement', 'focus']) test('Solana ' + mode + ' discovers only exact mint and venue pairs', async t => {
  const f = fixture(t), m = { ...message, assetId: 'solana:' + mint };
  if (mode === 'placement') f.book(m);
  else f.purchase = null;
  await f.intel.start();
  await f.intel.settled();
  if (mode === 'placement') assert.ok(await f.receive(m));
  else {
    await f.engine.focus.set(m.assetId);
    assert.equal(f.intel.placements.state(m.assetId), null);
  }
  const pair = { chainId: 'solana', dexId: 'orca', baseToken: { address: mint }, pairAddress: 'P'.repeat(43),
    quoteToken: { address: 'So11111111111111111111111111111111111111112' }, priceNative: '2', volume: { h24: 500 } };
  f.engine.http.getPublic = url => {
    assert.ok(url.endsWith('/solana/' + mint));
    return [pair, { ...pair, chainId: 'base' }, { ...pair, dexId: 'unknown', pairAddress: 'B'.repeat(43) },
      { ...pair, baseToken: { address: 'D'.repeat(43) }, pairAddress: 'C'.repeat(43) }];
  };
  const observations = [];
  f.engine.publish = rows => observations.push(...rows);
  await f.engine.scheduler.jobs.get('discovery:placement-pools').run();
  const pools = f.store.newPools({});
  assert.deepEqual(pools.map(p => [p.pool, p.tx]), [[pair.pairAddress, null]]);
  assert.equal(observations.length, 1);
  assert.equal(observations[0][0], 'dex:solana:' + pair.pairAddress);
  assert.equal(f.store.getAsset('solana:' + 'D'.repeat(43)), undefined);
});

test('placement verification coalesces concurrent reads, bounds per-key work and preserves standing on RPC outage', async t => {
  const f = fixture(t);
  const all = await Promise.all(Array.from({ length: 11 }, () => f.receive()));
  assert.equal(all.filter(Boolean).length, 8);
  assert.equal(f.calls.filter(c => c.method === 'eth_getCode').length, 1);
  assert.equal(f.calls.filter(c => c.params[0]?.to === contract).length, 3);
  f.time += 6 * 60_000;
  f.offline = true;
  const previous = f.engine.hints.rank(peer);
  assert.equal(await f.receive(), false);
  assert.equal(f.engine.hints.rank(peer), previous);
});

for (const reason of ['graduation', 'focus']) test('pool re-announcements after ' + reason + ' survive restart and require creation receipts', async t => {
  const sender = fixture(t), receiver = fixture(t);
  const source = sender.engine.evm.get('ethereum');
  const [deployment] = source.chain.deployments, [quote] = source.chain.quotes;
  const event = Object.values(source.chain.events).find(e => e.signature === 'PairCreated(address,address,address,uint256)');
  const header = { number: '0x10', hash: hash(100), timestamp: '0x' + (epoch / 1000).toString(16) };
  const receipts = new Map();
  function pool(n, base, tx = hash(n)) {
    const p = { chain: 'ethereum', dex: deployment.name, kind: deployment.kind, token0: base, token1: quote,
      pool: addr(2000 + n), firstSeen: epoch - DAY + n, block: 16, tx };
    sender.engine.registry.pool(p);
    if (tx) receipts.set(tx, { status: '0x1', blockNumber: '0x10', transactionHash: tx, blockHash: header.hash, logs: [{
      blockHash: header.hash, blockNumber: '0x10', transactionHash: tx, address: deployment.address,
      topics: [event.topic, hash(base), hash(quote)], data: '0x' + word(p.pool) + word(1),
    }] });
    return p;
  }
  if (reason === 'graduation') sender.store.writer.prepare('INSERT INTO intel_graduated VALUES (?,?)').run(assetId, epoch - DAY);
  else {
    sender.purchase = null;
    await sender.engine.focus.set(assetId);
  }
  pool(1, addr(601)); // An unlisted, ungraduated DEX token.
  pool(2, token, null); // State seed without a creation proof.
  receipts.get(pool(3, token).tx).logs = []; // Legacy row with a transaction that did not create this pool.
  const pools = Array.from({ length: 65 }, (_, i) => pool(4 + i, token));
  const read = (chain, method, params) => {
    assert.equal(chain, 'ethereum');
    if (method === 'eth_getTransactionReceipt') return receipts.get(params[0]) ?? null;
    if (method === 'eth_getBlockByNumber') return header;
    if (method === 'eth_call' && params[0].data === '0x313ce567') return hash(6);
    throw new Error('unexpected method ' + method);
  };
  sender.chainRead = receiver.chainRead = read;
  async function start(f) { await f.intel.start(); await f.intel.settled(); }
  await start(sender);
  const turn = () => sender.engine.scheduler.jobs.get('discovery:reannounce').run();
  await turn();
  assert.equal(sender.sent.length, 0);
  for (let i = 0; i < 60; i++) {
    sender.time += 60_000;
    await turn();
    await turn(); // Multiple wakeups must share a single turn.
  }
  assert.deepEqual(sender.sent.map(([c, m]) => [c, m.pool]), pools.slice(0,60).map(p => [channel, p.pool]));
  await sender.intel.stop();
  sender.store.close();
  sender.open();
  await start(sender);
  await turn();
  assert.equal(sender.sent.length, 60);
  for (let i = 0; i < 6; i++) { sender.time += 60_000; await turn(); }
  assert.deepEqual(sender.sent.slice(60).map(([, m]) => m.pool), [...pools.slice(60), pools[0]].map(p => p.pool));

  const [, sent] = sender.sent[0], late = { channel, from: peer, ts: receiver.time, message: sent };
  receiver.engine.receive(channel, late);
  assert.equal(receiver.store.getAsset(assetId), undefined);
  await receiver.engine.verifyHint();
  assert.ok(receiver.store.getAsset(assetId));
  assert.equal(receiver.store.newPools({})[0].tx, sent.tx);
  const wrong = { ...sender.sent[1][1], token0: addr(502) };
  receiver.engine.receive(channel, { ...late, message: wrong });
  const before = receiver.engine.hints.rank(peer);
  await receiver.engine.verifyHint();
  assert.ok(receiver.engine.hints.rank(peer) < before);
  assert.equal(receiver.store.getAsset('ethereum:' + wrong.token0), undefined);
});

test('promotion preserves an existing ranked asset’s measured price, trust and trending score', async t => {
  const f = fixture(t);
  const a = f.engine.registry.registerToken('ethereum', token, { decimals: 6 });
  f.store.upsertAsset({ ...a, rank: 55 });
  f.store.upsertPrice({ asset: assetId, price: '1.25', trust: 'green', visibility: 'live', at: epoch, trending: 44 });
  const price = f.store.getPrice(assetId), counts = f.store.marketCounts(), ranks = f.store.listMarkets();
  assert.ok(await f.receive());
  assert.deepEqual(f.store.getPrice(assetId), price);
  assert.deepEqual(f.store.marketCounts(), counts);
  assert.deepEqual(f.store.listMarkets(), ranks);
  assert.deepEqual(f.store.listWatchlist(), []);
});

test('failed persistence leaves neither registry nor lease behind, and retry can adopt', async t => {
  const f = fixture(t);
  f.store.writer.exec(`CREATE TRIGGER fail_lease BEFORE INSERT ON engine_placement_assets BEGIN
    SELECT RAISE(ABORT,'fixture write failure'); END`);
  const prior = f.engine.hints.rank(peer);
  assert.equal(await f.receive(), false);
  assert.equal(f.engine.hints.rank(peer), prior);
  assert.equal(f.engine.registry.assets.has(assetId), false);
  assert.equal(f.store.getAsset(assetId), undefined);
  f.store.writer.exec('DROP TRIGGER fail_lease');
  assert.ok(await f.receive());
});

test('a matching purchase expiring during token validation cannot register the preimage', async t => {
  const f = fixture(t);
  const original = f.engine.rpc.publicOnly.call;
  f.engine.rpc.publicOnly.call = async (...args) => {
    if (args[1] === 'eth_getCode') f.time = f.purchase.end;
    return original(...args);
  };
  const before = f.engine.hints.rank(peer);
  assert.equal(await f.receive(), false);
  assert.ok(f.engine.hints.rank(peer) < before);
  assert.equal(f.store.getAsset(assetId), undefined);
});

for (const first of ['payment', 'focus']) test('overlapping leases remember the paid deadline with ' + first + ' first', async t => {
  const f = fixture(t), paidUntil = f.purchase.end + 7 * DAY;
  if (first === 'payment') assert.ok(await f.receive());
  await f.engine.focus.set(assetId, { hours: 720 });
  if (first === 'focus') assert.ok(await f.receive());
  assert.equal(f.intel.placements.state(assetId).keepUntil, paidUntil);
  assert.equal(f.engine.focus.list().items[0].expiresAt, epoch + 30 * DAY);
  const lease = f.store.reader.prepare('SELECT keepUntil FROM engine_placement_assets WHERE asset=?');
  assert.equal(lease.get(assetId).keepUntil, epoch + 30 * DAY);
  await f.engine.focus.set(assetId, { hours: 1 });
  assert.equal(lease.get(assetId).keepUntil, paidUntil);
  await f.engine.focus.set(assetId, { remove: true });
  assert.equal(lease.get(assetId).keepUntil, paidUntil);
  assert.equal(f.intel.placements.state(assetId).keepUntil, paidUntil);
});

test('focus rejects unverified fungible identities before registration and coalesces concurrent requests', async t => {
  const f = fixture(t), sol = 'solana:' + mint;
  f.code = '0x';
  await assert.rejects(f.engine.focus.set(assetId), e => e.status === 422);
  assert.equal(f.store.getAsset(assetId), undefined);
  f.code = '0x6001'; f.allowance = '0x';
  await assert.rejects(f.engine.focus.set(assetId), e => e.status === 422);
  assert.equal(f.store.getAsset(assetId), undefined);
  f.initialized = false;
  await assert.rejects(f.engine.focus.set(sol), e => e.status === 422);
  assert.equal(f.store.getAsset(sol), undefined);
  f.initialized = true; f.mintOwner = addr(3);
  await assert.rejects(f.engine.focus.set(sol), e => e.status === 422);
  f.allowance = hash(0); f.calls.length = 0;
  const before = f.store.listMarkets();
  await Promise.all([f.engine.focus.set(assetId), f.engine.focus.set(assetId, { hours: 2 })]);
  assert.equal(f.calls.filter(c => c.method === 'eth_getCode').length, 1);
  assert.ok(!f.calls.some(c => c.params[0]?.to === contract));
  assert.deepEqual(f.store.listMarkets(), before);
  assert.equal(f.store.getPrice(assetId), undefined);
  assert.equal(f.engine.focus.list().items[0].expiresAt, epoch + 2 * 3_600_000);
  assert.equal(f.sent.length, 0);
  f.store.close();
  f.open();
  assert.equal(f.engine.focus.list().items[0].asset, assetId);
  f.time += 2 * 3_600_000;
  assert.equal(f.engine.focus.list().items.length, 0);
  f.engine.focus.resize();
  assert.equal(f.store.reader.prepare('SELECT 1 FROM engine_placement_assets WHERE asset=?').get(assetId), undefined);
});

test('focus enforces each profile cap, bounds renewals and releases pending verification on removal', async t => {
  const f = fixture(t), focus = f.engine.focus;
  const ids = [...f.engine.registry.seedIds].slice(0, 21);
  for (const [profile, cap] of [['small', 5], ['normal', 10], ['large', 20]]) {
    f.engine.profile = profile;
    for (const id of ids.slice(0, cap)) await focus.set(id);
    await assert.rejects(focus.set(ids[cap]), e => e.status === 409);
    assert.equal(focus.list().items.length, cap);
    await assert.rejects(focus.set(ids[0], { hours: 721 }), e => e.status === 400);
    await focus.set(ids[0], { hours: 720 });
  }
  f.engine.profile = 'small';
  focus.resize();
  assert.equal(focus.list().items.length, 5);
  await focus.set(focus.list().items[0].asset, { remove: true });
  let release;
  const original = f.engine.rpc.publicOnly.call;
  f.engine.rpc.publicOnly.call = async (...args) => {
    if (args[1] === 'eth_getCode') await new Promise(resolve => { release = resolve; });
    return original(...args);
  };
  const waiting = focus.set(assetId);
  await assert.rejects(focus.set('ethereum:' + addr(999)), e => e.status === 409);
  await focus.set(assetId, { remove: true });
  release();
  await assert.rejects(waiting, e => e.status === 409);
  assert.equal(f.store.getAsset(assetId), undefined);
});

test('focused SPL mint reads its finalized total even before any price, leaving circulation unestimated', async t => {
  const f = fixture(t), id = 'solana:' + mint;
  await f.engine.focus.set(id);
  f.chainRead = (chain, method, params) => {
    assert.equal(chain, 'solana');
    assert.equal(method, 'getTokenSupply');
    assert.deepEqual(params, [mint, { commitment: 'finalized' }]);
    return { context: { slot: 15 }, value: { amount: '5000000000', decimals: 9 } };
  };
  // Run the queued supply task independently of the logo server and metadata jobs.
  f.store.writer.prepare("UPDATE engine_focus_tasks SET dueAt=? WHERE task<>'supply'").run(f.time + DAY);
  await f.engine.scheduler.jobs.get('focus:collect').run();
  const covered = f.engine.focus.coverage(id);
  assert.equal(covered.totalSupplyKnown, true);
  assert.equal(covered.circulatingSupplyKnown, false);
  assert.equal(f.engine.registry.assets.get(id).totalSupply, 5);
  assert.equal(f.store.getPrice(id), undefined);
});
