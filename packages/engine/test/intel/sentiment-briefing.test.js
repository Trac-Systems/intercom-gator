import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sentiment, socialScore } from '../../src/intel/sentiment.js';
import { briefingMarkdown, buildBriefing, writeBriefing } from '../../src/intel/briefing.js';
import { DAY } from '../../src/intel/values.js';

const a = 'ethereum:native', b = 'bitcoin:native', at = 10 * DAY;
const keys = ['1', '2', '3'].map(c => c.repeat(64));
function post(id, key, ts, text, tickers) {
  return { key, id, ts, t: 'post', text, tickers };
}

test('mention counts use adjacent windows, authenticated identities and unambiguous asset IDs', () => {
  const posts = [post('old', keys[0], at - DAY - 1, '$ETH', []),
    post('new', keys[0], at - DAY, '$ETH $ETH', [{ sym: 'ETH', asset: a }]),
    post('new', keys[1], at - 2, '$ETH', []), post('new2', keys[2], at - 3, '$ETH', []),
    post('other', keys[0], at - 4, '$ETH', [{ sym: 'ETH', asset: b }]),
    post('uri', keys[0], at - 5, 'https://example.org/$ETH', []),
    post('future', keys[0], at, '$ETH', [])];
  posts.push(posts[1]);
  const opts = { posts, at, resolveSymbol: s => s === 'ETH' ? a : null, isFollowed: k => k === keys[0], isReputable: k => k === keys[1] };
  const r = sentiment(a, opts);
  assert.deepEqual([r.mentions, r.previous, r.change, r.changePct], [3, 1, 2, 200]);
  assert.deepEqual(r.posts.map(p => p.key), [keys[1], keys[0]]);
  const unresolved = sentiment(a, { posts, at });
  assert.equal(unresolved.mentions, 1);
  assert.equal(unresolved.changePct, null);
});

test('social factor measures directional words and activity against seven prior days', () => {
  const one = post('today', keys[0], at - 1, '$ETH bullish strong', []);
  const history = Array.from({ length: 14 }, (_, i) => post(String(i), keys[1], at - 2 * DAY, '$ETH', []));
  const eligibility = { isFollowed: k => k === keys[0], isProven: k => k === keys[1] };
  const score = rows => socialScore(rows, at, eligibility);
  const active = score([one]), lessActive = score([one, ...history]);
  assert.ok(active > lessActive && lessActive > 50);
  assert.ok(score([{ ...one, text: '$ETH bearish crash' }]) < 50);
  assert.equal(score([{ ...one, text: 'bullish strong' }]), 50);
  assert.equal(socialScore([], at), 50);
});

test('briefing facts rank price changes, attach risk, select hit alerts and quote trusted-author posts', async t => {
  const posts = [post('a', keys[0], at - 1, 'a\n## Fake header <script> ```', []), post('b', keys[2], at, 'ordinary', [])];
  const facts = buildBriefing({ at, since: at - DAY,
    assets: [{ id: a, symbol: 'ETH', change24h: '-1.4', at }, { asset: b, change24h: 3, at }],
    newTokens: [{ asset: a, firstSeen: at - 4, flags: { ownerMint: true, unsellable: 'unknown' } }],
    fearGreed: { at, value: 50, label: 'Neutral' },
    alerts: [{ asset: b, direction: 'above', threshold: '20', hitAt: at }, { asset: a, hitAt: null }], posts,
    isFollowed: k => k === keys[0] });
  assert.equal(facts.topMovers.gainers[0].asset, b);
  assert.equal(facts.topMovers.losers[0].asset, a);
  assert.equal(facts.notablePosts.length, 1);
  assert.equal(facts.alertsHit.length, 1);
  assert.equal(facts.alertsHit[0].isNew, true);
  const md = briefingMarkdown(facts);
  assert.match(md, /Fear & Greed/); assert.match(md, /50\/100/); assert.match(md, /ownerMint/);
  assert.match(md, /unknown .*unsellable/); assert.doesNotMatch(md, /^## Fake/m);
  // Temporary output stays inside the assigned test directory and is removed even on failure.
  const dir = await mkdtemp(join(import.meta.dirname, 'briefing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = await writeBriefing(dir, facts);
  assert.equal(filename, join(dir, 'agent', 'market', 'briefing.md'));
  assert.equal(await readFile(filename, 'utf8'), md);
  await writeBriefing(dir, buildBriefing({ at }));
  assert.deepEqual(await readdir(join(dir, 'agent', 'market')), ['briefing.md']);
  assert.doesNotMatch(await readFile(filename, 'utf8'), /Fake header/);
});
