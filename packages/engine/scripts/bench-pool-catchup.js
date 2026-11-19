// Offline benchmark. Start "serve <empty-dir>", then "measure <dir> off|on|mixed-off|mixed-on [seconds]"
// in a separate process. The directory contains only generated fixture data.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import createTestnet from 'hyperdht/testnet.js'
import { bundleDigest, signBundle } from '@gator/bundle'
import { createMemoryHub, keyFromSeed, MemoryTransport, SwarmTransport } from '@gator/net'
import { openStore } from '@gator/store'
import { createGator } from '../../api/src/app.js'
import { httpClient } from '../../api/src/client.js'
import { Engine, migrations } from '../src/index.js'
import { CATCHUP_JOB, POOL_CHANNEL } from '../src/intel/pool-catchup.js'
import { historyBundle, poolLedger } from '../test/fixtures/pool-history.js'

const [role, directory, mode, duration = '90', profile = 'normal'] = process.argv.slice(2)
const dir = resolve(directory ?? '.'), bundle = historyBundle()
const percentile = (arr, p) => arr.length ? +[...arr].sort((a,b) => a-b)[Math.ceil(arr.length*p)-1].toFixed(3) : null
const summary = arr => ({ n: arr.length, p50: percentile(arr, 0.5), p95: percentile(arr, 0.95) })

async function serve() {
  mkdirSync(dir, { recursive: true })
  const release = join(dir, 'release')
  mkdirSync(release)
  const seed = randomBytes(32), wallet = keyFromSeed(seed.toString('hex'))
  for (const [name,value] of Object.entries(bundle)) writeFileSync(join(release, name + '.json'), JSON.stringify(value))
  writeFileSync(join(release, 'bundle.sig'), signBundle(bundleDigest(bundle), seed))
  const net = await createTestnet(3)
  const transport = new SwarmTransport({ dataDir: join(dir, 'sender'), wallet, bootstrap: net.bootstrap })
  const at = Date.now() - 60_000, ledger = poolLedger(bundle, at)
  const store = openStore({ file: join(dir, 'sender.db'), migrations })
  const engine = new Engine({ store, transport, bundle, backgroundJobs: [], patches: { patchFeed: false },
    rpcConfig: { fetch: ledger.fetch, bundleDigest: bundleDigest(bundle) } })
  const replies = [], frameBytes = [], cpuMs = []
  let pages = 0
  transport.on('message', (ch, env) => {
    if (ch === POOL_CHANNEL && env.from === transport.publicKey && env.message.t === 'page') {
      pages++
      frameBytes.push(Buffer.byteLength(JSON.stringify(env)) + 3)
    }
  })
  const respond = engine.catchup.serve.bind(engine.catchup)
  engine.catchup.serve = (...args) => {
    const before = pages, start = performance.now(), cpu = process.cpuUsage()
    respond(...args)
    if (pages !== before) {
      replies.push(performance.now() - start)
      const used = process.cpuUsage(cpu)
      cpuMs.push((used.user + used.system) / 1000)
    }
  }
  try {
    await ledger.seed(engine, 1000)
    assert.equal(store.reader.prepare('SELECT count(*) n FROM engine_pool_history WHERE verified=1').get().n, 1000)
    await engine.start()
    await engine.catchup.membership
    writeFileSync(join(dir, 'testnet.json'), JSON.stringify({ at, bootstrap: net.bootstrap, root: transport.publicKey }))
    console.log('Local testnet ready')
    await new Promise(done => { process.once('SIGINT', done); process.once('SIGTERM', done) })
    console.log(JSON.stringify({ responderMs: summary(replies), responderCpuMs: summary(cpuMs), frameBytes: summary(frameBytes) }))
  } finally {
    await engine.stop()
    await transport.close()
    store.close()
    await net.destroy()
  }
}

async function measure() {
  assert.ok(['off','on','mixed-off','mixed-on'].includes(mode))
  const enabled = mode.endsWith('on')
  const { at, bootstrap, root } = JSON.parse(readFileSync(join(dir, 'testnet.json')))
  const ledger = poolLedger(bundle, at), seconds = Number(duration), tickerTimes = []
  const dataDir = mkdtempSync(join(dir, 'receiver-'))
  const app = await createGator({ dataDir, port: 0, signals: false, release: { dir: join(dir, 'release'), rootKey: root },
    transport: opts => new SwarmTransport({ ...opts, bootstrap, blindRelay: null }),
    config: { profile, patchFeed: false }, fetch(url, init) {
      if (String(url).includes('/api/v2/ticker/')) tickerTimes.push(performance.now())
      return ledger.fetch(url, init)
    } })
  try {
    const engine = app.engine
    await engine.catchup.membership
    if (!enabled) await engine.catchup.leave()
    // Same CEX and public names work in both A/B cases. Mixed runs keep all default scheduler jobs.
    if (!mode.startsWith('mixed')) engine.scheduler.backgroundJobs = new Set(['cex:bitstamp','names',CATCHUP_JOB])
    engine.scheduler.jobs.get('cex:bitstamp').interval = 2000
    const get = httpClient(dataDir, { port: app.port })
    const count = () => app.store.reader.prepare('SELECT count(*) n FROM pools').get().n
    const deadline = Date.now() + 180_000
    for (;;) {
      const ready = (!enabled || count() > 0) && app.store.getPrice('bitcoin:native') && app.transport.peerCount()
      if (ready) break
      if (Date.now() >= deadline) throw new Error('Timed out before first pool/price/connection')
      await delay(200)
    }
    // Warm the HTTP connection, query cache, claims channel and first book refresh.
    for (let i = 0; i < 30; i++) { await get('GET','/assets/BTC'); await delay(100) }
    const latency = [], age = [], pools = count(), initialReceipts = ledger.receipts.length
    const cpu = process.cpuUsage(), start = performance.now(), end = start + seconds * 1000
    while (performance.now() < end) {
      const t = performance.now(), detail = await get('GET','/assets/BTC')
      latency.push(performance.now() - t)
      assert.equal(detail.price, 123.1)
      const quote = engine.book.marketPrices.get('cex:bitstamp:BTC-USD')
      age.push(Math.max(0, Date.now() - quote.at))
      await delay(Math.max(1, t + 100 - performance.now()))
    }
    const used = process.cpuUsage(cpu)
    assert.ok(age.every(Number.isFinite))
    if (enabled) assert.ok(count() > pools)
    const ticks = tickerTimes.filter(t => t >= start)
    console.log(JSON.stringify({ mode, seconds, profile: app.config.profile, rpm: engine.budget.limit,
      apiMs: summary(latency), priceAgeMs: summary(age), pollGapMs: summary(ticks.slice(1).map((t,i) => t - ticks[i])),
      cpuPercent: +((used.user + used.system) /
        ((performance.now() - start) * 10)).toFixed(2), newPools: count() - pools,
      receipts: ledger.receipts.length - initialReceipts }))
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }) }
}

async function responderCost() {
  const ledger = poolLedger(bundle, Date.now() - 60_000), hub = createMemoryHub()
  const transport = new MemoryTransport({ hub }), client = new MemoryTransport({ hub })
  let now = Date.now(), last
  const store = openStore({ file: ':memory:', migrations })
  const engine = new Engine({ bundle, transport, store, clock: () => now, backgroundJobs: [], rpcConfig: { fetch: ledger.fetch,
    sleep: async ms => { now += ms } } })
  try {
    await ledger.seed(engine, 1000)
    await Promise.all([transport.join(POOL_CHANNEL), client.join(POOL_CHANNEL)])
    transport.on('message', (_, env) => { last = env })
    const times = [], cpus = [], sizes = []
    let before = null
    for (let i = 0; i < 500; i++) {
      now += 6000
      const req = { t: 'get', v: 1, to: transport.publicKey, id: randomBytes(12).toString('hex'), until: now, before }
      const start = performance.now(), cpu = process.cpuUsage()
      engine.catchup.serve(client.publicKey, req, now)
      times.push(performance.now() - start)
      const diff = process.cpuUsage(cpu)
      cpus.push((diff.user + diff.system) / 1000)
      assert.equal(last.message.id, req.id)
      assert.equal(last.pow.difficulty, 10)
      assert.equal(last.message.rows.length, 8)
      sizes.push(Buffer.byteLength(JSON.stringify(last)) + 3)
      const row = last.message.rows.at(-1)
      before = last.message.more ? [row.at,row.chain,row.pool] : null
      await new Promise(resolve => setImmediate(resolve))
    }
    console.log(JSON.stringify({ responderMs: summary(times), cpuMs: summary(cpus), signedFrameBytes: summary(sizes) }))
  } finally { await Promise.all([transport.close(), client.close()]); store.close() }
}

if (role === 'serve') await serve()
else if (role === 'measure') await measure()
else if (role === 'cost') await responderCost()
else throw new Error('Specify serve, measure or cost')
