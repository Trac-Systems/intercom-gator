import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { bundleDigest, loadBundle } from '@gator/bundle'
import { MemoryTransport } from '@gator/net'
import { openStore } from '@gator/store'
import { Engine, migrations } from '../src/index.js'
import { BUDGETS, RateLimited } from '../src/scheduler/index.js'

const exchanges = ['bitstamp', 'bitfinex', 'bitvavo', 'kucoin', 'okx']
const chains = ['ethereum', 'base']
const backgroundJobs = [...exchanges.map(id => 'cex:' + id),
  ...chains.flatMap(id => ['evm:' + id + ':logs', 'evm:' + id + ':state'])]
const bundle = loadBundle()
const dir = await mkdtemp(fileURLToPath(new URL('./.smoke-', import.meta.url)))
const requests = {}, upstreamErrors = {}, jobErrors = {}, completed = {}
const dispatchTimes = []
let peak = 0, total = 0, budgetBlocked = 0
const increment = (counts, key) => { counts[key] = (counts[key] ?? 0) + 1 }

async function measuredFetch(url, init) {
  const now = performance.now()
  while (dispatchTimes.length && dispatchTimes[0] <= now - 60000) dispatchTimes.shift()
  if (dispatchTimes.length >= BUDGETS.small) {
    budgetBlocked++
    throw new Error('Small request ceiling reached before dispatch')
  }
  const host = new URL(url).host
  increment(requests, host)
  dispatchTimes.push(now)
  peak = Math.max(peak, dispatchTimes.length)
  total++
  let response
  try {
    response = await fetch(url, init)
  } catch (err) {
    if (!stop.signal.aborted) increment(upstreamErrors, host + ' ' + (err.cause?.code ?? err.name))
    throw err
  }
  if (!response.ok) increment(upstreamErrors, host + ' HTTP ' + response.status)
  return response
}

const stop = new AbortController()
const interrupt = () => stop.abort()
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
let store, transport, engine
try {
  store = openStore({ file: join(dir, 'smoke.db'), migrations, profile: 'small' })
  transport = new MemoryTransport({ skipPow: true })
  engine = new Engine({ store, transport, bundle, profile: 'small', backgroundJobs, random: 42,
    rpcConfig: { fetch: measuredFetch, retries: 1 } })
  for (const id of backgroundJobs) {
    const job = engine.scheduler.jobs.get(id)
    const run = job.run
    // Keep a light cadence while letting both RPC jobs process their durable queues.
    job.interval = Math.max(job.interval, id.startsWith('cex:') ? 45_000 : 15_000)
    job.run = async () => {
      try {
        await run()
        increment(completed, id)
      } catch (error) {
        if (!(error instanceof RateLimited) && !stop.signal.aborted) increment(jobErrors, id + ' ' + error.message)
        throw error
      }
    }
  }
  const start = Date.now()
  await engine.start()
  console.log('Sampling five public ticker feeds and Ethereum/Base logs for five minutes.')
  await delay(300_000, undefined, { signal: stop.signal }).catch(error => {
    if (error.name !== 'AbortError') throw error
  })
  const interrupted = stop.signal.aborted
  stop.abort()
  await engine.stop()
  engine.book.refresh()
  const db = store.reader
  const trust = { green: 0, yellow: 0, red: 0 }
  for (const row of db.prepare('SELECT trust, count(*) AS n FROM prices GROUP BY trust').all()) trust[row.trust] = row.n
  const marketsByExchange = Object.fromEntries(exchanges.map(id => [id,
    db.prepare("SELECT count(*) AS n FROM markets WHERE kind='cex' AND exchange=?").get(id).n]))
  const logScans = Object.fromEntries(chains.map(id => [id, {
    throughBlock: engine.evm.get(id).cursor.get(id)?.block ?? null,
    pendingLogs: engine.evm.get(id).queueSize.get(id).n,
    markets: db.prepare("SELECT count(*) AS n FROM markets WHERE kind='dex' AND chain=?").get(id).n,
  }]))
  console.log(JSON.stringify({
    startedAt: new Date(start).toISOString(), seconds: Math.round((Date.now() - start) / 1000), interrupted,
    bundleDigest: bundleDigest(bundle), profile: engine.profile, budgetPerMinute: engine.budget.limit,
    assetsPriced: db.prepare('SELECT count(*) AS n FROM prices').get().n,
    markets: engine.registry.markets.size, marketsByExchange, trust, logScans,
    totalRequests: total, requestsPerHost: requests, peakRequestsIn60s: peak, budgetBlocked,
    completedJobs: completed, upstreamErrors, jobErrors,
  }, null, 2))
  if (interrupted || budgetBlocked || !Object.values(marketsByExchange).every(Boolean) ||
      !Object.values(logScans).every(scan => scan.throughBlock !== null)) process.exitCode = 1
} finally {
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', interrupt)
  try {
    await engine?.stop()
  } finally {
    try { await transport?.close() } finally {
      store?.close()
      await rm(dir, { recursive: true, force: true })
    }
  }
}
