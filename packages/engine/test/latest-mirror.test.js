import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { loadBundle } from '@gator/bundle'
import { openStore } from '@gator/store'
import { migrations as socialMigrations } from '@gator/social'
import { Engine, migrations } from '../src/index.js'

const start = Date.UTC(2026, 10, 20, 12)
const DAY = 86400_000
const peer = 'b'.repeat(64)

class Transport extends EventEmitter {
  publicKey = 'a'.repeat(64)
  topics = new Map()
  channels() { return [...this.topics.keys()] }
  async join(channel, policy) { this.topics.set(channel, policy); return true }
  async leave(channel) { return this.topics.delete(channel) }
  send() { return true }
}

async function fixture(t) {
  const bundle = structuredClone(loadBundle())
  bundle.exchanges = bundle.exchanges.filter(s => s.id === 'bitstamp')
  bundle.tokens.tokens = bundle.tokens.tokens.filter(token => token.coin === 'tether-usdt')
  const store = openStore({ file: ':memory:', profile: 'small', migrations: [...migrations, ...socialMigrations] })
  let now = start
  const engine = new Engine({ bundle, transport: new Transport(), store, clock: () => now, backgroundJobs: [], random: () => 0.5,
    rpcConfig: { bundleDigest: '0'.repeat(64), fetch: () => assert.fail('Unexpected HTTP read'), timeout: 500, retries: 0,
      requestsPerMinute: 60 } })
  await engine.start()
  clearTimeout(engine.timer)
  t.after(async () => { await engine.stop(); store.close() })
  const book = engine.book
  const market = (base, quote) => engine.registry.cex('bitstamp', base, quote)
  const row = (m, price, at = now) => [m.id, String(price), 1, String(price), null, null, at]
  /** The mirror's rows against a fresh read of engine_latest + obs (order is not part of the contract). */
  const table = () => {
    const saved = book.latest
    book.latest = null
    book.checkLatest(now)
    const fresh = book.latest
    book.latest = saved
    return fresh
  }
  const flat = latest => [...latest].flatMap(([m, rows]) => [...rows].map(([r, l]) => JSON.stringify([m, r, l]))).sort()
  const same = message => assert.deepEqual(flat(book.latest), flat(table()), message)
  return { engine, store, book, market, row, same, now: () => now, advance: ms => { now += ms } }
}

test('the in-memory latest rows always equal engine_latest joined to obs', async t => {
  const { engine, store, book, market, row, same, now, advance } = await fixture(t)
  const btc = market('BTC', 'USD'), eth = market('ETH', 'USD')
  engine.publish([row(btc, 100_000), row(eth, 3_000)])
  book.refresh()
  assert.ok(book.latest.size >= 2, 'loaded on the first rebuild')
  same('after the first load')

  advance(30_000)
  engine.publish([row(btc, 100_500)])
  book.ingest(peer, [row(btc, 100_400), row(eth, 3_010)], false)
  same('own and peer receipts')
  assert.equal(book.latest.get(btc.id).get(engine.transport.publicKey).price, '100500')

  // An older receipt never replaces the latest one.
  book.ingest(peer, [row(btc, 99_000, now() - 20_000)], false)
  same('older receipt')
  assert.equal(book.latest.get(btc.id).get(peer).price, '100400')

  // The 24 h prune deletes rows older than a day; the mirror drops the same rows.
  advance(DAY + 60_000)
  engine.publish([row(eth, 3_100)])
  store.prune({ now: now() })
  same('after the prune')
  assert.equal(book.latest.has(btc.id), false)

  // A market re-mapped to another pair loses its rows.
  engine.registry.register({ ...engine.registry.markets.get(eth.id), base: btc.base })
  same('after a re-mapped market')
  assert.equal(book.latest.has(eth.id), false)
})

test('drift between the mirror and engine_latest reloads it within a minute', async t => {
  const { engine, store, book, market, row, same, advance } = await fixture(t)
  const btc = market('BTC', 'USD')
  engine.publish([row(btc, 100_000)])
  book.refresh()
  advance(10_000)
  // An outer transaction that rolls back undoes the write after ingest mirrored it.
  assert.throws(() => store.transaction(() => {
    engine.publish([row(btc, 101_000)])
    throw new Error('rolled back')
  }), /rolled back/)
  assert.equal(book.latest.get(btc.id).get(engine.transport.publicKey).price, '101000')
  advance(60_000)
  book.dirty = true
  book.refresh()
  assert.equal(book.latestReloads, 1)
  same('reloaded')
  assert.equal(book.latest.get(btc.id).get(engine.transport.publicKey).price, '100000')
})

const settle = async book => { while (book.rebuilding || book.rebuildTimer) await new Promise(r => setImmediate(r)) }

test('a read never waits for a rebuild under 15 s old: it rebuilds in the background, in slices', async t => {
  const { engine, book, market, row, advance } = await fixture(t)
  const btc = market('BTC', 'USD')
  engine.publish([row(btc, 100_000)])
  book.maxStaleMs = 4000
  book.dirty = true
  book.refreshed = -Infinity
  book.refresh()
  let rebuilds = 0
  const rank = engine.registry.rankMarkets.bind(engine.registry)
  engine.registry.rankMarkets = (...args) => { rebuilds++; return rank(...args) }
  const before = { snapshots: book.snapshots, prices: book.marketPrices }
  advance(5_000)
  engine.publish([row(btc, 101_000)])
  // Due (dirty, 5 s old): the read returns the last rebuild and leaves the new one to the background.
  assert.equal(book.refresh(), before.snapshots)
  assert.equal(rebuilds, 0)
  assert.ok(book.rebuildTimer)
  book.sliceMs = 0
  await new Promise(r => setTimeout(r, 0))
  assert.ok(book.rebuilding, 'the rebuild yields between slices')
  // Between slices every reader sees the whole previous rebuild.
  assert.equal(book.snapshots, before.snapshots)
  assert.equal(book.marketPrices, before.prices)
  assert.equal(book.refresh(), before.snapshots)
  advance(1_000)
  engine.publish([row(btc, 102_000)])
  await settle(book)
  assert.equal(rebuilds, 1)
  assert.notEqual(book.snapshots, before.snapshots)
  // Rows are read when the rebuild reaches them (with 0 ms slices: after the ingest above).
  assert.equal(book.marketPrices.get(btc.id).price, 102_000)
  assert.equal(book.dirty, true, 'an ingest during the rebuild leaves the book dirty for the next one')
  // A read older than 15 s (a stalled loop) rebuilds at once, as before.
  advance(16_000)
  book.refresh()
  assert.equal(rebuilds, 2)
  assert.equal(book.marketPrices.get(btc.id).price, 102_000)
  // A stopped book schedules nothing.
  book.stop()
  advance(5_000)
  engine.publish([row(btc, 103_000)])
  book.refresh()
  assert.equal(book.rebuildTimer, null)
})

test('coverage counts from memory exactly like the former engine_latest query', async t => {
  const { engine, store, book, market, row, advance, now } = await fixture(t)
  const btc = market('BTC', 'USD'), eth = market('ETH', 'USD')
  const proven = 'c'.repeat(64), muted = 'd'.repeat(64)
  engine.publish([row(btc, 100_000), row(eth, 3_000)])
  for (const key of [peer, proven, muted]) book.ingest(key, [row(btc, 100_100), row(eth, 3_001)], false)
  store.writer.prepare('INSERT OR REPLACE INTO engine_standing VALUES (?,?,?,?)').run(proven, 5, now(), 1)
  store.writer.prepare('INSERT OR REPLACE INTO engine_standing VALUES (?,?,?,?)').run(muted, 5, now(), 1)
  store.writer.prepare('INSERT OR REPLACE INTO reporters(key,strikes,mutedUntil) VALUES (?,5,?)').run(muted, now() + 3_600_000)
  advance(120_000)
  engine.publish([row(btc, 100_200)])
  const old = store.writer.prepare(`SELECT market,count(*) AS n,max(l.reporter=?) AS own FROM engine_latest l
    LEFT JOIN reporters r ON r.key=l.reporter LEFT JOIN engine_standing s ON s.reporter=l.reporter
    WHERE srcTs>=? AND coalesce(r.mutedUntil,0)<=? AND coalesce(r.weight,1)>0
      AND (l.reporter=? OR s.agreements>=?) GROUP BY market`)
  for (const window of [60_000, 600_000]) {
    const own = engine.transport.publicKey, since = now() - window
    const expected = new Map(old.all(own, since, now(), own, 3).map(r => [r.market, book.localOnly(r.market) ? r.own : r.n]))
    assert.deepEqual(book.countCoverage(since, now()), expected, 'window ' + window)
  }
  assert.equal(book.coverage(btc.id, 600_000), 2, 'own + proven; the unproven and the muted peer do not count')
  assert.equal(book.coverage(btc.id, 60_000), 1, 'only the fresh own row')
})
