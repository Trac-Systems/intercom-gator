import assert from 'node:assert/strict'
import test from 'node:test'
import { CandleHistory, deadHistory } from '../src/candles/index.js'

const HOUR = 3_600_000
const to = 1_800_000_000_000 - (1_800_000_000_000 % HOUR)
const from = to - 24 * HOUR
const series = (fn) => Array.from({ length: 24 }, (_, i) => ({ ts: from + i * HOUR, ...fn(i) }))
const flat = () => series(() => ({ open: '2', high: '2', low: '2', close: '2' }))
const live = (base) => series((i) => ({ open: String(base + i), high: String(base + i + 1), low: String(base + i - 0.5), close: String(base + i + 0.5) }))

function history({ stable = false, bars }) {
  const markets = ['cex:a:X-USD', 'cex:b:X-USDT', 'cex:c:X-USD'].map((id) => {
    const [, exchange] = id.split(':')
    return { id, base: 'x:native', kind: 'cex', symbol: 'X', exchange, quote: id.endsWith('USDT') ? 'usdt' : 'fiat:USD' }
  })
  const registry = {
    markets: new Map(markets.map((m) => [m.id, m])),
    venues: new Map(['a', 'b', 'c'].map((id) => [id, { candles: { intervals: { '1h': '1h' } } }])),
    main: new Map([['x:native', { id: 'cex:b:X-USDT' }]]),
    assets: new Map([['x:native', { id: 'x:native', stable }]]),
  }
  // A flat USDT rate lets the USDT market convert exactly.
  const store = { candles: ({ asset }) => (asset === 'usdt' ? series(() => ({ open: '1', high: '1', low: '1', close: '1' })) : []) }
  const h = new CandleHistory({ store, registry, clock: () => to })
  const asked = []
  h.market = async (market) => { asked.push(market.id); return bars[market.id] ?? [] }
  return { h, asked }
}

test('dead history: at least 80% flat bars over a dozen or more', () => {
  assert.equal(deadHistory(flat()), true)
  assert.equal(deadHistory(live(10)), false)
  assert.equal(deadHistory(flat().slice(0, 11)), false)
})

test('imported history comes from the main market first and skips a market nobody trades', async () => {
  let { h, asked } = history({ bars: { 'cex:a:X-USD': flat(), 'cex:b:X-USDT': live(10), 'cex:c:X-USD': live(50) } })
  let rows = await h.get('x:native', { tf: '1h', from, to, limit: 24 })
  assert.deepEqual(asked, ['cex:b:X-USDT'])
  assert.equal(rows[0].close, '10.5')
  ;({ h, asked } = history({ bars: { 'cex:a:X-USD': flat(), 'cex:b:X-USDT': flat(), 'cex:c:X-USD': live(50) } }))
  rows = await h.get('x:native', { tf: '1h', from, to, limit: 24 })
  assert.deepEqual(asked, ['cex:b:X-USDT', 'cex:a:X-USD', 'cex:c:X-USD'])
  assert.equal(rows[0].source, 'cex:c:X-USD')
  // A stablecoin's quiet hours are legitimately flat.
  ;({ h, asked } = history({ stable: true, bars: { 'cex:b:X-USDT': flat() } }))
  rows = await h.get('x:native', { tf: '1h', from, to, limit: 24 })
  assert.equal(rows.length, 24)
})

test('migration drops flat imported history of non-stable assets only', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { openStore } = await import('./store-fixture.js')
  const { migrations } = await import('../src/schema.js')
  const dir = mkdtempSync(join(tmpdir(), 'dead-seed-')), file = join(dir, 'test.db')
  let store
  t.after(() => { try { store?.close() } finally { rmSync(dir, { recursive: true, force: true }) } })
  store = openStore({ file, migrations: migrations.filter((m) => m.id !== 'engine-013-dead-seed-candles') })
  for (const id of ['dead:native', 'stable:native', 'live:native']) store.upsertAsset({ id, symbol: id, name: id })
  const insert = store.writer.prepare(`INSERT INTO candles(asset,tf,ts,open,high,low,close,samples,firstTs,firstId,lastTs,lastId)
    VALUES (?,'1h',?,?,?,?,?,1,?,0,?,0)`)
  for (const asset of ['dead:native', 'stable:native', 'live:native'])
    for (let i = 0; i < 20; i++) {
      const ts = from + i * HOUR, p = asset === 'live:native' ? String(10 + i) : '2'
      insert.run(asset, ts, p, asset === 'live:native' ? String(11 + i) : p, p, p, ts, ts + HOUR - 1)
    }
  // A local bar of the dead asset (several samples, real span) stays.
  store.writer.prepare(`INSERT INTO candles(asset,tf,ts,open,high,low,close,samples,firstTs,firstId,lastTs,lastId)
    VALUES ('dead:native','1h',?,'3','3','3','3',4,?,0,?,0)`).run(to, to + 5, to + 600)
  store.writer.prepare('INSERT INTO engine_asset_data(asset,stable) VALUES (?,1)').run('stable:native')
  store.close()
  store = openStore({ file, migrations })
  const count = (asset) => store.reader.prepare("SELECT count(*) AS n FROM candles WHERE asset=? AND tf='1h'").get(asset).n
  assert.equal(count('dead:native'), 1)
  assert.equal(count('stable:native'), 20)
  assert.equal(count('live:native'), 20)
})

test('a long range asks a start-anchored venue for its newest page, not its oldest', async () => {
  const DAY = 24 * HOUR, now = to
  const market = { id: 'cex:a:X-USD', base: 'x:native', kind: 'cex', symbol: 'XUSD', exchange: 'a', quote: 'fiat:USD' }
  const registry = { venues: new Map([['a', { id: 'a', rpm: 60, candles: { intervals: { '1d': '1d' }, max: 1000,
    url: 'https://venue.test/k?symbol={symbol}&interval={interval}&startTime={startMs}&endTime={lastMs}&limit={limit}' } }]]) }
  const urls = []
  const h = new CandleHistory({ store: {}, registry, clock: () => now, scheduler: { demand: (key, url, fn) => fn() },
    http: { get: async (url) => { urls.push(new URL(url)); return [] } } })
  await h.market(market, '1d', now - 2000 * DAY, now, 2000)
  assert.equal(+urls[0].searchParams.get('startTime'), now - 1000 * DAY)
  assert.equal(urls[0].searchParams.get('limit'), '1000')
  // A range within one page is unchanged.
  await h.market(market, '1d', now - 365 * DAY, now, 365)
  assert.equal(+urls[1].searchParams.get('startTime'), now - 365 * DAY)
})

test('an empty page from before the listing leaves the market active; an empty recent range marks it idle', async () => {
  const DAY = 24 * HOUR
  const markets = [{ id: 'cex:a:X-USD', base: 'x:native', kind: 'cex', symbol: 'X', exchange: 'a', quote: 'fiat:USD' }]
  const registry = { markets: new Map(markets.map((m) => [m.id, m])), main: new Map(),
    venues: new Map([['a', { candles: { intervals: { '1d': '1d' } } }]]), assets: new Map([['x:native', { id: 'x:native' }]]) }
  const h = new CandleHistory({ store: { candles: () => [] }, registry, clock: () => to })
  h.market = async () => []
  await h.get('x:native', { tf: '1d', from: to - 4000 * DAY, to: to - 2000 * DAY, limit: 2000 }).catch(() => {})
  assert.equal(h.idle.size, 0, 'the 1990s say nothing about trading today')
  await h.get('x:native', { tf: '1d', from: to - 365 * DAY, to, limit: 365 }).catch(() => {})
  assert.equal(h.idle.size, 1)
})

test('closed days a venue sent serve the next deep chart load without asking again', async () => {
  const DAY = 24 * HOUR, end = to - (to % DAY)
  const markets = [{ id: 'cex:a:X-USD', base: 'x:native', kind: 'cex', symbol: 'X', exchange: 'a', quote: 'fiat:USD' }]
  const registry = { markets: new Map(markets.map((m) => [m.id, m])), main: new Map(),
    venues: new Map([['a', { candles: { intervals: { '1d': '1d' } } }]]), assets: new Map([['x:native', { id: 'x:native' }]]) }
  const h = new CandleHistory({ store: { candles: () => [] }, registry, clock: () => end + HOUR })
  let asked = 0
  const bar = (ts) => ({ ts, tf: '1d', open: '1', high: '1.2', low: '0.9', close: '1.1', source: 'cex:a:X-USD', quote: 'fiat:USD' })
  h.market = async (market, tf, from, until) => {
    asked++
    const rows = []
    for (let ts = from; ts < until; ts += DAY) rows.push(bar(ts))
    return rows
  }
  const range = { tf: '1d', from: end - 2000 * DAY, to: end - DAY, limit: 2000 }
  assert.equal((await h.get('x:native', range)).length, 1999)
  assert.equal((await h.get('x:native', range)).length, 1999)
  assert.equal(asked, 1, 'the second load is served from the kept days')
  // Today's open bar is never kept: a range reaching it asks again.
  await h.get('x:native', { ...range, to: end + 1 })
  assert.equal(asked, 2)
  // Sixteen assets at most: the one charted longest ago goes.
  h.days.delete('x:native')
  for (let i = 0; i < 16; i++) h.days.set('other:' + i, new Map([[end - 2 * DAY, bar(end - 2 * DAY)]]))
  await h.get('x:native', range)
  assert.equal(h.days.size, 16)
  assert.ok(h.days.has('x:native') && !h.days.has('other:0'))
})
