import test from 'node:test'
import assert from 'node:assert/strict'
import { openStore } from './store-fixture.js'
import { Registry } from '../src/registry/index.js'
import { MarketBook } from '../src/aggregate/book.js'
import { migrations } from '../src/schema.js'
import { CandleHistory } from '../src/candles/index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

test('SQLite raw deduplication, restart, five independent spot-check strikes and 24h data mute', (t) => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  let now = 1740000000000
  const ownKey = 'a'.repeat(64),
    other = 'b'.repeat(64)
  const catalog = {
    assets: [{ id: 'bitcoin:native', symbol: 'BTC', name: 'Bitcoin', rank: 1 }],
    chains: [],
    exchanges: [{ id: 'spot' }],
  }
  const registry = new Registry(store, catalog)
  const market = registry.cex('spot', 'BTC', 'USD').id
  const options = { store, registry, ownKey, clock: () => now }
  const book = new MarketBook(options)
  const write = (key, value) =>
    book.ingest(key, [[market, String(value), 4, null, null, null, now]], key === ownKey)
  for (let i = 0; i < 5; i++) {
    now += 60_000
    write(other, 57)
    write(ownKey, 27)
    write(ownKey, 27)
  }
  assert.equal(store.getReporter(other).strikes, 5)
  assert.equal(book.muted(other), true)
  assert.equal(book.coverage(market, 60_000), 1)
  assert.equal(store.observations({ market }).length, 10)
  assert.equal(book.refresh().get('bitcoin:native').price, 27)
  assert.equal(new MarketBook(options).refresh().get('bitcoin:native').price, 27)
  // Candles chart the aggregated price only: the muted reporter's 57 never draws a wick.
  const [bar] = store.candles({ asset: 'bitcoin:native', tf: '1d' })
  assert.deepEqual([bar.open, bar.high, bar.low, bar.close], ['27', '27', '27', '27'])
  now += 86400_000
  assert.equal(book.muted(other), false)
})

test('exchange identities require a unique or explicitly mapped symbol; quote candles stay separate', (t) => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const assets = ['foo:native', 'bar:native'].map((id) => ({ id, name: 'Shared label', symbol: 'ABC' }))
  const registry = new Registry(store, {
    assets,
    chains: [],
    exchanges: [{ id: 'a' }, { id: 'mapped', symbolMap: { ABC: 'bar:native' } }],
  })
  assert.equal(registry.cex('a', 'ABC', 'USD').base, 'unresolved:a:ABC')
  assert.equal(registry.cex('mapped', 'ABC', 'USD').base, 'bar:native')
})

test('changes use the last observed USD close at the one-hour, one-day and seven-day boundaries', (t) => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const base = 1740000000000,
    day = 86400000
  let now = base
  const registry = new Registry(store, {
    assets: [{ id: 'eth:native', symbol: 'ETH', name: 'Ethereum', rank: 2 }],
    chains: [],
    exchanges: [{ id: 'a' }],
  })
  const market = registry.cex('a', 'ETH', 'USD').id,
    ownKey = 'a'.repeat(64)
  const book = new MarketBook({ store, registry, clock: () => now, ownKey })
  registry.setSupply('eth:native', { totalSupply: 1000 })
  let snapshot
  for (const [ago, price] of [
    [7 * day, 25],
    [day, 50],
    [3600000, 80],
    [0, 100],
  ]) {
    now = base - ago
    book.ingest(ownKey, [[market, String(price), '2', null, null, null, now]], true)
    snapshot = book.refresh().get('eth:native')
  }
  assert.deepEqual([snapshot.change1h, snapshot.change24h, snapshot.change7d], [25, 100, 300])
  // No circulating figure: the cap uses the total supply until one is measured or reported.
  assert.equal(snapshot.marketCap, 100000)
  assert.equal(snapshot.fdv, 100000)
})

test("change24h follows the venues' own 24 h move when the node's history disagrees with it", (t) => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const base = 1740000000000,
    day = 86400000
  let now = base
  const registry = new Registry(store, {
    assets: [{ id: 'index:native', symbol: 'INDEX', name: 'Index', rank: 9 }],
    chains: [],
    exchanges: [{ id: 'a' }],
  })
  const market = registry.cex('a', 'INDEX', 'USD').id,
    ownKey = 'a'.repeat(64)
  const book = new MarketBook({ store, registry, clock: () => now, ownKey })
  const ticks = new Map()
  registry.venues.get('a').lastTickers = ticks
  // History written while another listing set the price ($0.0046), then the real market ($0.209, +1% on the venue).
  let snapshot
  for (const [ago, price] of [[7 * day, 0.0045], [day, 0.0046], [0, 0.209]]) {
    now = base - ago
    ticks.set(market, { at: now, dayRatio: 1.01 })
    book.ingest(ownKey, [[market, String(price), '200000', null, null, null, now]], true)
    snapshot = book.refresh().get('index:native')
  }
  assert.ok(Math.abs(snapshot.change24h - 1) < 1e-9)
  assert.equal(snapshot.change7d, null)
  // History that agrees with the venue (within 25%) keeps the node's own figures.
  now += 3600_000
  ticks.set(market, { at: now, dayRatio: 40 })
  book.ingest(ownKey, [[market, '0.21', '200000', null, null, null, now]], true)
  snapshot = book.refresh().get('index:native')
  assert.ok(Math.abs(snapshot.change24h - (0.21 / 0.0046 - 1) * 100) < 1e-6)
  assert.notEqual(snapshot.change7d, null)
  // A venue read older than two hours is not used.
  now += 60_000
  ticks.set(market, { at: now - 3 * 3600_000, dayRatio: 1.01 })
  book.ingest(ownKey, [[market, '0.211', '200000', null, null, null, now]], true)
  assert.ok(book.refresh().get('index:native').change24h > 1000)
})

test('history 1.4x away from the venues for ten minutes is dropped once a day; the importer skips outliers', (t) => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const base = 1740000000000,
    day = 86400000
  let now = base - day
  const registry = new Registry(store, {
    assets: [{ id: 'index:native', symbol: 'INDEX', name: 'Index', rank: 9 }],
    chains: [],
    exchanges: [{ id: 'a', candles: { intervals: { '1h': '60' } } }],
  })
  const market = registry.cex('a', 'INDEX', 'USD', 'INDEX-USD').id,
    ownKey = 'a'.repeat(64)
  const book = new MarketBook({ store, registry, clock: () => now, ownKey })
  const ticks = new Map()
  registry.venues.get('a').lastTickers = ticks
  const observe = (price) => {
    ticks.set(market, { at: now, dayRatio: 1.01 })
    book.ingest(ownKey, [[market, String(price), '200000', null, null, null, now]], true)
    return book.refresh().get('index:native')
  }
  observe(0.0046)
  now = base
  observe(0.209)
  const bars = () => store.candles({ asset: 'index:native', tf: '1h' }).length
  assert.ok(bars() >= 2)
  now += 9 * 60_000
  observe(0.209)
  assert.ok(bars() >= 2, 'kept until the disagreement lasted ten minutes')
  now += 2 * 60_000
  assert.ok(Math.abs(observe(0.209).change24h - 1) < 1e-9)
  assert.equal(store.candles({ asset: 'index:native', tf: '1h' }).some(b => +b.close < 0.1), false)
  assert.equal(store.candles({ asset: 'index:native', tf: '1d' }).some(b => +b.open < 0.1), false)
  // The refill never imports from a market the price leaves out as an outlier.
  const importer = (outliers) => new CandleHistory({ store, registry, clock: () => now, outliers })
  assert.deepEqual(importer(() => null).candidates('index:native', '1h').map(m => m.id), [market])
  assert.deepEqual(importer(() => [market]).candidates('index:native', '1h'), [])
})

test('asset candles follow the aggregated USD price once a cross quote converts', (t) => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  let now = 1740000000000
  const assets = [
    { id: 'a:native', symbol: 'A', name: 'Coin' },
    { id: 'b:native', symbol: 'B', name: 'Quote' },
  ]
  const registry = new Registry(store, { assets, exchanges: [{ id: 'v' }], chains: [] })
  const cross = registry.cex('v', 'A', 'B').id,
    direct = registry.cex('v', 'B', 'USD').id
  const ownKey = '1'.repeat(64),
    book = new MarketBook({ store, registry, ownKey, clock: () => now })
  book.ingest(ownKey, [[cross, '12', 1, null, null, null, now]], true)
  book.refresh()
  assert.equal(store.candles({ asset: assets[0].id }).length, 0)
  book.ingest(ownKey, [[direct, '2', 1, null, null, null, now]], true)
  book.refresh()
  now += 1000
  book.refresh()
  for (const tf of ['1m', '5m', '1h', '1d']) {
    const [bar, ...rest] = store.candles({ asset: assets[0].id, tf })
    assert.equal(rest.length, 0)
    assert.deepEqual([bar.open, bar.high, bar.low, bar.close, bar.samples], ['24', '24', '24', '24', 1])
  }
})

test('a new pool token cannot hijack a CEX label and a late supply measurement updates a stored valuation', (t) => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const asset = { id: 'eth:native', symbol: 'ETH', name: 'Ether' },
    registry = new Registry(store, { assets: [asset], chains: [], exchanges: [{ id: 's' }] })
  registry.token('sol', 'MintLabel', { symbol: 'ETH', decimals: 8 })
  assert.equal(registry.cex('s', 'ETH', 'USD').base, asset.id)
  assert.equal(registry.known('cex:s:FOOBAR-USD'), null)
  const book = new MarketBook({ store, registry, ownKey: 'a'.repeat(64), clock: () => 1740000000000 })
  book.ingest(book.ownKey, [['cex:s:ETH-USD', '2', 4, null, null, null, 1740000000000]], true)
  book.refresh()
  registry.setSupply(asset.id, { circulatingSupply: 10, totalSupply: 12 })
  book.dirty = true
  book.refresh()
  assert.equal(store.getPrice(asset.id).marketCap, 20)
  assert.equal(store.getPrice(asset.id).fdv, 24)
})

test('multiple remote reports compared with the same local spot check produce at most one strike', (t) => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  let now = 1740000000000
  const registry = new Registry(store, {
    assets: [{ id: 'a:native', symbol: 'A', name: 'A' }],
    chains: [],
    exchanges: [{ id: 's' }],
  })
  const market = registry.cex('s', 'A', 'USD').id,
    ownKey = 'a'.repeat(64),
    peer = 'b'.repeat(64)
  const book = new MarketBook({ store, registry, ownKey, clock: () => now })
  book.ingest(ownKey, [[market, '10', 0, null, null, null, now]], true)
  for (let i = 0; i < 10; i++) {
    now += 10
    book.ingest(peer, [[market, '12', 0, null, null, null, now]], false)
  }
  assert.equal(store.getReporter(peer).strikes, 1)
  assert.equal(book.muted(peer), false)
})

test('reporter standing requires three independent local checks over time and survives reopening the book', t => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  let now = 1740000000000
  const registry = new Registry(store, {
    assets: [{ id: 'eth:native', symbol: 'ETH', name: 'Ether', rank: 2 }],
    exchanges: [{ id: 'spot' }, { id: 'other' }], chains: [],
  })
  const ownKey = 'a'.repeat(64), peer = 'b'.repeat(64)
  const checked = registry.cex('spot', 'ETH', 'USD').id
  const other = registry.cex('other', 'ETH', 'USD').id
  const requests = []
  const options = { store, registry, ownKey, clock: () => now, followed: key => key === peer,
    onDisagreement: market => requests.push(market) }
  let book = new MarketBook(options)
  const write = (key, market, price) => book.ingest(key, [[market, String(price), 1, null, null, null, now]], key === ownKey)

  // A follow or an echo after a local read cannot grant standing.
  write(ownKey, checked, 100)
  write(peer, checked, 100)
  assert.equal(book.standing.get(peer), undefined)
  for (const gap of [60_000, 1000, 60_000]) {
    now += gap
    write(peer, checked, 100)
    write(ownKey, checked, 100)
    assert.equal(book.isProven(peer), false)
  }
  now += 60_000
  write(peer, checked, 100)
  write(ownKey, checked, 100)
  book = new MarketBook(options)
  assert.equal(book.isProven(peer), true)
  write(peer, other, 101)
  assert.equal(book.coverage(other, 60_000), 1)
  write('c'.repeat(64), other, 30)
  assert.equal(book.refresh().get('eth:native').price, 101)
  assert.equal(book.marketPrices.get(checked).price, 100)
  assert.equal(book.marketPrices.get(other).price, 101)
  now += 500
  write(peer, checked, 125)
  assert.equal(book.isProven(peer), false)
  assert.equal(book.coverage(other, 60_000), 0)
  assert.equal(store.getReporter(peer).strikes, 1)
  assert.deepEqual(requests, [checked])
})

test('standing migration evicts the weakest, oldest checks at its hard cap', t => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const insert = store.writer.prepare('INSERT INTO engine_standing VALUES (?,?,?,?)')
  store.transaction(() => {
    insert.run('proven', 3, 0, 1)
    for (let i = 1; i <= 4096; i++) insert.run(String(i), 1, i, i)
  })
  const saved = id => store.reader.prepare('SELECT agreements FROM engine_standing WHERE reporter=?').get(id)
  assert.equal(store.reader.prepare('SELECT count(*) AS n FROM engine_standing').get().n, 4096)
  assert.equal(saved('proven').agreements, 3)
  assert.equal(saved('1'), undefined)
  assert.equal(saved('4096').agreements, 1)
})

test('only fresh, locally proven reporters at two venues can turn the trust dot green', t => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const ownKey = 'a'.repeat(64), peers = ['b', 'c', 'd', 'e'].map(c => c.repeat(64))
  let now = 1740000000000
  const registry = new Registry(store, {
    assets: [{ id: 'eth:native', symbol: 'ETH', name: 'Ether', rank: 2 }],
    exchanges: [{ id: 'one' }, { id: 'two' }], chains: [],
  })
  const a = registry.cex('one', 'ETH', 'USD').id, b = registry.cex('two', 'ETH', 'USD').id
  const book = new MarketBook({ store, registry, ownKey, clock: () => now })
  const write = (key, market) => book.ingest(key, [[market, '10', 1, null, null, null, now]], key === ownKey)
  for (let i = 0; i < 3; i++) {
    now += 60_000
    for (const key of peers) write(key, a)
    write(ownKey, a)
  }
  write('f'.repeat(64), b)
  assert.equal(book.coverage(a, 60_000), 5)
  assert.equal(book.coverage(b, 60_000), 0)
  assert.equal(book.refresh().get('eth:native').trust, 'yellow')
  write(peers[0], b)
  assert.equal(book.refresh().get('eth:native').trust, 'green')
  registry.venues.get('two').publishMarketData = false
  now += 1000
  assert.equal(book.coverage(b, 60_000), 0)
  assert.equal(book.refresh().get('eth:native').trust, 'yellow')
})

test('provisional turnover cannot promote a venue or mark an unranked market inactive', t => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const now = 1740000000000
  const registry = new Registry(store, {
    assets: [{ id: 'sample:native', symbol: 'S', name: 'Sample' }],
    exchanges: [{ id: 'one' }], chains: [],
  })
  const id = registry.cex('one', 'S', 'USD').id, ownKey = 'a'.repeat(64)
  const book = new MarketBook({ store, registry, ownKey, clock: () => now })
  const row = [id, '10', 0, null, null, null, now]
  book.ingest('b'.repeat(64), [row], false)
  book.refresh()
  assert.equal(registry.main.size, 0)
  assert.equal(registry.jobsFor(() => true)[0].active, true)
  assert.equal(book.coverage(id, 3600_000), 0)
  book.ingest(ownKey, [row], true)
  book.refresh()
  assert.equal(registry.main.get('sample:native').id, id)
})

test('the migration does not grant standing to legacy reporter weights or comparisons', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(import.meta.dirname, 'migration-'))
  const file = join(dir, 'gator.db')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const now = 1740000000000, peer = 'b'.repeat(64), ownKey = 'a'.repeat(64)
  const catalog = { assets: [{ id: 'sample:native', symbol: 'S', name: 'Sample' }], exchanges: [{ id: 'one' }], chains: [] }
  const previous = openStore({ file, migrations: migrations.slice(0, 5) })
  const market = 'cex:one:S-USD'
  try {
    previous.upsertAsset(catalog.assets[0])
    previous.upsertMarket({ id: market, base: 'sample:native', quote: 'fiat:USD', kind: 'cex', exchange: 'one' })
    previous.insertObservations([{ market, price: '12', srcTs: now, at: now, reporter: peer, baseVol24h: '10' }])
    previous.writer.exec('INSERT INTO engine_latest SELECT market,reporter,srcTs,id FROM obs')
    previous.writer.prepare('INSERT INTO reporters(key,weight) VALUES (?,20)').run(peer)
    previous.writer.exec('INSERT INTO engine_checks SELECT id FROM obs')
  } finally { previous.close() }
  const store = openStore({ file, migrations })
  try {
    const registry = new Registry(store, catalog), book = new MarketBook({ store, registry, ownKey, clock: () => now })
    assert.equal(book.refresh().get('sample:native').price, 12)
    assert.equal(book.isProven(peer), false)
    assert.equal(book.coverage(market, 60_000), 0)
    assert.equal(store.getReporter(peer).weight, 20)
  } finally { store.close() }
})

test('unproven ingest charges rows in a rolling minute across keys and batches, exempting own and proven reads', t => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  let now = 1_800_000_000_000
  const registry = new Registry(store, {
    assets: [{ id: 'test:native', name: 'Test', symbol: 'T' }], exchanges: [{ id: 'v' }], chains: [],
  })
  const market = registry.cex('v', 'T', 'USD').id
  const book = new MarketBook({ store, registry, ownKey: 'own', clock: () => now })
  const write = (key, count, srcTs = now) => book.ingest(key, Array.from({ length: count }, (_, i) =>
    [market, '10', 1, null, null, null, srcTs - i]), key === 'own')
  const total = () => store.reader.prepare('SELECT sum(reports) n FROM store_report_activity').get().n
  write('peer', 140)
  assert.equal(total(), 120)
  now += 30_000
  write('peer', 4)
  for (let i = 0; i < 16; i++) write('other' + i, 120)
  assert.equal(total(), 2000)
  for (let i = 0; i < 3000; i++) write('extra' + i, 1)
  assert.equal(book.unprovenIngest.keys.size, 17)
  assert.equal(book.unprovenIngest.dropped1h(now), 3064)
  store.writer.prepare('INSERT INTO engine_standing VALUES (?,3,?,1)').run('proven', now)
  write('proven', 160)
  write('own', 160)
  assert.equal(total(), 2320)
  now += 29_999
  write('peer', 1)
  assert.equal(total(), 2320)
  now++
  write('peer', 125)
  assert.equal(total(), 2440)
  assert.equal(book.unprovenIngest.dropped1h(now), 3070)
  now += 3_600_000
  assert.equal(book.unprovenIngest.dropped1h(now), 0)
})

test('exact checked receipts survive head refresh, age pruning and byte pressure', async t => {
  const { fitBudget } = await import('../../store/src/prune.js')
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const start = 1_800_000_000_000
  let now = start
  const registry = new Registry(store, {
    assets: [{ id: 'a:native', name: 'A', symbol: 'A', rank: 1 }], exchanges: [{ id: 'v' }], chains: [],
  })
  const market = registry.cex('v','A','USD').id
  const ownKey = 'own', book = new MarketBook({ registry, store, ownKey, clock: () => now })
  const write = (key, ts, price) => book.ingest(key, [[market,price,1,null,null,null,ts]], key === ownKey)
  write('peer', now, '99')
  write(ownKey, now, '100')
  now += 10_000
  write(ownKey, now, '200')
  write('peer', now, '200')
  const reports = () => store.reader.prepare('SELECT count(*) n FROM obs').get().n
  assert.equal(reports(), 2)
  assert.deepEqual(store.checkedPrices(market,'peer',start,start+10_000), ['200','99'])
  now += 80_000
  write(ownKey, now, '250')
  write('peer', start + 9000, '201')
  assert.equal(store.getReporter('peer'), undefined)
  assert.equal(store.nearestObservation(market, ownKey, start+9000,30_000).price,'200')
  const latest = store.reader.prepare('SELECT srcTs FROM engine_latest WHERE market=? AND reporter=?')
  assert.equal(latest.get(market, ownKey).srcTs,now)
  now += 35 * 60_000
  write(ownKey,now,'300')
  assert.equal(book.refresh().get('a:native').price, 300)
  now += 3 * 3_600_000
  store.prune({ now })
  assert.equal(book.refresh().get('a:native').why.stale, true)
  const preserved = store.reader.prepare(`SELECT obsId AS id FROM engine_latest UNION SELECT obsId FROM engine_checks
    UNION SELECT localId FROM engine_spot_checks`).all().map(r=>r.id)
  store.transaction(db => fitBudget(db,1,now))
  for (const id of preserved) assert.ok(store.reader.prepare('SELECT id FROM obs WHERE id=?').get(id))
  assert.equal(store.reader.prepare('PRAGMA foreign_key_check').get(),undefined)
});

test('byte pressure preserves late claim comparisons without advancing the source cutoff of other streams', async t => {
  const { fitBudget } = await import('../../store/src/prune.js')
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  const start = 1_800_000_000_000
  let now = start
  const registry = new Registry(store, {
    assets: [{ id: 'a:native', name: 'A', symbol: 'A' }], exchanges: [{ id: 'v' }], chains: [],
  })
  const market = registry.cex('v','A','USD').id, ownKey = 'own'
  const book = new MarketBook({ store, registry, ownKey, clock: () => now })
  const write = (key,ts,price) => book.ingest(key,[[market,price,0,null,null,null,ts]],key===ownKey)
  write(ownKey,start,'10')
  now += 12_000
  write(ownKey,now,'11')
  now += 35*60_000
  write(ownKey,now,'20')
  assert.equal(store.transaction(db => fitBudget(db,1,now)).obs,1)
  assert.equal(store.reader.prepare('SELECT count(*) n FROM obs').get().n,1)
  // The old source times still have exact price evidence after their full quote span was evicted.
  assert.equal(store.nearestObservation(market,ownKey,start+1,100).price,'10')
  assert.equal(store.nearestObservation(market,ownKey,start+5000,100),undefined)
  const accepted = store.reader.prepare('SELECT seq FROM store_obs_clock').get().seq
  write(ownKey,start,'999')
  assert.equal(store.reader.prepare('SELECT seq FROM store_obs_clock').get().seq,accepted)
  write('late-peer',start+100,'30')
  assert.equal(store.getReporter('late-peer').strikes,1)
  assert.deepEqual(store.checkedPrices(market,'late-peer',start,start+500),['30'])
  const pinned = store.reader.prepare('SELECT localId,srcTs,price FROM engine_spot_checks').get()
  assert.equal(pinned.price,'10')
  assert.equal(pinned.srcTs,start)
  assert.ok(store.reader.prepare('SELECT 1 FROM obs WHERE id=?').get(pinned.localId))
  assert.equal(store.reader.prepare('SELECT srcTs FROM engine_latest WHERE reporter=?').get(ownKey).srcTs,now)
  now += 3*3_600_000
  store.prune({now})
  assert.equal(store.reader.prepare('SELECT count(*) n FROM store_obs_comparisons').get().n,0)
});

test('an honest peer with some volatile disagreements is never muted; strikes fade; a peer wrong on most checks is', t => {
  const store = openStore({ file: ':memory:', migrations })
  t.after(() => store.close())
  let now = 1740000000000
  const ownKey = 'a'.repeat(64), peer = 'b'.repeat(64)
  const assets = ['BTC', 'ETH', 'SOL', 'XRP'].map((s, i) => ({ id: s.toLowerCase() + ':native', symbol: s, name: s, rank: i + 1 }))
  const registry = new Registry(store, { assets, chains: [], exchanges: [{ id: 'spot' }] })
  const markets = assets.map(a => registry.cex('spot', a.symbol, 'USD').id)
  const book = new MarketBook({ store, registry, ownKey, clock: () => now })
  const write = (key, market, value) => book.ingest(key, [[market, String(value), 4, null, null, null, now]], key === ownKey)
  // 40 checks over 40 minutes on four markets, every fifth > 3% apart (a volatile pair): 8 strikes, 20% of checks.
  // The lifetime rule muted this peer after its fifth strike (owner node 11-20: 19 of 30 peers, no peer data left).
  for (let i = 0; i < 40; i++) {
    now += 60_000
    const market = markets[i % markets.length]
    write(peer, market, i % 5 === 0 ? 110 : 100)
    write(ownKey, market, 100)
  }
  assert.equal(book.muted(peer), false)
  assert.ok(store.getReporter(peer).strikes <= 1, 'agreements took the strikes back')
  // Turning wrong on most checks mutes it within the hour.
  let minutes = 0
  while (!book.muted(peer) && minutes < 60) {
    now += 60_000
    const market = markets[minutes++ % markets.length]
    write(peer, market, 150)
    write(ownKey, market, 100)
  }
  assert.equal(book.muted(peer), true)
  assert.ok(minutes < 30, 'muted after ' + minutes + ' minutes')
})

test('the update clears strikes and mutes left by the lifetime rule once', t => {
  const file = join(mkdtempSync(join(tmpdir(), 'strike-amnesty-')), 'gator.db')
  let after
  // Close before removing: Windows cannot unlink an open database file.
  t.after(() => {
    after?.close()
    rmSync(dirname(file), { recursive: true, force: true })
  })
  const peer = 'b'.repeat(64), until = Date.now() + 86_400_000
  const before = openStore({ file, migrations: migrations.filter(m => m.id !== 'engine-024-strike-amnesty') })
  before.upsertReporter({ key: peer, strikes: 5, mutedUntil: until })
  before.close()
  after = openStore({ file, migrations })
  assert.deepEqual([after.getReporter(peer).strikes, after.getReporter(peer).mutedUntil], [0, 0])
})
