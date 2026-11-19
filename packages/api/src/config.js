import { randomUUID } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { join } from 'node:path';
import { cardProblem, editCard } from '@gator/social';
import { detectProfile, PROFILE_LIMITS } from '@gator/store';
import { validHandle, validUrl } from '../../dashboard/public/js/lib/text.js';
import { check, readJson, writePrivate } from './local.js';

const order = Object.keys(PROFILE_LIMITS);
export const profiles = Object.fromEntries(order.map(p => [p, {
  budgetPerMin: PROFILE_LIMITS[p].requestsPerMinute, storageCapMB: PROFILE_LIMITS[p].storeBudgetMB,
  follows: p === 'small' ? 100 : 200,
}]));
export const saveConfig = (dir, config) => writePrivate(join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n');

function endpoint(e) {
  check(e && typeof e.url === 'string' && e.url.length <= 2048 && validUrl(e.url), 'bad url');
  const { kind = 'rpc', chain = 'Ethereum' } = e;
  check(['rpc', 'api', 'cex'].includes(kind) && typeof chain === 'string' && chain.length <= 100, 'bad endpoint');
  if (e.source !== undefined) check(typeof e.source === 'string' && /^[a-z0-9-]{1,80}$/.test(e.source), 'bad source');
  return { ...(e.source && { source: e.source }), id: String(e.id || randomUUID()).slice(0, 80), kind, chain, url: e.url, label: String(e.label || '').slice(0, 40) };
}

/** Validate the entire patch on a copy before persisting or applying it. */
export function patchConfig(current, patch, detected) {
  check(patch && typeof patch === 'object' && !Array.isArray(patch), 'bad settings');
  const next = structuredClone(current);
  if (patch.profile !== undefined) {
    check(order.includes(patch.profile) && order.indexOf(patch.profile) <= order.indexOf(detected), 'profile can only be lowered');
    next.profile = patch.profile;
    for (const k of ['budgetPerMin', 'storageCapMB']) next[k] = Math.min(next[k], profiles[next.profile][k]);
  }
  for (const [k, min, error] of [['budgetPerMin', 10, 'budget out of range'], ['storageCapMB', 100, 'storage out of range']]) {
    if (patch[k] == null) continue;
    const value = Math.round(Number(patch[k]));
    check(value >= min && value <= profiles[next.profile][k], error);
    next[k] = value;
  }
  if (patch.theme !== undefined) {
    check(['system', 'light', 'dark'].includes(patch.theme), 'bad theme');
    next.theme = patch.theme;
  }
  for (const k of Object.keys(next.agent)) {
    if (typeof patch.agent?.[k] === 'boolean') next.agent[k] = patch.agent[k];
  }
  if (typeof patch.agentPosting === 'boolean') next.agent.agentPosting = patch.agentPosting;
  if (typeof patch.officialMutes === 'boolean') next.officialMutes = patch.officialMutes;
  // Signed bundle updates from GitHub between releases (on unless the owner turns it off; absent = default).
  if (typeof patch.patchFeed === 'boolean') next.patchFeed = patch.patchFeed;
  if (patch.endpoints !== undefined) {
    check(Array.isArray(patch.endpoints) && patch.endpoints.length <= 128, 'too many endpoints');
    next.endpoints = patch.endpoints.map(endpoint);
  }
  if (patch.endpoint) {
    const e = patch.endpoint;
    if (e.remove) next.endpoints = next.endpoints.filter(x => x.id !== e.id);
    else {
      check(next.endpoints.length < 128, 'too many endpoints');
      next.endpoints.unshift(endpoint({ ...e, id: randomUUID() }));
    }
  }
  if (patch.moveEndpoint) {
    const { id, by } = patch.moveEndpoint;
    const i = next.endpoints.findIndex(e => e.id === id), j = i + (by < 0 ? -1 : 1);
    if (i >= 0 && j >= 0 && j < next.endpoints.length) [next.endpoints[i], next.endpoints[j]] = [next.endpoints[j], next.endpoints[i]];
  }
  return next;
}

export function loadConfig(dir, overrides = {}) {
  const disk = statfsSync(dir);
  const detected = detectProfile({ totalMemBytes: totalmem(), cpus: availableParallelism(), freeDiskBytes: disk.bsize * disk.bavail }).profile;
  const { budgetPerMin, storageCapMB } = profiles[detected];
  const defaults = { profile: detected, budgetPerMin, storageCapMB, officialMutes: true, theme: 'system', endpoints: [],
    agent: { agentPosting: false, agentReplies: false, agentFollow: false } };
  const stored = readJson(join(dir, 'config.json'), {});
  // A moved data directory or smaller disk can lower the available profile after a restart.
  if (order.indexOf(stored.profile) > order.indexOf(detected)) {
    stored.profile = detected;
    if (stored.budgetPerMin != null) stored.budgetPerMin = Math.min(stored.budgetPerMin, budgetPerMin);
    if (stored.storageCapMB != null) stored.storageCapMB = Math.min(stored.storageCapMB, storageCapMB);
  }
  // A release can lower a profile's ceiling (storage 4 GiB -> 1 GiB on large, 11-19): a saved value above the new
  // ceiling is clamped instead of refusing to start. Newly requested settings stay strictly validated.
  const ceiling = profiles[order.includes(stored.profile) ? stored.profile : detected];
  for (const k of ['budgetPerMin', 'storageCapMB']) if (stored[k] != null) stored[k] = Math.min(stored[k], ceiling[k]);
  return { detected, config: patchConfig(patchConfig(defaults, stored, detected), overrides, detected) };
}

/** `bundle` is the effective bundle (release plus root patches) once the engine runs. */
export function rpcEndpoints(release, config, bundle = release.bundle) {
  const users = Object.create(null);
  for (const e of config.endpoints.filter(e => e.kind === 'rpc')) {
    const name = e.chain.toLowerCase();
    const chain = bundle.chains.find(c => [c.id, c.name.toLowerCase(), String(c.chainId)].includes(name)
      || (name === 'bnb chain' && c.id === 'bsc'));
    (users[chain?.id ?? name] ??= []).push(e.url);
  }
  return Object.fromEntries(Object.keys(users).map(id => [id, release.selectEndpoints(bundle, id, { endpoints: users })
    .filter(url => users[id].includes(url))]));
}

/** The dashboard's card edit, with the rules every harness shares (@gator/social editCard/cardProblem): omitted fields
 * keep, '' or null removes; `links` (≤ 4 http(s) URLs), `dns` and `github` are editable; harness tags that other
 * harnesses of this identity added are kept and `gator` is added. The caller checks `isCard` with the root key.
 * @param {object|null} old the stored signed card (with its inline avatar) @param {object} patch @param {string} key */
export function editedCard(old, patch, key) {
  check(patch && typeof patch === 'object' && !Array.isArray(patch), 'bad card');
  const card = editCard(old, patch, { key, harness: 'gator' });
  check(validHandle(card.handle), 'handle: 2–24 of a–z, 0–9, _');
  // avatar: checked by the caller (isCard, room in the signed card) so the size message can name the bytes.
  const problem = cardProblem({ ...card, avatar: undefined }, { key });
  check(!problem, problem);
  return card;
}
