import { test } from 'node:test';
import assert from 'node:assert/strict';
import { face, rememberAvatar } from '../public/js/lib/face.js';
import { dataUrlBytes, encodeUnder, kb } from '../public/js/ui/avatar-editor.js';

const key = 'ab'.repeat(32), hash = 'cd'.repeat(32);

test('face falls back to the key-print and swaps in a known signed picture', () => {
  assert.match(face({ key }, 36), /^<svg class="kp kp-tag"/);
  assert.doesNotMatch(face({ key }, 36), /data-av/);
  // Unknown image: the key-print waits for hydration.
  assert.match(face({ key, avatar: hash }, 36), /^<svg data-av="c?d/);
  // Anything but a SHA-256 is ignored.
  assert.doesNotMatch(face({ key, avatar: '"><script>' }, 36), /script|data-av/);
  rememberAvatar(hash, 'data:image/webp;base64,UklGRg==');
  const html = face({ key, avatar: hash }, 28, 'x');
  assert.match(html, /^<img class="kp kp-tag x av" src="data:image\/webp;base64,UklGRg==" width="28" height="28" alt=""/);
  // Only PNG and WebP data URLs are remembered.
  rememberAvatar('ef'.repeat(32), 'data:image/svg+xml;base64,PHN2Zz4=');
  assert.match(face({ key, avatar: 'ef'.repeat(32) }, 28), /^<svg data-av/);
});

test('the editor encodes WebP under the card room, else PNG, else nothing', () => {
  assert.equal(dataUrlBytes('data:image/png;base64,AAAA'), 3);
  assert.equal(dataUrlBytes('data:image/png;base64,AAA='), 2);
  assert.equal(kb(2048), '2 KB');
  const b64 = n => 'A'.repeat(Math.ceil(n / 3) * 4);
  const webp = { toDataURL: (type, q) => type === 'image/webp' ? 'data:image/webp;base64,' + b64(Math.round(q * 4000)) : 'data:image/png;base64,' + b64(9000) };
  const r = encodeUnder(webp, 2400);
  assert.equal(r.type, 'image/webp');
  assert.ok(r.bytes <= 2400 && r.quality < 0.7);
  // Browsers without a WebP encoder return PNG for image/webp.
  const pngOnly = n => ({ toDataURL: () => 'data:image/png;base64,' + b64(n) });
  assert.equal(encodeUnder(pngOnly(1500), 2400).type, 'image/png');
  assert.equal(encodeUnder(pngOnly(9000), 2400), null);
});
