import test from 'node:test'
import assert from 'node:assert/strict'
import { dayRatio } from '../src/sources/bundle-adapter.js'

test("a venue's 24 h move reads its open price or its change field in the bundle's unit", () => {
  const read = (fields, row, last) => dayRatio(fields, (path) => row[path], last)
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, a + ' != ' + b)
  close(read({ open24h: 'o' }, { o: '100' }, '105'), 1.05)
  close(read({ change24h: 'c', changeUnit: 'percent' }, { c: '2.5' }, '1'), 1.025)
  close(read({ change24h: 'c', changeUnit: 'ratio' }, { c: -0.2 }, '1'), 0.8)
  close(read({ change24h: 'c', changeUnit: 'percent-string' }, { c: '-3.5%' }, '1'), 0.965)
  close(read({ change24h: 'c', changeUnit: 'absolute' }, { c: '5' }, '105'), 1.05)
  // An empty open falls back to the change field.
  close(read({ open24h: 'o', change24h: 'c', changeUnit: 'percent' }, { o: '0', c: '10' }, '2'), 1.1)
  assert.equal(read({ change24h: 'c', changeUnit: 'percent' }, { c: 'n/a' }, '1'), null)
  assert.equal(read({ change24h: 'c', changeUnit: 'percent' }, { c: '' }, '1'), null)
  assert.equal(read({ change24h: 'c', changeUnit: 'ratio' }, { c: 250 }, '1'), null)
  assert.equal(read({ open24h: 'o' }, { o: '100' }, '0'), null)
  assert.equal(read({}, {}, '1'), null)
})
