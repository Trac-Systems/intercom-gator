import test from 'node:test';
import assert from 'node:assert/strict';
import { RANGES, rangeById, aggregate, bucketStart, rangeChange, rangeHighLow, timeLabel, crosshairTime, readoutTime, priceLabel, minMove, axisPrice, tickmarkLabels, priceFormat, stepIndex, TF_SECONDS } from '../public/js/lib/chart-format.js';

test('six ranges with legible candle buckets', () => {
  assert.deepEqual(RANGES.map((r) => r.id), ['1H', '1D', '1W', '1M', '1Y', 'ALL']);
  for (const r of RANGES) {
    assert.ok(TF_SECONDS[r.candle] >= TF_SECONDS[r.tf], r.id);
    assert.ok(['1m', '5m', '1h', '1d'].includes(r.tf), 'stored timeframes only');
    if (r.bars) assert.ok(r.bars / (TF_SECONDS[r.candle] / TF_SECONDS[r.tf]) <= 130, r.id + ' keeps ≤130 candles');
  }
  assert.equal(rangeById('nope').id, '1D');
});

test('aggregate merges OHLCV into aligned buckets', () => {
  const c = [0, 300, 600, 900, 1200].map((t, i) => ({ t, o: 10 + i, h: 12 + i, l: 9 + i, c: 11 + i, v: 1 }));
  const a = aggregate(c, 900);
  assert.deepEqual(a, [{ t: 0, o: 10, h: 14, l: 9, c: 13, v: 3 }, { t: 900, o: 13, h: 16, l: 12, c: 15, v: 2 }]);
  // weeks start on Monday 00:00 UTC (2026-11-16 was a Monday)
  const mon = Date.UTC(2026, 10, 16) / 1000;
  assert.equal(bucketStart(mon + 3 * 86400, 604800), mon);
  assert.equal(bucketStart(mon - 1, 604800), mon - 604800);
});

test('range change and extremes', () => {
  const c = [{ t: 0, o: 100, h: 120, l: 90, c: 110, v: 0 }, { t: 1, o: 110, h: 130, l: 105, c: 125, v: 0 }];
  assert.equal(rangeChange(c), 25);
  assert.deepEqual(rangeHighLow(c), { high: 130, low: 90 });
  assert.equal(rangeChange([]), null);
});

test('time labels (UTC for the test)', () => {
  const t = Date.UTC(2026, 10, 19, 13, 5) / 1000;
  assert.equal(timeLabel(t, 300, true), '13:05');
  assert.equal(timeLabel(t, 86400, true), '19 Nov');
  assert.equal(timeLabel(t, 604800, true), 'Nov 2026');
  assert.equal(crosshairTime(t, 3600, true), '19 Nov 13:05');
  assert.equal(crosshairTime(t, 86400, true), '19 Nov 2026');
  assert.equal(readoutTime(t, 60, true), '19 Nov 2026 13:05 UTC');
  assert.equal(readoutTime(t, 86400, true), '19 Nov 2026');
});

test('price labels never print 0 for a real price', () => {
  assert.equal(priceLabel(91240.12), '91,240');
  assert.equal(priceLabel(3412.55), '3,412.55');
  assert.equal(priceLabel(182.4), '182.40');
  assert.equal(priceLabel(1.0002), '1.0002');
  assert.equal(priceLabel(0.2141), '0.2141');
  assert.equal(priceLabel(0.00001242), '0.0₄1242');
  assert.equal(priceLabel(0.00031), '0.0₃31');
  assert.equal(priceLabel(0.0071), '0.0071');
  assert.equal(priceLabel(1.242e-9), '0.0₈1242');
  assert.equal(priceLabel(0), '0');
});

test('axis step and snapping', () => {
  assert.equal(minMove([{ h: 91240 }]), 1);
  assert.equal(minMove([{ c: 0.00001242 }]), 1e-9);
  assert.equal(minMove([]), 0.01);
  assert.equal(axisPrice(0.00015000000000000001, 1e-5), 0.00015);
  assert.equal(axisPrice(1.3552527156068805e-20, 1e-5), 0);
  assert.deepEqual(tickmarkLabels(1)([91000.00000000001, 90500]), ['91,000', '90,500']);
  const f = priceFormat([{ h: 182.4 }]);
  assert.equal(f.type, 'custom'); assert.equal(f.minMove, 0.01); assert.equal(f.base, 100);
});

test('keyboard stepping through candles', () => {
  assert.equal(stepIndex('ArrowLeft', -1, 10), 8);
  assert.equal(stepIndex('ArrowRight', 9, 10), 9);
  assert.equal(stepIndex('Home', 5, 10), 0);
  assert.equal(stepIndex('End', 0, 10), 9);
  assert.equal(stepIndex('PageUp', 3, 10), 0);
  assert.equal(stepIndex('x', 3, 10), null);
  assert.equal(stepIndex('ArrowLeft', -1, 0), null);
});
