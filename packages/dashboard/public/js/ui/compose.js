// Compose box with the 500-character counter (ring + number), used for posts and replies.

import { esc } from '../lib/format.js';
import { kp, keySeed } from '../lib/keyprint.js';
import { face } from '../lib/face.js';
import { counter, POST_MAX } from '../lib/text.js';

const R = 9, C = 2 * Math.PI * R;

/** @param {any} ctx @param {{ id: string, placeholder: string, button: string, label: string }} o */
export function composeHTML(ctx, o) {
  const me = ctx.me;
  return `<form class="compose" id="${o.id}" novalidate>${me ? face(me, 40) : '<span></span>'}<div>` +
    `<label class="vh" for="${o.id}-ta">${esc(o.label)}</label><textarea class="ta" id="${o.id}-ta" rows="2" maxlength="2000" placeholder="${esc(o.placeholder)}"></textarea>` +
    `<div class="bar"><span class="as">${me ? 'As ' + esc(me.handle) : ''}</span>` +
    `<svg class="ring" viewBox="0 0 22 22" aria-hidden="true"><circle class="bg" cx="11" cy="11" r="${R}"/><circle class="fg" cx="11" cy="11" r="${R}" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${C.toFixed(2)}"/></svg>` +
    `<span class="cnt-l n" aria-live="polite" aria-label="Characters left">${POST_MAX}</span>` +
    `<button class="btn pri" type="submit" disabled>${esc(o.button)}</button></div></div></form>`;
}

/**
 * Wire a compose form. onSend gets the text; resolve to clear, throw to keep it.
 * @param {HTMLFormElement|null} form @param {(text: string) => Promise<void>} onSend
 */
export function wireCompose(form, onSend) {
  if (!form) return () => {};
  const ta = /** @type {HTMLTextAreaElement} */ (form.querySelector('textarea'));
  const ring = /** @type {SVGCircleElement} */ (form.querySelector('.ring'));
  const fg = /** @type {SVGCircleElement} */ (form.querySelector('.ring .fg'));
  const cnt = /** @type {HTMLElement} */ (form.querySelector('.cnt-l'));
  const btn = /** @type {HTMLButtonElement} */ (form.querySelector('button[type=submit]'));
  let busy = false;
  const update = () => {
    const c = counter(ta.value);
    fg.setAttribute('stroke-dashoffset', (C * (1 - c.ratio)).toFixed(2));
    ring.classList.toggle('near', c.near && !c.over);
    ring.classList.toggle('over', c.over);
    cnt.textContent = String(c.left);
    cnt.className = 'cnt-l n' + (c.over ? ' over' : c.near ? ' near' : '');
    btn.disabled = busy || c.over || !ta.value.trim();
    ta.style.height = 'auto';
    ta.style.height = Math.min(320, ta.scrollHeight + 2) + 'px';
  };
  const send = async (e) => {
    e?.preventDefault();
    if (btn.disabled) return;
    busy = true; update();
    try { await onSend(ta.value.trim()); ta.value = ''; } catch { /* keep text; caller shows the error */ }
    busy = false; update();
  };
  const key = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(e); };
  ta.addEventListener('input', update);
  ta.addEventListener('keydown', key);
  form.addEventListener('submit', send);
  update();
  return () => { ta.removeEventListener('input', update); ta.removeEventListener('keydown', key); form.removeEventListener('submit', send); };
}
