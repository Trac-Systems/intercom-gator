import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { COIN_FEEDS } from '../src/sources/supply-coin-feeds.js'
import { readCirculation } from '../src/sources/supply-circulation.js'
import { tokenSupply, quant } from '../src/sources/supply-token.js'
import { word } from '../src/sources/evm-abi.js'

const sample = JSON.parse(readFileSync(new URL('fixtures/coin-supply-mainnet.json', import.meta.url)))
const now = Date.UTC(2026, 10, 19, 14, 30), day = 86400_000
// Keyless mainnet responses collected on November 19. Only fields consumed by the readers are retained.
const expected = {
  'zcash-ledger': '16973015.25350373', 'etc-blockscout': '159075303.949153086677906799',
  'monero-emission': '18833085.134928652887', 'hedera-supply': '44327616897.03852297',
  'bittensor-issuance': '11742122.003206764', 'icp-ledger': '559055345.80571279',
  'polkadot-issuance': '1691388543.4197930497', 'kaspa-supply': '27818115901.28163331',
  'algorand-supply': '9081580690', 'filfox-supply': '928004480.724649128182862744',
  'pi-mainnet-supply': '11401653831.367605', 'pearl-blockbook': '384045029.10454513',
  'zilliqa-supply': '20650731367.226546319917', 'lunc-bank': '6442643078351.400543',
  'bitfinex-leo': '919857851.9', 'render-foundation': '481144915.0816846',
  'chainlink-supply': '766849970.424883961240529443', 'wlfi-supply': '31780562427',
  'whitechain-issuance': '73625000.891750309520656226', 'wbt-tronscan': '79375000',
  'htx-tronscan': '888846370538192', 'jst-tronscan': '8018019892.341737',
}
for (const feed of COIN_FEEDS) {
  test(feed.method + ' reads ' + feed.asset + ' in whole coins with bounded freshness', () => {
    const r = readCirculation(feed, sample[feed.api], now)
    assert.equal(r.source, feed.api)
    assert.equal(r.method, feed.method)
    assert.equal(r.value, expected[feed.api])
    assert.equal(r.expiresAt, r.at + 2 * day)
    assert.ok(r.total == null || Number(r.total) >= Number(r.value))
    assert.throws(() => readCirculation(feed, null, now))
    if (r.at !== now) assert.throws(() => readCirculation(feed, sample[feed.api], r.expiresAt))
  })
}
test('rejects unsynchronized chains, the wrong ledger unit and duplicated reserves', () => {
  for (const [api, change] of [
    ['zcash-ledger', r => { r.result.chain = 'test' }], ['zcash-ledger', r => { r.result.headers++ }],
    ['zcash-ledger', r => { r.result.valuePools.pop(); r.result.valuePools.pop() }],
    ['polkadot-issuance', r => { r.data.detail.DOT.token_decimals = 18 }],
    ['pearl-blockbook', r => { r.blockbook.inSync = false }],
    ['chainlink-supply', r => { r.balances.push(r.balances[0]) }],
    ['hedera-supply', r => { r.released_supply = '5000000000000000001' }],
    ['render-foundation', r => { r.solanaCirculatingSupply = r.totalSupply }],
    ['lunc-bank', r => { r.amount.denom = 'uusd' }],
  ]) {
    const data = structuredClone(sample[api])
    change(data)
    assert.throws(() => readCirculation(COIN_FEEDS.find(f => f.api === api), data, now), api)
  }
})

test('Quant uses the bound crowdsale ledger and excludes tokens stranded in its own contract', async () => {
  const sale = '0x398e41ac3d5972b4bac2320cd130c7a25ca446f7', address = quant.split(':')[1]
  // Mainnet block 26449861, including the dead-address and token-contract balances.
  const results = [BigInt(address), 0x70ef4f4b2e4f070fda0bdn, 0x12f0e9bce8c2f025968d2n,
    0n, 0n, 0x19fb0da6b738a59n, 0x7e67b27bcff8b9d484985n]
  const rpc = { batch: async (_, requests) => {
    assert.deepEqual(requests.slice(0, 3).map(r => r.params[0]), ['0xfc0c546a', '0x7365e2d7', '0x7df042a2'].map(data => ({ to: sale, data })))
    assert.deepEqual(requests.slice(3).map(r => r.params[0]), [0, 1, 0xdead, address].map(a => ({ to: address, data: '0x70a08231' + word(a) })))
    return results.map(n => '0x' + word(n))
  } }
  const run = () => tokenSupply({ id: quant, address }, { id: 'ethereum', family: 'evm' }, rpc, {})
  const r = await run()
  assert.equal(r.total, '24431259.031815365879859599')
  assert.equal(r.value, '14880362.073480871290811825')
  assert.equal(r.estimate, true)
  results[0] = 0n
  await assert.rejects(run(), /crowdsale/)
})
