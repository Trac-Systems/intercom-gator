// Person marks: the avatar a key signed into its profile card, else its key-print.
// Views render `face(person, size)` synchronously. A known image is drawn at once; an unknown one renders the
// key-print with `data-av` and is swapped in when its bytes arrive (one request per hash, cached for the page).

import { kp, keySeed } from './keyprint.js';

const HASH = /^[0-9a-f]{64}$/;
const DATA_URL = /^data:image\/(?:png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
/** @type {Map<string, string|null>} hash → data URL (null: not available) */
const images = new Map();
/** @type {Map<string, Promise<void>>} */
const pending = new Map();
/** @type {null | ((hash: string) => Promise<{type: string, data: string}>)} */
let fetcher = null;

/** Escape for an attribute (hashes and data URLs are already strict; this is belt and braces). @param {string} s */
const attr = (s) => s.replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);

/** @param {string} url @param {string} cls @param {number} size */
function img(url, cls, size) {
  return `<img class="${attr(cls)} av" src="${attr(url)}" width="${size}" height="${size}" alt="" aria-hidden="true" decoding="async" draggable="false">`;
}

/**
 * The mark for a person or channel: their signed avatar when they have one, else the key-print tag.
 * @param {{key?: string, avatar?: string|null}|null|undefined} p @param {number} size @param {string} [cls]
 */
export function face(p, size, cls) {
  const key = String(p?.key || '');
  const mark = kp(keySeed(key), 'tag', size, cls);
  const hash = p?.avatar;
  if (!hash || !HASH.test(hash)) return mark;
  const url = images.get(hash);
  if (url) return img(url, 'kp kp-tag' + (cls ? ' ' + cls : ''), size);
  if (url === null) return mark;
  return mark.replace('<svg ', `<svg data-av="${hash}" `);
}

/** Remember an image the page already has (e.g. right after saving one). @param {string} hash @param {string} url */
export function rememberAvatar(hash, url) {
  if (HASH.test(hash) && DATA_URL.test(url)) images.set(hash, url);
}

const RETRY_MS = 15000;
/** @type {Map<string, number>} hash → when a failed fetch may run again */
const retryAt = new Map();

/** @param {string} hash @returns {Promise<boolean>} true when the fetch failed for a passing reason */
async function fetchOne(hash) {
  try {
    const r = await /** @type {NonNullable<typeof fetcher>} */ (fetcher)(hash);
    const url = 'data:' + r.type + ';base64,' + r.data;
    images.set(hash, DATA_URL.test(url) && ['image/png', 'image/webp'].includes(r.type) ? url : null);
    return false;
  } catch (e) {
    // A missing image stays missing for this page. A timeout or a busy node is retried shortly instead of
    // leaving the key-print in place until the next reload.
    if (/** @type {any} */ (e)?.status === 404) { images.set(hash, null); return false; }
    retryAt.set(hash, Date.now() + RETRY_MS);
    setTimeout(() => hydrateAvatars(document), RETRY_MS);
    return true;
  }
}

/** @param {string} hash */
function load(hash) {
  let job = pending.get(hash);
  if (!job && !((retryAt.get(hash) ?? 0) > Date.now())) {
    job = fetchOne(hash);
    pending.set(hash, job);
    job.then((retry) => { if (retry) pending.delete(hash); });
  }
  return job ?? Promise.resolve(true);
}

/** Swap every waiting key-print under `root` whose image is known or arrives. @param {ParentNode} root */
export function hydrateAvatars(root) {
  if (!fetcher) return;
  for (const el of /** @type {NodeListOf<SVGElement>} */ (root.querySelectorAll('svg[data-av]'))) {
    const hash = el.getAttribute('data-av') || '';
    el.removeAttribute('data-av');
    load(hash).then(() => {
      // Not settled yet (failed for a passing reason): wait for the retry pass.
      if (!images.has(hash)) { if (el.isConnected) el.setAttribute('data-av', hash); return; }
      const url = images.get(hash);
      if (!url || !el.isConnected) return;
      const size = Number(el.getAttribute('width')) || 36;
      const tpl = document.createElement('template');
      tpl.innerHTML = img(url, el.getAttribute('class') || 'kp kp-tag', size);
      el.replaceWith(tpl.content);
    });
  }
}

/**
 * Start hydrating avatars wherever views render. One observer for the whole page; views stay synchronous strings.
 * @param {(hash: string) => Promise<{type: string, data: string}>} fetchAvatar
 */
export function watchAvatars(fetchAvatar) {
  fetcher = fetchAvatar;
  let queued = false;
  const run = () => { queued = false; hydrateAvatars(document); };
  new MutationObserver(() => { if (!queued) { queued = true; queueMicrotask(run); } })
    .observe(document.body, { childList: true, subtree: true });
  run();
}
