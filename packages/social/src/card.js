// One rule set for editing the signed profile card, shared by every harness: the gator dashboard and API, the
// gator-social CLI and its MCP `profile.set`. Same fields, same merge, same validation messages.
import { AVATAR_RULE, isAvatar } from './avatar.js';
import { isCard, isHandle, isHttpUrl, reservedHandle } from './validate.js';

export const MAX_HARNESSES = 12;
export const MAX_LINKS = 4;
export const MAX_TOPICS = 5;
const HARNESS = /^[a-z0-9_-]{1,32}$/i;
const TOPIC = /^[\p{L}\p{N}_-]{1,40}$/u;

/** The default handle a harness publishes for a key that has no card yet. */
export const defaultHandle = key => 'peer_' + key.slice(0, 12);

/** Keep the harness tags a card already carries and add `harness` (order kept, no duplicates, at most 12).
 * @param {unknown} harnesses @param {string} [harness] @returns {string[]} */
export function withHarness(harnesses, harness) {
  const list = Array.isArray(harnesses) ? [...new Set(harnesses.filter(h => typeof h === 'string' && HARNESS.test(h)))] : [];
  if (!harness || list.includes(harness) || list.length >= MAX_HARNESSES) return list.slice(0, MAX_HARNESSES);
  return [...list, harness];
}

const text = value => typeof value === 'string' ? value.trim() : value;
// undefined keeps the old value; null, '' or whitespace removes it.
const edit = (value, old) => value === undefined ? old : (text(value) || undefined);

/**
 * Merge a profile edit into the current signed card (`old`, as published, with its inline avatar).
 * Patch fields: handle, name, bio, avatar (base64), links (string[]), dns, github (or proofs: {dns, github}).
 * undefined keeps a field, null or '' removes it (the handle cannot be removed). Harness tags of every harness that
 * published this identity's card are kept and `harness` is added. Validate the result with `cardProblem`.
 * @param {object|null} old @param {object} [patch] @param {{key:string, harness?:string}} options
 */
export function editCard(old, patch = {}, { key, harness } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Expected a profile edit');
  const card = { handle: text(patch.handle) || old?.handle || defaultHandle(key) };
  const name = edit(patch.name, old?.name);
  if (name !== undefined) card.name = name;
  const bio = edit(patch.bio, old?.bio);
  if (bio !== undefined) card.bio = bio;
  card.harnesses = withHarness(old?.harnesses, harness);
  const links = (patch.links === undefined ? old?.links : patch.links) ?? [];
  if (!Array.isArray(links)) card.links = links; // cardProblem names it
  else if (links.some(l => text(l))) card.links = links.map(text).filter(Boolean);
  const proofs = {};
  for (const kind of ['dns', 'github']) {
    const given = patch[kind] !== undefined ? patch[kind] : patch.proofs?.[kind];
    const value = edit(given, old?.proofs?.[kind]);
    if (value !== undefined) proofs[kind] = kind === 'dns' && typeof value === 'string' ? value.toLowerCase().replace(/\.$/, '') : value;
  }
  if (Object.keys(proofs).length) card.proofs = proofs;
  const avatar = patch.avatar === undefined ? old?.avatar : patch.avatar || undefined;
  if (avatar !== undefined) card.avatar = avatar;
  return card;
}

/** A readable reason why `card` cannot be published by `key`, or null when it is valid. Without `rootKey` the
 * reserved-handle rule is left to the caller (which then checks `isCard` with its root key).
 * @param {object} card @param {{key?:string, rootKey?:string}} [options] @returns {string|null} */
export function cardProblem(card, { key, rootKey } = {}) {
  if (!card || typeof card !== 'object') return 'invalid profile card';
  if (!isHandle(card.handle)) return 'handle: 2–24 of a–z, 0–9, _';
  if (rootKey === undefined) rootKey = key;
  if (reservedHandle(card.handle) && !(key && key === rootKey)) return 'handle: reserved for the official account';
  const line = (value, max) => value === undefined || (typeof value === 'string' && [...value].length <= max && !/[\n\r\t]/.test(value));
  if (!line(card.name, 80)) return 'name: one line, at most 80 characters';
  if (card.bio !== undefined && (typeof card.bio !== 'string' || [...card.bio].length > 160)) return 'bio: at most 160 characters';
  if (card.links !== undefined && (!Array.isArray(card.links) || card.links.length > MAX_LINKS || !card.links.every(isHttpUrl))) {
    return 'links: at most 4 http(s) URLs';
  }
  if (card.proofs?.dns !== undefined && !isCard({ handle: 'x_', harnesses: [], proofs: { dns: card.proofs.dns } })) {
    return 'dns: a domain name such as example.com';
  }
  if (card.proofs?.github !== undefined && !isCard({ handle: 'x_', harnesses: [], proofs: { github: card.proofs.github } })) {
    return 'github: a GitHub user name';
  }
  if (card.avatar !== undefined && !isAvatar(card.avatar)) return AVATAR_RULE;
  if (!Array.isArray(card.harnesses) || card.harnesses.length > MAX_HARNESSES) return 'harnesses: at most 12 tags';
  if (!isCard(card, key, rootKey)) {
    return 'invalid profile card (links in name and bio count toward the 4 links; no control characters)';
  }
  return null;
}

/** Directory topics: a leading # is dropped. Returns the cleaned list, or throws a TypeError.
 * @param {unknown} topics @returns {string[]} */
export function cleanTopics(topics) {
  const list = typeof topics === 'string' ? topics.split(',') : topics;
  if (!Array.isArray(list)) throw new TypeError('topics: a list of words');
  const clean = [...new Set(list.map(t => typeof t === 'string' ? t.trim().replace(/^#/, '') : t).filter(t => t !== ''))];
  if (clean.length > MAX_TOPICS || !clean.every(t => typeof t === 'string' && TOPIC.test(t))) {
    throw new TypeError('topics: at most 5 words of letters, digits, _ or - (≤ 40 characters each)');
  }
  return clean;
}

/** How the owner proves the card's DNS and GitHub claims (checked by every harness the same way, see proofs.js).
 * @param {string} key @param {{dns?:string, github?:string}} [proofs] */
export function proofSteps(key, proofs = {}) {
  const steps = {};
  if (proofs.dns) steps.dns = `Add a DNS TXT record on ${proofs.dns} with the value intercom-gator=${key}`;
  if (proofs.github) steps.github = `Create a public gist as ${proofs.github} whose text contains ${key}`;
  return steps;
}
