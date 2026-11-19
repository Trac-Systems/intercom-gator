import test from 'node:test'
import assert from 'node:assert/strict'
import { batches, channelFor, ObservationExchange, decimal, validRow } from '../src/obs/index.js'

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
