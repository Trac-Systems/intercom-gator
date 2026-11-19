import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadBundle } from '@gator/bundle'
import { createMemoryHub, MemoryTransport } from '@gator/net'
import { Engine, migrations } from '../src/index.js'
import { word } from '../src/sources/evm-abi.js'
import { ADD_LIMITS } from '../src/intel/add-token.js'
import { openStore } from './store-fixture.js'

const DMT = '0x249130f5e2dd4cf278180c0df8273f3592ad1247'
const ETH_POOL = '0xb44cc02c4ffa5ad68cc66ab404800a4f0029e5b6a9752b7cffc1bf8bbaaa92a3'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' // Circle USDC on Ethereum (public contract)
const CREATED_TX = '0xd241f3cb7fab0bbdc3b12468f1f0db79cd538acf888c54494bc5966baa845266'
const USDC_POOL = '0x6ad53eb6c9f2f86b4d1edd95395d783eef8de8e182776539f776ceb9d90de524'
// Real public reads recorded on 2026-11-20 (Ethereum head 0x193a1ec) by a live add of DMT-NAT.
const recorded = JSON.parse(readFileSync(new URL('./fixtures/add-token-dmt-nat.json', import.meta.url)))

function replay(records) {
  const byKey = new Map()
  for (const r of records) {
    const key = r.url + ' ' + r.method + ' ' + JSON.stringify(r.params)
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(r)
  }
  const used = new Map()
  return async (url, init) => {
    if (!init?.body) return new Response('{}', { status: 503 })
    const req = JSON.parse(init.body), list = Array.isArray(req) ? req : [req]
    const out = list.map(r => {
      const key = new URL(url).host + ' ' + r.method + ' ' + JSON.stringify(r.params)
      const hits = byKey.get(key)
      if (!hits) return { jsonrpc: '2.0', id: r.id, error: { code: -32000, message: 'not recorded' } }
      const n = used.get(key) ?? 0
      used.set(key, n + 1)
      const hit = hits[Math.min(n, hits.length - 1)]
      return hit.error ? { jsonrpc: '2.0', id: r.id, error: hit.error } : { jsonrpc: '2.0', id: r.id, result: hit.result }
    })
    return Response.json(Array.isArray(req) ? out : out[0])
  }
}

async function engineWith(fetch, { at = Date.parse('2026-11-20T00:20:00Z') } = {}) {
  // Real time keeps flowing (the RPC client's short in-call waits use it); the add's patient waits fast-forward.
  let offset = at - Date.now()
  const now = () => Date.now() + offset
  const store = openStore({ file: ':memory:', migrations, profile: 'normal' })
  // Offline replay: lift the public endpoints' documented rate limits so the test does not wait on buckets.
  const bundle = structuredClone(loadBundle())
  for (const chain of bundle.chains) for (const e of chain.endpoints) e.limits = '6000/minute'
  const engine = new Engine({ store, transport: new MemoryTransport({ hub: createMemoryHub() }), bundle,
    clock: now, backgroundJobs: [], rpcConfig: { fetch, retries: 0 }, patches: { patchFeed: false } })
  engine.addTokenSleep = async ms => { offset += ms }
  const sent = []
  engine.transport.send = (channel, message) => { sent.push([channel, message]); return true }
  await engine.start()
  clearTimeout(engine.timer)
  return { engine, store, sent, advance: ms => { offset += ms }, clock: now }
}

// Multicall3 aggregate3 answer where every call fails (a contract without the ERC-20 interface).
function failedAggregate(data) {
  const count = Number(BigInt('0x' + data.slice(10 + 64, 10 + 128)))
  let offset = count * 32
  const offsets = [], tuples = []
  for (let i = 0; i < count; i++) {
    offsets.push(word(offset))
    const tuple = word(0) + word(64) + word(0)
    tuples.push(tuple)
    offset += tuple.length / 2
  }
  return '0x' + word(32) + word(count) + offsets.join('') + tuples.join('')
}
function contractWithoutErc20(calls = { n: 0 }) {
  return async (url, init) => {
    const req = JSON.parse(init.body), list = Array.isArray(req) ? req : [req]
    const out = list.map(({ id, method, params }) => {
      calls.n++
      if (method === 'eth_getCode') return { jsonrpc: '2.0', id, result: '0x6080604052' }
      if (method === 'eth_call') return { jsonrpc: '2.0', id, result: failedAggregate(params[0].data) }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'unexpected' } }
    })
    return Response.json(Array.isArray(req) ? out : out[0])
  }
}

test('DMT-NAT on Ethereum: both standard-key V4 pools are found, registered and priced; a found creation is announced', async t => {
  const { engine, store, sent, clock } = await engineWith(replay(recorded))
  t.after(async () => { await engine.stop(); store.close() })
  // The recording ran with ETH at $3,000 (the native quote prices the ETH pool's depth).
  store.writer.prepare("INSERT INTO prices(asset,price,at,trust) VALUES ('ethereum:native','3000',?,'green')").run(clock())
  const result = await engine.addTokens.add({ address: DMT.toUpperCase().replace('0X', '0x'), chain: 'ethereum' }, { by: 'agent' })
  assert.equal(result.asset, 'ethereum:' + DMT)
  const [token] = result.tokens
  assert.equal(token.decimals, 0)
  assert.equal(token.symbol, 'dmt-nat')
  for (const pool of [ETH_POOL, USDC_POOL]) {
    const row = token.pools.find(p => p.pool === pool)
    assert.ok(row?.registered, pool + ' registered')
    assert.equal(row.kind, 'v4')
    assert.ok(engine.registry.markets.has('dex:ethereum:' + pool))
  }
  assert.ok(token.priceUsd > 1e-8 && token.priceUsd < 1e-6, 'priced: ' + token.priceUsd)
  // Dust pools of the same token stay out (empty or below the added-token depth floor).
  assert.ok(token.pools.some(p => !p.registered && /floor|empty/.test(p.reason)))
  // The USDC pool's Initialize was found inside the inline search and shared as an ordinary pool record.
  const usdc = token.pools.find(p => p.pool === USDC_POOL)
  assert.equal(usdc.creation.state, 'found')
  assert.equal(usdc.creation.block, 23747800)
  assert.equal(usdc.creation.shared, true)
  const announced = sent.filter(([ch, m]) => ch === 'gator/new' && m.t === 'pool')
  assert.deepEqual(announced.map(([, m]) => m), [{ t: 'pool', v: 1, chain: 'ethereum', pool: USDC_POOL, dex: 'uniswap-v4',
    kind: 'v4', token0: DMT, token1: USDC, block: 23747800, tx: CREATED_TX }])
  // Catch-up serves it by verification time (the creation is a year older than the 7-day window).
  const history = store.reader.prepare('SELECT at,verified FROM engine_pool_history WHERE chain=? AND pool=?').get('ethereum', USDC_POOL)
  assert.equal(history.verified, 1)
  assert.ok(Math.abs(history.at - clock()) < 120_000, 'indexed at verification time')
  assert.ok(result.rpcCalls > 0 && result.rpcCalls < 40, 'bounded reads: ' + result.rpcCalls)
  // The listing shows the token and the remaining searches.
  const [listed] = engine.addTokens.list()
  assert.equal(listed.asset, 'ethereum:' + DMT)
  assert.ok(listed.pools.some(p => p.creation.state === 'searching'))
})

test('a non-ERC-20 contract is rejected; adds are rate limited per node', async t => {
  const calls = { n: 0 }
  const { engine, store } = await engineWith(contractWithoutErc20(calls))
  t.after(async () => { await engine.stop(); store.close() })
  const address = '0x' + 'ab'.repeat(20)
  await assert.rejects(engine.addTokens.add({ address, chain: 'base' }), e => e.status === 422 && /not an ERC-20/.test(e.message))
  await assert.rejects(engine.addTokens.add({ address: 'nope' }), e => e.status === 400)
  await assert.rejects(engine.addTokens.add({ address, chain: 'solana' }), e => e.status === 400)
  for (let i = 1; i < ADD_LIMITS.perHour; i++) await assert.rejects(engine.addTokens.add({ address, chain: 'base' }), e => e.status === 422)
  const before = calls.n
  await assert.rejects(engine.addTokens.add({ address, chain: 'base' }), e => e.status === 429 && e.details.retryAt > 0)
  assert.equal(calls.n, before, 'a refused add makes no reads')
  assert.equal(engine.registry.assets.has('base:' + address), false)
})

test('creation search walks back in chunks, halves on provider span limits and resumes', async t => {
  const { engine, store } = await engineWith(contractWithoutErc20())
  t.after(async () => { await engine.stop(); store.close() })
  const source = engine.evm.get('ethereum')
  const init = Object.values(source.chain.events).find(e => e.signature.startsWith('Initialize('))
  const manager = source.chain.deployments.find(d => d.kind === 'v4')
  const head = 3_000_000, created = 1_234_567, limit = 300_000
  const log = { address: manager.address, topics: [init.topic, USDC_POOL, '0x' + word(DMT), '0x' + word(USDC)],
    data: '0x' + [10000, 200, 0, 2n ** 96n, 0].map(word).join(''), blockNumber: '0x' + created.toString(16),
    transactionHash: '0x' + 'cd'.repeat(32), logIndex: '0x1', blockHash: '0x' + 'ef'.repeat(32) }
  const asked = []
  const rpc = { async call(chain, method, [filter]) {
    if (method === 'eth_getBlockByNumber') return { number: '0x' + head.toString(16) }
    const from = Number(filter.fromBlock), to = Number(filter.toBlock)
    asked.push([from, to])
    assert.deepEqual(filter.topics, [[init.topic], USDC_POOL])
    if (to - from + 1 > limit) throw new Error('query block range exceeds server limit')
    return created >= from && created <= to ? [log] : []
  } }
  store.writer.prepare(`INSERT INTO engine_added_pools(chain,pool,asset,dex,kind,state,updatedAt) VALUES
    ('ethereum',?,?,?,'v4','searching',0)`).run(USDC_POOL, 'ethereum:' + DMT, manager.name)
  const row = () => store.reader.prepare('SELECT * FROM engine_added_pools WHERE pool=?').get(USDC_POOL)
  let state, steps = 0
  do { state = await engine.addTokens.searchStep(row(), rpc); steps++ } while (state === 'searching' && steps < 40)
  assert.equal(state, 'found')
  assert.equal(row().block, created)
  assert.equal(row().tx, log.transactionHash)
  assert.equal(row().token0, DMT)
  // The first (1M-block) window was refused, then halved until the provider accepted it; ranges never overlap.
  assert.ok(asked[0][1] - asked[0][0] + 1 > limit)
  const ok = asked.filter(([a, b]) => b - a + 1 <= limit)
  for (let i = 1; i < ok.length; i++) assert.equal(ok[i][1], ok[i - 1][0] - 1)
  assert.equal(ok[0][1], head)
})
