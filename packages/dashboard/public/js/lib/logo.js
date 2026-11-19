// Token, chain and exchange marks with the node's own logo image.
// The key-print identicon is the mark while the image loads and whenever there is none: the image sits on top of the
// identicon in a box of the same size (no layout shift) and is shown once it has decoded. Logos come only from the
// local node (`/img/<sha256>.<ext>`); anything else in a `logo` field is ignored.

import { kp, kpData, tokSeed } from './keyprint.js';

const LOCAL = /^\/img\/[0-9a-f]{64}\.(?:png|webp|jpg)$/;
/** Sources that decoded (render as shown, no fade) and sources that failed (render the identicon only). */
const loaded = new Set();
const failed = new Set();

/**
 * @param {string} seed key-print seed
 * @param {'coin'|'tag'|'sq'} shape identicon shape (the image itself is always round)
 * @param {number} size CSS px
 * @param {string|null|undefined} logo `/img/<sha>.<ext>` from the API
 * @param {string} [cls]
 */
export function mark(seed, shape, size, logo, cls) {
  if (typeof logo !== 'string' || !LOCAL.test(logo) || failed.has(logo)) return kp(seed, shape, size, cls);
  const d = kpData(seed);
  const svg = '<svg class="kp-' + shape + '" viewBox="0 0 30 30" width="' + size + '" height="' + size + '" style="--ha:' + d.ha + ';--hb:' + d.hb + '" aria-hidden="true"><rect class="g" width="30" height="30"/><path class="b" d="' + d.b + '"/><path class="a" d="' + d.a + '"/></svg>';
  return '<span class="kp lg' + (loaded.has(logo) ? ' on' : '') + (cls ? ' ' + cls : '') + '" style="--s:' + size + 'px">' + svg +
    '<img src="' + logo + '" alt="" width="' + size + '" height="' + size + '" loading="lazy" decoding="async" draggable="false"></span>';
}

/** Token mark (asset row, search hit, chip). @param {any} t @param {number} size @param {string} [cls] */
export function tokMark(t, size, cls) { return mark(tokSeed(t), 'coin', size, t && t.logo, cls); }
/** Chain mark; seed as before (`chain:` + display name). @param {{ name: string, logo?: string|null }} c @param {number} size */
export function chainMark(c, size) { return mark('chain:' + c.name, 'coin', size, c.logo); }
/** Exchange mark; seed as before (`ex:` + venue name). @param {string} name @param {string|null|undefined} logo @param {number} size */
export function exMark(name, logo, size) { return mark('ex:' + name, 'tag', size, logo); }

function settle(event, ok) {
  const img = event.target;
  if (!(img instanceof HTMLImageElement) || !img.parentElement || !img.parentElement.classList.contains('lg')) return;
  const src = img.getAttribute('src');
  if (ok) { loaded.add(src); img.parentElement.classList.add('on'); }
  else { failed.add(src); img.remove(); }
}
if (typeof document !== 'undefined') {
  // load/error do not bubble; capture sees every image (inline handlers are not allowed by the CSP).
  document.addEventListener('load', (e) => settle(e, true), true);
  document.addEventListener('error', (e) => settle(e, false), true);
}
