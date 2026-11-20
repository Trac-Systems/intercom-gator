// A chain's USD stablecoin never depends on one third-party reference (11-20, WP-stable): BSC USDT, Base/Optimism USDC
// and Polygon USDT had only a llama reference price; when it lapsed every DEX market quoted in them lost its USD rate and
// the chain's tokens vanished. Such a deployment now borrows its signed sibling's measured price, behind a de-peg guard.
import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { loadBundle } from '@gator/bundle'
import { openStore } from '@gator/store'
import { Engine, migrations } from '../src/index.js'
import { word } from '../src/sources/evm-abi.js'
import { seedValue } from '../src/sources/evm.js'
import { priceSiblings } from '../src/aggregate/coins.js'
import { aggregateAssets, BORROW_BOUND } from '../src/aggregate/index.js'

const start = Date.UTC(2026, 10, 20)
const address = n => '0x' + word(n).slice(-40)
const USDT = 'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7'
const USDC = 'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
// The chains of the minute-10 collapse and the USD stable their DEX markets are quoted in.
const STABLES = {
  bsc: 'bsc:0x55d398326f99059ff775485246999027b3197955', // Binance-Peg USDT: no coin group, signed links to USDT
  base: 'base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC, coin circle-usdc
  optimism: 'optimism:0x0b2c639c533813f4aa9d7837caf62653d097ff85', // USDC, coin circle-usdc
  polygon: 'polygon:0xc2132d05d31c914a87c6611c10748aeb04b58e8f', // USDT, coin tether-usdt (escrow-backed)
}
const TOKENS_PER_CHAIN = 12

function node(t) {
  const bundle = loadBundle(), store = openStore({ file: ':memory:', migrations, profile: 'small' })
  const transport = Object.assign(new EventEmitter(), { publicKey: word(1), channels: () => [], join: async () => true,
    leave: async () => true, send: () => true, peerCount: () => 0 })
  let now = start
  const engine = new Engine({ store, bundle, transport, profile: 'small', clock: () => now, backgroundJobs: [],
    patches: { patchFeed: false }, rpcConfig: { fetch: () => assert.fail('unexpected upstream request') } })
  t.after(async () => { await engine.stop(); store.close() })
  const own = rows => engine.book.ingest(engine.book.ownKey, rows.map(([m, p, v = '1000']) => [m, p, v, null, null, null, now]), true)
  const refresh = () => { engine.book.dirty = true; engine.book.refreshed = 0; return engine.book.refresh() }
  return { engine, store, own, refresh, now: () => now, advance: ms => { now += ms } }
}

/** USDT and USDC on two venues each (the node's own reads: green), as the CEX side of the coin groups. */
function cex(engine, own, usdt = '1.0002', usdc = '0.9999') {
  const ids = [['kraken', 'USDT', usdt], ['bitstamp', 'USDT', usdt], ['coinbase', 'USDC', usdc], ['kraken', 'USDC', usdc]]
    .map(([venue, label, price]) => [engine.registry.cex(venue, label, 'USD').id, price])
  own(ids.map(([id, price]) => [id, price, '5000000']))
}

let pools = 0
function pool(engine, chain, token0, token1, liquidity = 250_000) {
  const source = engine.evm.get(chain)
  const deploy = source.chain.deployments.find(d => d.kind === 'v2') ?? source.chain.deployments[0]
  return engine.registry.pool({ chain, pool: address(5000 + pools++), dex: deploy.name, kind: deploy.kind,
    token0, token1, firstSeen: start, liquidity }, {}, false)
}

/** Real-shaped chain books: the chain's wrapped native and its top signed tokens (seed order), each with one funded
 * pool against the chain's USD stable and turnover, as the EVM reader reports them. */
function chainBooks(engine, own) {
  const value = seedValue(engine.registry), tokens = {}
  for (const [chain, stable] of Object.entries(STABLES)) {
    const source = engine.evm.get(chain)
    const quotes = [...source.quotes.keys()]
    const natives = engine.catalog.assets.filter(a => a.chain === chain && quotes.includes(a.address) && !a.stable)
    const top = engine.catalog.assets
      .filter(a => a.chain === chain && /^0x/.test(a.address) && !a.stable && !quotes.includes(a.address))
      .sort((a, b) => value(a) - value(b) || (a.id < b.id ? -1 : 1))
      .slice(0, TOKENS_PER_CHAIN - natives.length)
    tokens[chain] = [...natives, ...top].map((a, i) => {
      const market = pool(engine, chain, a.address, stable.split(':')[1])
      assert.equal(market.quote, stable, 'the stable is the quote of every pool')
      own([[market.id, String(2 + i * 3.5)]])
      return a.id
    })
  }
  return tokens
}

const live = (snapshots, ids) => ids.filter(id => snapshots.get(id)?.visibility === 'live').length

test('with references off, every chain whose USD stable has no own price keeps its DEX prices through the signed group', t => {
  const { engine, own, refresh } = node(t)
  cex(engine, own)
  refresh()
  const tokens = chainBooks(engine, own)
  const siblings = engine.book.siblings
  assert.equal(engine.store.writer.prepare('SELECT count(*) AS n FROM engine_references').get().n, 0, 'llama outage')

  engine.book.siblings = new Map()
  const before = refresh()
  engine.book.siblings = siblings
  const after = refresh()
  const counts = {}
  for (const [chain, ids] of Object.entries(tokens)) {
    counts[chain] = [live(before, ids), live(after, ids)]
    assert.equal(counts[chain][0], 0, chain + ': nothing prices the stable, so nothing quoted in it has a USD rate')
    assert.equal(counts[chain][1], ids.length, chain + ': every token keeps a live USD price')
  }
  t.diagnostic('live tokens before/after, references off: ' + JSON.stringify(counts))

  const bsc = after.get(STABLES.bsc), polygon = after.get(STABLES.polygon), base = after.get(STABLES.base)
  assert.equal(bsc.why.borrowedFrom, USDT, 'a third-party peg borrows through its signed links')
  assert.equal(polygon.why.borrowedFrom, USDT, 'a coin-group member borrows from the measured member')
  assert.equal(base.why.borrowedFrom, USDC)
  assert.equal(after.get(STABLES.optimism).why.borrowedFrom, USDC)
  assert.equal(bsc.price, 1.0002)
  assert.equal(bsc.trust, after.get(USDT).trust, 'the borrowed conversion follows the group price')
  assert.equal(bsc.trust, 'green')
  assert.equal(bsc.volume24h, null, 'a borrowed rate carries no volume of its own')
  // A DEX token's USD price is its pool price times the borrowed rate, and its turnover counts.
  const wbnbId = 'bsc:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', wbnb = after.get(wbnbId)
  const poolPrice = 2 + tokens.bsc.indexOf(wbnbId) * 3.5
  assert.ok(Math.abs(wbnb.price - poolPrice * 1.0002) < 1e-9)
  assert.ok(wbnb.volume24h > 0 && wbnb.why.provenSources > 0)
  assert.equal(engine.book.marketPrices.size > 40, true)
})

test('a de-pegged deployment is not borrowed: its own pools against the native coin disagree by more than 2%', t => {
  const { engine, own, refresh, advance } = node(t)
  cex(engine, own)
  own([[engine.registry.cex('kraken', 'BNB', 'USD').id, '600', '20000']])
  refresh()
  const wbnb = pool(engine, 'bsc', '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', STABLES.bsc.split(':')[1])
  const native = pool(engine, 'bsc', 'native', STABLES.bsc.split(':')[1])
  assert.equal(native.base, 'bsc:native')
  own([[wbnb.id, '660'], [native.id, '660']])
  // BNB trades at $600 on the venues and at 660 Binance-Peg USDT in its pools: the peg is at $0.909.
  let p = refresh()
  assert.equal(p.get(STABLES.bsc), undefined, 'no borrowed rate')
  assert.equal(p.get(wbnb.base), undefined, 'markets quoted in the de-pegged stable keep the existing rule (no USD rate)')
  // Within the bound (600 → 610 = 1.6%) the peg holds and the group's price is borrowed.
  advance(1000)
  own([[wbnb.id, '610'], [native.id, '610']])
  p = refresh()
  assert.ok(Math.abs(600 / 610 - 1) < BORROW_BOUND)
  assert.equal(p.get(STABLES.bsc)?.why.borrowedFrom, USDT)
  assert.equal(p.get(wbnb.base)?.visibility, 'live')
})

test('an unproven peer cannot block borrowing with a de-pegged pool price', t => {
  const { engine, own, refresh } = node(t)
  cex(engine, own)
  own([[engine.registry.cex('kraken', 'BNB', 'USD').id, '600', '20000']])
  refresh()
  const wbnb = pool(engine, 'bsc', '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', STABLES.bsc.split(':')[1])
  const native = pool(engine, 'bsc', 'native', STABLES.bsc.split(':')[1])
  own([[wbnb.id, '601']])
  engine.book.ingest(word(7), [[native.id, '900', '1000', null, null, null, start]], false)
  const p = refresh()
  assert.equal(p.get(STABLES.bsc)?.why.borrowedFrom, USDT)
})

test('the reference stays a further fallback: one that disagrees by more than 2% keeps the existing rule', t => {
  const { engine, store, own, refresh, now } = node(t)
  cex(engine, own)
  refresh()
  const wbnb = pool(engine, 'bsc', '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', STABLES.bsc.split(':')[1])
  own([[wbnb.id, '600']])
  const insert = store.writer.prepare('INSERT OR REPLACE INTO engine_references VALUES (?,?,?,?)')
  insert.run(STABLES.bsc, 'llama-prices', 0.95, now())
  let p = refresh()
  assert.deepEqual(p.get(STABLES.bsc).why.referenceProviders, ['llama-prices'])
  assert.equal(p.get(STABLES.bsc).why.borrowedFrom, undefined)
  assert.ok(Math.abs(p.get(wbnb.base).price - 570) < 1e-9, 'converted at the reference')
  // An agreeing reference: the measured group price is preferred to the third-party reference.
  insert.run(STABLES.bsc, 'llama-prices', 0.999, now())
  p = refresh()
  assert.equal(p.get(STABLES.bsc).why.borrowedFrom, USDT)
  assert.ok(Math.abs(p.get(wbnb.base).price - 600 * 1.0002) < 1e-9)
})

test('signed siblings: coin groups and reciprocal links only, never by symbol', () => {
  const siblings = priceSiblings(loadBundle().tokens.tokens)
  assert.ok(siblings.get(STABLES.polygon).includes(USDT), 'coin group member')
  assert.ok(siblings.get(STABLES.base).includes(USDC))
  assert.ok(siblings.get(STABLES.bsc).includes(USDT), 'reciprocal signed links into one stablecoin group')
  assert.ok(!siblings.get(STABLES.bsc).includes(USDC))
  assert.equal(siblings.get('bsc:0x2170ed0880ac9a755fd29b2688956bd959f933f8'), undefined, 'linked WETH: not a stablecoin')
  const tokens = [
    { id: 'a:1', symbol: 'USDX', coin: 'x', category: 'stablecoin', links: [] },
    { id: 'b:1', symbol: 'USDX', category: 'stablecoin' }, // same ticker, no signed relation
    { id: 'c:1', symbol: 'USDX', category: 'stablecoin', links: ['a:1'] }, // one-sided link
    { id: 'd:1', symbol: 'USDY', coin: 'y', category: 'stablecoin', links: ['e:1'] },
    { id: 'e:1', symbol: 'USDY', category: 'stablecoin', links: ['d:1', 'f:1'] },
    { id: 'f:1', symbol: 'USDZ', coin: 'z', category: 'stablecoin', links: ['e:1'] }, // links into two groups
  ]
  const synthetic = priceSiblings(tokens)
  assert.equal(synthetic.get('b:1'), undefined)
  assert.equal(synthetic.get('c:1'), undefined)
  assert.equal(synthetic.get('e:1'), undefined, 'ambiguous: links into two coin groups')
  assert.equal(synthetic.get('a:1'), undefined, 'a group of one lends to nobody')
})

test('an own fresh price wins, and a stale or reference-only sibling never lends', () => {
  const now = start
  const assets = new Map([
    ['x:usd', { id: 'x:usd', stable: true }], ['l:usd', { id: 'l:usd', stable: true }],
    ['r:usd', { id: 'r:usd', stable: true }], ['x:tok', { id: 'x:tok' }],
  ])
  const market = (id, base, quote, price, at = now, kind = 'cex') => ({ id, base, quote, kind, exchange: id, price,
    priceText: String(price), at, window: 60_000, baseVolume: 10, usdVolume: null, agents: ['me'], provenAgents: ['me'],
    ownFresh: true, spread: 0 })
  const pool = market('dex:x:p', 'x:tok', 'x:usd', 5, now, 'dex')
  const lenders = new Map([['x:usd', ['l:usd', 'r:usd']]])
  // A stale sibling (its market is older than three windows) does not lend; nor does a reference-only one.
  const reference = new Map([['r:usd', { asset: 'r:usd', price: 1, at: now, why: { stale: false, fresh: true, depegs: [],
    referenceProviders: ['llama-prices'], pools: 0, exchanges: 0, provenSources: 0 } }]])
  let out = aggregateAssets(assets, [market('cex:l', 'l:usd', 'fiat:USD', 1, now - 600_000), pool], now, reference, { lenders })
  assert.equal(out.get('x:usd'), undefined)
  assert.equal(out.get('x:tok'), undefined)
  out = aggregateAssets(assets, [market('cex:l', 'l:usd', 'fiat:USD', 1.001), pool], now, new Map(), { lenders })
  assert.equal(out.get('x:usd').why.borrowedFrom, 'l:usd')
  assert.ok(Math.abs(out.get('x:tok').price - 5.005) < 1e-9)
  // The deployment's own fresh market price wins over borrowing.
  out = aggregateAssets(assets, [market('cex:l', 'l:usd', 'fiat:USD', 1.001), market('cex:x', 'x:usd', 'fiat:USD', 0.97),
    pool], now, new Map(), { lenders })
  assert.equal(out.get('x:usd').why.borrowedFrom, undefined)
  assert.equal(out.get('x:usd').price, 0.97)
})
