import test from 'node:test'
import assert from 'node:assert/strict'
import { loadBundle } from '@gator/bundle'
import { openStore } from './store-fixture.js'
import { adaptBundle, tickerRecords } from '../src/sources/bundle-adapter.js'
import { fetchTickers } from '../src/sources/cex.js'
import { Registry } from '../src/registry/index.js'
import { migrations } from '../src/schema.js'
import { nativeCategoryId } from '../src/registry/native-category.js'
import { NATIVE_FEEDS } from '../src/sources/supply-feeds.js'
import { expires } from '../src/sources/supply-validity.js'
import { DAY } from '../src/sources/supply-api.js'
import {
  hyperliquidTokenDetails, HYPE_TOKEN_ID, HYPEREVM_FULL_SUPPLY, MAX_AGE,
} from '../src/sources/supply-hyperliquid.js'

const bundle = loadBundle()
const catalog = adaptBundle(bundle)
// Jupiter lists this SPL mint as "HYPE" (dev hypbpm7…, 647,449.98 supply, created 2025-10-08). Its 1:1 backing by
// HyperCore HYPE is not verifiable from the node's sources, so it must never take the HYPE ticker.
const SOLANA_HYPE = 'solana:98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g'

// Shape of POST /info {"type":"spotMetaAndAssetCtxs"} (2026-11-19): token rows are addressed by their `index`
// field (not array position), pair rows by name, and contexts by pair index; '#…' contexts are not spot pairs.
function spotReply() {
  const tokens = [
    { name: 'USDC', index: 0 },
    { name: 'PURR', index: 1 },
    { name: 'UBTC', index: 197 },
    { name: 'HYPE', index: 150, tokenId: HYPE_TOKEN_ID },
    { name: 'USDT0', index: 268 },
  ]
  const universe = [
    { tokens: [1, 0], name: 'PURR/USDC', index: 0 },
    { tokens: [150, 0], name: '@107', index: 1 },
    { tokens: [197, 0], name: '@142', index: 2 },
    { tokens: [150, 268], name: '@207', index: 3 },
    { tokens: [999, 0], name: '@9', index: 4 },
  ]
  const ctx = (coin, midPx, markPx, dayNtlVlm, dayBaseVlm) => ({ coin, midPx, markPx, prevDayPx: markPx, dayNtlVlm, dayBaseVlm,
    circulatingSupply: '1', totalSupply: '1' })
  return [{ tokens, universe }, [
    ctx('PURR/USDC', '0.0846885', '0.08474', '1190613.8', '14695192.0'),
    ctx('@107', '68.8105', '68.823', '37078384.1', '553775.65'),
    ctx('@142', null, '63900.0', '37791690.9', '591.4'),
    ctx('@207', '68.79', '68.8', '1000.0', '14.5'),
    ctx('@9', '1.0', '1.0', '0', '0'),
    ctx('#373891', '0.5', '0.5', '10', '20'),
  ]]
}

test('Hyperliquid spot names (PURR/USDC, @107) map through spotMeta.tokens by index; perps stay derivatives', () => {
  const spot = catalog.exchanges.find(e => e.id === 'hyperliquid-spot')
  const perps = catalog.exchanges.find(e => e.id === 'hyperliquid')
  assert.equal(spot.derivativeOnly, false)
  assert.equal(perps.derivativeOnly, true)
  assert.deepEqual(spot.ticker.body, { type: 'spotMetaAndAssetCtxs' })
  assert.equal(spot.ticker.cost, 20)
  assert.equal(spot.publishMarketData, false, 'Hyperliquid data stays local')
  const rows = [...tickerRecords(spot, spotReply())]
  const pairs = Object.fromEntries(rows.map(r => [r.raw, r.pair?.join('-') ?? null]))
  assert.deepEqual(pairs, { 'PURR/USDC': 'PURR-USDC', '@107': 'HYPE-USDC', '@142': 'UBTC-USDC', '@207': 'HYPE-USDT0',
    '@9': null, '#373891': null })
  const hype = rows.find(r => r.raw === '@107')
  assert.equal(hype.price, '68.8105')
  assert.equal(hype.quoteVolume, '37078384.1')
  assert.equal(rows.find(r => r.raw === '@142').price, '63900.0', 'markPx stands in when the book has no mid')
})

test('spot tickers register HYPE markets on hyperliquid:native and keep the raw coin for candles', async t => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const registry = new Registry(store, catalog)
  // A discovered Solana token with the same label exists on the node (as on the owner's node).
  registry.token('solana', SOLANA_HYPE.slice(7), { symbol: 'HYPE', name: 'HYPE', decimals: 9 })
  const venue = catalog.exchanges.find(e => e.id === 'hyperliquid-spot')
  let published = []
  const http = { get: async (url, rpm, cost, body) => {
    assert.equal(url, 'https://api.hyperliquid.xyz/info')
    assert.deepEqual(body, { type: 'spotMetaAndAssetCtxs' })
    return spotReply()
  } }
  const count = await fetchTickers({ venue, http, registry, clock: () => 1_795_100_000_000,
    publish: rows => { published = rows }, discover: () => {}, saveDerivative: () => assert.fail('spot row saved as derivative') })
  const hype = registry.markets.get('cex:hyperliquid-spot:HYPE-USDC')
  assert.equal(hype.base, 'hyperliquid:native')
  assert.equal(hype.symbol, '@107')
  assert.equal(registry.markets.get('cex:hyperliquid-spot:HYPE-USDT0').quote, 'arbitrum:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9')
  assert.equal(registry.markets.get('cex:hyperliquid-spot:UBTC-USDC').base, 'hyperevm:0x9fdbda0a5e284c32744d2f17ee5c74b284993463')
  assert.equal(registry.markets.get('cex:hyperliquid-spot:PURR-USDC').symbol, 'PURR/USDC')
  assert.ok(count >= 4 && published.every(row => !row[0].includes('#')))
  assert.ok([...registry.markets.values()].every(m => m.base !== SOLANA_HYPE))
})

test('HYPE tickers bind to HyperCore HYPE on every venue and never to the unverified Solana HYPE mint', async t => {
  for (const venue of catalog.exchanges) assert.equal(venue.symbolMap.HYPE, 'hyperliquid:native', venue.id)
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const registry = new Registry(store, catalog)
  registry.token('solana', SOLANA_HYPE.slice(7), { symbol: 'HYPE', name: 'HYPE', decimals: 9 })
  for (const [venue, quote] of [['bybit', 'USDT'], ['okx', 'USDT'], ['gate', 'USDT'], ['kucoin', 'USDT'], ['bitget', 'USDT']])
    assert.equal(registry.cex(venue, 'HYPE', quote)?.base, 'hyperliquid:native', venue)
  // Even a signed but unlinked Solana HYPE identity would not take the label: the shared native mapping wins.
  const withMint = structuredClone(bundle)
  withMint.tokens.tokens.push({ id: SOLANA_HYPE, symbol: 'HYPE', name: 'HYPE', decimals: 9, source: 'gator-curated', links: [] })
  const adapted = adaptBundle(withMint)
  const store2 = openStore({ file: ':memory:', migrations })
  t.after(() => store2.close())
  assert.equal(new Registry(store2, adapted).cex('bybit', 'HYPE', 'USDT').base, 'hyperliquid:native')
  assert.ok(!bundle.tokens.tokens.some(t => t.id === SOLANA_HYPE || t.links.includes(SOLANA_HYPE)))
})

// tokenDetails for HYPE on 2026-11-19 (genesis list and prices omitted).
const details = () => ({
  name: 'HYPE', maxSupply: '1000000000.0', totalSupply: '998720525.1321299076', circulatingSupply: '301558048.7813248634',
  szDecimals: 2, weiDecimals: 8, midPx: '68.7905', genesis: { userBalances: [], existingTokenBalances: [] },
  nonCirculatingUserBalances: [
    ['0x43e9abea1910387c4292bca4b94de81462f8a251', '238275372.8628970385'],
    ['0xfefefefefefefefefefefefefefefefefefefefe', '49091295.1547392309'],
    ['0x0000000000000000000000000000000000000000', '1673.78676325'],
    ['0x000000000000000000000000000000000000dead', '2.71671343'],
  ],
  futureEmissions: '409794131.8296920061',
})

test('HYPE supply comes from Hyperliquid tokenDetails with its method, source and a two-day maximum age', () => {
  const now = 1_795_100_000_000
  const result = hyperliquidTokenDetails(details(), now)
  assert.deepEqual(result, { value: '301558048.7813248634', total: '998720525.1321299076', at: now, expiresAt: now + 2 * DAY,
    method: 'hyperliquid-token-details', source: 'hyperliquid-token-details' })
  assert.equal(MAX_AGE, 2 * DAY)
  assert.equal(expires(result), now + MAX_AGE)
  // Circulating must equal total minus listed non-circulating balances minus future emissions.
  assert.throws(() => hyperliquidTokenDetails({ ...details(), circulatingSupply: '401558048.7813248634' }, now), /Inconsistent/)
  assert.throws(() => hyperliquidTokenDetails({ ...details(), totalSupply: '1000000001' }, now), /Inconsistent/)
  assert.throws(() => hyperliquidTokenDetails({ ...details(), name: 'PURR' }, now), /Invalid/)
  assert.throws(() => hyperliquidTokenDetails({ ...details(), nonCirculatingUserBalances: [['0xabc', '1']] }, now), /non-circulating/)
  assert.throws(() => hyperliquidTokenDetails(null, now), /Invalid/)
  // Registered ahead of the spot-context feed; both read only the HyperCore identity.
  const feeds = NATIVE_FEEDS.filter(f => f.asset === 'hyperliquid:native')
  assert.deepEqual(feeds.map(f => f.api), ['hyperliquid-token-details', 'hyperliquid-spot'])
  assert.deepEqual(feeds[0].body, { type: 'tokenDetails', tokenId: HYPE_TOKEN_ID })
  const api = bundle.apis.find(a => a.id === 'hyperliquid-token-details')
  assert.equal(api.terms.redistribution, 'unclear', 'the reading stays local')
  // The shared api.hyperliquid.xyz bucket must not drop below the exchange records' weight budget.
  assert.ok(api.requestsPerMinute >= 1200)
})

test('Hyperliquid chain records validate: HyperCore and HyperEVM share one HYPE, verified RPCs, V3 factories', () => {
  const core = bundle.chains.find(c => c.id === 'hyperliquid'), evm = bundle.chains.find(c => c.id === 'hyperevm')
  assert.equal(core.family, 'hyperliquid')
  assert.deepEqual(core.native, { symbol: 'HYPE', decimals: 8 })
  assert.ok(core.endpoints.filter(e => e.verified.ok).length >= 3)
  assert.equal(evm.family, 'evm')
  assert.equal(evm.chainId, 999)
  assert.deepEqual(evm.native, { symbol: 'HYPE', decimals: 18 })
  assert.ok(evm.endpoints.length >= 3 && evm.endpoints.every(e => e.verified.ok && e.verified.result === '0x3e7'))
  const token = id => bundle.tokens.tokens.find(t => t.id === id)
  assert.deepEqual(token('hyperliquid:native').links, ['hyperevm:native'])
  assert.deepEqual(token('hyperevm:native').links, ['hyperliquid:native'])
  const dex = bundle.dex.evm.find(d => d.chain === 'hyperevm')
  assert.deepEqual(dex.deployments.map(d => [d.name, d.kind]), [['HyperSwap V3', 'v3'], ['Project X V3', 'v3']])
  assert.equal(bundle.paidExtras.hyperevm, '')
  // Only the HyperCore identity carries a supply job, so the coin's cap counts once.
  const adaptedEvm = catalog.chains.find(c => c.id === 'hyperevm')
  assert.ok(adaptedEvm.endpoints.length >= 3 && adaptedEvm.deployments.length === 2)
  assert.equal(catalog.chains.find(c => c.id === 'hyperliquid').endpoints.length, 0, 'no EVM/Solana reader for HyperCore')
  // HyperEVM ERC-20 readings only for tokens whose totalSupply is their whole supply (no HyperCore pre-mint).
  for (const id of HYPEREVM_FULL_SUPPLY) assert.ok(token(id), id)
  // USDC on HyperEVM (totalSupply 5.82B on 2026-11-19) is a stable anchor for pool valuation only.
  for (const symbol of ['UBTC', 'UETH', 'USOL', 'PURR', 'WHYPE', 'USDC']) {
    const t = bundle.tokens.tokens.find(x => x.id.startsWith('hyperevm:') && x.symbol === symbol)
    assert.ok(t && !HYPEREVM_FULL_SUPPLY.has(t.id), symbol)
  }
  const usdc = catalog.assets.find(a => a.id === 'hyperevm:0xb88339cb7199b77e23db6e890353e22632ba630f')
  assert.equal(usdc.stable, true)
  for (const venue of catalog.exchanges) assert.equal(venue.symbolMap.USDC, 'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')
  assert.equal(nativeCategoryId('hyperliquid:native'), 'layer-1')
  assert.equal(nativeCategoryId('hyperevm:native'), 'layer-1')
})
