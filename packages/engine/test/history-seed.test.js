import assert from 'node:assert/strict'
import test from 'node:test'
import { openStore } from './store-fixture.js'
import { migrations } from '../src/schema.js'
import { registerHistorySeed } from '../src/candles/seed.js'

const HOUR = 3_600_000

test('history seed fills missing hours from venue bars once per hour and never overwrites local bars', async (t) => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  let now = 1740000000000 + 30 * 60_000
  store.trackMarketActivity(() => now, store.onPrune)
  const hour = now - (now % HOUR)
  for (const [id, rank] of [['a:native', 1], ['b:native', 2]]) {
    store.upsertAsset({ id, symbol: id, name: id, rank })
    store.upsertPrice({ asset: id, price: '1', at: now, visibility: 'live' })
  }
  store.recordPrices([{ asset: 'a:native', price: '7', at: hour - HOUR + 5 }])
  const calls = []
  const jobs = []
  const engine = {
    store,
    profile: 'small',
    clock: () => now,
    book: { dirty: false },
    registerJob: (job) => jobs.push(job),
    async candles(id, options) {
      calls.push([id, options])
      const local = store.candles({ asset: id, tf: '1h', from: options.from, to: options.to })
      const venue = []
      for (let ts = options.from; ts < options.to; ts += HOUR)
        if (!local.some((b) => b.ts === ts)) venue.push({ ts, open: '5', high: '6', low: '4', close: '5', source: 'cex:v:A-USD' })
      return [...local, ...venue]
    },
  }
  const seed = registerHistorySeed(engine)
  assert.deepEqual(jobs.map((j) => j.id), ['history:seed'])
  assert.equal(seed.due(), 'a:native')
  assert.equal(await seed.run(1), 8 * 24 - 1)
  assert.equal(calls[0][1].tf, '1h')
  const bars = store.candles({ asset: 'a:native', tf: '1h', limit: 500 })
  assert.equal(bars.length, 8 * 24)
  // The node's own bar from the aggregated price stays.
  assert.equal(bars.find((b) => b.ts === hour - HOUR).close, '7')
  assert.equal(engine.book.dirty, true)
  assert.equal(seed.due(), 'b:native')
  assert.equal(await seed.run(), 8 * 24)
  assert.equal(calls.length, 2)
  // Covered assets cost no request; the next hour re-checks without re-fetching complete history.
  assert.equal(seed.due(), undefined)
  now += HOUR
  assert.equal(seed.due(), undefined)
  assert.equal(calls.length, 2)
})
