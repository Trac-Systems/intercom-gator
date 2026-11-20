import { loadBundle } from '@gator/bundle'
import { createMemoryHub, MemoryTransport } from '@gator/net'
import { Engine, migrations } from '../src/index.js'
import { word } from '../src/sources/evm-abi.js'
import { openStore } from './store-fixture.js'

const matchTopic = (want, have) => want == null || (Array.isArray(want) ? want.includes(have) : want === have)
const span = filter => [Number(filter.fromBlock), Number(filter.toBlock)]
const shape = filter => JSON.stringify([filter.address, filter.topics])

/** Replays recorded public reads in the order they were recorded, whichever endpoint the replayed node picks (its
 * rotation can differ). An eth_getLogs window that the recording covered for the same filter, but asked from a
 * slightly different head, is answered from the recorded logs. Any other unrecorded read fails at once. */
export function replay(records) {
  const byKey = new Map(), covered = new Map(), logs = new Map()
  for (const r of records) {
    const key = r.method + ' ' + JSON.stringify(r.params)
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(r)
    if (r.method === 'eth_getLogs' && Array.isArray(r.result)) {
      const s = shape(r.params[0])
      if (!covered.has(s)) covered.set(s, [])
      covered.get(s).push(span(r.params[0]))
      for (const log of r.result) logs.set(log.transactionHash + ':' + log.logIndex, log)
    }
  }
  const coveredBy = filter => {
    let [from, to] = span(filter)
    for (const [a, b] of (covered.get(shape(filter)) ?? []).sort((x, y) => y[1] - x[1]))
      if (a <= from && b >= to) return true
      else if (b >= to - 16 && a <= to) to = a - 1 // windows walk from a head read a few blocks apart
    return to < from + 16
  }
  const used = new Map()
  return async (url, init) => {
    if (!init?.body) return new Response('{}', { status: 503 })
    const req = JSON.parse(init.body), list = Array.isArray(req) ? req : [req]
    const out = list.map(r => {
      const key = r.method + ' ' + JSON.stringify(r.params)
      const hits = byKey.get(key)
      if (!hits && r.method === 'eth_getLogs' && coveredBy(r.params[0])) {
        const [from, to] = span(r.params[0])
        const result = [...logs.values()].filter(log => Number(log.blockNumber) >= from && Number(log.blockNumber) <= to &&
          [r.params[0].address].flat().map(a => a.toLowerCase()).includes(log.address.toLowerCase()) &&
          (r.params[0].topics ?? []).every((want, i) => matchTopic(want, log.topics[i])))
        return { jsonrpc: '2.0', id: r.id, result }
      }
      if (!hits) {
        if (process.env.REPLAY_DEBUG) console.log('UNRECORDED', r.method, JSON.stringify(r.params).slice(0, 300))
        return { jsonrpc: '2.0', id: r.id, error: { code: -32000, message: 'not recorded' } }
      }
      const n = used.get(key) ?? 0
      used.set(key, n + 1)
      const hit = hits[Math.min(n, hits.length - 1)]
      return hit.error ? { jsonrpc: '2.0', id: r.id, error: hit.error } : { jsonrpc: '2.0', id: r.id, result: hit.result }
    })
    return Response.json(Array.isArray(req) ? out : out[0])
  }
}

/** One node replaying `fetch`. `Engine`/`migrations`/`bundle` select another release (the archived v0.1.0). */
export async function engineWith(fetch, { at = Date.parse('2026-11-20T00:20:00Z'), Engine: Node = Engine,
  migrations: schema = migrations, bundle: signed = loadBundle(), backgroundJobs = [] } = {}) {
  // Real time keeps flowing (the RPC client's short in-call waits use it); the add's patient waits fast-forward.
  let offset = at - Date.now()
  const now = () => Date.now() + offset
  const store = openStore({ file: ':memory:', migrations: schema, profile: 'normal' })
  // Offline replay: lift the public endpoints' documented rate limits so the test does not wait on buckets.
  const bundle = structuredClone(signed)
  for (const chain of bundle.chains) for (const e of chain.endpoints) e.limits = '6000/minute'
  const engine = new Node({ store, transport: new MemoryTransport({ hub: createMemoryHub() }), bundle,
    clock: now, backgroundJobs, patches: { patchFeed: false },
    // Endpoint cooldowns and bucket waits fast-forward the clock instead of sleeping.
    rpcConfig: { fetch, retries: 0, sleep: async ms => { offset += ms } } })
  engine.addTokenSleep = async ms => { offset += ms }
  const sent = []
  engine.transport.send = (channel, message) => { sent.push([channel, message]); return true }
  await engine.start()
  clearTimeout(engine.timer)
  return { engine, store, sent, advance: ms => { offset += ms }, clock: now }
}

// Multicall3 aggregate3 answer where every call fails (a contract without the ERC-20 interface).
export function failedAggregate(data) {
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
export function contractWithoutErc20(calls = { n: 0 }) {
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

