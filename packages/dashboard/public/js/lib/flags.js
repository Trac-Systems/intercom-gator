// Risk flags: one shape for every source. Pure: runs in Node for tests.
//
// The API sends `flags` as strings: raised flags by key ("ownerMint"), unknown ones as
// "<key> unknown", and "risk unchecked" when no check ran. New-token rows also carry the raw
// `riskFlags` object ({ key: true | false | 'unknown' }). Sample data uses short sentences
// ("owner can mint"). All of them become { raised, unknown, clear, checked }.

const LABELS = {
  ownerMint: 'Owner can mint',
  ownerPause: 'Owner can pause',
  blacklist: 'Owner can blacklist',
  upgradeable: 'Upgradeable contract',
  lpUnlocked: 'Liquidity not locked',
  veryNew: 'Very new',
  lowLiquidity: 'Low liquidity',
  honeypot: 'Cannot be sold',
  unsellable: 'Cannot be sold',
};
// Flags that can take your money directly. Everything else raised is a caution.
const SEVERE = /^(ownerMint|ownerPause|blacklist|honeypot|unsellable)$|cannot be sold|owner can|can be swapped|blacklist/i;

/** "lpUnlocked" → "Lp unlocked"; known keys get a written label. @param {string} key */
export function flagLabel(key) {
  const k = String(key || '').trim();
  if (Object.hasOwn(LABELS, k)) return LABELS[k];
  const words = k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}

/** 'r' (severe) or 'y' (caution) for a raised flag. @param {string} key */
export function flagSeverity(key) { return SEVERE.test(String(key)) ? 'r' : 'y'; }

/**
 * @typedef {{ key: string, label: string, sev?: 'r'|'y' }} Flag
 * @typedef {{ raised: Flag[], unknown: Flag[], clear: Flag[], checked: boolean, worst: 'r'|'y'|null }} FlagSet
 */

/**
 * @param {string[]|null|undefined} flags API / sample strings
 * @param {Record<string, boolean|string>|null} [raw] riskFlags or { flag: on } from risk.checks
 * @returns {FlagSet}
 */
export function flagSet(flags, raw) {
  /** @type {Map<string, Flag>} */ const raised = new Map();
  /** @type {Map<string, Flag>} */ const unknown = new Map();
  /** @type {Map<string, Flag>} */ const clear = new Map();
  let unchecked = false;
  for (const s of Array.isArray(flags) ? flags : []) {
    const f = String(s || '').trim();
    if (!f) continue;
    if (/^risk unchecked$/i.test(f)) { unchecked = true; continue; }
    const m = /^(.*\S)\s+unknown$/i.exec(f);
    if (m) unknown.set(m[1], { key: m[1], label: flagLabel(m[1]) });
    else raised.set(f, { key: f, label: flagLabel(f), sev: flagSeverity(f) });
  }
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (v === true) { if (!raised.has(k)) raised.set(k, { key: k, label: flagLabel(k), sev: flagSeverity(k) }); unknown.delete(k); }
      else if (v === false) { if (!raised.has(k)) clear.set(k, { key: k, label: flagLabel(k) }); unknown.delete(k); }
      else if (!raised.has(k)) unknown.set(k, { key: k, label: flagLabel(k) });
    }
  }
  const r = [...raised.values()].sort((a, b) => (a.sev === b.sev ? 0 : a.sev === 'r' ? -1 : 1));
  const checked = !unchecked && (Array.isArray(flags) || !!raw);
  return { raised: r, unknown: [...unknown.values()], clear: [...clear.values()], checked, worst: r.length ? r[0].sev || 'y' : null };
}

/**
 * What the compact chip says.
 * @param {FlagSet} fs
 * @returns {{ cls: 'r'|'y'|'u'|'g', text: string, aria: string }}
 */
export function chipInfo(fs) {
  const list = (a) => a.map((f) => f.label).join(', ');
  const unk = fs.unknown.length ? `; ${fs.unknown.length} not known: ${list(fs.unknown)}` : '';
  if (fs.raised.length) {
    const n = fs.raised.length;
    return { cls: fs.worst || 'y', text: n + (n === 1 ? ' flag' : ' flags'), aria: `Risk: ${n} ${n === 1 ? 'flag' : 'flags'}: ${list(fs.raised)}${unk}` };
  }
  if (!fs.checked) return { cls: 'u', text: 'Unchecked', aria: 'Risk: not checked yet' };
  if (fs.unknown.length) return { cls: 'u', text: fs.unknown.length + ' unknown', aria: `Risk: no flags found${unk}` };
  return { cls: 'g', text: 'No flags', aria: 'Risk: no flags found' };
}

/** "No flags only" filter: checked, nothing raised, nothing unknown. @param {FlagSet} fs */
export function isClean(fs) { return fs.checked && !fs.raised.length && !fs.unknown.length; }
