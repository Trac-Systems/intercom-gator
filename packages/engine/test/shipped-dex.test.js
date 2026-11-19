import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBundle } from '@gator/bundle'
import { openStore } from '@gator/store'
import { migrations } from '../src/schema.js'
import { adaptBundle } from '../src/sources/bundle-adapter.js'
import { decodeEvent, word } from '../src/sources/evm-abi.js'
import { EvmSource } from '../src/sources/evm.js'
import { resolveCurveCreations } from '../src/sources/curve.js'
import { Registry } from '../src/registry/index.js'

const bundle = loadBundle(), catalog = adaptBundle(bundle)
const addr = n => '0x' + word(n).slice(-40)
const data = (...ns) => '0x' + ns.map(n => word(BigInt.asUintN(256, BigInt(n)))).join('')
const eventFor = (chain, id) => chain.events[bundle.dex.events.find(e => e.id === id).topic0]

test('every shipped swap and creation layout decodes its declared indexed and data words', () => {
  // Distinct values for addresses, booleans and tick spacing catch a misplaced pool word.
  const cases = {
    'v2-pair': [[11, 12], [99, 1]],
    'v3-pool': [[11, 12, 3000], [60, 99]],
    'velo-pool': [[11, 12, 1], [99, 1]],
    'solidly-pair': [[11, 12], [1, 99, 1]],
    'slipstream-pool': [[11, 12, 100], [99]],
    'v4-init': [[99, 11, 12], [3000, 60, 0, 1n << 96n, 0]],
    'curve-plain': [[], [11, 12, 0, 0, 100, 500, 1]],
    'v2-swap': [[1, 2], [5, 0, 0, 8]],
    'velo-swap': [[1, 2], [5, 0, 0, 8]],
    'v3-swap': [[1, 2], [5, -8, 1n << 96n, 20, 0]],
    'pancake-swap': [[1, 2], [5, -8, 1n << 96n, 20, 0, 0, 0]],
    'v4-swap': [[99, 1], [5, -8, 1n << 96n, 20, 0, 3000]],
    'balancer-swap': [[99, 11, 12], [5, 8]],
    'curve-swap': [[1], [1, 8, 0, 5]],
  }
  for (const { id, topic0 } of bundle.dex.events.filter(e => !e.signature.startsWith('Sync('))) {
    const event = catalog.chains.map(c => c.events[topic0]).find(Boolean)
    const [indexed, payload] = cases[id]
    const log = { address: addr(99), topics: [topic0, ...indexed.map(n => data(n))], data: data(...payload) }
    const decoded = decodeEvent(log, event)
    assert.ok(decoded, id)
    if (decoded.type === 'curve-deployment') assert.deepEqual(decoded.coins, [addr(11), addr(12)])
    else if (decoded.type === 'pool') assert.deepEqual([decoded.token0, decoded.token1], [addr(11), addr(12)])
    else assert.deepEqual([decoded.amount0, decoded.amount1], [5n, 8n])
    if (decoded.pool) assert.equal(decoded.pool, ['manager', 'vault'].includes(event.emitter) ? data(99) : addr(99), id)
    assert.equal(decodeEvent({ ...log, data: log.data + word(0) }, event), null)
  }
})

test('Solidly and Slipstream spot pool lookup uses the corresponding three-argument factory method', async (t) => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  for (const [chainId, kind, id, selector, argument] of [
    ['fantom', 'solidly-v1', 'v2-swap', '0x6801cc30', 1],
    ['base', 'slipstream', 'v3-swap', '0x28af8d0b', 100],
  ]) {
    const chain = catalog.chains.find(c => c.id === chainId)
    const deployment = chain.deployments.find(d => d.kind === kind)
    const source = new EvmSource({ chain, store })
    let verified = false
    source.read = async calls => calls.map(({ to, data: input }) => {
      if (to === deployment.address) {
        assert.equal(input, selector + word(11) + word(12) + word(argument))
        verified = true
        return data(99)
      }
      return { '0x0dfe1681': data(11), '0xd21220a7': data(12), '0xc45a0155': data(deployment.address),
        '0x22be3de1': data(1), '0xd0c93a7c': data(100) }[input] ?? null
    })
    const result = await source.identify([{ swap: { pool: addr(99) }, event: eventFor(chain, id) }], 20)
    assert.equal(verified, true)
    assert.equal(result[0].kind, kind)
    assert.equal(result[0].pool, addr(99))
  }
})

test('Curve plain creations and preexisting swaps resolve through the factory at the scanned block', async (t) => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const chain = catalog.chains.find(c => c.id === 'ethereum')
  const deployment = chain.deployments.find(d => d.kind === 'curve-plain')
  const registry = new Registry(store, catalog), rows = [], pools = []
  const now = 1740000000000
  const source = new EvmSource({ chain, registry, store, clock: () => now,
    publish: observations => rows.push(...observations), discover: pool => pools.push(pool.pool),
    rpc: { call: async () => ({ number: '0x14', timestamp: '0x' + (now / 1000).toString(16) }) } })
  const first = addr(11), second = addr(12)
  const coins = data(11, 12, 0, 0)
  source.read = async (calls, block) => calls.map(({ to, data: input }) => {
    if (input === '0x313ce567') return data(6)
    assert.equal(to, deployment.address)
    if (input === '0x956aae3a') return data(block === 20 ? 5 : 4)
    if (input === '0x3a1d5d8e' + word(4)) return data(99)
    if ([99, 98].some(n => input === '0x9ac90d3d' + word(n))) return coins
    if (input === '0x9ac90d3d' + word(97)) return data(0, 0, 0, 0)
    assert.fail(input)
  })
  function enqueue(id, address, index, topics, payload) {
    const log = { address, logIndex: '0x' + index.toString(16), blockNumber: '0x14', transactionHash: data(1),
      topics: [eventFor(chain, id).topic, ...topics], data: payload }
    source.enqueue.run('ethereum', 20, index, JSON.stringify(log))
  }
  enqueue('curve-plain', deployment.address, 0, [], data(first, second, 0, 0, 100, 500, 2))
  for (const [i, pool] of [99, 98, 97].entries()) enqueue('curve-swap', addr(pool), i + 1, [data(1)], data(1, 8e6, 0, 2e6))
  await source.state()
  assert.deepEqual(pools, [addr(99), addr(98)])
  assert.deepEqual(rows.map(r => r.slice(0, 3)), [99, 98].map(n => ['dex:ethereum:' + addr(n), '4', '2']))
})

test('a failed factory lookup or ambiguous coin list leaves the Curve creation unassigned', async () => {
  for (const unresolved of [null, data(11, 12, 0, 0)]) {
    const swap = { type: 'curve-deployment', emitter: addr(10), coins: [addr(11), addr(12)] }
    const event = { swap }
    await resolveCurveCreations([event], 20, async (calls, block) => calls.map(({ data: input }, i) => {
      if (input === '0x956aae3a') return data(block === 20 ? 6 : 4)
      if (input.startsWith('0x3a1d5d8e')) return data(i + 98)
      return i === 0 ? data(11, 12, 0, 0) : unresolved
    }))
    assert.equal(event.swap, swap)
  }
})
