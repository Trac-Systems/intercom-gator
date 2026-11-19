import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBundle, validateBundle } from '../src/index.js';

test('logo references name a licensed source; chain token templates substitute exactly one address', () => {
  const base = loadBundle();
  const withChange = change => { const b = structuredClone(base); change(b); return () => validateBundle(b); };
  assert.doesNotThrow(withChange(() => {}));
  assert.throws(withChange(b => { delete b.chains[0].logoSource; }), /logo and logoSource/);
  assert.throws(withChange(b => { b.tokens.tokens.find(t => t.logo).logoSource = 'nobody'; }), /unknown logo source/);
  assert.throws(withChange(b => { b.chains[0].logo = 'http://insecure.example/x.png'; }), /https URL/);
  assert.throws(withChange(b => { b.chains[0].tokenLogo = 'https://x.example/{address}/{address}.png'; }), /template/);
  assert.throws(withChange(b => { b.tokens.exchangeLogos[0].extra = 1; }), /unknown field/);
  for (const e of base.tokens.exchangeLogos) assert.equal(e.logoSource, 'venue-site-icon');
  const site = base.tokens.sources.find(s => s.id === 'venue-site-icon');
  assert.deepEqual([site.url, site.license], [null, null]);
});
