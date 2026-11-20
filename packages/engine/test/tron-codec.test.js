import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { tronAddress, tronHex } from '../src/sources/tron/address.js'
import { FACTORIES, USDT, WTRX } from '../src/sources/tron/deployments.js'
import { creationReceipt, eventPath, hintFactory, parsePage } from '../src/sources/tron/events.js'
import { seedPlan, snapshots } from '../src/sources/tron/state.js'

const fixture = name => JSON.parse(readFileSync(new URL('./fixtures/tron/' + name + '.json', import.meta.url)))

test('TRON mainnet Base58Check, network prefix and 20-byte ABI addresses round trip', () => {
  const hex = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c'
  assert.equal(tronHex(USDT), hex)
  assert.equal(tronAddress(hex), USDT)
  assert.equal(tronAddress('0x' + hex.slice(2)), USDT)
  for (const bad of [USDT.toLowerCase(), USDT.slice(0, -1) + 'u', USDT + '1', null]) assert.equal(tronHex(bad), null)
  for (const bad of ['42' + hex.slice(2), hex.slice(2), hex + '0', null]) assert.equal(tronAddress(bad), null)
  // Older signed schemas check the spelling only. A bad checksum must not stop the other chain jobs at startup.
  assert.deepEqual(seedPlan([{ chain: 'tron', address: USDT.slice(0, -1) + 'u' }]), seedPlan([]))
})

for (const factory of FACTORIES.filter(f => f.event)) {
  test('confirmed SunSwap ' + factory.kind + ' event and its solidified creation receipt agree', () => {
    const window = { from: 0, until: 1800000000000 }
    const page = fixture(factory.kind + '-events'), receipt = fixture(factory.kind + '-receipt')
    const { pools, fingerprint } = parsePage(factory, page, window)
    assert.equal(pools.length, 3)
    const [p] = pools
    assert.equal(hintFactory(p), factory)
    assert.deepEqual(creationReceipt(p, receipt), { fee: p.fee, firstSeen: p.firstSeen })
    for (const other of [{ pool: WTRX }, { block: p.block + 1 }, { token0: p.token1 }, { tx: '1'.repeat(64) }])
      assert.equal(creationReceipt({ ...p, ...other }, receipt), null)
    const wrongLog = { ...receipt.log[0], topics: ['a'.repeat(64), ...receipt.log[0].topics.slice(1)] }
    assert.equal(creationReceipt(p, { ...receipt, log: [wrongLog] }), null)
    assert.equal(creationReceipt(p, { ...receipt, receipt: { result: 'REVERT' } }), null)
    const resume = eventPath(factory, { ...window, fingerprint })
    const params = new URLSearchParams(resume.split('?')[1])
    assert.equal(params.get('fingerprint'), page.meta.fingerprint)
    assert.equal(params.get('only_confirmed'), 'true')
    assert.equal(params.get('order_by'), 'block_timestamp,asc')
    assert.throws(() => parsePage(factory, page, { ...window, fingerprint }), /continuation/)
    assert.throws(() => parsePage(factory, { ...page, data: [{ ...page.data[0], contract_address: USDT }],
      meta: { page_size: 1 } }, window), /factory event/)
  })
}

test('one solidified block prices real V2 reserves, V3 slot0 and legacy native TRX reserves', async () => {
  const { at, pools, calls } = fixture('state')
  const client = { async aggregate(requests) {
    assert.deepEqual(requests, calls.map(({ to, data }) => ({ to, data })))
    return { at, values: calls.map(c => c.result) }
  } }
  const rows = await snapshots(pools.map(p => ({ ...p, token0: p.currencies[0], token1: p.currencies[1] })), client, { assets: new Map([['tron:native', { decimals: 6 }]]) })
  const [v2, v3, v1] = rows.map(r => r.state)
  assert.equal(v2.reserve0, 145865830.651025)
  assert.equal(v2.reserve1, 45334215.309779)
  assert.ok(Math.abs(v2.price - 0.3107939338) < 1e-9)
  assert.ok(Math.abs(v3.price - 0.3105846875) < 1e-9)
  assert.equal(v3.reserve1, 23978485.062176)
  assert.ok(Math.abs(1 / v1.price - 0.31088) < 0.0001)
  assert.equal(rows[0].info.token1.symbol, 'USDT')
  assert.ok(rows.every(r => r.at === at))
})
