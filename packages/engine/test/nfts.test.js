import test from 'node:test'
import assert from 'node:assert/strict'
import { bundleDigest, loadBundle } from '@gator/bundle'
import { MemoryTransport } from '@gator/net'
import { keccak256 } from '../src/intel/keccak.js'
import { word } from '../src/sources/evm-abi.js'
import { PROTOCOLS, TOPICS, decodeSale, salesFromLogs, washFlag, saleFloor, percentile, NftSource, NftCollections,
  EthPrice, MIN_SALES } from '../src/nfts/index.js'
import { SourceStats, sourceState, sourcesReport } from '../src/health/sources.js'
import { Engine, migrations } from '../src/index.js'
import { openStore } from './store-fixture.js'

const addr = (n) => '0x' + n.toString(16).padStart(40, '0')
const w = (n) => word(BigInt.asUintN(256, BigInt(n)))
const tx = (n) => '0x' + n.toString(16).padStart(64, '0')
const SEAPORT = '0x0000000000000068f116a894984e2db1123eb395', BLUR = '0xb2ecfe4e4d61f8790bbb9de2d1259b9e2410cea5'
const PP = '0x9a1d00000000fc540e2000560054812452eb5366'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const E = 10n ** 18n
const SELLER = addr(0xa1), BUYER = addr(0xb2), FEE = addr(0xfe), NFT = addr(0x721), OTHER = addr(0x722)

/** ABI-encode Seaport's OrderFulfilled data: orderHash, recipient, offer[], consideration[]. */
function seaport({ offerer, recipient = 0, offer, consideration, n = 1, idx = 0, block = 100 }) {
  const head = 4 * 32, offerBytes = 32 + offer.length * 4 * 32
  const data = '0x' + w(7) + w(recipient) + w(head) + w(head + offerBytes) +
    w(offer.length) + offer.map(([t, token, id, amount]) => w(t) + w(token) + w(id) + w(amount)).join('') +
    w(consideration.length) + consideration.map(([t, token, id, amount, to]) => w(t) + w(token) + w(id) + w(amount) + w(to)).join('')
  return { address: SEAPORT, topics: [TOPICS.seaport[0], '0x' + w(offerer), '0x' + w(0)], data,
    blockNumber: '0x' + block.toString(16), logIndex: '0x' + idx.toString(16), transactionHash: tx(n) }
}
const marketplaces = new Map([[SEAPORT, { name: 'Seaport 1.6', protocol: 'seaport' }], [BLUR, { name: 'Blur', protocol: 'blur-v2' }],
  [PP, { name: 'Payment Processor', protocol: 'payment-processor-v2' }]])
const currencies = new Map([['native', { symbol: 'ETH', decimals: 18, unit: 'ETH' }], [WETH, { symbol: 'WETH', decimals: 18, unit: 'ETH' }],
  [USDC, { symbol: 'USDC', decimals: 6, unit: 'USD' }]])
const ctx = { chain: 'ethereum', marketplaces, currencies, timeOf: () => 1_000, ethUsd: () => 2000 }

test('event topics are the Keccak-256 of the documented signatures', () => {
  for (const events of Object.values(PROTOCOLS))
    for (const [signature, topic] of Object.entries(events)) assert.equal(keccak256(signature), topic)
})

test('Seaport listings, accepted offers and match orders become one priced sale each', () => {
  const listing = seaport({ offerer: SELLER, recipient: BUYER, offer: [[2, NFT, 7, 1]],
    consideration: [[0, 0, 0, 95n * E / 100n, SELLER], [0, 0, 0, 5n * E / 100n, FEE]] })
  const bid = seaport({ offerer: BUYER, recipient: SELLER, n: 2, offer: [[1, WETH, 0, 2n * E]],
    consideration: [[2, NFT, 8, 1, BUYER], [1, WETH, 0, E / 20n, FEE]] })
  // A match order: the listing side has no recipient; the mirror side names the buyer as the NFT's recipient.
  const matchA = seaport({ offerer: SELLER, n: 3, offer: [[2, NFT, 9, 1]], consideration: [[0, 0, 0, E, SELLER]] })
  const matchB = seaport({ offerer: BUYER, n: 3, idx: 1, offer: [[0, 0, 0, E]], consideration: [[2, NFT, 9, 1, BUYER]] })
  const { sales, skipped } = salesFromLogs([matchB, bid, listing, matchA], ctx)
  assert.deepEqual(skipped, { bundle: 0, currency: 0, malformed: 0 })
  const byToken = Object.fromEntries(sales.map((s) => [s.tokenId, s]))
  assert.equal(byToken[7].priceEth, 1)
  assert.equal(byToken[7].priceUsd, 2000)
  assert.deepEqual([byToken[7].seller, byToken[7].buyer, byToken[7].fees], [SELLER, BUYER, 1])
  assert.deepEqual([byToken[8].priceEth, byToken[8].seller, byToken[8].buyer, byToken[8].fees], [2, SELLER, BUYER, 1])
  assert.equal(sales.filter((s) => s.tokenId === '9').length, 1)
  assert.deepEqual([byToken[9].priceEth, byToken[9].seller, byToken[9].buyer, byToken[9].fees], [1, SELLER, BUYER, 0])
  assert.equal(byToken[7].marketplace, 'Seaport 1.6')
})

test('bundles split within one collection, cross-collection bundles and unknown currencies are skipped', () => {
  const same = seaport({ offerer: SELLER, recipient: BUYER, offer: [[2, NFT, 1, 1], [2, NFT, 2, 1]], consideration: [[0, 0, 0, 3n * E, SELLER]] })
  const mixed = seaport({ offerer: SELLER, recipient: BUYER, n: 2, offer: [[2, NFT, 3, 1], [2, OTHER, 4, 1]], consideration: [[0, 0, 0, E, SELLER]] })
  const odd = seaport({ offerer: SELLER, recipient: BUYER, n: 3, offer: [[2, NFT, 5, 1]], consideration: [[1, addr(0xdead), 0, E, SELLER]] })
  const usd = seaport({ offerer: SELLER, recipient: BUYER, n: 4, offer: [[3, OTHER, 6, 4]], consideration: [[1, USDC, 0, 1000n * 10n ** 6n, SELLER]] })
  const swap = seaport({ offerer: SELLER, recipient: BUYER, n: 5, offer: [[2, NFT, 6, 1]], consideration: [[2, OTHER, 1, 1, SELLER]] })
  const { sales, skipped } = salesFromLogs([same, mixed, odd, usd, swap], ctx)
  assert.deepEqual(skipped, { bundle: 1, currency: 1, malformed: 1 })
  assert.deepEqual(sales.filter((s) => s.collection === NFT).map((s) => [s.tokenId, s.priceEth, s.bundle]), [['1', 1.5, 2], ['2', 1.5, 2]])
  const multi = sales.find((s) => s.collection === OTHER)
  assert.deepEqual([multi.qty, multi.priceUsd, multi.priceEth, multi.unitEth, multi.currency, multi.standard],
    [4, 1000, 0.5, 0.125, 'USD', 'erc1155'])
})

test('Blur V2 packed executions and Payment Processor events decode parties, token and price', () => {
  const packed = (1n << 248n) | ((3n * E / 2n) << 160n) | BigInt(NFT)
  const blur = { address: BLUR, topics: [TOPICS['blur-v2'][0]], data: '0x' + w(1) + w((42n << 168n) | BigInt(BUYER)) + w(packed),
    blockNumber: '0x1', logIndex: '0x0', transactionHash: tx(9) }
  const fill = decodeSale(blur)
  assert.deepEqual([fill.items[0].collection, fill.items[0].tokenId, fill.payments[0].amount, fill.buyer, fill.seller],
    [NFT, '42', 3n * E / 2n, BUYER, null])
  const offer1155 = Object.values(PROTOCOLS['payment-processor-v2'])[3]
  const pp = { address: PP, topics: [offer1155, '0x' + w(SELLER), '0x' + w(BUYER), '0x' + w(OTHER)],
    data: '0x' + w(BUYER) + w(WETH) + w(5) + w(2) + w(E), blockNumber: '0x1', logIndex: '0x1', transactionHash: tx(10) }
  const { sales } = salesFromLogs([blur, pp], ctx)
  assert.deepEqual(sales.map((s) => [s.marketplace, s.tokenId, s.priceEth, s.qty, s.seller, s.buyer]),
    [['Blur', '42', 1.5, 1, null, BUYER], ['Payment Processor', '5', 1, 2, SELLER, BUYER]])
  assert.equal(decodeSale({ ...blur, data: '0x' + w(1) + w(1) + w((2n << 248n) | BigInt(NFT)) }), null)
  assert.equal(decodeSale({ ...blur, topics: [tx(1)] }), null)
})

test('wash-like trades are flagged and the sale floor is a robust low percentile of clean sales', () => {
  const at = 10 * 86_400_000
  assert.equal(washFlag({ seller: SELLER, buyer: SELLER, at }), 'self')
  const back = { seller: BUYER, buyer: SELLER, at, fees: 0 }
  assert.equal(washFlag(back, [{ seller: SELLER, buyer: BUYER, at: at - 3600_000, fees: 0 }]), 'loop')
  assert.equal(washFlag({ ...back, fees: 2 }, [{ seller: SELLER, buyer: BUYER, at: at - 3600_000, fees: 1 }]), null)
  assert.equal(washFlag(back, [{ seller: SELLER, buyer: BUYER, at: at - 2 * 86_400_000, fees: 0 }]), null)
  assert.equal(percentile([5, 1, 4, 2, 3, 6, 7, 8, 9, 10], 0.1), 1)
  assert.equal(percentile([], 0.1), null)
  const sale = (i, unitEth, flag = null, ago = i * 60_000) => ({ at: at - ago, unitEth, priceEth: unitEth, priceUsd: unitEth * 2000, flag })
  assert.equal(saleFloor([sale(1, 1), sale(2, 2)], at), null)
  const day = Array.from({ length: 30 }, (_, i) => sale(i, 1 + i / 10))
  assert.deepEqual(saleFloor([sale(0, 0.01, 'loop'), ...day], at), { eth: 1.2, usd: 2400, sales: 30 })
  // A quiet day falls back to the last 20 clean sales within a week.
  const week = Array.from({ length: 25 }, (_, i) => sale(i, 2 + i, null, (i + 1) * 3 * 3600_000))
  assert.equal(saleFloor(week, at).sales, 20)
  assert.equal(saleFloor(week, at).eth, 3)
})

function fakeRpc(head = 1000, { fail = 0 } = {}) {
  const calls = []
  return {
    calls, logs: [], fail,
    async call(chain, method, params) {
      calls.push([method, params[0]])
      if (method === 'eth_getBlockByNumber') return { number: '0x' + head.toString(16), timestamp: '0x' + (1_700_000_000).toString(16) }
      if (method === 'eth_getLogs') {
        if (this.fail > 0) { this.fail--; throw new Error('RPC request failed') }
        const from = Number(params[0].fromBlock), to = Number(params[0].toBlock)
        return this.logs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to)
      }
      if (method === 'eth_call') return '0x' + w(32) + w(4) + Buffer.from('Pics').toString('hex').padEnd(64, '0')
      throw new Error('unexpected ' + method)
    },
    async batch(chain, list) { return Promise.all(list.map((c) => this.call(chain, c.method, c.params))) },
  }
}

function source(t, rpc, now = { t: 1_700_000_000_000 }) {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const chain = { id: 'ethereum', name: 'Ethereum', family: 'evm', blockTime: 12_000, multicall: null, endpoints: [] }
  const prices = new EthPrice(store, () => now.t)
  const s = new NftSource({ chain, store, rpc, clock: () => now.t, prices, profile: 'normal',
    marketplaces: [{ address: SEAPORT, name: 'Seaport 1.6', protocol: 'seaport' }], currencies: [{ address: WETH, symbol: 'WETH', decimals: 18, unit: 'ETH' }] })
  return { store, s, now, chains: new Map([['ethereum', chain]]) }
}

test('the scanner backfills an hour, keeps a durable cursor, records gaps and halves its span on errors', async (t) => {
  const rpc = fakeRpc(1000)
  const { store, s, now, chains } = source(t, rpc)
  for (let i = 0; i < MIN_SALES; i++)
    rpc.logs.push(seaport({ offerer: SELLER, recipient: BUYER, n: 100 + i, block: 990 - i, offer: [[2, NFT, i, 1]],
      consideration: [[0, 0, 0, E, SELLER]] }))
  // Ten-minute ranges, three per run on the normal profile: the hour of backfill takes two runs.
  await s.scan()
  assert.equal(store.reader.prepare('SELECT block FROM engine_nft_scans').get().block, 698 + 150)
  await s.scan()
  const filter = rpc.calls.find((c) => c[0] === 'eth_getLogs')[1]
  assert.deepEqual(filter.address, [SEAPORT])
  assert.deepEqual(filter.topics, [TOPICS.seaport])
  assert.equal(Number(filter.fromBlock), 998 - 300 + 1)
  assert.equal(store.reader.prepare('SELECT block FROM engine_nft_scans').get().block, 998)
  assert.equal(store.reader.prepare('SELECT count(*) AS n FROM engine_nft_sales').get().n, MIN_SALES)
  // The seller's own estimate from the head timestamp: 12 s per block.
  const sale = store.reader.prepare('SELECT * FROM engine_nft_sales WHERE tokenId=?').get('0')
  assert.equal(sale.at, 1_700_000_000_000 - 10 * 12_000)
  assert.equal(sale.priceUsd, null)

  const list = new NftCollections({ store, clock: () => now.t, chains, sources: [s] })
  assert.ok(s.needsNames())
  await s.names()
  const row = list.list().items[0]
  assert.deepEqual([row.id, row.name, row.symbol, row.sales24h, row.volume24hEth, row.floor, row.floorKind, row.chainName],
    ['ethereum:' + NFT, 'Pics', 'Pics', 3, 3, 1, 'sale', 'Ethereum'])
  assert.equal(list.detail('ethereum:' + NFT).sales.length, 3)
  assert.equal(list.detail('ethereum:' + addr(5)), null)
  assert.equal(list.status().sales24h, 3)

  // Far behind after downtime: skip to the backlog limit and record the skipped range.
  rpc.calls.length = 0
  const far = fakeRpc(5000)
  s.rpc = far
  s.latest = null
  now.t += 60_000
  await s.scan()
  const gap = store.getSetting('engine-gap/ethereum/nft-sales')
  assert.deepEqual([gap.from, gap.to, gap.count], [999, 4998 - 900, 1])
  far.fail = 3
  s.latest = null
  now.t += 60_000
  const span = s.span
  await assert.rejects(s.scan())
  assert.equal(s.span, Math.floor(span / 2))
  assert.equal(s.status().lastError, 'Log request failed')
  assert.ok(s.status().requests1h >= 5)
})

test('source health states come from hourly outcome counters', () => {
  let now = 1_000_000
  const stats = new SourceStats(() => now)
  assert.equal(sourceState(stats.summary('x'), { now }), 'off')
  stats.record('x', { ok: true, latency: 100, at: now })
  assert.equal(sourceState(stats.summary('x'), { now }), 'ok')
  stats.record('x', { ok: true, latency: 9000, at: now })
  assert.equal(sourceState(stats.summary('x'), { now }), 'slow')
  for (let i = 0; i < 4; i++) stats.record('x', { ok: false, latency: 50, at: now })
  assert.equal(sourceState(stats.summary('x'), { now }), 'failing')
  stats.record('y', { ok: false, status: 429, at: now })
  assert.equal(sourceState(stats.summary('y'), { now }), 'rate-limited')
  now += 2 * 3600_000
  assert.equal(stats.summary('x').requests1h, 0)
  assert.equal(stats.summary('x').lastSuccess, 1_000_000)
})

test('the shipped bundle registers NFT jobs and a sources report without URLs beyond host names', async (t) => {
  const bundle = loadBundle()
  const transport = new MemoryTransport({ skipPow: true })
  const store = openStore({ file: ':memory:', migrations, profile: 'small' })
  const engine = new Engine({ transport, store, bundle, backgroundJobs: [], nfts: true, rpcConfig: { fetch: () => { throw new Error('offline') },
    endpoints: { ethereum: ['https://user:secret@rpc.example.org/v2/KEY123?token=abc'] } } })
  t.after(async () => { await engine.stop(); await transport.close(); store.close() })
  assert.ok(bundleDigest(bundle))
  for (const chain of ['ethereum', 'base']) {
    assert.ok(engine.scheduler.jobs.has('nft:' + chain + ':sales'))
    assert.ok(engine.scheduler.jobs.has('nft:' + chain + ':names'))
  }
  const seeded = store.reader.prepare('SELECT count(*) AS n FROM engine_nft_collections WHERE seeded=1').get().n
  assert.equal(seeded, bundle.dex.nft.collections.length)
  assert.ok(seeded >= 100)
  engine.sourceStats.record('http:https://mirror.example.net:8443', { ok: true, latency: 10 })
  const report = engine.sources()
  assert.deepEqual(report.groups.map((g) => g.id), ['cex', 'rpc', 'scanners', 'nft', 'data'])
  const text = JSON.stringify(report)
  assert.doesNotMatch(text, /KEY123|secret|token=|https?:\/\//)
  const mine = report.groups[1].items.find((i) => i.yours)
  assert.deepEqual([mine.host, mine.state], ['rpc.example.org', 'off'])
  assert.equal(report.groups[3].items.length, 2)
  assert.ok(report.groups[4].items.some((i) => i.id === 'http:mirror.example.net' && i.host === 'mirror.example.net'))
  assert.equal(engine.nftCollections({ limit: 5 }).items.length, 5)
})

test('a spare RPC endpoint is standby while another endpoint of its chain answers; unread chains and NFT sales are not listed', () => {
  const now = 1_000_000
  const stats = new SourceStats(() => now)
  stats.record('rpc:a', { ok: true, latency: 80, at: now })
  const engine = {
    clock: () => now, sourceStats: stats, scheduler: { jobs: new Map() }, evm: new Map(), nftsEnabled: false,
    nfts: { sources: [{ id: 'ethereum', status: () => ({ requests1h: 0, chainName: 'Ethereum' }) }] },
    catalog: { exchanges: [], apis: [] }, budget: { limit: 100, used: 0 }, registry: { chains: new Map() },
    rpc: { chains: new Map([['scroll', [{ id: 'a', url: 'https://a.example' }, { id: 'b', url: 'https://b.example' }]],
      ['fantom', [{ id: 'c', url: 'https://c.example' }]]]) },
  }
  const report = sourcesReport(engine)
  const rpc = Object.fromEntries(report.groups.find((g) => g.id === 'rpc').items.map((i) => [i.id, i.state]))
  // Fantom has no reader in this process: Sources lists only upstreams the node calls.
  assert.deepEqual(rpc, { 'rpc:a': 'ok', 'rpc:b': 'standby' })
  assert.equal(report.counts.standby, 1)
  assert.ok(!report.groups.some((g) => g.id === 'nft'))
})
