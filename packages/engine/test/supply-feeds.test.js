import assert from 'node:assert/strict'
import test from 'node:test'
import { tetherRows, circleRows, issuerSiblings, ISSUERS } from '../src/sources/supply-issuer.js'
import { stellarLumens, hyperliquidSpot, bitcoinCashStats } from '../src/sources/supply-feeds.js'

// Trimmed from the live replies of 2026-11-19 (read-only probes); the arithmetic below is exact.
const now = Date.parse('2026-11-19T10:00:00Z')
const tronUsdt = 'tron:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', ethUsdt = 'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7'
const tether = () => ({ data: { usdt: { id: 1795044600,
  totaltokens_tron: '94207597532.05478', reserve_balance_tron: '2469202678.196809', quarantined_tron: 0,
  totaltokens_eth: '84296691994.493958', reserve_balance_eth: '4498804504.786249', quarantined_eth: 0.0,
  totaltokens_sol: '3839918754.96687', reserve_balance_sol: '1835812633.018104', quarantined_sol: '3698541.306464',
  totaltokens_cosmos: 159997865.1663, reserve_balance_cosmos: 131998085.0543, quarantined_cosmos: 0,
  totaltokens_bnb: 0, reserve_balance_bnb: 0, quarantined_bnb: 0 } } })

test('Tether rows subtract unissued and quarantined tokens per pinned chain with exact decimals', () => {
  const rows = tetherRows(tether(), now)
  assert.deepEqual(rows.get(tronUsdt), { value: '91738394853.857971', total: '94207597532.05478', at: 1795044600000,
    method: 'issuer-circulating', source: 'tether-transparency' })
  assert.equal(rows.get(ethUsdt).value, '79797887489.707709')
  // 3839918754.96687 - 1835812633.018104 - 3698541.306464
  assert.equal(rows.get('solana:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB').value, '2000407580.642302')
  // Chains without a pinned bundle deployment (Cosmos) and chains without issuance (BNB) are ignored.
  assert.equal(rows.size, 3)
  const broken = tether()
  broken.data.usdt.reserve_balance_tron = '94207597532.05479'
  broken.data.usdt.totaltokens_eth = '1e21'
  assert.deepEqual([...tetherRows(broken, now).keys()], ['solana:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'])
  assert.throws(() => tetherRows(tether(), 1795044600000 + 5 * 86_400_000), /Tether/)
  assert.throws(() => tetherRows({ data: { usdt: { ...tether().data.usdt, id: '1795044600' } } }, now), /Tether/)
})

test('Circle maps USDC and EURC to separate native deployments, once per coin and chain', () => {
  const at = '2026-11-19T09:59:01.757Z'
  const payload = { data: [
    { symbol: 'EURC', chains: [{ chain: 'ETH', amount: '324238642.824787', updateDate: at }] },
    { symbol: 'USDC', chains: [
      { chain: 'ETH', amount: '44453803449.582333', secondaryMarketBurnedAmount: '4484490.55', updateDate: at },
      { chain: 'TRX', amount: '27934099.204966', updateDate: at },
      { chain: 'BASE', amount: '4242464802.859863', updateDate: at },
      { chain: 'BASE', amount: '1', updateDate: at },
      { chain: 'SOL', amount: '6117879725.654265', updateDate: '2026-11-01T00:00:00Z' },
      { chain: 'POLY', amount: '-5', updateDate: at },
    ] },
  ] }
  const rows = circleRows(payload, now)
  assert.equal(rows.get('ethereum:0x1abaea1f7c830bd89acc67ec4af516284b1bc33c').value, '324238642.824787')
  assert.deepEqual([...rows].filter(([id]) => id !== 'ethereum:0x1abaea1f7c830bd89acc67ec4af516284b1bc33c'), [['ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', { value: '44453803449.582333',
    at: Date.parse(at), method: 'issuer-circulating', source: 'circle-stablecoins' }]])
  assert.throws(() => circleRows({ data: [] }, now), /Circle/)
})

test('issuer siblings link only pinned deployments of the same token', () => {
  assert.ok(issuerSiblings(tronUsdt).includes(ethUsdt))
  assert.ok(!issuerSiblings(tronUsdt).includes(tronUsdt))
  assert.ok(!issuerSiblings(tronUsdt).includes(ISSUERS['circle-stablecoins'].deployments.ETH))
  assert.deepEqual(issuerSiblings('bsc:0x55d398326f99059ff775485246999027b3197955'), [])
})

test('SDF lumen metrics give circulating and total XLM from a fresh report', () => {
  const data = { updatedAt: '2026-11-19T09:54:58.444Z', totalSupply: '50001786837.3970712',
    circulatingSupply: '35418251039.9453919', sdfMandate: '14313587649.2473526' }
  assert.deepEqual(stellarLumens(data, now), { value: '35418251039.9453919', total: '50001786837.3970712',
    at: Date.parse(data.updatedAt), method: 'sdf-lumen-supply', source: 'stellar-lumens' })
  assert.throws(() => stellarLumens({ ...data, circulatingSupply: '50001786837.3970713' }, now), /Stellar/)
  assert.throws(() => stellarLumens({ ...data, updatedAt: '2026-11-10T00:00:00Z' }, now), /Stellar/)
  assert.throws(() => stellarLumens({ ...data, totalSupply: 50001786837.39 }, now), /Stellar/)
})

test('Hyperliquid HYPE supply comes from the pinned token id and its USDC pair context', () => {
  const meta = { tokens: [{ name: 'USDC', index: 0 },
    { name: 'HYPE', index: 150, tokenId: '0x0d01dc56dcaaca66ad901c959b4011ec' },
    { name: 'HYPE', index: 999, tokenId: '0xffffffffffffffffffffffffffffffff' }],
  universe: [{ tokens: [999, 0], name: '@1', index: 0 }, { tokens: [150, 268], name: '@207', index: 1 },
    { tokens: [150, 0], name: '@107', index: 2 }] }
  const contexts = [{ coin: '@1', circulatingSupply: '1', totalSupply: '1' },
    { coin: '@207', circulatingSupply: '2', totalSupply: '2' },
    { coin: '@107', circulatingSupply: '301556112.0284147859', totalSupply: '998721166.0017445087', markPx: '68.531' }]
  assert.deepEqual(hyperliquidSpot([meta, contexts], now), { value: '301556112.0284147859', total: '998721166.0017445087',
    at: now, method: 'hyperliquid-spot-supply', source: 'hyperliquid-spot' })
  const swapped = structuredClone(contexts)
  swapped[2].coin = '@207'
  assert.throws(() => hyperliquidSpot([meta, swapped], now), /HYPE/)
  assert.throws(() => hyperliquidSpot({ tokens: [] }, now), /Hyperliquid/)
})

test('BCH issuance follows the Bitcoin subsidy schedule from the stated tip height', () => {
  // 210000 * (50 + 25 + 12.5 + 6.25) + (978005 - 840000 + 1) * 3.125 - 50 (unspendable genesis)
  assert.deepEqual(bitcoinCashStats({ context: { code: 200 }, data: { best_block_height: 978005 } }), {
    value: '20118718.75', total: '20118718.75', block: 978005, method: 'scheduled-emission', estimate: true,
    source: 'bitcoin-cash-stats' })
  assert.throws(() => bitcoinCashStats({ context: { code: 430 }, data: { best_block_height: 978005 } }), /BCH/)
  assert.throws(() => bitcoinCashStats({ context: { code: 200 }, data: { best_block_height: 100 } }), /BCH/)
})
