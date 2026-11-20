import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LOOKUP_LIMITS } from '../src/intel/add-token.js'
import { engineWith, replay } from './add-token-fixture.js'

// Real public reads through the bundle's endpoints, recorded on 2026-11-20 by address-only adds (every EVM chain).
const load = name => JSON.parse(readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url)))
const BSC = load('add-token-bsc-v2'), BASE = load('add-token-base-v3'), NEGATIVE = load('add-token-lookup-negative')
const BABYDOGE = '0xc748673057861a797275cd8a068abb95a902e8de' // BabyDoge on BNB Chain (PancakeSwap V2 pairs)
const BRETT = '0x532f27101965dd16442e59d40670faf5ebb142e4' // BRETT on Base (Uniswap V3 pools)
const FACTORY = '0x1f98431c8ad98523631ae4a59f267346ea31f984' // Uniswap V3 factory: a contract, not a token
const DEAD = '0x000000000000000000000000000000000000dead' // no code on any chain
const HOUR = 3_600_000

/** A node replaying `records` at the recording time; `reads()` counts the requests it sent. */
async function node(records, recordedAt) {
  const counted = { n: 0 }, rp = replay(records)
  const fetch = (url, init) => { if (init?.body) counted.n += [JSON.parse(init.body)].flat().length; return rp(url, init) }
  const n = await engineWith(fetch, { at: Date.parse(recordedAt) })
  // The recording ran with these quote prices (they price the pools' depth against the $100 floor).
  for (const [asset, price] of [['ethereum:native', '3000'], ['base:native', '3000'], ['bsc:native', '600']])
    n.store.writer.prepare("INSERT INTO prices(asset,price,at,trust) VALUES (?,?,?,'green')").run(asset, price, n.clock())
  return { ...n, reads: () => counted.n }
}

test('search lookup: a V2 token on BNB Chain is found by its address alone, once, without the add_token quota', async t => {
  const { engine, store, reads, advance } = await node(BSC.adds[BABYDOGE].records, BSC.recordedAt)
  t.after(async () => { await engine.stop(); store.close() })
  const { addTokens } = engine
  // Partial addresses and non-addresses never start anything.
  assert.equal(addTokens.lookup(BABYDOGE.slice(0, 20)), null)
  assert.equal(addTokens.lookup('babydoge'), null)
  assert.equal(addTokens.status(BABYDOGE), null, 'status alone does not start a lookup')
  const first = addTokens.lookup(BABYDOGE.toUpperCase().replace('0X', '0x'))
  assert.equal(first.state, 'queued')
  assert.equal(first.chains, 20)
  assert.equal(first.message, 'Looking this address up on 20 chains…')
  // A repeated search while it runs is the same lookup.
  const again = addTokens.lookup(BABYDOGE)
  assert.equal(again.startedAt, first.startedAt)
  assert.ok(['queued', 'running'].includes(again.state))
  await addTokens.lookupsIdle()
  const done = addTokens.status(BABYDOGE)
  assert.equal(done.state, 'found')
  assert.equal(done.asset, 'bsc:' + BABYDOGE)
  assert.equal(done.tokens[0].symbol, 'BabyDoge')
  assert.match(done.message, /^Found BabyDoge on BNB Chain with \d+ pools\.$/)
  // The deep PancakeSwap V2 pair is registered as an ordinary v2 market.
  const v2 = BSC.adds[BABYDOGE].expect.tokens[0].pools.find(p => p.kind === 'v2' && p.liquidityUsd > 1e6)
  assert.ok(engine.registry.markets.has('dex:bsc:' + v2.pool), 'v2 pool registered')
  const [listed] = addTokens.list()
  assert.equal(listed.addedBy, 'search')
  assert.ok(listed.pools.some(p => p.pool === v2.pool && p.kind === 'v2'))
  // Search lookups use their own quota; the explicit add_token quota is untouched.
  assert.equal((store.getSetting('engine-add-token/recent') ?? []).length, 0)
  assert.equal(store.getSetting('engine-add-token/lookups').length, 1)
  // Searching it again reads nothing more: first the finished lookup answers, later the token is simply known.
  const used = reads()
  assert.equal(addTokens.lookup(BABYDOGE).state, 'found')
  advance(HOUR + 60_000)
  assert.equal(addTokens.lookup(BABYDOGE), null)
  assert.equal(reads(), used)
  assert.equal(store.getSetting('engine-add-token/lookups').length, 1)
})

test('add_token: a V3 token on Base is found by its address alone and priced (a search does not re-add a known token)', async t => {
  const { engine, store } = await node(BASE.adds[BRETT].records, BASE.recordedAt)
  t.after(async () => { await engine.stop(); store.close() })
  // BRETT is a bundle token, so a search finds it directly and starts no lookup; an agent's add_token still works.
  assert.equal(engine.addTokens.lookup(BRETT), null)
  const result = await engine.addTokens.add({ address: BRETT }, { by: 'agent' })
  assert.equal(result.asset, 'base:' + BRETT)
  assert.equal(result.chainsProbed, 20)
  assert.ok(result.tokens[0].priceUsd > 0)
  const v3 = BASE.adds[BRETT].expect.tokens[0].pools.filter(p => p.kind === 'v3' && p.liquidityUsd >= 100)
  assert.ok(v3.length >= 2)
  for (const p of v3) assert.ok(engine.registry.markets.has('dex:base:' + p.pool), p.pool + ' registered')
  // Uniswap V3 is not the only kind it finds on Base (Aerodrome Slipstream, PancakeSwap V3).
  const [listed] = engine.addTokens.list()
  assert.ok(listed.pools.some(p => p.kind === 'slipstream') && listed.pools.some(p => p.kind === 'pancake-v3'))
})

test('search lookup: no contract and non-token answers are cached for 24 h; lookups run one at a time', async t => {
  // The recording's transient "Too Many Requests" answers were retried on another endpoint; this replay skips them.
  const records = [...NEGATIVE.adds[FACTORY].records, ...NEGATIVE.adds[DEAD].records].filter(r => r.error?.code !== -32029)
  const { engine, store, reads, advance } = await node(records, NEGATIVE.recordedAt)
  t.after(async () => { await engine.stop(); store.close() })
  const { addTokens } = engine
  assert.equal(addTokens.lookup(FACTORY).state, 'queued')
  assert.equal(addTokens.lookup(DEAD).state, 'queued')
  await addTokens.lookupsIdle()
  const factory = addTokens.status(FACTORY), dead = addTokens.status(DEAD)
  assert.equal(factory.state, 'not-token')
  assert.match(factory.message, /contract, but not a token/)
  assert.equal(dead.state, 'no-contract')
  assert.match(dead.message, /^No contract at this address on any of the 20 chains\./)
  const used = reads()
  // After the in-memory answer expires, the persisted negative cache answers without reads and without quota.
  advance(2 * HOUR)
  const cached = addTokens.lookup(DEAD)
  assert.equal(cached.state, 'no-contract')
  assert.ok(cached.retryAt > engine.clock() && cached.retryAt <= engine.clock() + LOOKUP_LIMITS.negativeMs)
  assert.equal(addTokens.lookup(FACTORY).state, 'not-token')
  assert.equal(reads(), used)
  assert.equal(store.getSetting('engine-add-token/lookups').length, 2)
  // Neither cached address is registered anywhere.
  assert.equal(addTokens.list().length, 0)
  // After 24 h the address is looked up again.
  advance(LOOKUP_LIMITS.negativeMs)
  assert.equal(addTokens.lookup(DEAD).state, 'queued')
  await addTokens.lookupsIdle()
  assert.ok(reads() > used)
  assert.equal(addTokens.status(DEAD).state, 'no-contract')
})

test('search lookup: answers with chains left unchecked are not cached for 24 h', async t => {
  // As recorded: three endpoints answered "Too Many Requests" first (this replay does not retry them).
  const records = [...NEGATIVE.adds[FACTORY].records, ...NEGATIVE.adds[DEAD].records]
  const { engine, store, reads, advance } = await node(records, NEGATIVE.recordedAt)
  t.after(async () => { await engine.stop(); store.close() })
  engine.addTokens.lookup(FACTORY)
  engine.addTokens.lookup(DEAD)
  await engine.addTokens.lookupsIdle()
  const factory = engine.addTokens.status(FACTORY), dead = engine.addTokens.status(DEAD)
  assert.equal(factory.state, 'not-token')
  assert.match(factory.message, /\(17 of 20 chains checked; the others did not answer/)
  assert.equal(dead.state, 'unavailable')
  assert.equal(dead.message, 'No token here on 17 of 20 chains; 3 did not answer. Search again in a few minutes.')
  assert.equal(store.getSetting('engine-add-token/negative'), undefined)
  const used = reads()
  assert.equal(engine.addTokens.lookup(DEAD).state, 'unavailable', 'the short retry window still dedupes')
  assert.equal(reads(), used)
  advance(LOOKUP_LIMITS.retryMs + 1000)
  assert.equal(engine.addTokens.lookup(FACTORY).state, 'queued')
  assert.equal(engine.addTokens.lookup(DEAD).state, 'queued')
  await engine.addTokens.lookupsIdle()
})

/** Every chain answers "no code" (the logic tests below need many distinct addresses). */
function noCode(calls = { n: 0 }) {
  return async (url, init) => {
    const req = JSON.parse(init.body), list = Array.isArray(req) ? req : [req]
    const out = list.map(({ id, method }) => {
      calls.n++
      return method === 'eth_getCode' ? { jsonrpc: '2.0', id, result: '0x' } : { jsonrpc: '2.0', id, error: { code: -32601, message: 'unexpected' } }
    })
    return Response.json(Array.isArray(req) ? out : out[0])
  }
}

test('search lookup quota: 20 per hour per node, separate from add_token; a queue of 4; waits for an explicit add', async t => {
  const calls = { n: 0 }
  const { engine, store, advance } = await engineWith(noCode(calls))
  t.after(async () => { await engine.stop(); store.close() })
  const { addTokens } = engine
  const addr = i => '0x' + i.toString(16).padStart(40, '0')
  for (let i = 1; i <= LOOKUP_LIMITS.perHour; i++) {
    advance(150_000) // spread over 50 minutes, so the node's request budget refills between lookups
    assert.equal(addTokens.lookup(addr(i)).state, 'queued')
    await addTokens.lookupsIdle()
    assert.equal(addTokens.status(addr(i)).state, 'no-contract')
  }
  const before = calls.n
  const limited = addTokens.lookup(addr(100))
  assert.equal(limited.state, 'limited')
  assert.ok(limited.retryAt > engine.clock())
  assert.match(limited.message, /Lookup limit reached on this node \(20 per hour\)/)
  assert.equal(calls.n, before, 'a refused lookup makes no reads')
  assert.equal(addTokens.status(addr(100)), null, 'a refused lookup leaves no entry')
  // add_token keeps its own quota: an explicit add still runs (and gets the real answer, not a 429).
  await assert.rejects(addTokens.add({ address: addr(100), chain: 'base' }), e => e.status === 422)
  // The next hour admits lookups again. A lookup queued behind an explicit add waits for it, then runs.
  advance(HOUR + 1000)
  const explicit = addTokens.add({ address: addr(200), chain: 'base' }).catch(e => e)
  const queued = addTokens.lookup(addr(201))
  assert.equal(queued.state, 'queued')
  assert.equal((await explicit).status, 422)
  await addTokens.lookupsIdle()
  assert.equal(addTokens.status(addr(201)).state, 'no-contract')
  // At most 4 lookups wait at once; more answer "busy" without using the quota.
  const used = store.getSetting('engine-add-token/lookups').length
  for (let i = 0; i < LOOKUP_LIMITS.maxQueued; i++) assert.equal(addTokens.lookup(addr(300 + i)).state, 'queued')
  assert.equal(addTokens.lookup(addr(310)).state, 'busy')
  assert.equal(store.getSetting('engine-add-token/lookups').length, used + LOOKUP_LIMITS.maxQueued)
  await addTokens.lookupsIdle()
})
