import test from 'node:test'
import assert from 'node:assert/strict'
import {
  Scheduler,
  coverageTarget,
  seededRandom,
  EndpointBucket,
  RequestBudget,
  RateLimited,
} from '../src/scheduler/index.js'
import { RpcClient, fetchJson } from '../src/rpc/index.js'

test('coverage targets, 10% spot checks and deterministic choices', async () => {
  assert.deepEqual(
    [50, 51, 500, 501].map((r) => coverageTarget(r).count),
    [5, 3, 3, 2]
  )
  const run = async () => {
    let now = 0
    const s = new Scheduler({ clock: () => now, random: seededRandom(17), coverage: () => 5 })
    for (const id of ['a', 'b']) s.add({ id, markets: () => [{ id, rank: 1 }], run() {} })
    const result = []
    for (let i = 0; i < 1000; i++) {
      now += 1000
      result.push(await s.runOne())
    }
    return result
  }
  const result = await run()
  assert.deepEqual(result, await run())
  assert.ok(result.filter(Boolean).length > 75 && result.filter(Boolean).length < 125)
})

test('rolling machine budget and half-rate endpoint bucket charge unsuccessful attempts too', () => {
  let now = 100
  const budget = new RequestBudget('small', 2, () => now)
  const bucket = new EndpointBucket(120, () => now)
  bucket.take(budget)
  now += 999
  assert.throws(() => bucket.take(budget), RateLimited)
  now++
  bucket.take(budget)
  now += 1000
  assert.throws(() => bucket.take(budget), RateLimited)
  now = 60100
  bucket.take(budget)
  assert.equal(budget.used, 2)
})

test('a background job allowlist applies to later discoveries as well as startup jobs', async () => {
  const scheduler = new Scheduler({ backgroundJobs: ['cex:sample'], coverage: () => 0 })
  scheduler.add({ id: 'cex:sample', run() {} })
  scheduler.add({ id: 'meta:discovered', run() { assert.fail('outside scope') } })
  assert.equal(await scheduler.runOne(), 'cex:sample')
  assert.equal(await scheduler.runOne(), null)
})

test('RPC prefers a user endpoint, rotates on error, correlates shuffled batch ids', async () => {
  let now = 10_000
  const visited = [],
    health = []
  const rpc = new RpcClient({
    endpoints: { sol: [{ url: 'https://public.invalid', batch: true, rpm: 600 }] },
    userEndpoints: { sol: [{ url: 'https://user.invalid', batch: true, rpm: 600 }] },
    clock: () => now,
    sleep: async (ms) => {
      now += ms
    },
    recordHealth: (h) => health.push(h),
    fetch: async (url, options) => {
      visited.push(url)
      if (url.includes('user')) return new Response('', { status: 503 })
      return Response.json(
        JSON.parse(options.body)
          .reverse()
          .map((c) => ({ id: c.id, jsonrpc: '2.0', result: c.method }))
      )
    },
  })
  assert.deepEqual(await rpc.batch('sol', [{ method: 'getHealth' }, { method: 'getSlot' }]), [
    'getHealth',
    'getSlot',
  ])
  assert.deepEqual(visited, ['https://user.invalid', 'https://public.invalid'])
  assert.deepEqual(
    health.map((h) => h.ok),
    [false, true]
  )
  assert.ok(!JSON.stringify(health).includes('https'))
})

test('HTTP checks streamed bytes and RPC rejects duplicate or uncorrelated replies', async () => {
  await assert.rejects(
    fetchJson(async () => new Response('abcd'), 'fixture', {}, { maxBytes: 3 }),
    /limit/
  )
  const rpc = new RpcClient({
    endpoints: { e: ['https://fixture.invalid'] },
    retries: 0,
    fetch: async () => Response.json({ id: 0, result: 'ok', jsonrpc: '2.0' }),
  })
  await assert.rejects(rpc.call('e', 'eth_blockNumber'), /RPC request failed/)
})

test('batch fallback makes paced singleton requests and preserves results across long rate waits', async () => {
  let now = 1000
  const calls = []
  const rpc = new RpcClient({
    endpoints: { eth: [{ url: 'https://fixture.invalid', rpm: 12 }] },
    clock: () => now,
    aliases: { 1: 'eth' },
    sleep: async (ms) => {
      now += ms
    },
    fetch: async (_url, init) => {
      const q = JSON.parse(init.body)
      calls.push(now)
      return Response.json({ jsonrpc: '2.0', id: q.id, result: q.method })
    },
  })
  assert.deepEqual(await rpc.batch(1, [{ method: 'first' }, { method: 'second' }, { method: 'third' }]), [
    'first',
    'second',
    'third',
  ])
  assert.deepEqual(calls, [1000, 11000, 21000])
})

test('on-demand candle requests share one in-flight result and apply exponential failure cooldown', async () => {
  let now = 1000,
    runs = 0,
    finish
  const scheduler = new Scheduler({ clock: () => now, coverage: () => 0 })
  const run = () => {
    runs++
    return new Promise((resolve) => {
      finish = resolve
    })
  }
  const a = scheduler.demand('candles:m', 'range', run),
    b = scheduler.demand('candles:m', 'range', run)
  assert.equal(runs, 1)
  assert.equal(scheduler.choose(), null)
  finish([1])
  assert.deepEqual(await Promise.all([a, b]), [[1], [1]])
  await assert.rejects(
    scheduler.demand('candles:m', 'range', async () => {
      throw Error('offline')
    }),
    /offline/
  )
  await assert.rejects(scheduler.demand('candles:m', 'range', run), RateLimited)
  now += 2000
  assert.equal(await scheduler.demand('candles:m', 'range', async () => 4), 4)
})

test('variable request weights respect the rolling documented allowance at the end of a full minute', () => {
  let now = 0
  const budget = new RequestBudget('normal', 240, () => now),
    bucket = new EndpointBucket(120, () => now)
  for (let i = 0; i < 59; i++) {
    bucket.take(budget)
    now += 1000
  }
  assert.throws(() => bucket.take(budget, 3), RateLimited)
  now = 61000
  bucket.take(budget, 3)
})

test('an upstream timeout rotates to a healthy endpoint', async () => {
  const tried = []
  const rpc = new RpcClient({
    endpoints: { eth: ['https://first.invalid', 'https://second.invalid'] },
    timeout: 8,
    sleep: async () => {},
    fetch: async (url, init) => {
      tried.push(url)
      if (url.includes('first'))
        return new Promise((resolve, reject) => {
          const keepAlive = setTimeout(resolve, 1000)
          init.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(keepAlive)
              reject(init.signal.reason)
            },
            { once: true }
          )
        })
      return Response.json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x1' })
    },
  })
  assert.equal(await rpc.call('eth', 'eth_chainId'), '0x1')
  assert.equal(tried.length, 2)
})

test('disagreements coalesce, have global and per-market cooldowns, and respect source backoff', async () => {
  let now = 1000
  const checks = []
  const s = new Scheduler({ clock: () => now, random: () => 0.5, coverage: () => 5 })
  s.add({ id: 'cex:spot', markets: () => [{ id: 'a', rank: 1 }],
    run: () => assert.fail('already covered'), spotCheck: id => checks.push(id) })
  for (let i = 0; i < 40; i++) s.requestSpotCheck('cex:spot', String(i))
  assert.equal(s.spotChecks.size, 32)
  s.jobs.get('cex:spot').next = now + 500
  assert.equal(await s.runOne(), null)
  now += 500
  assert.equal(await s.runOne(), 'cex:spot')
  s.requestSpotCheck('cex:spot', '0')
  now += 14_999
  assert.equal(await s.runOne(), null)
  now++
  await s.runOne()
  assert.deepEqual(checks, ['0', '1'])
  now += 300_000
  s.requestSpotCheck('cex:spot', '0')
  await s.runOne()
  assert.deepEqual(checks, ['0', '1', '0'])
})

test('public-only reads fail closed across aliases, batches, duplicate URLs and exhausted retries', async () => {
  let now = 1000
  const urls = []
  const endpoint = url => ({ url, batch: true, rpm: 6000 })
  const rpc = new RpcClient({
    endpoints: { eth: [endpoint('https://bundled.invalid'), endpoint('https://overlap.invalid')] },
    userEndpoints: { 1: [endpoint('https://user.invalid'), endpoint('https://overlap.invalid')] },
    aliases: { 1: 'eth' }, retries: 1, clock: () => now, sleep: async ms => { now += ms },
    fetch: async url => { urls.push(url); return new Response(null, { status: 503 }) },
  })
  await assert.rejects(rpc.publicOnly.call(1, 'eth_chainId'))
  await assert.rejects(rpc.publicOnly.batch(1, [{ method: 'first' }, { method: 'second' }]))
  assert.deepEqual(urls, Array(4).fill('https://bundled.invalid'))
  const privateOnly = new RpcClient({ userEndpoints: { eth: ['https://user.invalid'] },
    fetch: () => assert.fail('no eligible endpoint') })
  await assert.rejects(privateOnly.publicOnly.call('eth', 'eth_chainId'), /No eligible/)
})

test('jobs without markets get every fourth turn, longest-waiting first, despite high market scores', async () => {
  let now = 0
  const s = new Scheduler({ clock: () => now, random: seededRandom(5), coverage: () => 0 })
  const ran = []
  s.add({ id: 'venue', markets: () => Array.from({ length: 500 }, (_, i) => ({ id: 'm' + i, rank: 1 })), run: () => ran.push('venue') })
  for (const id of ['supply', 'seed']) s.add({ id, interval: 1, run: () => ran.push(id) })
  s.add({ id: 'idle', ready: () => false, run: () => ran.push('idle') })
  for (let i = 0; i < 40; i++) {
    now += 1000
    await s.runOne()
  }
  // At least the reserved fourth turns; exploration may add a few.
  assert.ok(ran.filter((id) => id !== 'venue').length >= 10)
  assert.ok(Math.abs(ran.filter((id) => id === 'supply').length - ran.filter((id) => id === 'seed').length) <= 1)
  assert.equal(ran.includes('idle'), false)
})

test('a job that never settles frees its slot at the deadline and backs off', async () => {
  const { JobDeadline } = await import('../src/scheduler/index.js')
  const s = new Scheduler({ coverage: () => 0 })
  s.add({ id: 'stuck', interval: 1000, deadlineMs: 50, run: () => new Promise(() => {}) })
  const started = Date.now()
  // The deadline timer is unref'd (it never delays shutdown); keep this test's event loop alive meanwhile.
  const alive = setInterval(() => {}, 1000)
  try { await assert.rejects(s.execute(s.jobs.get('stuck'), s.jobs.get('stuck').run), JobDeadline) }
  finally { clearInterval(alive) }
  assert.ok(Date.now() - started < 1000)
  const job = s.jobs.get('stuck')
  assert.equal(job.failures, 1)
  assert.ok(Number.isFinite(job.next) && job.next > Date.now())
  assert.ok(job.lastDeadline)
})

test('a focused market doubles a matching job score and guarantees turns for other markets and background jobs', async () => {
  let now = 0;
  const scheduler = new Scheduler({ clock: () => now, coverage: () => 0, random: () => 0.5 });
  scheduler.focus = { active: () => true, market: id => id === 'focus' };
  const runs = new Map();
  for (const id of ['a','b','c','focus','history']) {
    const job = { id, interval: 0, run() { runs.set(id, (runs.get(id) ?? 0) + 1); } };
    if (id !== 'history') job.markets = () => [{ id, rank: 40 }];
    scheduler.add(job);
  }
  for (let i = 0; i < 160; i++) { now++; await scheduler.runOne(); }
  assert.equal(scheduler.jobs.get('focus').scored.score, 2 * scheduler.jobs.get('a').scored.score);
  assert.equal(runs.size, 5);
  assert.equal(runs.get('history'), 40);
  assert.ok(runs.get('focus') > runs.get('a'));
});
