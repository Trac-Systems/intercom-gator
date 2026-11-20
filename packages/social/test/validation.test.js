import test from 'node:test';
import assert from 'node:assert/strict';
import { extractText, isCard, isHandle, isHttpUrl, isText, validMessage, validEnvelope } from '../src/validate.js';
import { Hub } from './hub.js';
import { settingsFor, policyFor } from '../src/policy.js';

test('handle grammar accepts exactly the bounded lowercase ASCII alphabet', () => {
  let state = 82721;
  const random = n => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) % n);
  for (let i = 0; i < 4000; i++) {
    const chars = i % 2 ? 'asdf_93' : 'asdf_93@😺 AZ-\n';
    const handle = Array.from({ length: random(32) }, () => chars[random(chars.length)]).join('');
    assert.equal(isHandle(handle), handle.length >= 2 && handle.length <= 24 &&
      [...handle].every(c => 'abcdefghijklmnopqrstuvwxyz0123456789_'.includes(c)));
  }
});

test('text boundaries count Unicode code points and validate schemes everywhere', () => {
  for (const glyph of ['a', '猫', '😺']) {
    for (let n = 490; n <= 510; n++) assert.equal(isText(glyph.repeat(n)), n <= 500);
  }
  for (const scheme of ['file://', 'data:', 'javascript:', 'FtP://', 'arbitrary:']) {
    for (const prefix of ['', '[read](', 'some text ']) assert.equal(isText(prefix + scheme + 'host/x)'), false);
  }
  for (let n = 1; n <= 7; n++) assert.equal(isText('see ' + 'https://host.tld/x '.repeat(n)), n <= 4);
  assert.ok(isText('Update: see https://example.com\nNext line.'));
  assert.equal(isHttpUrl('https://'), false);
  assert.equal(isText('a\u202eb'), false);
});

test('metadata extraction ignores email addresses, URL fragments and repeated labels', () => {
  assert.deepEqual(extractText('$btc $BTC #Cats #cats @BOB01, a@else.io https://e.test/#fake'), {
    tickers: [{ sym: 'BTC' }], tags: ['cats'], handles: ['bob01']
  });
});

test('typed messages reject unexpected fields, invalid references, untrusted links and malformed cards', () => {
  const card = { handle: 'cat', harnesses: ['gator'] };
  assert.ok(isCard(card));
  for (const field of [{ links: ['ftp://a.test'] }, { proofs: { github: 'x/y' } },
    { proofs: { dns: 'host/a' } }, { harnesses: 1 }, { bio: 'a'.repeat(161) }, { handle: 'X' }]) {
    assert.equal(isCard({ ...card, ...field }), false);
  }
  for (const value of [null, [], 23, true, {}, { t: '__proto__', v: 1 }, { t: 'notice', v: 2, text: 'ok' },
    { v: 1, t: 'notice', text: 'ad', paid: true }, { t: 'like', v: 1, target: { id: 'x' } }]) {
    assert.equal(validMessage(value), false);
  }
});

test('network policy always authenticates and clamps sizes, work, rates and hops', () => {
  const root = 'a'.repeat(64);
  for (const n of [-999, 0, 15, 1e7]) {
    const settings = settingsFor({ caps: { reply: n }, pow: { reply: n }, rates: { posts: n }, relayTtl: n });
    const policy = policyFor('soc/r/' + root, root, settings);
    assert.ok(policy.verifySignature && policy.maxReceiveBytes >= 1024 && policy.maxReceiveBytes <= 2048);
    assert.ok(policy.powDifficulty >= 8 && policy.powDifficulty <= 16);
    assert.ok(settings.rates.posts >= 1 && settings.rates.posts <= 100);
    assert.ok(settings.relayTtl >= 1 && settings.relayTtl <= 8);
  }
  assert.equal(policyFor('soc/official', root, settingsFor()).ownerKey, root);
});

test('adjacent Markdown links and mixed card fields share the four-link wire limit', () => {
  for (const sep of ['', ', ', ' ']) {
    const link = '[safe](https://example.org)';
    assert.equal(isText(Array(5).fill(link).join(sep)), false);
    assert.equal(isText(link + sep + '[bad](javascript:alert(1))'), false);
    assert.equal(isText(Array(4).fill(link).join(sep)), true);
  }
  assert.ok(isText('http://[::1]:8080/path'));
  assert.equal(isCard({ handle: 'at', harnesses: [], bio: 'https://a.test', links: Array(4).fill('https://a.test') }), false);
});

test('generated signed envelopes bind every authenticated field and survive wire JSON round trips', () => {
  const hub = new Hub(), peer = hub.peer();
  const channel = 'soc/u/' + peer.publicKey;
  const other = hub.peer().publicKey;
  for (let i = 0; i < 100; i++) {
    const text = 'Observation ' + i + ' 🐈 $1INCH #topic';
    const e = peer.envelope(channel, { v: 1, t: 'post', text });
    assert.ok(validEnvelope(channel, JSON.parse(JSON.stringify(e)), peer.publicKey));
    for (const edit of [{ ts: e.ts - i - 1 }, { id: e.id + 'a' }, { from: other }, { origin: other },
      { channel: 'soc/p/gator' }, { message: { ...e.message, text: text + '!' } }]) {
      const modified = { ...e, ...edit };
      assert.equal(validEnvelope(modified.channel, modified, peer.publicKey), false);
    }
    assert.ok(validEnvelope(channel, { ...e, ttl: 1 }, peer.publicKey));
  }
  assert.deepEqual(extractText('$1INCH and $42').tickers, [{ sym: '1INCH' }]);
  assert.equal(isText('Open [this](//example.org)'), false);
});

test('root network settings may carry up to eight blind relay keys', () => {
  const root = 'a'.repeat(64), key = n => n.toString(16).padStart(64, '0');
  const net = relays => validMessage({ t: 'net', v: 1, seq: 1, relays }, root, root);
  assert.equal(net([key(1), key(2)]), true);
  assert.equal(net([]), true);
  assert.equal(net(Array.from({ length: 9 }, (_, i) => key(i + 1))), false);
  assert.equal(net(['not-a-key']), false);
  assert.equal(net([key(0xabc).toUpperCase()]), false);
  assert.deepEqual(settingsFor({ seq: 1, relays: [key(3)] }).relays, [key(3)]);
  assert.equal(settingsFor({ seq: 1 }).relays, null, 'absent keeps the release list');
});

test('only the public lane accepts shares and wants, and a share authenticates the author independently', () => {
  const hub = new Hub(), author = hub.peer(), forwarder = hub.peer();
  const ownerLane = 'soc/u/' + author.publicKey;
  const ref = { key: forwarder.publicKey, id: 'original' };
  const post = author.envelope(ownerLane, { v: 1, t: 'post', text: 'Quoted news', quote: ref });
  const share = original => ({ v: 1, t: 'share', original });
  const valid = (message, channel = 'soc/all', signer = forwarder) =>
    validEnvelope(channel, signer.envelope(channel, message), forwarder.publicKey);
  for (const message of [share(post), { v: 1, t: 'want' }, { v: 1, t: 'want', since: 123 }]) {
    assert.ok(valid(message));
    assert.ok(valid(message, 'soc/all', author));
    for (const channel of ['soc/official', 'soc/dir', 'soc/p/gator', 'soc/pr/gator',
      'soc/u/' + forwarder.publicKey, 'soc/r/' + forwarder.publicKey]) assert.equal(valid(message, channel), false);
  }
  for (const message of [{ v: 1, t: 'want', since: -1 }, { v: 1, t: 'want', limit: 500 },
    post.message, { v: 1, t: 'mention', original: post }]) assert.equal(valid(message), false);
  for (const message of [{ t: 'reply', text: 'hi', parent: ref }, { t: 'repost', target: ref, original: post },
    { t: 'follow', key: ref.key }, { t: 'card', handle: 'writer', harnesses: [] }]) {
    assert.equal(valid(share(author.envelope(ownerLane, { v: 1, ...message }))), false);
  }
  for (const original of [{ ...post, message: { ...post.message, text: 'edited' } },
    forwarder.envelope(ownerLane, post.message, { from: author.publicKey }),
    forwarder.envelope('soc/p/gator', post.message), forwarder.envelope(ownerLane, post.message)]) {
    assert.equal(valid(share(original)), false);
  }
});

test('signed root net accepts legacy settings and clamps opt-in public overrides', () => {
  const root = new Hub().peer(), channel = 'soc/official';
  for (const [overrides, bytes, work] of [[{}, 4096, 12],
    [{ caps: { public: 1 }, pow: { public: 100 } }, 2048, 16],
    [{ caps: { public: 9999 }, pow: { public: 0 } }, 4096, 8]]) {
    const message = { t: 'net', v: 1, seq: 7, rates: { posts: 6 }, ...overrides };
    assert.ok(validEnvelope(channel, root.envelope(channel, message), root.publicKey));
    assert.deepEqual(policyFor('soc/all', root.publicKey, settingsFor(message)),
      { verifySignature: true, maxReceiveBytes: bytes, powDifficulty: work });
  }
  assert.equal(validMessage({ t: 'net', v: 1, seq: 7, caps: { unknown: 1 } }), false);
});
