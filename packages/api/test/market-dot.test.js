import test from 'node:test';
import assert from 'node:assert/strict';
import { marketDot } from '../src/markets.js';

test('a market row is green only when it confirms a green asset price: fresh, within 1%, not an outlier', () => {
  const ok = { stale: false, spread: 0.001, usd: 1758.5, ageMs: 30_000, windowMs: 60_000, assetTrust: 'green', assetUsd: 1757.7, outlier: false };
  assert.equal(marketDot(ok), 'green'); // Binance ETH/USDT next to a green ETH (owner's node, 11-19)
  assert.equal(marketDot({ ...ok, usd: 1757.7 * 1.02 }), 'yellow'); // 2% off
  assert.equal(marketDot({ ...ok, assetTrust: 'yellow' }), 'yellow'); // asset not confirmed
  assert.equal(marketDot({ ...ok, outlier: true }), 'yellow');
  assert.equal(marketDot({ ...ok, ageMs: 90_000 }), 'yellow'); // older than the target window
  assert.equal(marketDot({ ...ok, usd: null }), 'yellow'); // no USD rate for the quote
  assert.equal(marketDot({ ...ok, stale: true }), 'red');
  assert.equal(marketDot({ ...ok, spread: 0.04 }), 'red');
});
