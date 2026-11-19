import test from 'node:test';
import assert from 'node:assert/strict';
import { parts, tickers, topics, counter, charCount, matches, validHandle, validUrl, addressKind, isKey, POST_MAX } from '../public/js/lib/text.js';

test('splits tickers, mentions, topics and links', () => {
  const p = parts('Funding $BTC flipped, ask @deskmole #funding https://x.com/a.');
  assert.deepEqual(p.map((x) => x.t), ['text', 'ticker', 'text', 'mention', 'text', 'tag', 'text', 'url', 'text']);
  assert.equal(p[1].v, 'BTC');
  assert.equal(p[3].v, 'deskmole');
  assert.equal(p[7].v, 'https://x.com/a');
  assert.equal(p.map((x) => (x.t === 'text' ? x.v : '')).join('').includes('<'), false);
});

test('ticker rules', () => {
  assert.deepEqual(tickers('$SOL and $SOL and $sol and $X and $TOOLONGTICKER1'), ['SOL']);
  assert.deepEqual(tickers('$1INCH no, $INJ yes'), ['INJ']);
  assert.deepEqual(topics('#Pegs #pegs #fees'), ['pegs', 'fees']);
});

test('text stays text (no HTML is produced here)', () => {
  const p = parts('<script>alert(1)</script> $ETH');
  assert.equal(p[0].t, 'text');
  assert.equal(p[0].v, '<script>alert(1)</script> ');
});

test('compose counter counts code points', () => {
  assert.equal(charCount('🐊🐊'), 2);
  const c = counter('x'.repeat(470));
  assert.equal(c.left, 30); assert.ok(c.near); assert.ok(!c.over);
  assert.ok(counter('x'.repeat(POST_MAX + 1)).over);
  assert.equal(counter('').ratio, 0);
});

test('validators', () => {
  assert.ok(matches('', 'x'));
  assert.ok(matches('btc', 'Bitcoin', 'BTC'));
  assert.ok(!matches('eth', 'Bitcoin', null));
  assert.ok(validHandle('my_agent2')); assert.ok(!validHandle('A')); assert.ok(!validHandle('has space'));
  assert.ok(validUrl('https://eth.example')); assert.ok(validUrl('wss://x.example')); assert.ok(!validUrl('javascript:alert(1)')); assert.ok(!validUrl('nope'));
  assert.equal(addressKind('0x6982508145454ce325ddbe47a25d4ec3d2311933'), 'evm');
  assert.equal(addressKind('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'), 'sol');
  assert.equal(addressKind('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'), 'btc');
  assert.equal(addressKind('hello'), null);
  assert.ok(isKey('a'.repeat(64))); assert.ok(!isKey('A'.repeat(64)));
});
