import test from 'node:test'
import assert from 'node:assert/strict'
import { batches, channelFor, ObservationExchange, decimal, validRow, PeerQuota, WireBudget, WIRE_MESSAGE_BYTES } from '../src/obs/index.js'

const at = 1740000000000,
  id = 'cex:spot:ETH-USD',
  b = '0000000000000001'
const row = [id, '0.00000012', '5', null, null, null, at]
test('batches fit signed channel cap and row count with exact numeric strings', () => {
  const input = Array.from({ length: 521 }, () => [...row].map((v, i) => (i === 2 ? '1'.repeat(75) : v)))
  const output = [...batches(input, b, at)]
  assert.equal(output.flatMap(([, msg]) => msg.o).length, 521)
  for (const [channel, msg] of output) {
    assert.equal(channel, channelFor(id))
    assert.ok(msg.o.length <= 200 && Buffer.byteLength(JSON.stringify(msg)) <= 15360)
  }
  assert.equal(decimal(1.2e-8), '0.000000012')
  assert.equal(validRow([id, 'Infinity', 1, null, null, null, at], at), false)
})

test('observation receiver checks sender, shard, digest, size, timestamp, version and per-key quota', () => {
  const ingested = []
  const exchange = new ObservationExchange({
    transport: { publicKey: '1'.repeat(64) },
    clock: () => at,
    digest: b,
    rowLimit: 2,
    ingest: (...args) => ingested.push(args),
  })
  const channel = channelFor(id),
    from = '2'.repeat(64)
  const message = { t: 'obs', v: 1, b, at, o: [row] }
  const receive = (msg, c = channel, key = from) => exchange.receive(c, { channel: c, from: key, message: msg })
  receive({ ...message, v: 2 })
  receive({ ...message, b: 'f'.repeat(16) })
  receive({ ...message, pad: 'x'.repeat(16_400) })
  receive({ ...message, at: at + 60_000 })
  receive(message, channel, 'not-a-key')
  receive(message, 'gator/px/16', '3'.repeat(64))
  for (let i = 0; i < 3; i++) receive(message)
  assert.equal(ingested.length, 2)
  receive(message, channel, '4'.repeat(64))
  assert.equal(ingested.length, 3)
})

const market = (i) => `cex:spot:T${i}-USD`
const wireRow = (i, price, now) => [market(i), String(price), '5', null, null, null, now]

test('the wire budget keeps a node under an old receiver quota, in small messages, top markets every round', () => {
  let now = at
  const key = '1'.repeat(64), receiver = new PeerQuota(() => now), sent = []
  let dropped = 0
  const exchange = new ObservationExchange({
    transport: { publicKey: key, send: (channel, msg) => {
      if (!receiver.take(key, msg.o.length)) dropped++
      sent.push({ now, msg })
      return true
    } },
    clock: () => now, digest: b, ingest: () => {},
    wireInfo: (id) => { const i = Number(id.slice(10, -4)); return { rank: i < 50 ? i + 1 : undefined, window: 3_600_000 } },
  })
  // Every 15 s a node reads 5,000 markets and every price moves 1 %: 20,000 due rows a minute.
  for (let step = 0; step < 40; step++, now += 15_000)
    exchange.publish(Array.from({ length: 5000 }, (_, i) => wireRow(i, (1.01 ** step).toFixed(8), now)))
  assert.equal(dropped, 0)
  for (let minute = 1; minute < 10; minute++) {
    const rows = sent.filter((s) => s.now >= at + minute * 60_000 && s.now < at + (minute + 1) * 60_000)
      .reduce((n, s) => n + s.msg.o.length, 0)
    assert.ok(rows <= 2000 && rows >= 1900, `minute ${minute}: ${rows} rows`)
  }
  assert.ok(sent.every((s) => Buffer.byteLength(JSON.stringify(s.msg)) <= WIRE_MESSAGE_BYTES))
  const top = sent.flatMap((s) => s.msg.o).filter((r) => Number(r[0].slice(10, -4)) < 50)
  assert.equal(top.length, 50 * 40, 'ranks 1-50 go out at every read')
})

test('an unchanged price goes out again only as a heartbeat after half its coverage window', () => {
  let now = at
  const sent = []
  const exchange = new ObservationExchange({
    transport: { publicKey: '1'.repeat(64), send: (channel, msg) => sent.push(...msg.o) },
    clock: () => now, digest: b, ingest: () => {}, wireInfo: () => ({ rank: 10, window: 60_000 }),
  })
  const send = (price, after) => { now += after; exchange.publish([wireRow(1, price, now)]); return sent.length }
  assert.equal(send('100', 0), 1)
  assert.equal(send('100.05', 20_000), 1, 'moved 0.05 %: not news')
  assert.equal(send('100.05', 11_000), 2, 'heartbeat')
  assert.equal(send('100.3', 1_000), 3, 'moved 0.25 %')
  assert.equal(send('100.3', 1_000), 3)
})

test('after the top tier, the budget is shared 50/30/20 and heartbeats keep a quarter of a tier', () => {
  let now = at
  const ranks = (id) => { const i = Number(id.slice(10, -4)); return { rank: i < 2000 ? 100 : i < 3000 ? 700 : undefined, window: 600_000 } }
  const wire = new WireBudget({ clock: () => now, info: ranks, rate: 1000 })
  for (let i = 0; i < 2000; i++) wire.offer(wireRow(i, 1, now), now)
  assert.equal(wire.take(now).length, 1000)
  now += 31 * 60_000
  for (let i = 0; i < 4000; i++) wire.offer(wireRow(i, 1, now), now)
  const tiers = { hb: 0, moved: 0, ranked: 0, unranked: 0 }
  const sentBefore = (id) => Number(id.slice(10, -4)) < 1000
  for (const [id] of wire.take(now)) {
    const i = Number(id.slice(10, -4))
    tiers[i < 2000 ? (sentBefore(id) ? 'hb' : 'moved') : i < 3000 ? 'ranked' : 'unranked']++
  }
  assert.deepEqual(tiers, { hb: 125, moved: 375, ranked: 300, unranked: 200 })
  assert.equal(wire.take(now).length, 0, 'the bucket is empty')
})
