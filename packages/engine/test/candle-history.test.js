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
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const before = openStore({ file, migrations: migrations.filter((m) => m.id !== 'engine-013-dead-seed-candles') })
  for (const id of ['dead:native', 'stable:native', 'live:native']) before.upsertAsset({ id, symbol: id, name: id })
  const insert = before.writer.prepare(`INSERT INTO candles(asset,tf,ts,open,high,low,close,samples,firstTs,firstId,lastTs,lastId)
    VALUES (?,'1h',?,?,?,?,?,1,?,0,?,0)`)
  for (const asset of ['dead:native', 'stable:native', 'live:native'])
    for (let i = 0; i < 20; i++) {
      const ts = from + i * HOUR, p = asset === 'live:native' ? String(10 + i) : '2'
      insert.run(asset, ts, p, asset === 'live:native' ? String(11 + i) : p, p, p, ts, ts + HOUR - 1)
    }
  // A local bar of the dead asset (several samples, real span) stays.
  before.writer.prepare(`INSERT INTO candles(asset,tf,ts,open,high,low,close,samples,firstTs,firstId,lastTs,lastId)
    VALUES ('dead:native','1h',?,'3','3','3','3',4,?,0,?,0)`).run(to, to + 5, to + 600)
  before.writer.prepare('INSERT INTO engine_asset_data(asset,stable) VALUES (?,1)').run('stable:native')
  before.close()
  const after = openStore({ file, migrations })
  t.after(() => after.close())
  const count = (asset) => after.reader.prepare("SELECT count(*) AS n FROM candles WHERE asset=? AND tf='1h'").get(asset).n
  assert.equal(count('dead:native'), 1)
  assert.equal(count('stable:native'), 20)
  assert.equal(count('live:native'), 20)
})
