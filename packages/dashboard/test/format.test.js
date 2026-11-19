import test from 'node:test';
import assert from 'node:assert/strict';
import { esc, money, priceParts, priceH, priceTxt, pct, dir, ago, ageMinutes, compact, keyGroups, shortAddr, fgLabel, funding, amount, MINUS } from '../public/js/lib/format.js';

test('esc escapes HTML-significant characters', () => {
  assert.equal(esc('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(esc(null), '');
});

test('money compacts by magnitude', () => {
  assert.equal(money(3.284e12), '$3.28T');
  assert.equal(money(142.6e9), '$142.6B');
  assert.equal(money(1.9e6), '$1.9M');
  assert.equal(money(312000), '$312K');
  assert.equal(money(12.5), '$12.50');
  assert.equal(money(-2e9), MINUS + '$2.0B');
  assert.equal(money(null), '—');
});

test('priceParts keeps the design rules, incl. subscript zero count', () => {
  assert.deepEqual(priceParts(91240.12), ['$91,240', '.12']);
  assert.deepEqual(priceParts(182.4), ['$182', '.40']);
  assert.deepEqual(priceParts(1.0002), ['$1', '.0002']);
  assert.deepEqual(priceParts(0.2141), ['$0', '.2141']);
  assert.deepEqual(priceParts(0.00001242), ['$0', '.0<sub>4</sub>1242']);
  assert.equal(priceTxt(0.00001242), '$0.0₄1242');
  assert.equal(priceH(0), '$0');
  assert.deepEqual(priceParts(NaN), ['—', '']);
});

test('pct uses a real minus and sensible decimals', () => {
  assert.equal(pct(1.84), '+1.8%');
  assert.equal(pct(-1.4), MINUS + '1.4%');
  assert.equal(pct(0.001), '0.0%');
  assert.equal(pct(0.05), '+0.05%');
  assert.equal(pct(212), '+212%');
  assert.equal(dir(2), 'up'); assert.equal(dir(-2), 'down'); assert.equal(dir(0), 'flat');
});

test('ago is short and human', () => {
  const now = Date.UTC(2026, 10, 19, 12);
  assert.equal(ago(now - 10e3, now), 'now');
  assert.equal(ago(now - 4 * 60e3, now), '4 min');
  assert.equal(ago(now - 3 * 3600e3, now), '3 h');
  assert.equal(ago(now - 2 * 86400e3, now), '2 d');
  assert.equal(ago(Date.UTC(2026, 9, 1), now), '1 Oct');
  assert.equal(ago(Date.UTC(2025, 9, 1), now), '1 Oct 2025');
});

test('small helpers', () => {
  assert.equal(ageMinutes('12 min'), 12);
  assert.equal(ageMinutes('2 h'), 120);
  assert.equal(compact(1240), '1.2K');
  assert.equal(compact(21400), '21K');
  assert.equal(keyGroups('3f9ab95decde'), '3f9a b95d ecde');
  assert.equal(shortAddr('0x6982508145454ce325ddbe47a25d4ec3d2311933'), '0x6982…1933');
  assert.equal(fgLabel(64), 'Greed'); assert.equal(fgLabel(10), 'Extreme fear'); assert.equal(fgLabel(50), 'Neutral');
  assert.equal(funding(-0.0034), MINUS + '0.0034%');
  assert.equal(amount(0.31), '0.3100'); assert.equal(amount(2500), '2,500');
});
