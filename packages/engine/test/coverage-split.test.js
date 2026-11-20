import assert from 'node:assert/strict'
import test from 'node:test'
import { ReporterSlice, nextPoolPage, trackedPools } from '../src/coverage/split.js'

const key = n => n.toString(16).padStart(64, '0')
const keys = n => Array.from({ length: n }, (_, i) => key(i + 1))
const ids = Array.from({ length: 300 }, (_, i) => 'dex:bsc:0x' + i.toString(16).padStart(40, '0'))
const owners = (nodes, market) => nodes.filter(node => node.priority(market) !== null).map(node => node.own)
const network = members => members.map(k => new ReporterSlice(k, members))

test('rendezvous assigns the exact number of copies independent of membership order or duplicate sightings', () => {
  for (const n of [1, 3, 7, 20, 32, 100]) {
    const members = keys(n), nodes = network(members)
    const reversed = members.map(k => new ReporterSlice(k, [k, ...members.toReversed(), k]))
    for (const id of ids.slice(0, 50)) {
      const a = owners(nodes, id)
      assert.equal(a.length, n >= 32 ? 4 : Math.min(n, 3))
      assert.deepEqual(owners(reversed, id), a)
    }
    assert.equal(nodes[0].version, reversed[0].version)
    assert.equal(nodes[0].split, n > 3)
  }
})

test('one join or departure displaces at most one owner and never swaps two surviving owners', () => {
  for (const n of [3, 7, 31, 32]) {
    const before = network(keys(n)), after = network(keys(n + 1)), newcomer = key(n + 1)
    let moved = 0
    for (const id of ids) {
      const a = owners(before, id), b = owners(after, id)
      if (a.join() === b.join()) continue
      moved++
      assert.ok(a.filter(k => !b.includes(k)).length <= 1)
      if (n !== 31) assert.deepEqual(b.filter(k => !a.includes(k)), [newcomer])
      else assert.equal(a.filter(k => !b.includes(k)).length, 0)
    }
    assert.ok(moved > 0)
  }
})

test('common and pinned pools overlap, scarce endpoints rotate, repairs skip covered pools', () => {
  const nodes = network(keys(7))
  for (const node of nodes) {
    const plan = node.partition(ids, id => id, 4, id => id === ids.at(-1))
    assert.deepEqual(plan.core, [...ids.slice(0, 4), ids.at(-1)])
    assert.equal(plan.core.length + plan.tail.length + plan.rest.length, ids.length)
    const seen = new Set()
    let cursor
    for (let turn = 0; turn < 800; turn++) {
      const page = nextPoolPage(plan, 1, cursor, () => true)
      assert.equal(page.rows.length, 1)
      seen.add(page.rows[0])
      cursor = page.next
    }
    assert.deepEqual(seen, new Set([...plan.core, ...plan.tail]))
    const repair = nextPoolPage(plan, 8, { turn: 15 }, id => id === plan.rest[0])
    assert.ok(repair.rows.includes(plan.rest[1]))
    assert.ok(!repair.rows.includes(plan.rest[0]))
    const a = trackedPools(plan, 32, 0, node.own), b = trackedPools(plan, 32, 1, node.own)
    assert.equal(new Set(a).size, 32)
    assert.ok(plan.core.every(id => a.includes(id) && b.includes(id)))
    assert.ok(b.some(id => !a.includes(id)))
  }
})

test('membership changes retain surviving trade slots and resume state after a departing cursor pool', () => {
  const own = key(1)
  const split = n => new ReporterSlice(own, keys(n)).partition(ids, id => id, 4)
  const before = split(7), after = split(8), oldSet = trackedPools(before, 32, 99, own)
  const newSet = trackedPools(after, 32, 99, own)
  for (const id of oldSet.filter(id => !newSet.includes(id))) assert.ok(!after.tail.includes(id))
  const gone = before.tail.find(id => !after.tail.includes(id))
  assert.ok(gone)
  const next = nextPoolPage(after, 1, { turn: 5, last: gone })
  const expected = before.tail.slice(before.tail.indexOf(gone) + 1).find(id => after.tail.includes(id)) ?? after.tail[0]
  assert.deepEqual(next.rows, [expected])
})
