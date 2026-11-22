import test from 'node:test';
import assert from 'node:assert/strict';
import { marketViews } from '../src/markets.js';

const DAY = 86_400_000, now = 20_000 * DAY + 5_000;

/** A venue with daily history from `first` that answers the newest `page` bars of a range, like the engine. */
function views({ first, page = 1000, local = [], fail = () => false }) {
  const calls = [];
  const engine = {
    async candles(id, { from, to, limit }) {
      calls.push([from / DAY, to / DAY, limit]);
      if (fail(calls.length)) throw new Error('venues busy');
      const rows = [];
      const start = Math.max(Math.ceil(from / DAY), Math.ceil(first / DAY), Math.ceil(to / DAY) - Math.min(page, limit));
      for (let ts = start * DAY; ts < to; ts += DAY)
        rows.push({ ts, open: '1', high: '2', low: '1', close: '2' });
      return rows;
    },
  };
  const store = { candles: () => local, reader: { prepare: () => ({}) } };
  return { candles: marketViews({ engine, store, intel: {}, clock: () => now }, {}).candles, calls };
}

test('ALL candles fill backwards from today, page by page, until the history starts', async () => {
  // Five years of history behind 1,000-bar pages: three pages from today back, newest first.
  const { candles, calls } = views({ first: now - 1825 * DAY });
  const res = await candles('x', { tf: '1d', limit: '0' });
  const days = res.candles.map(c => c.t * 1000 / DAY);
  assert.equal(days.at(-1), 20_000, 'ends with today');
  assert.equal(new Set(days.map((d, i) => d - i)).size, 1, 'no gap');
  assert.ok(calls[0][1] > 20_000, 'the first page ends now');
  // Each older page ends where the bars so far begin; the third finds nothing older and ends the walk.
  assert.deepEqual(calls.slice(1).map(c => c[1]), [19_001, 18_176]);
  assert.equal(res.candles.length, 1825);
  assert.equal(res.partial, undefined);
});

test('a short history stops after the page that found its start', async () => {
  const { candles, calls } = views({ first: now - 40 * DAY });
  const res = await candles('x', { tf: '1d', limit: '0' });
  assert.equal(res.candles.length, 40);
  assert.equal(calls.length, 2, 'one more page to learn that nothing is older');
});

test('more bars than the limit keep the newest; a failed older page keeps what came and says so', async () => {
  let { candles } = views({ first: 0, page: 2000 });
  let res = await candles('x', { tf: '1d', limit: '365' });
  assert.equal(res.candles.length, 365);
  assert.equal(res.candles.at(-1).t * 1000 / DAY, 20_000);
  ({ candles } = views({ first: 0, fail: n => n === 2 }));
  res = await candles('x', { tf: '1d', limit: '0' });
  assert.equal(res.partial, true);
  assert.equal(res.candles.length, 1000);
  assert.equal(res.candles.at(-1).t * 1000 / DAY, 20_000);
  // Nothing at all: the error surfaces.
  ({ candles } = views({ first: 0, fail: () => true }));
  await assert.rejects(candles('x', { tf: '1d', limit: '365' }), /venues busy/);
});
