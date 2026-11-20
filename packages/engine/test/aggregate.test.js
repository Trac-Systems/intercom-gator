import assert from 'node:assert/strict'
import test from 'node:test'
import { weightedMedian, marketMedian, aggregateAssets } from '../src/aggregate/index.js'

const now = 1740000000000
const assets = new Map([
  ['coin', { id: 'coin', supply: 50, totalSupply: 100 }],
  ['usdc', { id: 'usdc', stable: true }],
])
function market(exchange, base, quote, price, reporters, volume = 500, age = 0) {
  return marketMedian(
    { id: exchange + base, kind: 'cex', rank: 4, exchange, base, quote },
    reporters.map((r, i) => ({
      reporter: r,
      price: String(Array.isArray(price) ? price[i] : price),
      weight: 1,
      proven: true,
      srcTs: now - age,
      baseVol24h: volume,
      quoteVol24hUsd: null,
    })),
    now
  )
}
test('weighted medians and fresh independent venue agreement with overlapping reporters', () => {
  assert.equal(
    weightedMedian([
      { value: 1, weight: 1 },
      { value: 3, weight: 1 },
    ]),
    2
  )
  const reports = [
    market('A', 'coin', 'fiat:USD', 3, ['1', '2', '3', '4']),
    market('B', 'coin', 'fiat:USD', 3, ['4', '5']),
  ]
  const result = aggregateAssets(assets, reports, now).get('coin')
  assert.equal(result.trust, 'green')
  assert.equal(result.why.agents, 5)
  assert.equal(result.marketCap, 150)
  assert.equal(result.fdv, 300)
  assert.equal(result.volume24h, 3000)
  assert.equal(aggregateAssets(assets, reports, now + 181000).get('coin').trust, 'red')
})
test("the node's own fresh reads of two agreeing venues are green without peers; one venue is not", () => {
  const own = (exchange, price) => marketMedian(
    { id: exchange + 'coin', kind: 'cex', rank: 4, exchange, base: 'coin', quote: 'fiat:USD' },
    [{ reporter: 'me', own: true, proven: true, price: String(price), weight: 1, srcTs: now, baseVol24h: 10, quoteVol24hUsd: null }],
    now
  )
  const two = aggregateAssets(assets, [own('A', 3), own('B', 3.01)], now).get('coin')
  assert.equal(two.trust, 'green')
  assert.equal(two.why.ownSources, 2)
  assert.equal(aggregateAssets(assets, [own('A', 3)], now).get('coin').trust, 'yellow')
  assert.equal(aggregateAssets(assets, [own('A', 3), own('B', 3.1)], now).get('coin').trust, 'red')
  // A third own venue read a little earlier (within three windows) does not block green; alone it would not confirm.
  const older = marketMedian(
    { id: 'Ccoin', kind: 'cex', rank: 4, exchange: 'C', base: 'coin', quote: 'fiat:USD' },
    [{ reporter: 'me', own: true, proven: true, price: '3', weight: 1, srcTs: now - 90_000, baseVol24h: 10, quoteVol24hUsd: null }],
    now
  )
  assert.equal(aggregateAssets(assets, [own('A', 3), own('B', 3.01), older], now).get('coin').trust, 'green')
  assert.equal(aggregateAssets(assets, [own('A', 3), older], now).get('coin').trust, 'yellow')
  // Peer-only evidence still needs five proven reporters.
  assert.equal(aggregateAssets(assets, [market('A', 'coin', 'fiat:USD', 3, ['1', '2']), market('B', 'coin', 'fiat:USD', 3, ['3'])], now).get('coin').trust, 'yellow')
})

test('a 1.5% rise across ten staggered venue reads stays green (previously yellow)', () => {
  const markets = Array.from({ length: 10 }, (_, i) => {
    const elapsed = Math.round(60_000 * i / 9)
    return market(String(i), 'coin', 'fiat:USD', 100 + 1.5 * elapsed / 60_000, [String(i)], 500, 60_000 - elapsed)
  })
  const result = aggregateAssets(assets, markets, now).get('coin')
  assert.equal(result.trust, 'green')
  // A 30-second window covers at most four price steps, about 0.67%.
  assert.ok(result.why.spreadPct > 0.6 && result.why.spreadPct < 0.7)
})

test('within one market, a peer read minutes before ours is not a disagreement, a same-time one is', () => {
  // Rank 100: ten-minute window, so a peer row five minutes old still counts as current (ETH yellow, calm, 11-20).
  const pair = (peerPrice, peerAge) => marketMedian({ id: 'Acoin', kind: 'cex', rank: 100, exchange: 'A', base: 'coin', quote: 'fiat:USD' }, [
    { reporter: '1', price: '98.5', weight: 1, proven: true, own: true, srcTs: now, baseVol24h: 500, quoteVol24hUsd: null },
    { reporter: '2', price: String(peerPrice), weight: 1, proven: true, srcTs: now - peerAge, baseVol24h: 500, quoteVol24hUsd: null },
  ], now)
  const other = market('B', 'coin', 'fiat:USD', 98.5, ['3', '4', '5'])
  const trust = (m) => aggregateAssets(assets, [m, other], now).get('coin')
  assert.equal(pair(100, 300_000).alignedSpread, 0)
  assert.equal(trust(pair(100, 300_000)).trust, 'green', 'was yellow: 1.5% against a five-minute-old read')
  assert.equal(trust(pair(99.7, 10_000)).trust, 'yellow', 'two reads ten seconds apart, 1.2% apart')
  assert.equal(trust(pair(102.1, 300_000)).trust, 'red', 'any reporter more than 3% away still counts for red')
})

test('a thin market whose reporters disagree does not turn a widely traded asset yellow, a heavy one does', () => {
  // T sits in the middle of the price range, so it stays in the core; only its own reporters disagree.
  const split = (prices, volume) => market('T', 'coin', 'fiat:USD', prices, ['7', '8', '9'], volume)
  const heavy = [market('A', 'coin', 'fiat:USD', 100.2, ['1', '2', '3'], 50_000), market('B', 'coin', 'fiat:USD', 101, ['4', '5', '6'], 50_000)]
  const trust = (t) => aggregateAssets(assets, [...heavy, t], now).get('coin').trust
  assert.equal(trust(split([100, 100.6, 101.36], 100)), 'green', 'was yellow: 1.36% between reads of a market with 0.1% of the volume')
  assert.equal(trust(split([100, 100.6, 101.36], 50_000)), 'yellow')
  assert.equal(trust(split([98, 100.6, 103.5], 100)), 'red', 'a thin market more than 3% apart still turns it red')
})

test('two venues read in the same second 1.2% apart are yellow', () => {
  const result = aggregateAssets(assets, [
    market('A', 'coin', 'fiat:USD', 100, ['1', '2', '3'], 500, 800),
    market('B', 'coin', 'fiat:USD', 101.2, ['4', '5'], 500, 200),
  ], now).get('coin')
  assert.equal(result.trust, 'yellow')
  assert.ok(Math.abs(result.why.spreadPct - 1.2 / result.price * 100) < 1e-10)
})

test('a core venue 3.5% off two minutes earlier still turns the asset red', () => {
  const result = aggregateAssets(assets, [
    market('A', 'coin', 'fiat:USD', 100, ['1', '2', '3']),
    market('B', 'coin', 'fiat:USD', 100, ['4', '5']),
    market('C', 'coin', 'fiat:USD', 103.5, ['6'], 500, 120_000),
  ], now).get('coin')
  assert.equal(result.trust, 'red')
  assert.ok(Math.abs(result.why.spreadPct - 3.5) < 1e-10)
})

test('the FX timestamp determines whether a converted quote is within 30 seconds', () => {
  const direct = market('A', 'coin', 'fiat:USD', 100, ['1', '2', '3'])
  const cross = market('B', 'coin', 'usdc', 101.2, ['4', '5'])
  const withFx = (age, prices) => aggregateAssets(assets, [
    direct, cross, market('C', 'usdc', 'fiat:USD', prices, ['1', '2'], 500, age),
  ], now).get('coin')
  assert.equal(withFx(30_000, 1).trust, 'yellow')
  const apart = withFx(30_001, 1)
  assert.equal(apart.trust, 'green')
  assert.equal(apart.why.spreadPct, 0)
  // The FX market's own reporter spread still counts, even without an aligned venue pair.
  const noisyFx = withFx(30_001, [0.994, 1.006])
  assert.equal(noisyFx.trust, 'yellow')
  assert.ok(Math.abs(noisyFx.why.spreadPct - 1.2) < 1e-10)
})

test('a thin outlying market or a noisy quote path does not turn a widely traded asset red', () => {
  const assets = new Map([['coin', { id: 'coin' }], ['usdx', { id: 'usdx', stable: true }]])
  const major = [
    market('A', 'coin', 'fiat:USD', 100, ['1', '2', '3'], 1000),
    market('B', 'coin', 'fiat:USD', 100.2, ['1', '4', '5'], 1000),
    market('C', 'coin', 'fiat:USD', 99.9, ['2', '3', '4'], 1000),
  ]
  // A thin market at 2x (mislabeled ticker) sits in the light tail.
  const thin = market('D', 'coin', 'fiat:USD', 200, ['6'], 1)
  assert.equal(aggregateAssets(assets, [...major, thin], now).get('coin').trust, 'green')
  // A quote asset whose own venues disagree by 40% is not used to value coin when direct USD markets exist.
  const noisy = [market('E', 'usdx', 'fiat:USD', 1, ['1'], 10), market('F', 'usdx', 'fiat:USD', 1.4, ['2'], 10)]
  const viaNoisy = market('G', 'coin', 'usdx', 100, ['1', '2', '3', '4', '5'], 400)
  assert.equal(aggregateAssets(assets, [...major, ...noisy, viaNoisy], now).get('coin').trust, 'green')
  // Substantial markets that disagree still turn it red.
  const split = market('H', 'coin', 'fiat:USD', 110, ['1', '2', '3', '4', '5'], 3000)
  assert.equal(aggregateAssets(assets, [...major, split], now).get('coin').trust, 'red')
})

test('USD conversion uses measured depeg, distinct venue volume and reporter disagreement', () => {
  const reports = [
    market('A', 'coin', 'usdc', 2, ['1', '2']),
    market('C', 'usdc', 'fiat:USD', 0.8, ['3']),
    market('B', 'coin', 'fiat:USD', [1.8, 2.0], ['4', '5'], 1),
  ]
  const result = aggregateAssets(assets, reports, now).get('coin')
  assert.equal(result.price, 1.6)
  assert.deepEqual(result.why.depegs, ['usdc'])
  assert.equal(result.trust, 'red')
  assert.equal(aggregateAssets(assets, reports.slice(0, 1), now).size, 0)
})

test('USD conversion excludes circular quote paths and reporters outside the target window', () => {
  const assets = new Map([
    ['A', { id: 'A' }],
    ['B', { id: 'B' }],
  ])
  const direct = market('one', 'A', 'fiat:USD', 10, ['a'], 1)
  const swaps = [direct, market('two', 'B', 'A', 2, ['b'], 5), market('three', 'A', 'B', 100, ['c'], 1000)]
  const result = aggregateAssets(assets, swaps, now)
  assert.equal(result.get('A').price, 10)
  assert.equal(result.get('B').price, 20)
  const thin = marketMedian(
    { rank: 1 },
    [
      { srcTs: now - 59999, reporter: 'a', price: '2', weight: 1 },
      { srcTs: now - 90000, reporter: 'b', price: '10', weight: 1 },
    ],
    now
  )
  assert.deepEqual(thin.agents, ['a'])
  assert.equal(thin.price, 2)
})

test('market medians and USD multiplication preserve fixed-point digits beyond the double display value', () => {
  const assetMap = new Map([
    ['x', { id: 'x' }],
    ['q', { id: 'q' }],
  ])
  const m = market('s', 'x', 'q', ['0.10000000000000000001', '0.10000000000000000003'], ['a', 'b'])
  const q = market('t', 'q', 'fiat:USD', '0.2', ['c'])
  assert.equal(m.priceText, '0.10000000000000000002')
  assert.equal(aggregateAssets(assetMap, [m, q], now).get('x').priceText, '0.020000000000000000004')
})

test('a provisional venue or quote currency cannot supply confirming evidence or outvote a supported price', () => {
  const direct = market('A', 'coin', 'fiat:USD', 3, ['1', '2', '3', '4', '5'], 0)
  const unconfirmed = { ...market('B', 'coin', 'fiat:USD', 3, ['6'], 1e12), provenAgents: [] }
  const unresolved = { ...market('C', 'usdc', 'fiat:USD', 1, ['7']), provenAgents: [] }
  const cross = market('D', 'coin', 'usdc', 3, ['8'], 1e12)
  const result = aggregateAssets(assets, [direct, unconfirmed, unresolved, cross], now).get('coin')
  assert.equal(result.trust, 'yellow')
  assert.equal(result.why.provenSources, 1)
  assert.equal(result.why.provenAgents, 5)
  const other = { ...unconfirmed, price: 900, priceText: '900' }
  assert.equal(aggregateAssets(assets, [direct, other], now).get('coin').price, 3)
})

test('a minority CEX ticker far from agreeing venues leaves the price and trust; a real disagreement stays red', () => {
  // CTX: Coinbase $0.3739 and Gemini $0.3728 agree; HTX prints $0.54 inside a 0.38/0.70 book.
  const ctx = (htxVolume) => [
    market('coinbase', 'coin', 'fiat:USD', 0.3739, ['1', '2'], 28000),
    market('gemini', 'coin', 'fiat:USD', 0.3728, ['1', '2'], 3000),
    market('htx', 'coin', 'fiat:USD', 0.5402, ['1', '2'], htxVolume),
  ]
  const ratios = new Map([['coinbasecoin', 1.02], ['geminicoin', 1.019], ['htxcoin', 0.6]])
  const result = aggregateAssets(assets, ctx(5320), now, new Map(), { dayRatio: m => ratios.get(m.id) }).get('coin')
  assert.equal(result.price, 0.3739)
  assert.deepEqual(result.why.outliers, ['htxcoin'])
  assert.equal(result.exchanges, 2)
  assert.notEqual(result.trust, 'red')
  assert.ok(result.why.spreadPct < 1)
  // The venues' own 24 h move comes from the markets the price uses, weighted like the price.
  assert.equal(result.dayRatio, 1.02)
  // HTX carrying more than a third of the weight is a disagreement: kept, red.
  const heavy = aggregateAssets(assets, ctx(30000), now).get('coin')
  assert.equal(heavy.why.outliers, undefined)
  assert.equal(heavy.trust, 'red')
  // Two venues against one are not enough when the one is a DEX pool: pools carry the token's identity.
  const pool = marketMedian({ id: 'pool', kind: 'dex', rank: 4, base: 'coin', quote: 'fiat:USD' },
    [{ reporter: '1', price: '0.5402', weight: 1, proven: true, srcTs: now, baseVol24h: 5320, quoteVol24hUsd: null }], now)
  const withPool = aggregateAssets(assets, [...ctx(5320).slice(0, 2), pool], now).get('coin')
  assert.equal(withPool.why.outliers, undefined)
  assert.equal(withPool.trust, 'red')
})

test('a cap falls back to the total supply, except a HyperEVM total pre-minted to HyperCore', () => {
  const own = (asset) => marketMedian({ id: 'A' + asset, kind: 'cex', rank: 4, exchange: 'A', base: asset, quote: 'fiat:USD' },
    [{ reporter: 'me', own: true, proven: true, price: '2', weight: 1, srcTs: now, baseVol24h: 10, quoteVol24hUsd: null }], now)
  const own2 = (asset) => marketMedian({ id: 'B' + asset, kind: 'cex', rank: 4, exchange: 'B', base: asset, quote: 'fiat:USD' },
    [{ reporter: 'me', own: true, proven: true, price: '2', weight: 1, srcTs: now, baseVol24h: 10, quoteVol24hUsd: null }], now)
  const ubtc = 'hyperevm:0x9fdbda0a5e284c32744d2f17ee5c74b284993463', plain = 'ethereum:0x' + '1'.repeat(40)
  const totals = new Map([[ubtc, { id: ubtc, totalSupply: 21_000_000 }], [plain, { id: plain, totalSupply: 1000 }]])
  const result = aggregateAssets(totals, [own(ubtc), own2(ubtc), own(plain), own2(plain)], now)
  assert.equal(result.get(plain).marketCap, 2000)
  assert.equal(result.get(ubtc).marketCap, null)
  assert.equal(result.get(ubtc).fdv, 42_000_000)
  // Anywhere else, a total-based cap must stay within 2,000x the 24 h volume ($40 here): a pre-mint shows no cap.
  const premint = 'base:0x' + '2'.repeat(40)
  const minted = aggregateAssets(new Map([[premint, { id: premint, totalSupply: 1e9 }]]), [own(premint), own2(premint)], now)
  assert.equal(minted.get(premint).marketCap, null)
  assert.equal(minted.get(premint).fdv, 2e9)
  // A measured circulating figure is never held to it.
  const measured = aggregateAssets(new Map([[premint, { id: premint, supply: 1e9, totalSupply: 1e9 }]]), [own(premint), own2(premint)], now)
  assert.equal(measured.get(premint).marketCap, 2e9)
})
