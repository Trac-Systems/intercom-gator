// Key-prints: the deterministic marks drawn for every key, token, chain and exchange.
// Same seed, same mark, on every machine. Pure: no DOM.

/** 32-bit FNV-1a with a murmur finaliser. @param {string} s */
export function h32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

const COR = [[0, 0], [10, 0], [10, 10], [0, 10]];
const SD = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const ED = [[0, 1], [-1, 0], [0, -1], [1, 0]];

function qd(x, y, c) {
  const A = [x + COR[c][0], y + COR[c][1]];
  return 'M' + A[0] + ' ' + A[1] + 'L' + (A[0] + SD[c][0] * 10) + ' ' + (A[1] + SD[c][1] * 10) + 'A10 10 0 0 1 ' + (A[0] + ED[c][0] * 10) + ' ' + (A[1] + ED[c][1] * 10) + 'Z';
}
function lens(x, y, slash) {
  return slash ? 'M' + (x + 10) + ' ' + y + 'A10 10 0 0 1 ' + x + ' ' + (y + 10) + 'A10 10 0 0 1 ' + (x + 10) + ' ' + y + 'Z'
    : 'M' + x + ' ' + y + 'A10 10 0 0 1 ' + (x + 10) + ' ' + (y + 10) + 'A10 10 0 0 1 ' + x + ' ' + y + 'Z';
}
const PAIRS = [[0, 0], [0, 1], [0, 2], [1, 0]];

/** @param {Array<[number, number, number, string]>} cells @param {number} centre */
export function build(cells, centre) {
  let pa = '', pb = '';
  for (const [r, k, cor, col] of cells) {
    const a = qd(k * 10, r * 10, cor), b = qd((2 - k) * 10, (2 - r) * 10, (cor + 2) % 4);
    if (col === 'a') pa += a + b; else pb += a + b;
  }
  if (centre === 0) pa += lens(10, 10, false);
  else if (centre === 1) pa += lens(10, 10, true);
  else if (centre === 2) pa += 'M15 10a5 5 0 1 0 0.001 0Z';
  return { a: pa, b: pb };
}

const CACHE = new Map();

/**
 * Geometry and hues for one seed.
 * @param {string} seed
 * @returns {{ a: string, b: string, ha: number, hb: number }}
 */
export function kpData(seed) {
  const hit = CACHE.get(seed);
  if (hit) return hit;
  const a = h32(seed), b = h32(seed + '/cells'), c = h32(seed + '/tone');
  const ha = 222 + a % 104, off = 38 + (a >>> 9) % 40;
  let hb = (a >>> 20) & 1 ? ha + off : ha - off;
  if (hb > 325 || hb < 222) hb = hb > 325 ? ha - off : ha + off;
  /** @type {Array<[number, number, number, string]>} */
  const cells = [];
  const cols = [];
  PAIRS.forEach((p, i) => {
    const v = (b >>> (i * 6)) & 63;
    const empty = (v & 7) === 0;
    if (empty && cells.length + (3 - i) >= 2) return;
    const col = (c >>> i) & 1 ? 'b' : 'a';
    cols.push(col);
    cells.push([p[0], p[1], (v >>> 3) & 3, col]);
  });
  if (cols.indexOf('a') < 0) cells[0][3] = 'a';
  if (cols.indexOf('b') < 0 && cells.length > 1) cells[cells.length - 1][3] = 'b';
  const centre = (c >>> 8) % 4;
  const d = { ...build(cells, centre), ha, hb };
  if (CACHE.size > 4000) CACHE.clear();
  CACHE.set(seed, d);
  return d;
}

/** Inline style with the two hues, for rows and chips that tint by key. @param {string} seed */
export function hue(seed) { const d = kpData(seed); return '--ha:' + d.ha + ';--hb:' + d.hb; }

/**
 * The key-print as an SVG string.
 * @param {string} seed
 * @param {'coin'|'tag'|'sq'} shape coin = tokens, tag = agents/channels, sq = plain
 * @param {number} size
 * @param {string} [cls]
 */
export function kp(seed, shape, size, cls) {
  const d = kpData(seed);
  return '<svg class="kp kp-' + shape + (cls ? ' ' + cls : '') + '" viewBox="0 0 30 30" width="' + size + '" height="' + size + '" style="--ha:' + d.ha + ';--hb:' + d.hb + '" aria-hidden="true"><rect class="g" width="30" height="30"/><path class="b" d="' + d.b + '"/><path class="a" d="' + d.a + '"/></svg>';
}

/**
 * The brand mark ("Bite"): a gator head in profile on the key-print tag, built from the same
 * quarter discs (eye ridge, nostril knob, snout, chin), the slit lens (eye) and 45° chamfers
 * (the tooth zig-zag). Upper jaw a, lower jaw b; the neck bleeds off the tile.
 * 32-unit grid so the horizontal edges land on whole pixels at 16 and 32 px.
 * Same drawing as docs/assets/logo/gator-bite.svg and public/favicon.svg.
 */
const BRAND = {
  a: 'M0 10H4A4 4 0 0 1 12 10H21A2 2 0 0 1 25 10A6 6 0 0 1 31 16H28L25 19L22 16L19 19L16 16L13 19L10 16H0ZM8 7.2A3 3 0 0 1 8 11.6A3 3 0 0 1 8 7.2Z',
  b: 'M0 19H10L13 22L16 19L19 22L22 19L25 22L28 19A6 6 0 0 1 22 25H0Z',
};
/** @param {number} size */
export function brandSVG(size) {
  return '<svg class="kp kp-tag kp-brand" viewBox="0 0 32 32" width="' + size + '" height="' + size + '" aria-hidden="true"><rect class="g" width="32" height="32"/><path class="b" d="' + BRAND.b + '"/><path class="a" fill-rule="evenodd" d="' + BRAND.a + '"/></svg>';
}

/** Seed for a token: asset id when known, else first chain + symbol (as in the design). @param {any} t */
export function tokSeed(t) {
  if (!t) return 'token:?';
  if (t.seed) return t.seed;
  return (t.chains ? t.chains[0] : t.chain) + ':' + t.symbol;
}
/** Seed for a key (profile / channel). @param {string} key */
export function keySeed(key) { return 'key:' + key; }

/**
 * A larger, more legible key-print for profiles: the 30-unit mark plus the key as
 * 16 groups of four hex characters, so two people can compare keys by eye.
 * Pure string; the visual is the same `kp` mark at a larger size.
 * @param {string} key 64-hex
 */
export function keyprintRows(key) {
  const k = String(key || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  const groups = k.match(/.{1,4}/g) || [];
  const rows = [];
  for (let i = 0; i < groups.length; i += 4) rows.push(groups.slice(i, i + 4));
  return rows;
}
