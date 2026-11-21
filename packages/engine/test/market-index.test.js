import test from 'node:test'
import assert from 'node:assert/strict'
import { MarketMap } from '../src/registry/index.js'

// The indexed lookups must return exactly what a full scan returns, in the same order, after any mix of inserts,
// replacements (including a market moving to another exchange or base), deletes and re-inserts.
test('market index lookups equal a full scan in map order after random changes', () => {
  let seed = 7
  const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  const map = new MarketMap()
  const exchanges = ['binance', 'kraken', 'weex', undefined]
  const bases = ['btc', 'eth', 'sol', 'usdt']
  for (let step = 0; step < 5000; step++) {
    const id = 'm' + rand(300)
    const op = rand(10)
    if (op < 7) map.set(id, { id, exchange: exchanges[rand(4)], base: bases[rand(4)] })
    else if (op < 9 && map.has(id)) map.set(id, { ...map.get(id), symbol: 'x' + step })
    else map.delete(id)
    if (step % 97 === 0 || step === 4999) {
      for (const exchange of exchanges.filter(Boolean)) {
        assert.deepEqual([...map.where('exchange', exchange)], [...map.values()].filter(m => m.exchange === exchange))
      }
      for (const base of bases) {
        assert.deepEqual([...map.where('base', base)], [...map.values()].filter(m => m.base === base))
      }
    }
  }
  map.clear()
  assert.deepEqual([...map.where('exchange', 'binance')], [])
  assert.equal(map.size, 0)
})
