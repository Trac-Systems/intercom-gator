import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openStore } from './store-fixture.js'
import { Engine, migrations } from '../src/index.js'
import { POOL_CHANNEL, CATCHUP_JOB, PAGE_SQL } from '../src/intel/pool-catchup.js'
import { RateLimited } from '../src/scheduler/index.js'
import { hash, historyBundle, poolLedger } from './fixtures/pool-history.js'

const bundle = historyBundle()
const minute = 60_000, week = 7 * 86400_000
const nkey = n => n.toString(16).padStart(64, '0')

function fixture(t) {
  const dir = mkdtempSync(join(import.meta.dirname, 'history-'))
  const f = { time: Date.now(), nodes: new Map(), sent: [] }
  const clock = () => f.time
  f.ledger = poolLedger(bundle, f.time - minute)
  f.open = async (i, fetch = f.ledger.fetch) => {
    const key = nkey(i), channels = new Set()
    const transport = Object.assign(new EventEmitter(), { publicKey: key,
      join: c => !!channels.add(c), channels: () => [...channels], leave: c => channels.delete(c),
      peerCount: () => f.nodes.size - 1,
      send(channel, message) {
        f.sent.push({ from: key, channel, message })
        for (const n of f.nodes.values()) {
          if (n.transport !== transport && n.transport.channels().includes(channel))
            n.transport.emit('message', channel, { channel, from: key, ts: f.time, message: structuredClone(message) })
        }
        return true
      } })
    const store = openStore({ file: join(dir, i + '.db'), migrations, profile: 'normal' })
    const engine = new Engine({ store, transport, bundle, clock, backgroundJobs: [CATCHUP_JOB],
      patches: { patchFeed: false }, rpcConfig: { bundleDigest: 'a'.repeat(64), fetch,
        endpoints: { ethereum: ['https://private.invalid'] }, retries: 0, sleep: async ms => { f.time += ms } } })
    f.nodes.set(i, engine)
    await engine.start()
    await engine.catchup.membership
    clearTimeout(engine.timer)
    clearInterval(engine.catchup.timer)
    return engine
  }
  f.close = async i => {
    const e = f.nodes.get(i)
    await e.stop()
    e.store.close()
    f.nodes.delete(i)
  }
  f.turn = async (n, ms = 1000) => {
    f.time += ms
    n.catchup.tick()
    try { await n.scheduler.runOne() } catch (e) { if (!(e instanceof RateLimited)) throw e }
  }
  f.offer = n => n.transport.send(POOL_CHANNEL, { t: 'offer', v: 1 })
  t.after(async () => {
    for (const i of f.nodes.keys()) await f.close(i)
    rmSync(dir, { recursive: true, force: true })
  })
  return f
}
const poolCount = e => e.store.reader.prepare('SELECT count(*) n FROM pools').get().n

test('a late joiner pages tied creation times, skips known pools, and resumes a partially verified page after restart', async t => {
  const f = fixture(t), sender = await f.open(1)
  // Local scans use the node's configured RPC. The fixture ledger stands in for it here only.
  sender.evm.get('ethereum').rpc = sender.rpc.publicOnly
  await f.ledger.seed(sender, 18)
  assert.equal(sender.store.reader.prepare('SELECT count(*) n FROM engine_pool_history WHERE verified=1').get().n, 18)
  let receiver = await f.open(2)
  const routesAtConfirmation = []
  const nameRoute = receiver.store.reader.prepare('SELECT priority FROM engine_names WHERE asset=?')
  receiver.on('discovery', m => routesAtConfirmation.push(nameRoute.get(m.chain + ':' + m.token0)?.priority))
  receiver.registry.pool(f.ledger.record(18))
  f.sent.length = 0
  f.offer(sender)
  for (let i = 0; i < 30 && poolCount(receiver) < 3; i++) await f.turn(receiver)
  assert.equal(poolCount(receiver), 3)
  assert.deepEqual(routesAtConfirmation, [2,2], 'the committed name route already exists when discovery is emitted')
  assert.equal(receiver.catchup.state.page.rows.length, 8)
  await f.close(2)
  receiver = await f.open(2)
  assert.ok(receiver.catchup.state.page.offset >= 3)
  // Finish the durable page before the responder advertises again.
  for (let i = 0; i < 50 && receiver.catchup.state.page; i++) await f.turn(receiver)
  assert.equal(poolCount(receiver), 8)
  f.offer(sender)
  for (let i = 0; i < 200 && !receiver.catchup.state.done; i++) await f.turn(receiver)
  assert.equal(receiver.catchup.state.count, 18)
  assert.equal(receiver.catchup.state.done, true)
  assert.equal(poolCount(receiver), 18)
  assert.deepEqual(f.ledger.receipts, Array.from({ length: 17 }, (_, i) => hash(17 - i)))
  assert.ok(f.sent.every(s => s.channel === POOL_CHANNEL), 'no replay on the live channel')
  assert.equal(receiver.store.reader.prepare('SELECT publicOnly FROM engine_names WHERE asset=?')
    .get('ethereum:' + f.ledger.record(1).token0).publicOnly, 1)
  const gets = () => f.sent.filter(s => s.message.t === 'get').length
  const done = gets()
  f.offer(sender)
  await f.turn(receiver, minute)
  assert.equal(gets(), done)
  await f.close(2)
  f.time += 7 * 3600_000
  receiver = await f.open(2)
  f.offer(sender)
  await f.turn(receiver)
  assert.ok(gets() > done, 'long absence opens a fresh bounded window')
})

test('only the solicited signer and request ID can supply a page; a disproved receipt costs the live standing penalty', async t => {
  const f = fixture(t), receiver = await f.open(1), peer = await f.open(2)
  f.offer(peer)
  // Keep the request unanswered while constructing signed-envelope equivalents.
  peer.catchup.serve = () => {}
  await f.turn(receiver)
  const request = f.sent.find(s => s.message.t === 'get').message
  const row = { ...f.ledger.record(7), at: f.time - minute }
  const page = { t: 'page', v: 1, to: receiver.transport.publicKey, id: request.id, more: false, rows: [row] }
  const rx = (from, msg) => receiver.receive(POOL_CHANNEL, { from, ts: f.time, channel: POOL_CHANNEL, message: msg })
  rx(nkey(9), page)
  rx(nkey(2), { ...page, id: 'f'.repeat(24) })
  rx(nkey(2), { ...page, to: nkey(9) })
  rx(nkey(2), { ...page, rows: [row, row] })
  rx(nkey(2), { ...page, rows: [{ ...row, at: f.time - week - minute }] })
  rx(nkey(2), { ...page, rows: [{ ...row, padding: 'x'.repeat(7200) }] })
  assert.equal(receiver.catchup.state.page, null)
  f.ledger.missing.add(7)
  const before = receiver.hints.rank(nkey(2))
  rx(nkey(2), page)
  await f.turn(receiver)
  assert.deepEqual(f.ledger.receipts, [row.tx])
  assert.equal(poolCount(receiver), 0)
  assert.equal(receiver.hints.rank(nkey(2)), before - 4)
  assert.equal(receiver.hints.rank(nkey(9)), 0)
  f.time += 60 * minute
  assert.equal(receiver.hints.rank(nkey(2)), before)
})

test('responder keyset seek, 8-row and byte caps, local and per-peer pacing, and proof invalidation', async t => {
  const f = fixture(t), e = await f.open(1)
  e.evm.get('ethereum').rpc = e.rpc.publicOnly
  await f.ledger.seed(e, 12)
  const plan = e.store.reader.prepare('EXPLAIN QUERY PLAN ' + PAGE_SQL).all(f.time - week, f.time + 1, '', '', 9)
    .map(row => row.detail).join('\n')
  assert.match(plan, /SEARCH h USING COVERING INDEX engine_pool_history_page/)
  assert.match(plan, /SEARCH p USING PRIMARY KEY/)
  assert.doesNotMatch(plan, /SCAN|TEMP B-TREE/)
  const msg = { t: 'get', v: 1, to: nkey(1), id: 'a'.repeat(24), until: f.time, before: null }
  const request = (key, m = msg) => e.receive(POOL_CHANNEL, { from: key, ts: f.time, channel: POOL_CHANNEL, message: m })
  f.sent.length = 0
  request(nkey(2))
  request(nkey(3))
  const page = f.sent[0].message
  assert.equal(page.rows.length, 8)
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 7168)
  assert.equal(page.more, true)
  f.time += 1000
  request(nkey(2))
  assert.equal(f.sent.length, 1)
  request(nkey(3))
  assert.equal(f.sent.length, 2)
  f.time += 5000
  const last = page.rows.at(-1)
  request(nkey(2), { ...msg, before: [last.at, last.chain, last.pool] })
  assert.deepEqual(f.sent.at(-1).message.rows.map(r => r.tx), [4,3,2,1].map(hash))
  assert.equal(f.sent.at(-1).message.more, false)
  const p = f.ledger.record(1)
  e.store.upsertPool({ ...p, tx: hash(88) })
  assert.equal(e.store.reader.prepare('SELECT 1 FROM engine_pool_history WHERE pool=?').get(p.pool), undefined)
})

test('a pressured profile yields to price work, and a provider refusal backs off without losing progress or standing', async t => {
  const f = fixture(t)
  let reject = true, attempts = []
  const fetch = async (url, init) => {
    const { method } = JSON.parse(init.body)
    attempts.push([method, f.time, url])
    if (reject && method === 'eth_getBlockByNumber') {
      reject = false
      return new Response('{}', { status: 429, headers: { 'retry-after': '10' } })
    }
    return f.ledger.fetch(url, init)
  }
  const receiver = await f.open(1, fetch), peer = await f.open(2)
  peer.evm.get('ethereum').rpc = peer.rpc.publicOnly
  await f.ledger.seed(peer, 3)
  f.offer(peer)
  const rank = receiver.hints.rank(nkey(2))
  receiver.budget.setLimit(12)
  for (let i = 0; i < 9; i++) receiver.budget.take()
  for (let i = 0; i < 10; i++) await f.turn(receiver)
  assert.equal(attempts.length, 0)
  const prices = []
  receiver.scheduler.backgroundJobs.add('price-fixture')
  receiver.scheduler.add({ id: 'price-fixture', interval: 0, markets: () => [{ id: 'cex:fixture:X-Y', rank: 1 }],
    run: () => prices.push(f.time) })
  for (let i = 0; i < 16; i++) await f.turn(receiver, 4000)
  assert.equal(prices.length, 16)
  assert.equal(attempts.length, 0, 'including scheduler fairness and exploration turns')
  receiver.scheduler.jobs.delete('price-fixture')
  receiver.budget.setLimit(240)
  for (let i = 0; i < 200 && poolCount(receiver) < 3; i++) await f.turn(receiver, 500)
  assert.equal(poolCount(receiver), 3)
  assert.equal(receiver.hints.rank(nkey(2)), rank)
  assert.equal(attempts.filter(([m]) => m === 'eth_getTransactionReceipt').length, 3)
  assert.equal(attempts.filter(([m]) => m === 'eth_getBlockByNumber').length, 4)
  assert.ok(attempts[2][1] - attempts[1][1] >= 15_000)
  assert.ok(attempts.every(([, , url]) => new URL(url).hostname === 'history.invalid'))
  assert.ok(attempts.slice(1).every(([, at], i) => at - attempts[i][1] >= 1000))
})

test('a requester consults at most three responsive signers, stops at its durable cap, and ignores unsolicited pages', async t => {
  const f = fixture(t), receiver = await f.open(1)
  const nodes = []
  for (let i = 2; i <= 5; i++) nodes.push(await f.open(i))
  const sender = nodes[0]
  sender.evm.get('ethereum').rpc = sender.rpc.publicOnly
  await f.ledger.seed(sender, 5)
  for (const node of nodes) f.offer(node)
  assert.deepEqual(receiver.catchup.state.peers.map(p => p.key), [2,3,4].map(nkey))
  receiver.catchup.state.count = 4998
  for (let i = 0; i < 30 && !receiver.catchup.state.done; i++) await f.turn(receiver)
  assert.equal(receiver.catchup.state.count, 5000)
  assert.equal(poolCount(receiver), 2)
  assert.equal(f.ledger.receipts.length, 2)
  await f.close(1)
  const restarted = await f.open(1)
  for (const node of nodes) f.offer(node)
  const before = f.sent.length
  await f.turn(restarted)
  assert.equal(restarted.catchup.state.done, true)
  assert.ok(!f.sent.slice(before).some(s => s.message.t === 'get'))
})

test('v0.1.0 migration queues registered recent candidates; legacy swaps and state-only rows stay out of replies', async t => {
  const f = fixture(t), dir = mkdtempSync(join(import.meta.dirname, 'history-upgrade-'))
  let store
  // Close before removing: Windows cannot unlink an open database.
  t.after(() => { store?.close(); rmSync(dir, { recursive: true, force: true }) })
  const file = join(dir, 'node.db')
  const migrationId = 'engine-pool-catchup-v1'
  const old = openStore({ file, migrations: migrations.filter(m => m.id !== migrationId) })
  for (let i = 1; i <= 4; i++) {
    const row = f.ledger.record(i)
    if (i === 3) row.tx = null
    if (i === 4) row.firstSeen -= week
    old.upsertPool(row)
    old.writer.prepare("INSERT INTO markets(id,kind,chain,exchange,base,quote) VALUES(?,'dex',?,?,?,?)")
      .run('dex:ethereum:' + row.pool, row.chain, row.dex, 'ethereum:' + row.token0, 'ethereum:' + row.token1)
  }
  old.close()
  store = openStore({ file, migrations })
  const rows = store.reader.prepare('SELECT pool,verified FROM engine_pool_history ORDER BY pool')
  assert.deepEqual(rows.all().map(r => [r.pool,r.verified]), [1,2].map(i => [f.ledger.record(i).pool,0]))
  const clock = () => f.time
  const engine = new Engine({ store, bundle, clock, transport: { publicKey: nkey(1), peerCount: () => 1, send: () => true },
    backgroundJobs: [CATCHUP_JOB], rpcConfig: { fetch: async (url, init) => {
      const { id, method, params } = JSON.parse(init.body)
      if (method === 'eth_getTransactionReceipt' && params[0] === hash(2)) {
        const log = { ...f.ledger.log(2), topics: [hash(0)] }
        return Response.json({ id, jsonrpc: '2.0', result: { status: '0x1', blockHash: log.blockHash,
          blockNumber: log.blockNumber, transactionHash: log.transactionHash, logs: [log] } })
      }
      return f.ledger.fetch(url, init)
    } } })
  engine.catchup.start()
  try {
    for (let i = 0; i < 7; i++) await f.turn(engine)
    assert.deepEqual(rows.all().map(r => r.verified), [1,-1])
    assert.deepEqual(engine.catchup.select.all(f.time-week,f.time+1,'','',9).map(r => r.tx), [hash(1)])
  } finally { engine.catchup.stop() }
})

test('1,000 distinct DEX-only discoveries use one receipt per record under the ordinary RPC budget', async t => {
  const f = fixture(t), sender = await f.open(1)
  sender.evm.get('ethereum').rpc = sender.rpc.publicOnly
  await f.ledger.seed(sender, 1000)
  const receiver = await f.open(2)
  f.ledger.methods.clear()
  f.ledger.tags.clear()
  f.offer(sender)
  const start = f.time
  for (let i = 0; i < 5500 && !receiver.catchup.state.done; i++) await f.turn(receiver)
  assert.equal(poolCount(receiver), 1000)
  assert.equal(receiver.catchup.state.done, true)
  for (let i = 0; i < 20; i++) await f.turn(receiver)
  const names = receiver.store.reader.prepare('SELECT count(*) n FROM engine_names WHERE priority=2 AND name IS NOT NULL AND publishAt IS NULL').get().n
  assert.equal(names, 1001, 'on-chain name and symbol saved locally for each token and the quote')
  assert.equal(f.ledger.methods.get('eth_getTransactionReceipt'), 1000)
  assert.equal(f.ledger.methods.get('eth_getBlockByNumber'), 1000)
  assert.equal(f.ledger.tags.get('0x64'), 1000)
  assert.ok(f.ledger.tags.get('latest') <= 500, 'historical name reads batch on the same bounded lane')
  assert.equal(new Set(f.ledger.receipts).size, 1000)
  t.diagnostic(JSON.stringify({ records: 1000, rpc: Object.fromEntries(f.ledger.methods),
    tags: Object.fromEntries(f.ledger.tags), pages: f.sent.filter(s => s.message.t === 'page').length, simulatedSeconds: (f.time - start)/1000 }))
})

test('an upgrading responder holds the cursor before an unchecked row and serves the rest after proof', async t => {
  const f = fixture(t), sender = await f.open(1)
  sender.evm.get('ethereum').rpc = sender.rpc.publicOnly
  await f.ledger.seed(sender, 5)
  sender.store.writer.prepare('UPDATE engine_pool_history SET verified=0 WHERE pool=?').run(f.ledger.record(4).pool)
  const receiver = await f.open(2)
  f.offer(sender)
  for (let i = 0; i < 15; i++) await f.turn(receiver)
  const pages = f.sent.filter(s => s.from === nkey(1) && s.message.t === 'page').map(s => s.message)
  assert.deepEqual(pages.map(p => p.rows.map(r => r.tx)), [[hash(5)],[]])
  assert.ok(pages.every(p => p.more))
  assert.equal(receiver.catchup.state.peers[0].cursor[2], f.ledger.record(5).pool)
  for (let i = 0; i < 140 && !receiver.catchup.state.done; i++) {
    await f.turn(sender)
    await f.turn(receiver)
  }
  assert.equal(receiver.catchup.state.done, true)
  assert.equal(receiver.catchup.state.count, 5)
  assert.equal(poolCount(receiver), 5)
})

test('a slow optional join leaves price startup independent and is released if the engine stops mid-join', async t => {
  const f = fixture(t), e = await f.open(1)
  await e.stop()
  const joinChannel = e.transport.join.bind(e.transport)
  let grant
  e.transport.join = c => c === POOL_CHANNEL ? new Promise(resolve => { grant = () => resolve(joinChannel(c)) }) : joinChannel(c)
  await e.start()
  assert.equal(e.active, true)
  assert.equal(e.catchup.active, false)
  assert.ok(grant)
  const stopping = e.stop()
  await new Promise(resolve => setImmediate(resolve))
  grant()
  await stopping
  assert.equal(e.catchup.active, false)
  assert.deepEqual(e.transport.channels(), [])
  e.transport.join = c => c !== POOL_CHANNEL && joinChannel(c)
  await e.start()
  await e.catchup.membership
  assert.equal(e.active, true)
  assert.equal(e.catchup.active, false)
  assert.ok(e.transport.channels().includes('gator/new'))
})

test('a scarce public endpoint leaves three ordinary dispatch intervals between idle grants', async t => {
  const f = fixture(t), e = await f.open(1)
  const endpoint = e.rpc.chains.get('ethereum').find(x => !x.user)
  endpoint.bucket.rate = 6
  e.rpc.chains.set('ethereum', [endpoint])
  const receipt = () => e.rpc.callWhenIdle('ethereum', 'eth_getTransactionReceipt', [hash(1)])
  await receipt()
  const start = f.time
  f.time += 10_000
  await assert.rejects(receipt, error => error instanceof RateLimited && error.retryAt === start + 40_000)
  assert.deepEqual(f.ledger.receipts, [hash(1)])
  await e.rpc.publicOnly.call('ethereum', 'eth_getTransactionReceipt', [hash(2)])
  assert.deepEqual(f.ledger.receipts, [hash(1), hash(2)])
  f.time = start + 40_000
  await receipt()
  assert.equal(e.budget.used, 3)
})

test('a page on disk replays safely when a crash follows registration but precedes the next cursor checkpoint', async t => {
  const f = fixture(t), sender = await f.open(1)
  sender.evm.get('ethereum').rpc = sender.rpc.publicOnly
  await f.ledger.seed(sender, 3)
  let receiver = await f.open(2)
  f.offer(sender)
  for (let i = 0; i < 15 && poolCount(receiver) < 1; i++) await f.turn(receiver)
  assert.equal(receiver.store.getSetting('engine:pool-catchup').page.offset, 0)
  assert.equal(poolCount(receiver), 1)
  // Suppress the graceful-stop checkpoint; leave exactly the WAL state a crash would recover.
  receiver.catchup.active = false
  await f.close(2)
  await f.close(1)
  receiver = await f.open(2)
  for (let i = 0; i < 30 && receiver.catchup.state.page; i++) await f.turn(receiver)
  assert.equal(poolCount(receiver), 3)
  assert.equal(receiver.catchup.state.count, 3)
  assert.deepEqual(f.ledger.receipts, [3,2,1].map(hash))
})

test('a continuously due maintenance job gets every daemon tick; history can use its unspent turns', async t => {
  const f = fixture(t), sender = await f.open(1)
  sender.evm.get('ethereum').rpc = sender.rpc.publicOnly
  await f.ledger.seed(sender, 1)
  let turns = 0, firstReceiptTurn
  const receiver = await f.open(2, (url, init) => {
    if (JSON.parse(init.body).method === 'eth_getTransactionReceipt') firstReceiptTurn = turns
    return f.ledger.fetch(url, init)
  })
  f.offer(sender)
  receiver.catchup.tick()
  receiver.scheduler.backgroundJobs.add('maintenance-fixture')
  receiver.scheduler.add({ id: 'maintenance-fixture', interval: 0, run() {
    f.time += 1000
    if (++turns <= 3) receiver.budget.take()
  } })
  receiver.schedule()
  const end = Date.now() + 8000
  while (!poolCount(receiver)) {
    assert.ok(Date.now() < end, 'a queue of zero-RPC maintenance jobs cannot starve history')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  clearTimeout(receiver.timer)
  assert.equal(firstReceiptTurn, 4)
  assert.ok(turns >= 6)
  assert.equal(f.ledger.receipts.length, 1)
})

test('pages from two signers merge disjoint markets and share one verification for their overlap', async t => {
  const f = fixture(t), a = await f.open(1), b = await f.open(2)
  for (const peer of [a,b]) {
    peer.evm.get('ethereum').rpc = peer.rpc.publicOnly
    await f.ledger.seed(peer, 3)
  }
  a.store.writer.prepare('DELETE FROM engine_pool_history WHERE pool=?').run(f.ledger.record(3).pool)
  b.store.writer.prepare('DELETE FROM engine_pool_history WHERE pool=?').run(f.ledger.record(1).pool)
  const late = await f.open(3)
  f.offer(a)
  f.offer(b)
  for (let i = 0; i < 150 && !late.catchup.state.done; i++) await f.turn(late)
  assert.ok(late.catchup.state.done)
  assert.equal(late.catchup.state.count, 4)
  assert.equal(poolCount(late), 3)
  assert.equal(new Set(f.ledger.receipts).size, 3)
  assert.equal(f.ledger.receipts.length, 3)
})
