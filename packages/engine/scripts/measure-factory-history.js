// Read-only census. Run from the project root. JSON lines go to stdout so interrupted surveys are usable.
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { loadBundle } from '@gator/bundle'
import { adaptBundle } from '../src/sources/bundle-adapter.js'
import { multiRead, STATE_KINDS, field } from '../src/sources/evm-abi.js'
import { RpcClient } from '../src/rpc/index.js'
import { RequestBudget, RateLimited } from '../src/scheduler/index.js'

const catalog = adaptBundle(loadBundle())
const budget = new RequestBudget('normal', 24)
const chains = catalog.chains.filter(c => c.deployments.some(d => STATE_KINDS.includes(d.kind)))
const rpc = new RpcClient({ endpoints: Object.fromEntries(chains.map(c => [c.id, c.endpoints])),
  budget, retries: 1, timeout: 6_000 })
const print = row => console.log(JSON.stringify(row))
const hex = n => '0x' + n.toString(16)
const numeric = data => field(data, 0) === null || !Number.isSafeInteger(Number(data)) ? null : Number(data)
const samples = Number(process.argv[2] ?? 16)
const previous = process.argv[3] ? readFileSync(process.argv[3],'utf8').trim().split('\n').map(JSON.parse) : []
const inventory = new Map(previous.filter(r => r.type === 'inventory').map(r => [r.chain,r]))
const done = new Set(previous.filter(r => r.type === 'sample').map(r => r.chain + '/' + r.stratum))
async function retry(fn) {
  for (let attempts = 0; attempts < 3;) {
    try { return await fn() } catch (error) {
      if (error instanceof RateLimited && error.retryAt < Date.now() + 61_000) {
        await delay(Math.max(100, error.retryAt - Date.now()))
      } else if (++attempts === 3 || error instanceof RateLimited) throw error
    }
  }
}
async function measure(c) {
  const deployments = c.deployments.filter(d => STATE_KINDS.includes(d.kind))
  const header = await retry(() => rpc.call(c.id, 'eth_blockNumber'))
  const head = Number(header) - 64
  if (!Number.isSafeInteger(head) || head < 0) throw new Error('invalid head')
  const selectors = ['0x574f2ba3', '0xefde4e64']
  const result = await retry(() => multiRead(rpc, c, deployments.flatMap(d => selectors.map(data => ({ to: d.address, data }))), hex(head)))
  const factories = deployments.map((d, i) => ({ address: d.address, name: d.name, kind: d.kind,
    pairs: numeric(result[2*i]), pools: numeric(result[2*i+1]) }))
  inventory.set(c.id, { head, factories })
  print({ type: 'inventory', chain: c.id, head, factories })
}
async function sample(c, stratum) {
  const { head, factories } = inventory.get(c.id)
  const logFactories = factories.filter(f => f.pairs == null && f.pools == null)
  if (!logFactories.length) return
  const topics = Object.values(c.events).filter(e => e.emitter === 'factory' || e.signature.startsWith('Initialize('))
    .filter(e => c.deployments.some(d => logFactories.some(f => f.address === d.address) && d.topics.includes(e.topic)))
    .map(e => e.topic)
  const span = Math.min(previous.length ? 128 : 2048, Math.max(...rpc.chains.get(c.id).filter(e => e.logs !== false &&
    !(e.refusedMethods.get('eth_getLogs') > Date.now())).map(e => e.range ?? Infinity)))
  const width = Math.floor((head + 1) / samples)
  // A repeatable pseudo-random offset in each equal-length stratum of the chain's lifetime.
  const r = ((Math.imul(stratum + 1, 0x9e3779b1) ^ Math.imul(c.number, 0x85ebca6b)) >>> 0) / 2**32
  const start = width * stratum + Math.floor(r * Math.max(1, width - span))
  const end = Math.min(start + span - 1, head)
  const filter = { address: logFactories.map(d => d.address), topics: [topics], fromBlock: hex(start), toBlock: hex(end) }
  const logs = await retry(() => rpc.call(c.id, 'eth_getLogs', [filter]))
  if (!Array.isArray(logs)) throw new Error('invalid logs')
  const counts = {}
  for (const log of logs) {
    if (log.removed || !filter.address.includes(log.address?.toLowerCase()) || !topics.includes(log.topics?.[0])) continue
    const address = log.address.toLowerCase()
    counts[address] = (counts[address] ?? 0) + 1
  }
  print({ type: 'sample', chain: c.id, stratum, start, end, counts })
}
async function bounded(items, fn) {
  const jobs = items.values()
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (const item of jobs) {
      try { await fn(item) } catch (error) { print({ type: 'unavailable', chain: item.id, reason: error.kind ?? error.message }) }
    }
  }))
}
await bounded(chains.filter(c => !inventory.has(c.id)), measure)
for (let i = 0; i < samples; i++) await bounded(chains.filter(c => inventory.has(c.id) && !done.has(c.id + '/' + i)), c => sample(c, i))
print({ type: 'end', dispatches: budget.dispatches })
