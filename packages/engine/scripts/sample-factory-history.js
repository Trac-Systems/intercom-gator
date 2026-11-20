// Isolated public-RPC replay of historical ranges. No P2P, persistent keys, owner store or token input.
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { appendFileSync } from 'node:fs'
import { loadBundle } from '@gator/bundle'
import { openStore } from '@gator/store'
import { Engine, migrations } from '../src/index.js'
import { nativeRate } from './factory-survey-usd.js'
import { RateLimited } from '../src/scheduler/index.js'
import { PAGE_SIZE } from '../src/coverage/factory-history.js'

const duration = Number(process.argv[2] ?? 22) * 60_000
const print = row => console.log(JSON.stringify(row))
const started = Date.now(), store = openStore({ file: ':memory:', migrations, profile: 'normal' })
const transport = Object.assign(new EventEmitter(), { publicKey: '1'.repeat(64), send: () => true })
const dispatches = []
let label, record
const counted = async (url, options) => {
  const request = JSON.parse(options.body)
  const t = Date.now()
  dispatches.push(t)
  const response = await fetch(url, options)
  if (record) {
    const data = await response.clone().json().catch(() => ({}))
    if (data.result !== undefined) appendFileSync(record, JSON.stringify({ label, method: request.method, params: request.params, result: data.result }) + '\n')
  }
  return response
}
const engine = new Engine({ bundle: loadBundle(), store, transport, backgroundJobs: [], patches: { patchFeed: false },
  rpcConfig: { fetch: counted, retries: 0 } })
const history = engine.backfill
for (const chain of ['ethereum','polygon','base']) {
  for (let i = 0; i < 8; i++) {
    try { print(await nativeRate(engine,engine.evm.get(chain))); break } catch (e) {
      print({ type: 'native-retry', chain, reason: e.kind ?? e.message })
      await delay(Math.min(10_000, Math.max(1000,(e.retryAt ?? 0) - Date.now())))
    }
  }
}
const entry = (chain, dex) => history.tasks.find(t => t.source.chain.id === chain && t.factory.name === dex)
const eth = entry('ethereum','uniswap-v4'), polygon = entry('polygon','uniswap-v2'), base = entry('base','uniswap-v2')
const entries = [eth, polygon, base]
const pending = [], floors = {}, seen = new Set()
let seed = 20261120
function random() { seed = (Math.imul(seed,1664525) + 1013904223) >>> 0; return seed / 2**32 }
const cursor = (start, size) => ({ start, end: start + size, next: start, after: -1, span: size })
for (const task of entries) {
  while (!task.bounds) {
    try { await history.bounds(task) } catch (error) {
      if (!(error instanceof RateLimited)) throw error
      await delay(Math.max(50, error.retryAt - Date.now()))
    }
  }
}
for (const block of [23_467_351, 23_747_800]) {
  const start = Math.floor(block / 2048) * 2048
  pending.push({ task: { ...eth }, range: cursor(start, 2048), sample: 'historical-' + start, at: 0 })
}
function pushRandom(task) {
  const { mode, end } = task.bounds, size = mode === 'index' ? PAGE_SIZE : 2048
  const start = Math.floor(random() * Math.max(1, Math.floor(end / size))) * size
  pending.push({ task: { ...task }, range: cursor(start, Math.min(end - start, size)), sample: 'uniform-' + start, at: 0 })
}
for (const task of entries) pushRandom(task)
while (Date.now() - started < duration) {
  const now = Date.now(), limit = history.budget.retryAt()
  if (limit) { await delay(Math.min(1000, Math.max(1, limit - now))); continue }
  const job = pending.find(p => p.at <= now)
  if (!job) { await delay(250); continue }
  const { task, range, sample } = job
  const chain = task.source.chain.id
  label = chain + '/' + sample
  record = process.argv[3] && (sample.startsWith('historical') || !floors[chain]) ? process.argv[3] : null
  try {
    const page = await history.page(task, range)
    if (page) {
      const rows = []
      const bins = floors[chain] ??= [0,0,0,0,0]
      for (const [i,p] of page.pools.entries()) {
        const key = chain + ':' + p.pool
        if (seen.has(key)) continue
        seen.add(key)
        const d = page.states[i]?.liquidity
        bins[0]++
        if (Number.isFinite(d)) bins[1]++
        for (const [i,floor] of [100,1000,10000].entries()) if (d >= floor) bins[i+2]++
        if (d >= 100) rows.push([p.pool,p.token0,p.token1,Math.round(d),p.block])
      }
      print({ type: 'page', chain, sample, checked: page.pools.length, rows, bins: [...bins], calls: dispatches.length })
    }
    if (range.next >= range.end) {
      pending.splice(pending.indexOf(job), 1)
      if (sample.startsWith('uniform')) pushRandom(entries.find(t => t.source.chain.id === chain))
    }
  } catch (error) {
    job.at = error instanceof RateLimited ? error.retryAt : Date.now() + 10_000
    if (!(error instanceof RateLimited)) print({ type: 'retry', chain, sample, reason: error.kind ?? error.message })
  }
}
let peak = 0, first = 0
for (const [i,t] of dispatches.entries()) {
  while (dispatches[first] <= t - 60_000) first++
  peak = Math.max(peak, i - first + 1)
}
print({ type: 'end', minutes: (Date.now() - started)/60_000, calls: dispatches.length, peak, floors })
store.close()
