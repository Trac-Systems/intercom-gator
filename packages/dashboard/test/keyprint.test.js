import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { h32, kpData, kp, hue, brandSVG, tokSeed, keyprintRows } from '../public/js/lib/keyprint.js';

// The owner picked the marks drawn by design/keyprint/index.html. Load that page's own
// generator and check the port draws exactly the same mark for many seeds.
function designGenerator() {
  const html = readFileSync(new URL('../../../design/keyprint/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('function h32(');
  const end = html.indexOf('function hue(');
  assert.ok(start > 0 && end > start, 'design generator found');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end) + '; this.kpData = kpData; this.h32 = h32;', ctx);
  return ctx;
}

test('port matches the design generator for 500 seeds', () => {
  const d = designGenerator();
  const seeds = ['Bitcoin:BTC', 'Ethereum:ETH', 'key:3f9a', 'chain:Solana', 'ex:Binance'];
  for (let i = 0; i < 495; i++) seeds.push('key:' + i.toString(16).padStart(64, '0'));
  for (const s of seeds) {
    assert.equal(h32(s), d.h32(s), s);
    const a = kpData(s), b = d.kpData(s);
    assert.deepEqual({ a: a.a, b: a.b, ha: a.ha, hb: a.hb }, { a: b.a, b: b.b, ha: b.ha, hb: b.hb }, s);
  }
});

test('marks are deterministic and differ between seeds', () => {
  assert.equal(kp('key:abc', 'tag', 36), kp('key:abc', 'tag', 36));
  assert.notEqual(kpData('key:abc').a + kpData('key:abc').b, kpData('key:abd').a + kpData('key:abd').b);
  const { ha, hb } = kpData('anything');
  assert.ok(ha >= 222 && ha <= 325 && hb >= 222 - 77 && hb <= 325 + 77);
  assert.match(hue('x'), /^--ha:\d+;--hb:\d+$/);
});

test('svg output is self-contained and hidden from assistive tech', () => {
  const s = kp('Bitcoin:BTC', 'coin', 28, 'big');
  assert.match(s, /^<svg class="kp kp-coin big" viewBox="0 0 30 30" width="28" height="28"/);
  assert.match(s, /aria-hidden="true"/);
  assert.match(brandSVG(30), /kp-brand/);
});

test('token seed follows the design (first chain + symbol)', () => {
  assert.equal(tokSeed({ chains: ['Ethereum', 'Tron'], symbol: 'USDT' }), 'Ethereum:USDT');
  assert.equal(tokSeed({ chain: 'Base', symbol: 'MOSS' }), 'Base:MOSS');
});

test('key rows: 64 hex → 4 rows of 4 groups', () => {
  const rows = keyprintRows('ab'.repeat(32));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], ['abab', 'abab', 'abab', 'abab']);
});
