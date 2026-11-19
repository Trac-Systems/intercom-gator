import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBundle, validateBundle } from '../src/index.js';

const bundle = loadBundle();

test('categorised tokens require a taxonomy member, provenance and a reason for manual entries', () => {
  const sample = structuredClone(bundle);
  if (!sample.tokens.sources.some(s => s.id === 'gator-curated')) {
    sample.tokens.sources.push({ id: 'gator-curated', url: null, license: null, version: null, licenseUrl: null });
  }
  const t = sample.tokens.tokens[0];
  delete t.category;
  delete t.categorySource;
  delete t.categoryReason;
  assert.equal(validateBundle(sample), sample); // Archived lists and genuinely unknown assets.
  t.category = 'oracle-data';
  assert.throws(() => validateBundle(sample), /categorySource/);
  t.categorySource = 'unlisted';
  assert.throws(() => validateBundle(sample), /unknown category source/);
  t.categorySource = 'gator-curated';
  assert.throws(() => validateBundle(sample), /categoryReason/);
  t.categoryReason = 'Runs an oracle network.';
  assert.equal(validateBundle(sample), sample);
  t.category = 'Other';
  assert.throws(() => validateBundle(sample), /category/);
  delete t.category;
  assert.throws(() => validateBundle(sample), /categorySource/);
});

test('unseeded classifications require a unique valid deployment and the enclosing source', () => {
  const b = structuredClone(bundle);
  const source = b.tokens.sources.find(s => s.id === 'gator-curated');
  const row = { id: 'ethereum:0x' + 'a'.repeat(40), category: 'oracle-data',
    categorySource: source.id, categoryReason: 'Supplies oracle prices.' };
  source.assetCategories = [row];
  assert.equal(validateBundle(b), b);
  row.id = b.tokens.tokens[0].id;
  assert.throws(() => validateBundle(b), /duplicate classified/);
  row.id = 'solana:USDT';
  assert.throws(() => validateBundle(b), /32-byte address/);
  row.id = 'ethereum:0x' + 'a'.repeat(40);
  row.categorySource = 'gator-rules';
  assert.throws(() => validateBundle(b), /match its source/);
});

test('rebuild preserves manual decisions, checks reciprocal links and withdraws unsupported machine tags', async () => {
  const { categorise } = await import('../scripts/categories.js');
  const token = (id, links = [], extra = {}) => ({ id, links, name: 'Coin', symbol: 'USDC', ...extra });
  const manual = token('a:one', ['b:one', 'c:conflict'], {
    category: 'oracle-data', categorySource: 'gator-curated', categoryReason: 'Supplies price feeds.',
  });
  const wrapped = token('d:two', ['c:conflict'], { category: 'defi', categorySource: 'gator-curated',
    categoryReason: 'Runs a lending protocol.' });
  const input = { chains: [], dex: { evm: [] }, tokens: {
    sources: [{ id: 'trustwallet-assets', assetCategories: [
      { id: 'other:discovered', category: 'meme', categorySource: 'trustwallet-assets' },
    ] }],
    tokens: [manual, wrapped, token('b:one', ['a:one']), token('c:conflict', ['a:one', 'd:two']),
      token('e:one', ['a:one']), token('f:one', [], { category: 'stablecoin', categorySource: 'gator-linked' }),
      token('g:game'), token('h:sky', [], { name: 'SKY Governance Token' })],
  } };
  const records = new Map([['g:game', { tags: ['gamefi'] }], ['h:sky', { tags: ['stablecoin', 'defi'] }],
    ['other:discovered', { tags: ['privacy'] }]]);
  const data = categorise(input, records);
  assert.deepEqual(data.tokens[0], manual);
  assert.deepEqual(data.tokens.map(t => t.category ?? null),
    ['oracle-data', 'defi', 'oracle-data', null, null, null, 'gaming', null]);
  assert.equal(data.tokens[2].categorySource, 'gator-linked');
  assert.equal(data.sources[0].assetCategories[0].category, 'privacy');
  assert.deepEqual(categorise({ ...input, tokens: data }, records), data);
});
