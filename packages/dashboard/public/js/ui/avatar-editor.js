// Settings → Profile: pick a picture, crop it square, shrink it to 96 × 96 WebP (PNG when the browser cannot
// encode WebP) under the room left in the signed card, preview, save or remove. Everything happens in this tab;
// only the final small image is sent to the node, which checks it again and signs it into the card.

import { esc } from '../lib/format.js';
import { face, rememberAvatar } from '../lib/face.js';

export const AVATAR_PX = 96;
const VIEW = 240; // crop viewport in canvas pixels (CSS size is set in avatars.css)
const QUALITIES = [0.92, 0.85, 0.78, 0.7, 0.62, 0.54, 0.46, 0.38, 0.3, 0.22];

/** Bytes of a base64 data URL's payload. @param {string} url */
export function dataUrlBytes(url) {
  const b64 = url.slice(url.indexOf(',') + 1);
  return Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
}
/** @param {number} n */
export const kb = (n) => (n / 1024).toFixed(1).replace(/\.0$/, '') + ' KB';

/**
 * Encode a canvas under `room` bytes: WebP at falling quality, else PNG. Returns null when nothing fits.
 * @param {{toDataURL: (type: string, q?: number) => string}} canvas @param {number} room
 * @returns {{url: string, bytes: number, type: string, quality: number|null} | null}
 */
export function encodeUnder(canvas, room) {
  for (const q of QUALITIES) {
    const url = canvas.toDataURL('image/webp', q);
    if (!url.startsWith('data:image/webp')) break; // no WebP encoder here: try PNG
    const bytes = dataUrlBytes(url);
    if (bytes <= room) return { url, bytes, type: 'image/webp', quality: q };
  }
  const png = canvas.toDataURL('image/png');
  const bytes = dataUrlBytes(png);
  return png.startsWith('data:image/png') && bytes <= room ? { url: png, bytes, type: 'image/png', quality: null } : null;
}

/** The avatar row at the top of the profile form. @param {any} me */
export function avatarRow(me) {
  const room = Math.min(6144, me.avatarRoom ?? 6144);
  return `<div class="rowset av-row"><span class="k">Picture<small>Shown instead of your key-print</small></span>` +
    `<span class="v" style="display:block"><span class="av-now">${face(me, 64)}<span class="av-act">` +
    `<label class="btn sm" for="av-file">Choose image…</label><input type="file" id="av-file" accept="image/png,image/webp,image/jpeg,image/gif" hidden>` +
    `${me.avatar ? '<button class="btn sm" type="button" data-av-remove>Remove</button>' : ''}</span></span>` +
    `<span class="hint2 av-note">It travels inside your signed profile card, so every node that sees your card can show it, and anyone can keep a copy. ` +
    `Cropped square and shrunk to 96 × 96, at most ${esc(kb(room))} with this card.</span>` +
    `<div class="av-edit" id="av-edit" hidden></div></span></div>`;
}

/**
 * Wire the picker, the crop box and save/remove. Returns cleanup.
 * @param {any} ctx @param {HTMLElement} root
 */
export function mountAvatarEditor(ctx, root) {
  const input = /** @type {HTMLInputElement|null} */ (root.querySelector('#av-file'));
  const box = /** @type {HTMLElement|null} */ (root.querySelector('#av-edit'));
  if (!input || !box) return () => {};
  const room = Math.min(6144, ctx.me?.avatarRoom ?? 6144);
  /** @type {null | {img: HTMLImageElement, zoom: number, x: number, y: number}} */
  let st = null;
  let drag = null;

  const out = document.createElement('canvas');
  out.width = out.height = AVATAR_PX;

  /** Cover the viewport, then zoom; x/y is the image point at the viewport centre. */
  function geometry(size) {
    const { img, zoom } = /** @type {NonNullable<typeof st>} */ (st);
    const scale = Math.max(size / img.naturalWidth, size / img.naturalHeight) * zoom;
    return { scale, w: img.naturalWidth * scale, h: img.naturalHeight * scale };
  }
  function clamp() {
    const s = /** @type {NonNullable<typeof st>} */ (st);
    const { scale } = geometry(VIEW);
    const half = VIEW / 2 / scale;
    s.x = Math.min(Math.max(s.x, half), s.img.naturalWidth - half);
    s.y = Math.min(Math.max(s.y, half), s.img.naturalHeight - half);
  }
  function draw(canvas, size) {
    const s = /** @type {NonNullable<typeof st>} */ (st);
    const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    const { scale, w, h } = geometry(size);
    g.clearRect(0, 0, size, size);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(s.img, size / 2 - s.x * scale, size / 2 - s.y * scale, w, h);
  }
  /** @type {ReturnType<typeof encodeUnder>} */
  let result = null;
  function render() {
    if (!st) return;
    clamp();
    draw(/** @type {HTMLCanvasElement} */ (box.querySelector('#av-crop')), VIEW);
    draw(out, AVATAR_PX);
    result = encodeUnder(out, room);
    const info = /** @type {HTMLElement} */ (box.querySelector('#av-size'));
    const save = /** @type {HTMLButtonElement} */ (box.querySelector('[data-av-save]'));
    if (result) {
      for (const el of box.querySelectorAll('#av-prev,#av-prev-s')) /** @type {HTMLImageElement} */ (el).src = result.url;
      info.textContent = `${result.type === 'image/webp' ? 'WebP' : 'PNG'} · ${kb(result.bytes)} of ${kb(room)}`;
      info.classList.remove('err');
    } else {
      info.textContent = 'This browser cannot make this picture small enough. Try a simpler picture or another browser.';
      info.classList.add('err');
    }
    save.disabled = !result;
  }
  function open(img) {
    st = { img, zoom: 1, x: img.naturalWidth / 2, y: img.naturalHeight / 2 };
    box.hidden = false;
    box.innerHTML = `<div class="av-crop-w"><canvas id="av-crop" width="${VIEW}" height="${VIEW}" aria-label="Drag to move the picture"></canvas><span class="av-frame" aria-hidden="true"></span></div>` +
      `<div class="av-side"><span class="lbl2">Preview</span><span class="av-prevs"><img id="av-prev" class="kp kp-tag av" width="96" height="96" alt="Preview at 96 × 96"><img id="av-prev-s" class="kp kp-tag av" width="36" height="36" alt=""></span>` +
      `<label class="lbl2" for="av-zoom">Zoom</label><input type="range" id="av-zoom" min="1" max="4" step="0.01" value="1">` +
      `<span class="hint2 n" id="av-size"></span>` +
      `<span class="frow"><button class="btn pri sm" type="button" data-av-save>Save picture</button><button class="btn sm" type="button" data-av-cancel>Cancel</button></span></div>`;
    render();
  }
  function close() { st = null; result = null; box.hidden = true; box.innerHTML = ''; input.value = ''; }

  const onFile = () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { ctx.toast('That file is too large to use as a picture.', true); input.value = ''; return; }
    // A data: URL keeps the canvas untainted and needs no blob: in the page's image policy.
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => open(img);
      img.onerror = () => { ctx.toast('That file is not an image this browser can read.', true); input.value = ''; };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };
  /** @param {PointerEvent} e */
  const onDown = (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (!st || t.id !== 'av-crop') return;
    t.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, px: e.clientX, py: e.clientY, x: st.x, y: st.y, k: VIEW / t.getBoundingClientRect().width };
  };
  /** @param {PointerEvent} e */
  const onMove = (e) => {
    if (!st || !drag || e.pointerId !== drag.id) return;
    const { scale } = geometry(VIEW);
    st.x = drag.x - (e.clientX - drag.px) * drag.k / scale;
    st.y = drag.y - (e.clientY - drag.py) * drag.k / scale;
    render();
  };
  const onUp = () => { drag = null; };
  /** @param {Event} e */
  const onInput = (e) => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.id === 'av-zoom' && st) { st.zoom = +t.value; render(); }
  };
  /** @param {MouseEvent} e */
  const onClick = async (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.closest('[data-av-cancel]')) { close(); return; }
    if (t.closest('[data-av-save]') && result) {
      const btn = /** @type {HTMLButtonElement} */ (t.closest('[data-av-save]'));
      btn.disabled = true;
      try {
        const me = await ctx.api.setAvatar(result.url);
        if (me.avatar) rememberAvatar(me.avatar, result.url);
        ctx.me = { ...ctx.me, ...me };
        ctx.invalidate('settings', 'feed:', 'directory', 'profile:');
        ctx.toast('Picture saved. It goes out with your signed card.');
        ctx.renderMe?.();
        ctx.reload();
      } catch (x) { ctx.toast(/** @type {Error} */ (x).message, true); btn.disabled = false; }
      return;
    }
    if (t.closest('[data-av-remove]')) {
      try {
        const me = await ctx.api.removeAvatar();
        ctx.me = { ...ctx.me, ...me };
        ctx.invalidate('settings', 'feed:', 'directory', 'profile:');
        ctx.toast('Picture removed. Your key-print is shown again.');
        ctx.renderMe?.();
        ctx.reload();
      } catch (x) { ctx.toast(/** @type {Error} */ (x).message, true); }
    }
  };
  const row = /** @type {HTMLElement} */ (root.querySelector('.av-row'));
  input.addEventListener('change', onFile);
  row.addEventListener('pointerdown', onDown);
  row.addEventListener('pointermove', onMove);
  row.addEventListener('pointerup', onUp);
  row.addEventListener('pointercancel', onUp);
  row.addEventListener('input', onInput);
  row.addEventListener('click', onClick);
  return () => {
    input.removeEventListener('change', onFile);
    for (const [type, fn] of [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onUp], ['input', onInput], ['click', onClick]]) {
      row.removeEventListener(type, /** @type {any} */ (fn));
    }
  };
}
