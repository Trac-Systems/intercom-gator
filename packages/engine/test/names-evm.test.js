import test from 'node:test'
import assert from 'node:assert/strict'
import { word } from '../src/sources/evm-abi.js'
import { loadBundle } from '@gator/bundle'
import { adaptBundle } from '../src/sources/bundle-adapter.js'
import { abiLabel, evmNames } from '../src/sources/names/evm.js'
import { cleanLabel } from '../src/sources/names/text.js'
import { RateLimited } from '../src/scheduler/index.js'

const dynamic = text => {
  const hex = Buffer.from(text).toString('hex')
  return '0x' + word(32) + word(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0')
}
const fixed = text => '0x' + Buffer.from(text).toString('hex').padEnd(64, '0')
const aggregate = values => {
  const tuples = values.map(v => word(1) + word(64) + word((v.length - 2) / 2) + v.slice(2))
  let offset = 32 * values.length
  const offsets = tuples.map(v => { const pos = offset; offset += v.length / 2; return word(pos) })
  return '0x' + word(32) + word(values.length) + offsets.join('') + tuples.join('')
}

test('ABI string and padded bytes32 decode strictly, and display labels have Unicode character bounds', () => {
  assert.equal(abiLabel(dynamic('Silly Dragon')), 'Silly Dragon')
  assert.equal(abiLabel(fixed('MKR')), 'MKR')
  for (const raw of ['0x11', dynamic('x').slice(0, -2), '0x' + word(64) + word(1), '0xff' + '00'.repeat(31)])
    assert.equal(abiLabel(raw), null)
  assert.equal(cleanLabel('  ＵＳ\x00Ｄ\u202e\u200bＣ ', 16, ''), 'USDC')
  assert.equal(cleanLabel('\u200b\x00', 64, ''), null)
  assert.equal(cleanLabel('A'.repeat(42), 16, 'A'.repeat(42)), null)
  assert.equal(cleanLabel('🐉'.repeat(100), 64, ''), '🐉'.repeat(64))
  assert.equal(cleanLabel('a'.repeat(256), 16, ''), 'a'.repeat(16))
})

test('two EVM assets share one Multicall3 request to the chain deployment', async () => {
  const results = [dynamic('Silly Dragon'), dynamic('SILLY'), '0x' + word(9), '0x' + word(1e9),
    fixed('Maker'), fixed('MKR'), '0x' + word(18), '0x' + word(0)]
  const chain = { id: 'zksync', multicall: '0xf9cda624fbc7e059355ce98a31693d299facd963' }
  const addresses = [1, 2].map(n => ({ address: '0x' + word(n).slice(-40) }))
  let count = 0
  const rpc = { call: async (id, method, [call]) => {
    count++
    assert.equal(id, chain.id)
    assert.equal(call.to, chain.multicall)
    assert.ok(call.data.startsWith('0x82ad56cb'))
    return aggregate(results)
  } }
  const rows = await evmNames(chain, addresses, rpc, {}, new Map(), 0)
  assert.equal(count, 1)
  assert.deepEqual(rows[0], { name: 'Silly Dragon', symbol: 'SILLY', decimals: 9, method: 'erc20', totalSupply: 1 })
  assert.equal(rows[1].symbol, 'MKR')
})

test('missing multicall falls back to single selectors and resumes after a budget deferral', async () => {
  const asset = { address: '0x' + word(1).slice(-40) }, chain = { id: 'eth' }, reads = {}, cooldown = new Map()
  const results = [dynamic('Dragon'), fixed('D'), '0x' + word(0), '0x' + word(42)]
  let i = 0, deferred = false, aggregates = 0
  const rpc = { async call(id, method, [call]) {
    if (call.to !== asset.address) { aggregates++; return '0x' }
    if (i === 1 && !deferred) { deferred = true; throw new RateLimited(100) }
    return results[i++]
  } }
  await assert.rejects(evmNames(chain, [asset], rpc, reads, cooldown, 0), RateLimited)
  const [row] = await evmNames(chain, [asset], rpc, reads, cooldown, 100)
  assert.deepEqual([aggregates, i, row.name, row.symbol, row.totalSupply], [1, 4, 'Dragon', 'D', 42])
})

test('malformed registry addresses do not invalidate other contracts or spend individual RPC calls', async () => {
  const address = '0x' + word(4).slice(-40), targets = [], cooldown = new Map(), first = { address: 'broken' }
  const rpc = { async call(id, method, [call]) {
    targets.push(call.to)
    if (call.to !== address) return '0x'
    return { '0x06fdde03': dynamic('Good'), '0x95d89b41': fixed('G'), '0x313ce567': '0x' + word(4) }[call.data] ?? '0x'
  } }
  const rows = await evmNames({ id: 'eth' }, [first, { address }, { address: '0x' + word(5).slice(-40) }], rpc, {}, cooldown, 0)
  assert.equal(rows.length, 2) // The last contract remains due for its own single-call turn.
  assert.equal(rows[0], null)
  assert.equal(rows[1].name, 'Good')
  assert.deepEqual(targets.slice(1), Array(4).fill(address))
})

test('each signed EVM chain executes the metadata batch against its own Multicall3 deployment', async () => {
  const chains = adaptBundle(loadBundle()).chains.filter(c => c.family === 'evm')
  const values = [dynamic('Example'), fixed('EX'), '0x' + word(9), '0x' + word(0)]
  const visited = []
  for (const chain of chains) {
    const rpc = { async call(id, method, [call, block]) {
      visited.push(id)
      assert.equal(method, 'eth_call')
      assert.equal(block, 'latest')
      assert.equal(call.to, chain.multicall)
      assert.ok(call.data.startsWith('0x82ad56cb'))
      return aggregate(values)
    } }
    const result = await evmNames(chain, [{ address: '0x' + word(1234).slice(-40) }], rpc, {}, new Map(), 1)
    assert.equal(result[0].name, 'Example')
  }
  assert.deepEqual(visited, chains.map(c => c.id))
  assert.ok(visited.includes('zksync') && visited.includes('robinhood'))
})
