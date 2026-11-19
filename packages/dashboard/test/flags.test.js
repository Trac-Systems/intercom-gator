// Risk flags: one compact chip per row whatever the source shape; null-safe token links.
import test from 'node:test';
import assert from 'node:assert/strict';
import { flagSet, chipInfo, isClean, flagLabel } from '../public/js/lib/flags.js';
import { flagChip, flagPop, flagsHTML, tokHref, rowLink, tokCell, scoreHTML, tick } from '../public/js/ui/components.js';

// What /api/v1/new sends for a token like Brett on a young node (owner screenshot, 11-19).
const BRETT = {
  id: 'base:0x532f27101965dd16442e59d40670faf5ebb142e4', name: 'Brett', symbol: 'BRETT', chain: 'base',
  flags: ['upgradeable unknown', 'ownerMint unknown', 'ownerPause unknown', 'blacklist unknown', 'lpUnlocked unknown', 'veryNew unknown', 'lowLiquidity unknown', 'risk unchecked'],
};

test('API strings: raised keys, "<key> unknown" and "risk unchecked"', () => {
  const fs = flagSet(['ownerMint', 'lpUnlocked', 'upgradeable unknown']);
  assert.deepEqual(fs.raised.map((f) => f.key), ['ownerMint', 'lpUnlocked']); // severe first
  assert.equal(fs.worst, 'r');
  assert.deepEqual(fs.unknown.map((f) => f.label), ['Upgradeable contract']);
  assert.equal(fs.checked, true);
  assert.equal(flagSet(['risk unchecked']).checked, false);
});

test('raw riskFlags win over strings and add clear (false) checks', () => {
  const fs = flagSet(['veryNew unknown'], { veryNew: true, ownerMint: false, blacklist: 'unknown' });
  assert.deepEqual(fs.raised.map((f) => f.key), ['veryNew']);
  assert.equal(fs.worst, 'y');
  assert.deepEqual(fs.clear.map((f) => f.key), ['ownerMint']);
  assert.deepEqual(fs.unknown.map((f) => f.key), ['blacklist']);
});

test('sample sentences still work', () => {
  const fs = flagSet(['owner can mint', 'liquidity unlocked']);
  assert.equal(fs.worst, 'r');
  assert.equal(fs.raised[0].label, 'Owner can mint');
  assert.equal(chipInfo(flagSet([])).text, 'No flags');
  assert.equal(isClean(flagSet([])), true);
});

test('labels: known keys written out, others de-camelCased', () => {
  assert.equal(flagLabel('lpUnlocked'), 'Liquidity not locked');
  assert.equal(flagLabel('someNewCheck'), 'Some new check');
  assert.equal(flagLabel('sell_tax_high'), 'Sell tax high');
});

test('chip text: count + worst severity; unknown-only and unchecked are neutral', () => {
  assert.deepEqual(chipInfo(flagSet(['ownerMint', 'veryNew'])).text, '2 flags');
  assert.equal(chipInfo(flagSet(['ownerMint', 'veryNew'])).cls, 'r');
  assert.equal(chipInfo(flagSet(['veryNew'])).text, '1 flag');
  assert.equal(chipInfo(flagSet(['veryNew'])).cls, 'y');
  assert.equal(chipInfo(flagSet(['a unknown', 'b unknown'])).text, '2 unknown');
  assert.equal(chipInfo(flagSet(['a unknown', 'b unknown'])).cls, 'u');
  const brett = chipInfo(flagSet(BRETT.flags));
  assert.equal(brett.text, 'Unchecked');
  assert.equal(brett.cls, 'u');
  assert.equal(isClean(flagSet(['a unknown'])), false); // unknown is not clean
});

test('flagChip renders ONE fixed button for 8 flags, with the full list for screen readers and hover', () => {
  const h = flagChip({ ...BRETT, flags: ['ownerMint', 'ownerPause', 'blacklist', 'upgradeable', 'lpUnlocked', 'veryNew', 'lowLiquidity', 'honeypot'] });
  assert.equal((h.match(/<button/g) || []).length, 1);
  assert.match(h, /class="fchip r"/);
  assert.match(h, />8 flags</);
  assert.match(h, /aria-haspopup="dialog"/);
  assert.match(h, /aria-label="Risk: 8 flags: Owner can mint, Owner can pause/);
  assert.match(h, /data-flags="base:0x532f/);
  assert.doesNotMatch(h, /class="flag /); // no per-flag pills in the row
});

test('flagPop lists every flag with its state and links to the token', () => {
  const h = flagPop({ ...BRETT, flags: ['ownerMint', 'veryNew unknown'], riskFlags: { blacklist: false } });
  assert.match(h, /Owner can mint<\/span><span class="st">Yes/);
  assert.match(h, /Very new<\/span><span class="st">Unknown/);
  assert.match(h, /Owner can blacklist<\/span><span class="st">No/);
  assert.match(h, /href="#\/token\/base%3A0x532f/);
  assert.match(flagPop({ id: 'x:y', symbol: 'Q', flags: ['risk unchecked'] }), /Not checked yet/);
});

test('flagsHTML (token page) shows raised flags only, labelled', () => {
  assert.match(flagsHTML(['ownerMint', 'veryNew unknown']), /Owner can mint/);
  assert.doesNotMatch(flagsHTML(['ownerMint', 'veryNew unknown']), /Very new/);
  assert.match(flagsHTML(['risk unchecked']), /Unchecked/);
});

test('never a link to #/token/null: tokHref, rowLink, tokCell and tick guard missing ids', () => {
  for (const id of [null, undefined, '', 'null', 'undefined']) {
    assert.equal(tokHref({ id }), '');
    assert.equal(rowLink({ id }), '');
    const cell = tokCell({ watch: new Set(), mentions: new Map() }, { id, symbol: 'BTCUSDT', name: 'BTCUSDT' }, 'bybit');
    assert.doesNotMatch(cell, /href=/);
    assert.match(cell, /BTCUSDT/);
  }
  assert.equal(tokHref({ id: 'bitcoin:native' }), '#/token/bitcoin%3Anative');
  assert.equal(rowLink({ id: 'bitcoin:native' }), ' data-href="#/token/bitcoin%3Anative"');
  const ctx = { idx: { byId: new Map(), bySym: new Map([['X', { id: null, symbol: 'X', name: 'X' }]]) } };
  assert.equal(tick(ctx, 'X'), '$X');
});

test('trust score: null renders a quiet dash with the reason, never "null"; trustWhy goes in the tooltip', () => {
  const nil = scoreHTML(null, { comparedMarkets: 1 });
  assert.doesNotMatch(nil, /null|NaN/);
  assert.match(nil, /1 so far/);
  const s = scoreHTML(7, { agreement: 4.4, freshness: 2, confirmation: 0, book: 0.5, comparedMarkets: 37 });
  assert.match(s, /Trust 7 of 10/);
  assert.match(s, /Price agreement 4.4\/5/);
  assert.match(s, /37 markets compared/);
  assert.equal((s.match(/class="on"/g) || []).length, 7);
});
