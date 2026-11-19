import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyRpcError } from '../src/sources/rpc-errors.js'
import { RpcClient, fetchJson } from '../src/rpc/index.js'
import { RequestBudget } from '../src/scheduler/index.js'
import { adaptBundle, logWindow } from '../src/sources/bundle-adapter.js'
import { SourceStats, sourcesReport } from '../src/health/sources.js'
import { loadBundle } from '@gator/bundle'

// Messages as the providers sent them on 2026-11-19.
test('upstream refusals are classified by what they mean for rotation', () => {
  const kind = (status, code, message) => classifyRpcError({ status, code, message })
  assert.deepEqual(kind(400, 35, 'ranges over 100 blocks are not supported on free plan'), { kind: 'range', limit: 100 })
  assert.deepEqual(kind(200, -32602, 'block range too large: total block range in this request exceeds the maximum of 100 blocks'),
    { kind: 'range', limit: 100 })
  assert.deepEqual(kind(200, -32602, 'query exceeds max block range 1000'), { kind: 'range', limit: 1000 })
  assert.deepEqual(kind(200, -32602, 'block range greater than 1000 max'), { kind: 'range', limit: 1000 })
  assert.deepEqual(kind(403, -32602, 'A maximum of 10 addresses is allowed. No limit on a dedicated node: https://x'),
    { kind: 'addresses', limit: 10 })
  assert.equal(kind(403, -32602, 'Archive requests require a personal token. Get one at: https://x').kind, 'method')
  assert.equal(kind(403, -32602, 'Indexed requests require a personal token. Get one at: https://x').kind, 'method')
  assert.equal(kind(200, -32601, 'Method not found').kind, 'method')
  assert.equal(kind(429, -32029, 'Too Many Requests, Please apply an OnFinality API key').kind, 'rate-limited')
  assert.equal(kind(429, -32011, 'request limit reached').kind, 'rate-limited')
  assert.equal(kind(200, -32005, 'limit exceeded').kind, 'rate-limited')
  assert.equal(kind(200, -32001, "You've reached the usage limit for your current plan. To continue, please upgrade").kind, 'quota')
  assert.equal(kind(503, 100021, 'Apikey not found').kind, 'key')
  assert.equal(kind(400, 35, 'chain is not available on free plan, please upgrade to paid plan').kind, 'key')
  assert.equal(kind(403, undefined, 'unsupported platform').kind, 'key')
  assert.equal(kind(401, undefined, 'message: API key not found, json-rpc code: -32050, rest code: 401').kind, 'key')
  assert.equal(kind(403, undefined, 'Attention Required! | Cloudflare').kind, 'blocked')
  assert.equal(kind(400, 30, 'Request timeout on the free plan, please upgrade to paid plan').kind, 'timeout')
  assert.equal(kind(200, 3, 'execution reverted').kind, 'reverted')
  assert.equal(kind(200, -32000, 'header not found').kind, 'lagging')
  assert.equal(kind(200, -32005, 'query returned more than 10000 results').kind, 'too-large')
  assert.deepEqual(kind(200, -32602, 'Too many inputs provided; max 50'), { kind: 'inputs', limit: 50 })
  // Reads past a node's head (Celo forno, dRPC, HyperEVM): lagging, never a learned range cap.
  assert.equal(kind(400, -32019, 'block is out of range').kind, 'lagging')
  assert.equal(kind(200, -32000, 'unsupported block number').kind, 'lagging')
  assert.equal(kind(200, -32603, 'invalid block height: 51696048').kind, 'lagging')
  assert.equal(kind(200, -32602, 'invalid block range').kind, 'lagging')
  assert.equal(kind(500, 19, 'Temporary internal error. Please retry, trace-id: x').kind, 'server')
})

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

function client(endpoints, handler, extra = {}) {
  const health = []
  const rpc = new RpcClient({
    endpoints: { c: endpoints.map((url) => ({ url, rpm: 600 })) },
    budget: new RequestBudget('large'),
    sleep: async () => {},
    recordHealth: (h) => health.push(h),
    fetch: async (url, init) => handler(url, JSON.parse(init.body)),
    ...extra,
  })
  return { rpc, health, byUrl: (url) => rpc.chains.get('c').find((e) => e.url === url) }
}

test('a refused log range is learned per endpoint and the call moves on without a cooldown', async () => {
  const seen = []
  const { rpc, health, byUrl } = client(['https://small.example', 'https://big.example'], (url, body) => {
    seen.push(new URL(url).hostname)
    const span = Number(body.params[0].toBlock) - Number(body.params[0].fromBlock) + 1
    if (url.includes('small') && span > 100) return reply(rpcError(body.id, 35, 'ranges over 100 blocks are not supported on free plan'), 400)
    return reply({ jsonrpc: '2.0', id: body.id, result: [] })
  })
  const filter = { address: ['0x' + '1'.repeat(40)], fromBlock: '0x1', toBlock: '0x80' }
  assert.deepEqual(await rpc.call('c', 'eth_getLogs', [filter]), [])
  assert.deepEqual(seen, ['small.example', 'big.example'])
  const small = byUrl('https://small.example')
  assert.equal(small.range, 100)
  assert.equal(small.failures, 0)
  assert.equal(small.cooldown, 0)
  assert.deepEqual(health.map((h) => [h.ok, h.kind ?? null]), [[false, 'range'], [true, null]])
  // Ranges it serves still go there; heads were never affected.
  seen.length = 0
  await rpc.call('c', 'eth_getLogs', [{ ...filter, toBlock: '0x10' }])
  assert.deepEqual(seen, ['small.example'])
})

test('address caps and refused methods are learned; reverts are answers, not endpoint faults', async () => {
  const seen = []
  const { rpc, health, byUrl } = client(['https://capped.example', 'https://open.example'], (url, body) => {
    seen.push(new URL(url).hostname + ' ' + body.method)
    if (url.includes('capped') && body.method === 'eth_getLogs' && body.params[0].address.length > 10)
      return reply(rpcError(body.id, -32602, 'A maximum of 10 addresses is allowed.'), 403)
    if (url.includes('capped') && body.method === 'getTokenSupply')
      return reply(rpcError(body.id, -32602, 'Indexed requests require a personal token.'), 403)
    if (body.method === 'eth_call') return reply(rpcError(body.id, 3, 'execution reverted'))
    return reply({ jsonrpc: '2.0', id: body.id, result: 'ok' })
  })
  const address = Array.from({ length: 11 }, (_, i) => '0x' + String(i).padStart(40, '0'))
  assert.equal(await rpc.call('c', 'eth_getLogs', [{ address, fromBlock: '0x1', toBlock: '0x2' }]), 'ok')
  assert.equal(byUrl('https://capped.example').maxAddresses, 10)
  assert.equal(await rpc.call('c', 'getTokenSupply', ['mint']), 'ok')
  assert.ok(byUrl('https://capped.example').refusedMethods.get('getTokenSupply') > Date.now())
  seen.length = 0
  await rpc.call('c', 'getTokenSupply', ['mint'])
  assert.deepEqual(seen, ['open.example getTokenSupply'])
  // A revert: one request, no failure counted, no retry on the other endpoint.
  seen.length = 0
  health.length = 0
  await assert.rejects(rpc.call('c', 'eth_call', [{ to: '0x' + '2'.repeat(40), data: '0x' }, 'latest']),
    (error) => error.kind === 'reverted')
  assert.equal(seen.length, 1)
  assert.deepEqual(health.map((h) => h.ok), [true])
  assert.equal(byUrl('https://capped.example').failures + byUrl('https://open.example').failures, 0)
})

test('keyed, dead and quota endpoints cool down for 30 minutes; rate limits report 429', async () => {
  let now = 1_000_000
  const { rpc, health, byUrl } = client(['https://keyed.example', 'https://limited.example', 'https://good.example'], (url, body) => {
    if (url.includes('keyed')) return reply(rpcError(body.id, 100021, 'Apikey not found'), 503)
    if (url.includes('limited')) return reply(rpcError(body.id, -32029, 'Too Many Requests'), 429)
    return reply({ jsonrpc: '2.0', id: body.id, result: '0x1' })
  }, { clock: () => now })
  assert.equal(await rpc.call('c', 'eth_chainId'), '0x1')
  assert.equal(byUrl('https://keyed.example').cooldown, now + 30 * 60_000)
  assert.ok(byUrl('https://limited.example').cooldown >= now + 15_000)
  assert.deepEqual(health.filter((h) => !h.ok).map((h) => [h.kind, h.status]), [['key', 503], ['rate-limited', 429]])
  // fetchJson keeps the provider's error for classification, not in the thrown message.
  const error = await fetchJson(async () => reply(rpcError(1, -32602, 'secret-ish detail'), 403), 'x').catch((e) => e)
  assert.equal(error.status, 403)
  assert.equal(error.code, -32602)
  assert.doesNotMatch(error.message, /detail/)
})

test('the shipped bundle: failed records are skipped and a 100-block tier does not shrink a chain window', () => {
  const catalog = adaptBundle(loadBundle())
  const chain = (id) => catalog.chains.find((c) => c.id === id)
  const urls = (id) => chain(id).endpoints.map((e) => new URL(e.url).hostname)
  // Blast: three records failed their dated probe (needs a key, chain dropped); only Pocket is called.
  assert.deepEqual(urls('blast'), ['blast.api.pocket.network'])
  for (const c of catalog.chains) for (const e of c.endpoints) assert.ok(!/(^|\.)1rpc\.io$/.test(new URL(e.url).hostname), e.url)
  // dRPC's free tier serves at most 100 blocks, others more: the window stays 128.
  assert.equal(chain('ethereum').endpoints.find((e) => e.url.includes('drpc')).range, 100)
  assert.equal(chain('ethereum').range, 128)
  assert.equal(chain('hyperevm').range, 128)
  assert.equal(logWindow([{ logs: true, range: 100 }, { logs: false }]), 100)
  assert.equal(logWindow([{ logs: null, range: 100 }, { logs: true, range: null }]), Infinity)
  assert.equal(logWindow([]), Infinity)
  // Every EVM/Solana chain with an RPC reader keeps at least two endpoints except Blast (no keyless replacement).
  for (const c of catalog.chains.filter((c) => ['evm', 'solana'].includes(c.family) && c.id !== 'blast'))
    assert.ok(c.endpoints.length >= 2, c.id)
})

test('Sources carries the last failure kind and what an endpoint refuses', () => {
  const now = 5_000_000
  const stats = new SourceStats(() => now)
  stats.record('rpc:a', { ok: true, latency: 50, at: now - 1000 })
  stats.record('rpc:b', { ok: false, latency: 50, at: now - 500, status: 503, kind: 'key' })
  stats.record('http:https://x.example', { ok: false, latency: 50, at: now - 200, status: 403, kind: 'blocked' })
  const e = (id, extra = {}) => ({ id, url: 'https://' + id + '.example', failures: 0, cooldown: 0, refusedMethods: new Map(), ...extra })
  const engine = {
    clock: () => now, sourceStats: stats, scheduler: { jobs: new Map() }, evm: new Map(), nftsEnabled: false,
    catalog: { exchanges: [], apis: [{ id: 'x', name: 'X', url: 'https://x.example/v1' }, { id: 'unused', name: 'U', url: 'https://u.example/v1' }] },
    budget: { limit: 100, used: 0 }, registry: { chains: new Map() },
    rpc: { chains: new Map([['c', [e('a', { logs: true, range: 100, maxAddresses: 10 }),
      e('b', { failures: 8, cooldown: now + 60_000, logs: false, refusedMethods: new Map([['getTokenSupply', now + 1000]]) })]]]) },
  }
  const report = sourcesReport(engine)
  const rpc = Object.fromEntries(report.groups.find((g) => g.id === 'rpc').items.map((i) => [i.id, i]))
  assert.deepEqual(rpc['rpc:a'].refuses, { maxBlockRange: 100, maxAddresses: 10 })
  assert.equal(rpc['rpc:a'].lastError, null)
  assert.deepEqual(rpc['rpc:b'].refuses, { getLogs: true, methods: ['getTokenSupply'] })
  assert.equal(rpc['rpc:b'].lastError, 'key')
  const data = report.groups.find((g) => g.id === 'data').items
  // Only APIs this node called are listed.
  assert.deepEqual(data.map((i) => [i.id, i.lastError]), [['api:x', 'blocked']])
})

test('Hyperliquid: candles are POSTed with numeric times; the duplicate derivatives post is gone; Binance catalog fits', async () => {
  const { fillBody } = await import('../src/sources/http.js')
  const { derivativeJobs, sameAsTicker } = await import('../src/sources/derivatives.js')
  const catalog = adaptBundle(loadBundle())
  const venue = (id) => catalog.exchanges.find((v) => v.id === id)
  const hl = venue('hyperliquid')
  assert.equal(hl.candles.method, 'POST')
  assert.deepEqual(fillBody(hl.candles.body, { symbol: 'BTC', interval: '1h', startMs: 1795000000000, endMs: 1795003600000 }),
    { type: 'candleSnapshot', req: { coin: 'BTC', interval: '1h', startTime: 1795000000000, endTime: 1795003600000 } })
  assert.equal(fillBody('{a}-{b}', { a: 1, b: 'x' }), '1-x')
  assert.throws(() => fillBody({ x: '{missing}' }, {}), /missing/)
  // The ticker job reads funding and open interest from the same metaAndAssetCtxs rows.
  assert.ok(hl.derivatives.every((d) => sameAsTicker(hl, d)))
  assert.equal(derivativeJobs(hl, null, Date.now, () => {}).length, 0)
  assert.equal(derivativeJobs(venue('phemex'), null, Date.now, () => {}).length, 0)
  assert.ok(derivativeJobs(venue('binance'), null, Date.now, () => {}).length > 0)
  // Full exchangeInfo is 17.9 MB (over the 8 MB response cap); TRADING without permission sets is 2.5 MB.
  assert.match(venue('binance').format.catalog.url, /symbolStatus=TRADING&showPermissionSets=false$/)
})

test('the candle reader sends a POST venue its body and keys pending reads by it', async () => {
  const { CandleHistory } = await import('../src/candles/index.js')
  const sent = []
  const http = { get: async (url, rpm, cost, body) => { sent.push({ url, body }); return [] } }
  const scheduler = { demand: (id, key, run) => { sent.push({ key }); return run() } }
  const venues = new Map([['hyperliquid', adaptBundle(loadBundle()).exchanges.find((v) => v.id === 'hyperliquid')]])
  const history = new CandleHistory({ store: {}, registry: { venues, markets: new Map() }, http, clock: () => 1795003600000, scheduler })
  await history.market({ id: 'cex:hyperliquid:BTC-USDC', exchange: 'hyperliquid', symbol: 'BTC' }, '1h', 1795000000000, 1795003600000, 1)
  const request = sent.find((s) => s.url)
  assert.equal(request.url, 'https://api.hyperliquid.xyz/info')
  assert.deepEqual(request.body.req, { coin: 'BTC', interval: '1h', startTime: 1795000000000, endTime: 1795003600000 })
  assert.match(sent[0].key, /candleSnapshot/)
})

test('a node behind the requested block or slot is asked again elsewhere and is not counted as failing', async () => {
  assert.equal(classifyRpcError({ code: -32016, message: 'Minimum context slot has not been reached' }).kind, 'lagging')
  let now = 2_000_000
  const { rpc, health, byUrl } = client(['https://behind.example', 'https://ahead.example'], (url, body) =>
    url.includes('behind') ? reply(rpcError(body.id, -32000, 'header not found')) : reply({ jsonrpc: '2.0', id: body.id, result: '0x1' }),
  { clock: () => now })
  assert.equal(await rpc.call('c', 'eth_call', [{ to: '0x' + '3'.repeat(40), data: '0x' }, '0x10']), '0x1')
  const behind = byUrl('https://behind.example')
  assert.equal(behind.failures, 0)
  assert.equal(behind.cooldown, now + 2000)
  const stats = new SourceStats(() => now)
  for (const h of health) stats.record('rpc:' + h.id, h)
  const sum = stats.summary('rpc:' + behind.id)
  assert.deepEqual([sum.requests1h, sum.errors1h, sum.lastFailure], [1, 0, null])
})

test('Paradex loads its perpetuals catalog, not the 15 MB options list', () => {
  const paradex = adaptBundle(loadBundle()).exchanges.find((v) => v.id === 'paradex')
  assert.match(paradex.format.catalog.url, /\/v1\/markets\?asset_kind=PERP$/)
})

test('a key-list cap (Pocket getMultipleAccounts max 50) is learned; longer lists go elsewhere, shorter ones still come', async () => {
  const seen = []
  const { rpc, byUrl } = client(['https://capped.example', 'https://open.example'], (url, body) => {
    seen.push(new URL(url).hostname)
    if (url.includes('capped') && body.params[0].length > 50) return reply(rpcError(body.id, -32602, 'Too many inputs provided; max 50'))
    return reply({ jsonrpc: '2.0', id: body.id, result: { value: [] } })
  })
  const keys = (n) => Array.from({ length: n }, (_, i) => 'k' + i)
  await rpc.call('c', 'getMultipleAccounts', [keys(100), {}])
  assert.deepEqual(seen, ['capped.example', 'open.example'])
  assert.equal(byUrl('https://capped.example').maxInputs.get('getMultipleAccounts'), 50)
  assert.equal(byUrl('https://capped.example').failures, 0)
  seen.length = 0
  await rpc.call('c', 'getMultipleAccounts', [keys(100), {}])
  await rpc.call('c', 'getMultipleAccounts', [keys(10), {}])
  assert.deepEqual(seen, ['open.example', 'capped.example'])
})

test('a provider reason in JSON-RPC error data is classified (Pocket sheds heavy requests under load)', async () => {
  const { rpc, health } = client(['https://shed.example', 'https://ok.example'], (url, body) =>
    url.includes('shed')
      ? reply({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'request declined: this endpoint will not serve this request',
          data: 'node under capacity pressure; heavy requests are being shed first' } }, 400)
      : reply({ jsonrpc: '2.0', id: body.id, result: 1 }))
  assert.equal(await rpc.call('c', 'getMultipleAccounts', [['k'], {}]), 1)
  assert.deepEqual(health.filter((h) => !h.ok).map((h) => [h.kind, h.status]), [['rate-limited', 429]])
})

test('lagging endpoints do not use up the attempts while a caught-up endpoint is untried', async () => {
  const seen = []
  const { rpc } = client(['https://seed1.example', 'https://seed2.example', 'https://seed3.example', 'https://ahead.example'], (url, body) => {
    seen.push(new URL(url).hostname)
    return url.includes('seed') ? reply(rpcError(body.id, -32000, 'header not found')) : reply({ jsonrpc: '2.0', id: body.id, result: '0x2' })
  })
  // retries = 2 (3 attempts), but three lagging nodes come first.
  assert.equal(await rpc.call('c', 'eth_call', [{ to: '0x' + '4'.repeat(40), data: '0x' }, '0x20']), '0x2')
  assert.deepEqual(seen, ['seed1.example', 'seed2.example', 'seed3.example', 'ahead.example'])
})
