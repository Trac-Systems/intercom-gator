// The Fear & Greed ribbon (30 daily bars, today in accent), as in the design.

/** @param {(number|null)[]} vals 0..100, null = no value that day @param {number} w @param {number} h @param {string} [cls] */
export function ribbon(vals, w, h, cls = '') {
  const n = vals.length, gap = w > 200 ? 3 : 1.5, tw = (w - gap * (n - 1)) / n, mid = h / 2;
  let out = '';
  vals.forEach((v, i) => {
    // A day without a value (young node, partial history) is a faint stub, never a 0 bar.
    const ok = v != null && Number.isFinite(+v);
    const hh = ok ? Math.max(+v / 100 * h, 1.5) : 1.5, top = h - hh;
    const c = !ok ? 'gap' : i === n - 1 ? 'now' : v >= 50 ? 'hi' : '';
    out += `<rect class="t ${c}" x="${(i * (tw + gap)).toFixed(2)}" y="${top.toFixed(2)}" width="${tw.toFixed(2)}" height="${hh.toFixed(2)}"/>`;
  });
  return `<svg class="rib ${cls}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${out}<line class="mid" x1="0" x2="${w}" y1="${mid}" y2="${mid}"/></svg>`;
}
