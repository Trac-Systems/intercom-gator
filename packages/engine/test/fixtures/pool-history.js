import { loadBundle } from '@gator/bundle'
import { word } from '../../src/sources/evm-abi.js'

export const hash = n => '0x' + word(n)
const addr = n => '0x' + word(n).slice(-40)
export const rpcUrl = 'https://history.invalid'

export function historyBundle() {
  const bundle = structuredClone(loadBundle())
  bundle.exchanges = bundle.exchanges.filter(e => e.id === 'bitstamp')
  bundle.tokens.tokens = bundle.tokens.tokens.filter(t => ['bitcoin:native', 'ethereum:native'].includes(t.id))
  for (const t of bundle.tokens.tokens) t.links = []
  bundle.chains = bundle.chains.filter(c => ['ethereum', 'bitcoin'].includes(c.id))
  bundle.paidExtras = { ethereum: '', bitcoin: '' }
  bundle.dex.evm = bundle.dex.evm.filter(c => c.chain === 'ethereum')
  const eth = bundle.chains.find(c => c.id === 'ethereum')
  eth.endpoints = [1, 2, 3].map(i => ({ ...eth.endpoints.find(e => e.protocol === 'evm-jsonrpc'),
    url: rpcUrl + '/' + i, limits: '6000/minute' }))
  const dex = bundle.dex.evm[0]
  dex.deployments = dex.deployments.filter(d => d.name === 'Uniswap V2')
  dex.quoteTokens = dex.quoteTokens.filter(q => q.symbol === 'USDC')
  return bundle
}

// A private fixture ledger. A pool has a unique DEX-only token, a shared quote and a
// creation tx. Several creations can share one block timestamp (cursor tie coverage).
export function poolLedger(bundle, at) {
  const dex = bundle.dex.evm[0], factory = dex.deployments[0].address.toLowerCase()
  const topic = bundle.dex.events.find(e => e.signature === 'PairCreated(address,address,address,uint256)').topic0
  const block = 100, height = '0x64', blockHash = hash(99)
  const token1 = dex.quoteTokens[0].address.toLowerCase()
  const header = { number: height, hash: blockHash, timestamp: '0x' + Math.floor(at / 1000).toString(16) }
  function record(i) {
    return { chain: 'ethereum', dex: 'uniswap-v2', kind: 'v2', pool: addr(10_000 + i),
      token0: addr(100_000 + i), token1, tx: hash(i), block, firstSeen: Math.floor(at / 1000) * 1000 }
  }
  function log(i) {
    const { pool, token0, tx } = record(i)
    return { address: factory, topics: [topic, hash(token0), hash(token1)], data: hash(pool) + word(i),
      blockHash, blockNumber: height, transactionHash: tx, logIndex: '0x' + i.toString(16) }
  }
  // Answer metadata Multicall3 with locally read labels, decimals and supply.
  function aggregate(input) {
    const args = input.slice(10), start = 128, num = (pos) => Number(BigInt('0x' + args.slice(pos, pos + 64)))
    const count = num(64)
    let offset = count * 32
    const offsets = [], tuples = []
    for (let i = 0; i < count; i++) {
      const pos = start + num(start + i * 64) * 2
      const selector = args.slice(pos + 256, pos + 264)
      const value = ['06fdde03','95d89b41'].includes(selector) ? Buffer.from('LOCAL').toString('hex').padEnd(64, '0') : word(6)
      offsets.push(word(offset))
      const tuple = word(1) + word(64) + word(32) + value
      tuples.push(tuple)
      offset += tuple.length / 2
    }
    return hash(32) + word(count) + offsets.join('') + tuples.join('')
  }
  const methods = new Map(), tags = new Map(), receipts = [], missing = new Set()
  async function fetch(url, init) {
    if (!init?.body) {
      if (String(url).includes('/api/v2/ticker/')) return Response.json([{ market: 'BTC/USD', last: '123.1', volume: '100', bid: '123', ask: '124' }])
      return new Response('{}', { status: 503 })
    }
    if (new URL(url).origin !== rpcUrl) throw new Error('Unexpected fixture endpoint')
    const { id, method, params } = JSON.parse(init.body)
    methods.set(method, (methods.get(method) ?? 0) + 1)
    let result
    if (method === 'eth_getTransactionReceipt') {
      receipts.push(params[0])
      const i = Number(BigInt(params[0]))
      result = missing.has(i) ? null : { transactionHash: params[0], status: '0x1',
        blockHash, blockNumber: height, logs: [log(i)] }
    } else if (method === 'eth_getBlockByNumber') result = header
    else if (method === 'eth_call') {
      tags.set(params[1], (tags.get(params[1]) ?? 0) + 1)
      result = params[0].data.startsWith('0x82ad56cb') ? aggregate(params[0].data) : hash(6)
    }
    else if (method === 'eth_getLogs') result = []
    else throw new Error('Unexpected fixture method ' + method)
    return Response.json({ jsonrpc: '2.0', id, result })
  }
  async function seed(engine, count) {
    const src = engine.evm.get('ethereum')
    engine.store.transaction(() => {
      for (let i = 1; i <= count; i++) src.creation.run('ethereum', block, i, JSON.stringify(log(i)))
    })
    await src.state()
  }
  return { fetch, log, record, missing, seed, methods, tags, receipts }
}
