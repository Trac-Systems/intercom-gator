import test from 'node:test'
import assert from 'node:assert/strict'
import { emissionAtHeight } from '../src/sources/supply-emission.js'

for (const [chain, period] of [['bitcoin', 210000], ['bitcoin-cash', 210000], ['litecoin', 840000]]) {
  test(chain + ' issuance excludes genesis and halves starting at the boundary block', () => {
    assert.equal(emissionAtHeight(chain, 0), '0')
    assert.equal(emissionAtHeight(chain, 1), '50')
    assert.equal(emissionAtHeight(chain, period - 1), String(50 * (period - 1)))
    assert.equal(emissionAtHeight(chain, period), String(50 * (period - 1) + 25))
    assert.equal(emissionAtHeight(chain, 2 * period), String(75 * period - 37.5))
  })
}
test('Bitcoin subsidy truncates fractional satoshis, then stops permanently', () => {
  assert.equal(emissionAtHeight('bitcoin', 32 * 210000), '20999949.97480001')
  assert.equal(emissionAtHeight('bitcoin', 33 * 210000), '20999949.9769')
  assert.equal(emissionAtHeight('bitcoin', Number.MAX_SAFE_INTEGER), '20999949.9769')
})
test('Dogecoin anchors actual randomized rewards and includes each fixed-era transition', () => {
  assert.equal(emissionAtHeight('dogecoin', 0), '0')
  assert.equal(emissionAtHeight('dogecoin', 144998), null)
  let total = 61175406271
  assert.equal(emissionAtHeight('dogecoin', 144999), String(total))
  for (const [height, size, reward] of [[145000,55000,250000], [200000,100000,125000],
    [300000,100000,62500], [400000,100000,31250], [500000,100000,15625], [600000,100000,10000]]) {
    assert.equal(emissionAtHeight('dogecoin', height), String(total + reward))
    total += size * reward
    assert.equal(emissionAtHeight('dogecoin', height + size - 1), String(total))
  }
})
test('invalid heights cannot produce issuance', () => {
  for (const h of [-1, 4.5, NaN, '144999', Infinity]) assert.throws(() => emissionAtHeight('bitcoin', h))
  assert.equal(emissionAtHeight('unknown', 900000), null)
})
