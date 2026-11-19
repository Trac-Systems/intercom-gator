import test from 'node:test'
import assert from 'node:assert/strict'
import { flagReader } from '../src/sources/names/flags.js'

const engine = { clock: () => 0, store: { writer: { prepare: () => ({ all: () => [] }) } } }

test('issuer symbols flag imposters but not the issuer or bridged deployments the signed bundle lists', () => {
  const bridged = 'bsc:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'
  const seeds = new Map([[bridged, { id: bridged, symbol: 'USDC', address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' }]])
  const flags = flagReader(engine, seeds)
  assert.deepEqual(flags('ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'USDC'), [])
  assert.deepEqual(flags(bridged, 'USDC'), [])
  assert.deepEqual(flags('bsc:0x' + '1'.repeat(40), 'USDC'), ['imitates:USDC'])
  assert.deepEqual(flags('bsc:0x' + '1'.repeat(40), 'FISH'), [])
})
