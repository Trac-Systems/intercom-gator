import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBundle } from './schema.js';

/** The release extension: data this release reads that older releases' schemas reject. It lives beside the six
 * signed data files, is never part of the bundle digest or `obs.b`, and only changes how this node reads venues and
 * groups coins. Signed data (release + root patches) always wins over it. */
export const EXTENSIONS_FILE = 'release-extensions.json';
const defaultDir = fileURLToPath(new URL('../data/', import.meta.url));

const plain = v => v !== null && typeof v === 'object' && [null, Object.prototype].includes(Object.getPrototypeOf(v));
const venueId = /^[a-z][a-z0-9-]*$/;
// Venue labels use the engine's market-label form (upper case, as market IDs normalise them).
const venueLabel = /^[A-Z0-9][A-Z0-9._]{0,31}$/;
const assetId = /^[a-z][a-z0-9-]*:[^\s]{1,200}$/;
const groupId = /^[a-z][a-z0-9-]*$/;
const roles = ['issuance', 'escrow-backed'];

function check(ok, path, message) {
  if (!ok) throw new TypeError('release extensions ' + path + ': ' + message);
}

function https(value) {
  try {
    const u = new URL(value);
    return typeof value === 'string' && u.protocol === 'https:' && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Shape check of a parsed extension document. Returns it or throws a TypeError naming the bad path.
 * `{ v: 1, note?, symbolMap?: {venue: {LABEL: assetId}}, coinGroups?: [{id, source, members: {assetId: role}}] }` */
export function validateReleaseExtensions(ext) {
  check(plain(ext), '', 'expected an object');
  for (const key of Object.keys(ext)) check(['v', 'note', 'symbolMap', 'coinGroups'].includes(key), key, 'unknown field');
  check(ext.v === 1, 'v', 'expected version 1');
  if (Object.hasOwn(ext, 'note')) check(typeof ext.note === 'string', 'note', 'expected text');
  if (Object.hasOwn(ext, 'symbolMap')) {
    check(plain(ext.symbolMap), 'symbolMap', 'expected a venue map');
    for (const [venue, labels] of Object.entries(ext.symbolMap)) {
      const p = 'symbolMap.' + venue;
      check(venueId.test(venue), p, 'invalid venue ID');
      check(plain(labels) && Object.keys(labels).length > 0, p, 'expected a nonempty label-to-asset map');
      for (const [label, asset] of Object.entries(labels)) {
        check(venueLabel.test(label), p + '.' + label, 'invalid venue label');
        check(typeof asset === 'string' && assetId.test(asset), p + '.' + label, 'invalid asset ID');
      }
    }
  }
  if (Object.hasOwn(ext, 'coinGroups')) {
    check(Array.isArray(ext.coinGroups), 'coinGroups', 'expected a list');
    const ids = new Set();
    ext.coinGroups.forEach((g, i) => {
      const p = 'coinGroups[' + i + ']';
      check(plain(g) && Object.keys(g).length === 3 && ['id', 'source', 'members'].every(k => Object.hasOwn(g, k)), p,
        'expected id, source and members');
      check(typeof g.id === 'string' && groupId.test(g.id) && !ids.has(g.id), p + '.id', 'invalid or repeated group ID');
      ids.add(g.id);
      check(https(g.source), p + '.source', 'expected https URL');
      check(plain(g.members) && Object.keys(g.members).length >= 2, p + '.members', 'expected two or more members');
      for (const [asset, role] of Object.entries(g.members)) {
        check(assetId.test(asset), p + '.members.' + asset, 'invalid asset ID');
        check(roles.includes(role), p + '.members.' + asset, 'expected issuance or escrow-backed');
      }
      check(Object.values(g.members).includes('issuance'), p + '.members', 'needs an issuance member');
    });
  }
  return ext;
}

/** Read and check the release extension file in `dir`; null when the release ships none. */
export function loadReleaseExtensions({ dir = defaultDir } = {}) {
  let text;
  try {
    text = readFileSync(join(dir, EXTENSIONS_FILE), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return validateReleaseExtensions(JSON.parse(text));
}

function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Overlay a checked extension on an effective (release + patch chain) bundle. The input is never modified and its
 * digest is never affected; the result is for this node's own reading only and is never digested or signed.
 * Entries naming an asset or venue the bundle does not (yet) have are skipped quietly, as is a coin group that the
 * signed data already defines (or whose member already belongs to a signed group). Coin groups pass the bundle's
 * own coin rules; venue labels map to existing assets.
 * @returns {{bundle: object, applied: string[], skipped: string[]}} */
export function applyReleaseExtensions(bundle, ext) {
  const applied = [], skipped = [];
  if (!ext) return { bundle, applied, skipped };
  validateReleaseExtensions(ext);
  const next = structuredClone(bundle);
  const tokens = new Map(next.tokens.tokens.map(t => [t.id, t]));
  for (const group of ext.coinGroups ?? []) {
    const name = 'coinGroup:' + group.id;
    const members = Object.entries(group.members);
    const missing = members.find(([asset]) => !tokens.has(asset));
    if (missing) { skipped.push(name + ' (unknown ' + missing[0] + ')'); continue; }
    if ((next.tokens.coinGroups ?? []).some(g => g.id === group.id) ||
        members.some(([asset]) => Object.hasOwn(tokens.get(asset), 'coin'))) {
      skipped.push(name + ' (signed)');
      continue;
    }
    const groupsBefore = next.tokens.coinGroups;
    next.tokens.coinGroups = [...(groupsBefore ?? []), { id: group.id, source: group.source }];
    for (const [asset, role] of members) Object.assign(tokens.get(asset), { coin: group.id, coinSupply: role });
    try {
      validateBundle(next);
      applied.push(name);
    } catch (error) {
      for (const [asset] of members) {
        delete tokens.get(asset).coin;
        delete tokens.get(asset).coinSupply;
      }
      if (groupsBefore === undefined) delete next.tokens.coinGroups;
      else next.tokens.coinGroups = groupsBefore;
      skipped.push(name + ' (' + error.message + ')');
    }
  }
  // After the coin rules: the signed schema has no venue map, so validateBundle would reject this field.
  for (const [venue, labels] of Object.entries(ext.symbolMap ?? {})) {
    const exchange = next.exchanges.find(e => e.id === venue);
    const known = {};
    for (const [label, asset] of Object.entries(labels)) {
      const name = 'symbolMap:' + venue + ':' + label;
      if (!exchange) skipped.push(name + ' (unknown venue)');
      else if (!tokens.has(asset)) skipped.push(name + ' (unknown ' + asset + ')');
      else {
        known[label] = asset;
        applied.push(name);
      }
    }
    if (Object.keys(known).length) exchange.symbolMap = { ...known, ...(exchange.symbolMap ?? {}) };
  }
  if (!applied.length) return { bundle, applied, skipped };
  return { bundle: freeze(next), applied, skipped };
}
