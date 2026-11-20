import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { loadBundle } from '@gator/bundle'
import { openStore } from '@gator/store'
import { migrations as socialMigrations } from '@gator/social'
import { Engine, migrations } from '../src/index.js'
import { createRouter } from '../../api/src/routes.js'
import { bestState, chainLabel, contractRole, explorerUrl, linkGroups, representativeOrder, rowOrder } from '../src/aggregate/coins.js'

const start = Date.UTC(2026, 10, 19, 6)
const btc = 'bitcoin:native'
const ethUsdt = 'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7', tronUsdt = 'tron:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const arbUsdt0 = 'arbitrum:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'
const ethUsdc = 'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', baseUsdc = 'base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const bscUsdt = 'bsc:0x55d398326f99059ff775485246999027b3197955'

class Transport extends EventEmitter {
  publicKey = 'a'.repeat(64)
  topics = new Map()
  channels() { return [...this.topics.keys()] }
  async join(channel, policy) { this.topics.set(channel, policy); return true }
  async leave(channel) { return this.topics.delete(channel) }
  send() { return true }
}

/** Bitcoin, the whole signed Tether and Circle USDC groups and the Binance-Peg USDT, as shipped. */
async function fixture(t) {
  const bundle = structuredClone(loadBundle())
  bundle.exchanges = bundle.exchanges.filter(s => s.id === 'bitstamp')
  bundle.tokens.tokens = bundle.tokens.tokens.filter(token =>
    ['tether-usdt', 'circle-usdc'].includes(token.coin) || [btc, bscUsdt].includes(token.id))
  const store = openStore({ file: ':memory:', profile: 'small', migrations: [...migrations, ...socialMigrations] })
  let now = start
  const engine = new Engine({ bundle, transport: new Transport(), store, clock: () => now, backgroundJobs: [], random: () => 0.5,
    rpcConfig: { bundleDigest: '0'.repeat(64), fetch: () => assert.fail('Unexpected HTTP read'), timeout: 500, retries: 0,
      requestsPerMinute: 60 } })
  await engine.start()
  clearTimeout(engine.timer)
  t.after(async () => { await engine.stop(); store.close() })
  const reference = store.writer.prepare('INSERT OR REPLACE INTO engine_references VALUES (?,?,?,?)')
  const quote = (id, price) => { reference.run(id, 'fixture', price, now); engine.book.dirty = true }
  const trade = (symbol, quoteSymbol, price, volume) => {
    const market = engine.registry.cex('bitstamp', symbol, quoteSymbol)
    engine.publish([[market.id, String(price), volume, String(price * volume), null, null, now]])
    engine.book.dirty = true
    return market
  }
  const intel = { risk: { get: () => null }, claims: { list: () => [] }, placements: { state: () => null },
    newTokens: { list: () => [] } }
  const request = createRouter({ engine, store, transport: engine.transport, social: new EventEmitter(), release: { bundle },
    clock: () => now, intel })
  return { engine, store, quote, trade, request, advance: ms => { now += ms } }
}

/** USDT: Ethereum with CEX markets, TRON quoted without markets (the owner's node), USDT0 bridged on Arbitrum. */
async function tether(t) {
  const f = await fixture(t)
  const { engine, quote, trade } = f
  trade('BTC', 'USD', 100_000, 2)
  engine.setSupply(btc, { circulatingSupply: 19e6 })
  engine.setSupply(ethUsdt, { circulatingSupply: 79e9 })
  engine.setSupply(tronUsdt, { circulatingSupply: 92e9 })
  engine.setSupply(arbUsdt0, { circulatingSupply: 1e9 }) // escrow-backed: already inside Ethereum issuance
  engine.setSupply(ethUsdc, { circulatingSupply: 40e9 })
  engine.setSupply(baseUsdc, { circulatingSupply: 4e9 })
  trade('USDT', 'USD', 1, 5e6)
  trade('BTC', 'USDT', 100_010, 1)
  quote(tronUsdt, 1)
  quote(arbUsdt0, 1)
  quote(ethUsdc, 1)
  quote(baseUsdc, 1)
  return f
}

test('the markets list shows a coin once, ranked by its group cap and linked to the member with the most markets', async t => {
  const { engine, request } = await tether(t)
  const page = await request('GET', '/markets')
  const symbols = page.items.map(r => r.symbol)
  assert.deepEqual(symbols.filter(s => s === 'USDT'), ['USDT'])
  assert.equal(symbols.filter(s => s === 'USDC').length, 1)
  const usdt = page.items.find(r => r.coin === 'tether-usdt')
  // TRON alone ($92B) outranked Ethereum ($79B) and had no markets; the row opens Ethereum, the member with markets.
  assert.equal(usdt.id, ethUsdt)
  assert.equal(usdt.representative, ethUsdt)
  assert.equal(usdt.marketCap, 171e9)
  assert.equal(usdt.coinMarketCap, 171e9)
  assert.equal(usdt.group, 'coin')
  assert.equal(usdt.members, 15)
  // Ranks close up behind the collapsed rows: BTC, USDT, USDC.
  assert.deepEqual(page.items.map(r => [r.symbol, r.rank]).slice(0, 3), [['BTC', 1], ['USDT', 2], ['USDC', 3]])
  assert.deepEqual(page.items.map(r => r.rank), page.items.map((_, i) => i + 1))
  assert.equal(page.total, page.items.length)
  // Volume and exchange counts are sums over the live members.
  const own = engine.store.getAsset(ethUsdt)
  assert.equal(usdt.volume24h, page.items.length && [ethUsdt, tronUsdt, arbUsdt0]
    .map(id => engine.store.getAsset(id).volume24h ?? 0).reduce((a, b) => a + b, 0))
  assert.equal(usdt.exchanges, own.exchanges)
  // The detail rank is the coin's rank on every member page.
  assert.equal(engine.asset(tronUsdt).rank, 2)
  assert.equal(engine.asset(ethUsdt).rank, 2)
})

test('paging counters cover the collapsed list and sorting keeps one row per coin', async t => {
  const { request } = await tether(t)
  const all = await request('GET', '/markets')
  const ids = all.items.map(r => r.id)
  assert.equal(new Set(ids).size, ids.length)
  const pages = []
  for (let offset = 0; offset < all.total; offset += 1)
    pages.push(...(await request('GET', '/markets', { limit: '1', offset: String(offset) })).items.map(r => r.id))
  assert.deepEqual(pages, ids)
  const second = await request('GET', '/markets', { limit: '1', offset: '1' })
  assert.equal(second.total, all.total)
  assert.deepEqual(second.items.map(r => r.symbol), ['USDT'])
  // Unquoted members of a listed coin (12 Tether, 13 USDC deployments) are not hidden rows; the unquoted
  // Binance-Peg USDT is.
  assert.deepEqual(all.hidden, { stale: 0, unconfirmed: 1, dust: 0 })
  const withHidden = await request('GET', '/markets', { include: 'hidden' })
  assert.equal(withHidden.items.filter(r => r.coin === 'tether-usdt').length, 1)
  assert.equal(withHidden.total, withHidden.items.length)
  // A sort by market cap orders coins by their group cap.
  const byCap = await request('GET', '/markets', { sort: 'marketCap', order: 'desc' })
  assert.deepEqual(byCap.items.slice(0, 3).map(r => r.symbol), ['BTC', 'USDT', 'USDC'])
  const byVolume = await request('GET', '/markets', { sort: 'volume24h', order: 'asc' })
  assert.equal(byVolume.items.filter(r => r.symbol === 'USDT').length, 1)
})

test('a chain filter shows the coin through its member on that chain', async t => {
  const { request } = await tether(t)
  const tron = await request('GET', '/markets', { chain: 'tron' })
  assert.deepEqual(tron.items.map(r => [r.symbol, r.id]), [['USDT', tronUsdt]])
  assert.equal(tron.items[0].marketCap, 171e9)
  assert.equal(tron.total, 1)
  const arbitrum = await request('GET', '/markets', { chain: 'Arbitrum One' })
  assert.deepEqual(arbitrum.items.map(r => r.id), [arbUsdt0])
  assert.equal(arbitrum.items[0].rank, 2)
  const base = await request('GET', '/markets', { chain: 'base' })
  assert.deepEqual(base.items.map(r => [r.symbol, r.id]), [['USDC', baseUsdc]])
})

test('every member page is the coin page: all contracts, the Ethereum CEX markets and the coin figures', async t => {
  const { request } = await tether(t)
  for (const id of [tronUsdt, ethUsdt]) {
    const page = await request('GET', '/assets/' + encodeURIComponent(id))
    assert.equal(page.contracts.length, 15)
    assert.deepEqual(page.contracts.filter(c => c.current).map(c => c.id), [id])
    assert.equal(page.contracts[0].id, ethUsdt) // the representative leads
    const tron = page.contracts.find(c => c.id === tronUsdt)
    assert.deepEqual({ ...tron, current: undefined, logo: undefined }, { id: tronUsdt, chain: 'tron', chainName: 'TRON',
      address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', symbol: 'USDT', explorer: 'https://tronscan.org/#/token20/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      role: 'native', current: undefined, logo: undefined })
    assert.equal(page.contracts.find(c => c.id === arbUsdt0).role, 'bridged (USDT0)')
    assert.equal(page.contracts.find(c => c.id === ethUsdt).chainName, 'Ethereum')
    assert.equal(page.contracts.find(c => c.id === ethUsdt).explorer, 'https://etherscan.io/token/' + ethUsdt.slice(9))
    assert.ok(!page.contracts.some(c => c.id === bscUsdt), 'a third-party peg is not a Tether contract')
    assert.equal(page.coinGroup.coin, 'tether-usdt')
    assert.equal(page.coinGroup.marketCap, 171e9)
    assert.equal(page.coinGroup.rank, 2)
    // Markets: the union of the members' markets, each bound to its member and labelled with its chain.
    const venues = page.markets.map(m => m.id)
    assert.ok(venues.includes('cex:bitstamp:USDT-USD'))
    assert.ok(venues.includes('cex:bitstamp:BTC-USDT'))
    assert.ok(page.markets.every(m => m.asset === ethUsdt && m.chainName === 'Ethereum'))
    const markets = await request('GET', '/assets/' + encodeURIComponent(id) + '/markets')
    assert.deepEqual(markets.items.map(m => m.id), venues)
    const volumes = markets.items.map(m => m.volume24h ?? -1)
    assert.deepEqual(volumes, volumes.slice().sort((a, b) => b - a))
  }
  // The member's own figures stay available: TRON's own supply, price and cap.
  const tron = await request('GET', '/assets/' + encodeURIComponent(tronUsdt))
  assert.equal(tron.id, tronUsdt)
  assert.equal(tron.marketCap, 92e9)
})

test('standalone assets keep one contract (a native coin none) and search answers a coin once', async t => {
  const { engine, request } = await tether(t)
  assert.deepEqual((await request('GET', '/assets/' + encodeURIComponent(btc))).contracts, [])
  const peg = await request('GET', '/assets/' + encodeURIComponent(bscUsdt))
  assert.deepEqual(peg.contracts.map(c => [c.id, c.current, c.role]), [[bscUsdt, true, null]])
  assert.equal(peg.coinGroup, null)
  const found = engine.search('USDT', { limit: 6 })
  assert.equal(found.filter(r => r.coin === 'tether-usdt').length, 1)
  assert.equal(found.find(r => r.coin === 'tether-usdt').id, ethUsdt)
  // A search by address opens the member it matched.
  assert.equal(engine.search('TR7NHq')[0].id, tronUsdt)
  assert.equal(engine.search('TR7NHq')[0].marketCap, 171e9)
})

test('gainers and losers judge a coin by its representative, not by a member that moved the other way', async t => {
  const { engine } = await tether(t)
  const row = { ...engine.queries.marketList().items.find(r => r.coin === 'tether-usdt') }
  const lists = { gainers: engine.queries.marketList({ tab: 'gainers' }).items, losers: engine.queries.marketList({ tab: 'losers' }).items }
  const side = row.change24h > 0 ? 'gainers' : row.change24h < 0 ? 'losers' : null
  for (const [tab, items] of Object.entries(lists))
    assert.equal(items.filter(r => r.coin === 'tether-usdt').length, tab === side ? 1 : 0)
})

test('link sets: bridged copies collapse, a set that touches a signed coin keeps its own rows', () => {
  const tokens = loadBundle().tokens.tokens
  const groups = linkGroups(tokens)
  const of = id => groups.find(g => g.members.some(t => t.id === id))
  const uni = of('ethereum:0x1f9840a85d5af5bf1d1762f925bdaddc4201f984')
  assert.equal(uni.kind, 'linked')
  assert.equal(uni.collapse, true)
  assert.ok(uni.members.length >= 7)
  const pegs = of('bsc:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d') // Binance-Peg USDC + bridged USDC.e
  assert.equal(pegs.collapse, false)
  assert.equal(of(ethUsdt), undefined, 'signed coin members are not link sets')
  for (const g of groups) assert.ok(g.members.every(t => !t.coin))
})

test('contract helpers: explorer pages, roles, chain labels, representative and list order', () => {
  const evm = { explorer: 'https://etherscan.io', family: 'evm' }
  assert.equal(explorerUrl(undefined, evm, 'ethereum:0xabc'), 'https://etherscan.io/token/0xabc')
  assert.equal(explorerUrl({ id: 'x', explorer: 'https://arbiscan.io/address/0x1' }, evm, 'x:0x1'), 'https://arbiscan.io/address/0x1')
  assert.equal(explorerUrl({ id: 'x', explorer: 'javascript:alert(1)' }, evm, 'ethereum:0x1'), 'https://etherscan.io/token/0x1')
  assert.equal(explorerUrl(undefined, { explorer: 'https://explorer.solana.com', family: 'solana' }, 'solana:Mint'), 'https://explorer.solana.com/address/Mint')
  assert.equal(explorerUrl(undefined, { explorer: 'https://mempool.space', family: 'bitcoin' }, 'bitcoin:native'), 'https://mempool.space')
  assert.equal(explorerUrl(undefined, undefined, 'unknown:0x1'), null)
  const coin = { kind: 'coin' }, linked = { kind: 'linked' }
  assert.equal(contractRole({ id: 'a', coinSupply: 'issuance' }, coin, 'USDT'), 'native')
  assert.equal(contractRole({ id: 'a', coinSupply: 'escrow-backed', symbol: 'USDT' }, coin, 'USDT'), 'bridged')
  assert.equal(contractRole({ id: 'a', coinSupply: 'escrow-backed', symbol: 'USDT0' }, coin, 'USDT'), 'bridged (USDT0)')
  assert.equal(contractRole({ id: 'a' }, linked), 'linked')
  assert.equal(contractRole({ id: 'a' }, undefined), null)
  assert.equal(chainLabel({ name: 'OP Mainnet' }, 'optimism'), 'OP')
  assert.equal(chainLabel(undefined, 'tron'), 'tron')
  const records = { 'ethereum:a': { coinSupply: 'issuance' }, 'tron:b': { coinSupply: 'issuance' }, 'arbitrum:c': { coinSupply: 'escrow-backed' } }
  const order = (markets, supply = {}) => representativeOrder(id => markets[id] ?? 0, id => records[id], id => supply[id])
  assert.deepEqual(['tron:b', 'arbitrum:c', 'ethereum:a'].sort(order({ 'tron:b': 2 })), ['tron:b', 'ethereum:a', 'arbitrum:c'])
  assert.deepEqual(['tron:b', 'arbitrum:c', 'ethereum:a'].sort(order({})), ['ethereum:a', 'tron:b', 'arbitrum:c'])
  assert.deepEqual(['arbitrum:c', 'tron:b'].sort(order({}, { 'arbitrum:c': 9 })), ['tron:b', 'arbitrum:c'])
  assert.equal(bestState(['dust', 'stale', 'unconfirmed']), 'stale')
  assert.equal(bestState([]), null)
  const rows = [{ id: 'b', rank: null, name: 'b' }, { id: 'a', rank: 2, name: 'B' }, { id: 'c', rank: 1, name: 'a' }]
  assert.deepEqual(rows.slice().sort(rowOrder('rank', 'asc')).map(r => r.id), ['c', 'a', 'b'])
  assert.deepEqual(rows.slice().sort(rowOrder('rank', 'desc')).map(r => r.id), ['a', 'c', 'b'])
  assert.deepEqual(rows.slice().sort(rowOrder('name', 'asc')).map(r => r.id), ['c', 'a', 'b'])
})

test('the volume guard compares turnover with the coin cap, never one deployment\'s share', async t => {
  const { engine } = await tether(t)
  engine.book.refresh()
  // A coin member answers with the coin's counted-once cap (171B), not TRON's or Ethereum's own share.
  assert.equal(engine.book.guardCap(tronUsdt), 171e9)
  assert.equal(engine.book.guardCap(ethUsdt), 171e9)
  // A native coin uses its own cap; a standalone single-chain token none (its supply there may be a bridged share).
  assert.equal(engine.book.guardCap(btc), engine.book.snapshots.get(btc).marketCap)
  assert.ok(engine.book.guardCap(btc) > 1e12)
  assert.equal(engine.book.guardCap('ethereum:0xc669928185dbce49d2230cc9b0979be6dc797957'), null)
})
