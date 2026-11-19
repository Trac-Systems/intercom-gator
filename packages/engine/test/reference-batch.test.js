import test from 'node:test'
import assert from 'node:assert/strict'
import { Engine } from '../src/index.js'

test('the price reference pins the top assets without a market of their own into every batch', () => {
  const ids = ['ethereum:usdt', 'tron:usdt', 'solana:usdt', 'ethereum:a', 'ethereum:b', 'ethereum:c']
  const assets = ids.map((id) => ({ id }))
  const ranks = { 'ethereum:usdt': 4, 'tron:usdt': 3, 'solana:usdt': 60, 'ethereum:a': 10, 'ethereum:b': 20, 'ethereum:c': 30 }
  const self = {
    registry: {
      main: new Map([['ethereum:usdt', 'cex:x:USDT-USD'], ['ethereum:a', 'm'], ['ethereum:b', 'm'], ['ethereum:c', 'm']]),
      assets: new Map(ids.map((id) => [id, { rank: ranks[id] }])),
    },
  }
  const batch = (cursor, pin) => Engine.prototype.referenceBatch.call(self, assets, cursor, 2, pin).map((a) => a.id)
  // Reference-only assets come first by rank, every time, without repeating one already in the slice.
  assert.deepEqual(batch(4, true), ['tron:usdt', 'solana:usdt', 'ethereum:b', 'ethereum:c'])
  assert.deepEqual(batch(0, true), ['solana:usdt', 'ethereum:usdt', 'tron:usdt'])
  // Other reference sources keep the plain rotation.
  assert.deepEqual(batch(4, false), ['ethereum:b', 'ethereum:c'])
})
