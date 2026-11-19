import test from 'node:test'
import assert from 'node:assert/strict'
import { address, decodeEvent, decodeAggregate, encodeAggregate, swapValue, word } from '../src/sources/evm-abi.js'
import { EvmSource } from '../src/sources/evm.js'
import { Registry } from '../src/registry/index.js'
import { migrations } from '../src/schema.js'
import { openStore } from './store-fixture.js'

const addr = (n) => '0x' + n.toString(16).padStart(40, '0')
const topic = (n) => '0x' + word(n)
const data = (...ns) => '0x' + ns.map((n) => word(BigInt.asUintN(256, BigInt(n)))).join('')
const log = (topics, payload, emitter = addr(1)) => ({
  address: emitter,
  topics,
  data: payload,
  blockNumber: '0x12',
  logIndex: '0x0',
  transactionHash: topic(21),
})
const pair = [addr(11), addr(12)]
const swapCases = [
  ['Swap(address,uint256,uint256,uint256,uint256,address)', [topic(2), topic(3), topic(4)], data(2e6, 0, 0, 4e6)],
  ['Swap(address,address,uint256,uint256,uint256,uint256)', [topic(2), topic(3), topic(4)], data(0, 4e6, 2e6, 0)],
  [
    'Swap(address,address,int256,int256,uint160,uint128,int24)',
    [topic(2), topic(3), topic(4)],
    data(-2e6, 4e6, 2n ** 97n, 10, 0),
  ],
  [
    'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)',
    [topic(2), topic(13), topic(4)],
    data(2e6, -4e6, 2n ** 97n, 10, 0, 1),
  ],
  ['Swap(bytes32,address,address,uint256,uint256)', [topic(2), topic(13), topic(12), topic(11)], data(4e6, 2e6)],
]
test('V2, Solidly, V3, V4 and Balancer swaps retain pool identity, direction and decimals', () => {
  for (const [i, [signature, topics, payload]] of swapCases.entries()) {
    const swap = decodeEvent(log(topics, payload), signature)
    const result = swapValue(swap, { token0: pair[0], token1: pair[1] }, 6, 6, false)
    assert.equal(result.price, i === 2 || i === 3 ? 4 : 2)
    assert.equal(result.baseVolume, 2)
    assert.equal(swap.pool, i >= 3 ? topic(13) : addr(1))
    assert.equal(swapValue(swap, { token0: pair[0], token1: pair[1] }, 6, 6, true).price, 1 / result.price)
  }
  assert.equal(decodeEvent(log([topic(1)], '0x01'), swapCases[0][0]), null)
  assert.equal(address('0x1234'), null)
})

test('aggregate3 nested offsets encode arbitrary calldata and decode partial reverts', () => {
  const call = { to: addr(10), data: '0x313ce567' }
  assert.equal(
    encodeAggregate([call]),
    '0x82ad56cb' + [32, 1, 32, 10, 1, 96, 4].map(word).join('') + '313ce567'.padEnd(64, '0')
  )
  const response = data(32, 2, 64, 192, 1, 64, 32, 6, 0, 64, 0)
  assert.deepEqual(decodeAggregate(response, 2), [topic(6), null])
  assert.throws(() => decodeAggregate(response.slice(0, -64), 2))
})

test('EVM cursor and pending swaps survive restart; confirmed factory discovery precedes a priced swap', async (t) => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const topicCreate = topic(1),
    topicSwap = topic(2),
    now = 1740000000000
  const d = { address: addr(1), name: 'fixture', kind: 'v2', topics: [topicCreate, topicSwap] }
  const chain = {
    id: 'eth',
    range: 20,
    family: 'evm',
    quotes: [pair[1]],
    deployments: [d],
    events: {
      [topicCreate]: {
        topic: topicCreate,
        signature: 'PairCreated(address,address,address,uint256)',
        emitter: 'factory',
      },
      [topicSwap]: { topic: topicSwap, signature: swapCases[0][0], emitter: 'pool' },
    },
  }
  const assets = pair.map((address, i) => ({
    id: 'eth:' + address,
    symbol: 'T' + i,
    name: 'T' + i,
    address,
    decimals: 6,
  }))
  const registry = new Registry(store, { chains: [chain], assets, exchanges: [] })
  const seen = [],
    output = [],
    requests = []
  const rpc = {
    async call(c, method, [params]) {
      requests.push(method)
      if (method === 'eth_getBlockByNumber')
        return { number: params === 'latest' ? '0x14' : '0x12', timestamp: '0x' + (now / 1000).toString(16) }
      assert.equal(params.fromBlock, '0x12')
      if (params.topics[0].includes(topicSwap)) {
        assert.deepEqual(params, { address: [addr(33)], topics: [[topicSwap]], fromBlock: '0x12', toBlock: '0x12' })
        return [{ ...log([topicSwap, topic(3), topic(4)], swapCases[0][2], addr(33)), logIndex: '0x1' }]
      }
      assert.deepEqual(params.address, [d.address])
      assert.deepEqual(params.topics, [[topicCreate]])
      return [
        log([topicCreate, topic(11), topic(12)], data(33, 1)),
        { ...log([topicSwap, topic(3), topic(4)], swapCases[0][2], addr(33)), logIndex: '0x1' },
        log([topicCreate, topic(11), topic(12)], data(34, 1), addr(99)),
      ]
    },
  }
  const options = {
    chain,
    rpc,
    registry,
    store,
    clock: () => now,
    publish: (rows) => output.push(...rows),
    discover: (p) => seen.push(p),
  }
  await new EvmSource(options).logs()
  const second = new EvmSource(options)
  await second.state()
  await second.logs()
  await second.trades()
  const third = new EvmSource(options)
  await third.state()
  await third.trades()
  assert.equal(requests.filter((x) => x === 'eth_getLogs').length, 2)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].pool, addr(33))
  assert.deepEqual(output, [['dex:eth:' + addr(33), '2', '2', null, null, null, now]])
})

test('a V4 swap from a preexisting manager pool recovers its Initialize log and replays with the right currencies', async (t) => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const now = 1740000000000,
    manager = addr(93),
    id = topic(440),
    init = topic(10),
    swap = topic(11)
  const chain = {
    id: 'eth',
    family: 'evm',
    range: 10,
    quotes: [pair[1]],
    deployments: [{ address: manager, name: 'uni-v4', kind: 'v4', topics: [init, swap] }],
    events: {
      [init]: {
        topic: init,
        signature: 'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)',
        emitter: 'manager',
      },
      [swap]: { topic: swap, signature: swapCases[3][0], emitter: 'manager' },
    },
  }
  const assets = pair.map((address, i) => ({
    id: 'eth:' + address,
    address,
    symbol: 'T' + i,
    name: 'T' + i,
    decimals: 6,
  }))
  const registry = new Registry(store, { assets, chains: [chain], exchanges: [] }),
    seen = [],
    prices = []
  const rpc = {
    async call(_, method, args) {
      if (method === 'eth_getBlockByNumber') return { number: args[0], timestamp: '0x' + (now / 1000).toString(16) }
      assert.deepEqual(args[0].topics, [init, id])
      return [
        { ...log([init, id, topic(11), topic(12)], data(1, 2, 0, 2n ** 96n, 0), manager), blockNumber: '0x9' },
      ]
    },
  }
  const src = new EvmSource({
    chain,
    store,
    rpc,
    registry,
    clock: () => now,
    discover: (p) => seen.push(p),
    publish: (r) => prices.push(...r),
  })
  src.enqueue.run('eth', 18, 0, JSON.stringify(log([swap, id, topic(5)], swapCases[3][2], manager)))
  await src.state()
  assert.equal(prices.length, 0)
  await src.lookupV4()
  await src.state()
  await src.state()
  assert.equal(seen[0].pool, id)
  assert.deepEqual(prices, [['dex:eth:' + id, '4', '2', null, null, null, now]])
})
