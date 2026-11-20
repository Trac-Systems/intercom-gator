import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hiddenControl, hiddenTotal, includeFor, labelled, nameFlagChips, noteHidden, rowBadges, shortAsset, showsHidden,
  toggleHidden, unverifiedVolume, visBadge, withBadges } from '../public/js/lib/listmeta.js';
import { ratioText, splitsPanel } from '../public/js/ui/splits.js';

test('hidden entries: quiet control, include toggle and row badges', () => {
  assert.equal(hiddenControl('t1', { stale: 0, unconfirmed: 0, dust: 0 }), '');
  noteHidden('t1', { stale: 3, unconfirmed: 10, dust: 1 });
  assert.equal(hiddenTotal({ stale: 3, unconfirmed: 10, dust: 1 }), 14);
  assert.match(hiddenControl('t1'), /14 hidden · show/);
  assert.match(hiddenControl('t1'), /data-tip="3 stale: no price for over an hour\. 10 unconfirmed/);
  assert.deepEqual(includeFor('t1'), {});
  toggleHidden('t1');
  assert.ok(showsHidden('t1'));
  assert.deepEqual(includeFor('t1'), { include: 'hidden' });
  assert.match(hiddenControl('t1'), /Showing 14 hidden · hide/);
  toggleHidden('t1');
  const now = Date.UTC(2026, 10, 19, 12);
  assert.equal(visBadge({ visibility: 'live' }, now), '');
  assert.match(visBadge({ visibility: 'stale', staleSince: now - 3 * 3600_000 }, now), /class="vis vis-stale"[^>]*>stale · 3 h</);
  assert.match(visBadge({ visibility: 'dust' }, now), />dust</);
  assert.match(visBadge({ visibility: 'unconfirmed' }, now), /not yet confirmed/);
});

test('names: unnamed labels and imitation chips', () => {
  assert.equal(shortAsset('ethereum:0x1234567890abcdef1234567890abcdef12345678'), '0x1234…5678');
  assert.equal(shortAsset('bitcoin:native'), 'bitcoin');
  const t = { id: 'base:0xabcdef0123456789abcdef0123456789abcdef01', name: null, symbol: null, nameStatus: 'pending' };
  assert.equal(labelled(t).name, 'Unnamed · 0xabcd…ef01');
  assert.equal(labelled({ ...t, name: 'Kept', nameStatus: 'resolved' }).name, 'Kept');
  assert.match(rowBadges(t), /unnamed.*asking the token contract|asking the token contract.*unnamed/);
  assert.match(rowBadges({ ...t, nameStatus: 'unresolvable' }), /no readable name/);
  assert.match(nameFlagChips({ nameFlags: ["imitates:USDT"] }), /class="nflag"[^>]*ticker USDT[^>]*>same ticker</);
  assert.equal(nameFlagChips({}), '');
  const cell = '<div class="tok"><svg></svg><div class="nm"><b>X</b><span>X</span></div></div>';
  assert.equal(withBadges(cell, ''), cell);
  assert.match(withBadges(cell, '<i>b</i>'), /<span>X<span class="bdg"><i>b<\/i><\/span><\/span><\/div><\/div>$/);
  assert.match(withBadges('<b>x</b>', '<i>b</i>'), /<b>x<\/b><span class="bdg">/);
});

test('exchanges show unverified turnover apart; splits panel lists detached venues', () => {
  assert.equal(unverifiedVolume({ unresolvedVolume24h: 0 }), '');
  assert.match(unverifiedVolume({ unresolvedVolume24h: 722e9 }), /\+ \$722(\.0)?B unverified/);
  assert.match(unverifiedVolume({ unresolvedVolume24h: 722e9 }), /cannot match to a known asset/);
  // Volume the guard does not count (tokenized stocks' underlying volume) is named apart.
  const both = unverifiedVolume({ unresolvedVolume24h: 1e6, suspectVolume24h: 944e9 });
  assert.match(both, /\+ \$944(\.0)?B not counted/);
  assert.match(both, /tokenized stocks carrying the underlying stock market/);
  assert.equal(ratioText(12.44), '×12.4');
  assert.equal(ratioText(0.0312), '×0.031');
  assert.equal(ratioText(null), '—');
  const now = Date.UTC(2026, 10, 19, 12);
  assert.match(splitsPanel([], now), /No splits right now/);
  assert.match(splitsPanel(null, now), /Not available/);
  const html = splitsPanel([{ asset: 'rain:token', symbol: 'RAIN', price: 0.01, venues: 5, reason: null, guard: null,
    detached: [{ venue: 'bitget', label: 'RAIN', markets: ['cex:bitget:RAIN-USDT'], price: 1.2, ratio: 120, since: now - 7200_000 }] }], now);
  assert.match(html, /<b>RAIN<\/b>/);
  assert.match(html, /class="n">5</);
  assert.match(html, /bitget/);
  assert.match(html, /×120/);
  assert.match(html, />2 h</);
});
