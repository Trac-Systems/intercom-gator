import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBundle } from './schema.js';

export { categoryLabels, validateBundle } from './schema.js';
const datasets = ['exchanges', 'chains', 'dex', 'tokens', 'apis'];
const currentDatasets = [...datasets, 'paidExtras'];
const defaultDir = fileURLToPath(new URL('../data/', import.meta.url));
const trustedRoots = new WeakMap();

function plainObject(value) {
  return value !== null && typeof value === 'object' &&
    [null, Object.prototype].includes(Object.getPrototypeOf(value));
}

/** Canonical UTF-8 JSON text. Object keys use UTF-16 code-unit order. */
export function canonical(value) {
  const ancestors = new Set();
  function encode(item) {
    if (item === null || typeof item === 'boolean' || typeof item === 'string' ||
        Number.isFinite(item)) return JSON.stringify(item);
    const array = Array.isArray(item);
    if (!array && !plainObject(item)) throw new TypeError('Expected a plain JSON value');
    if (ancestors.has(item)) throw new TypeError('Cycle in JSON value');
    ancestors.add(item);
    const keys = Object.keys(item);
    const own = Reflect.ownKeys(item);
    if (own.length !== keys.length + Number(array)) throw new TypeError('Unrepresentable JSON property');
    if (array && (keys.length !== item.length || keys.some((key, i) => key !== String(i)))) {
      throw new TypeError('Expected a dense JSON array');
    }
    if (!array) keys.sort();
    const entries = keys.map(key => {
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (!Object.hasOwn(property, 'value')) throw new TypeError('Expected a JSON data property');
      const encoded = encode(property.value);
      return array ? encoded : JSON.stringify(key) + ':' + encoded;
    });
    ancestors.delete(item);
    return array ? '[' + entries.join(',') + ']' : '{' + entries.join(',') + '}';
  }
  return encode(value);
}

function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

/** Load the source files from dir. Supply a separately trusted root to enable patches.
 * @param {{dir?: string, rootPubKeyHex?: string}} [options] */
export function loadBundle({ dir = defaultDir, rootPubKeyHex } = {}) {
  const bundle = Object.fromEntries(datasets.map(name => [
    name, JSON.parse(readFileSync(join(dir, name + '.json'), 'utf8')),
  ]));
  try {
    bundle.paidExtras = JSON.parse(readFileSync(join(dir, 'paidExtras.json'), 'utf8'));
  } catch (error) {
    // Archived five-file releases retain their original canonical digest.
    if (error.code !== 'ENOENT') throw error;
  }
  validateBundle(bundle);
  if (rootPubKeyHex !== undefined) {
    trustedRoots.set(bundle, hexBytes(rootPubKeyHex, 32, 'root public key').toString('hex'));
  }
  return freeze(bundle);
}

/** SHA-256 of the canonical ordered array of [filename, parsed data] pairs. */
export function bundleDigest(bundle = loadBundle()) {
  const names = plainObject(bundle) && Object.hasOwn(bundle, 'paidExtras') ? currentDatasets : datasets;
  if (!plainObject(bundle) || Object.keys(bundle).length !== names.length ||
      !names.every(name => Object.hasOwn(bundle, name))) throw new TypeError('Invalid bundle envelope');
  return digest(names.map(name => [name + '.json', bundle[name]]));
}

function hexBytes(hex, length, name) {
  if (typeof hex !== 'string' || hex.length !== length * 2 || /[^0-9a-f]/i.test(hex)) {
    throw new TypeError('Invalid ' + name);
  }
  return Buffer.from(hex, 'hex');
}

// RFC 8410 PKCS#8 and SubjectPublicKeyInfo prefixes for 32-byte Ed25519 keys.
const pkcs8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const spki = Buffer.from('302a300506032b6570032100', 'hex');

/** Sign the 32 digest bytes. Accepts a raw seed (Uint8Array) or its hex encoding. */
export function signBundle(digestHex, secretKey) {
  const seed = typeof secretKey === 'string' ? hexBytes(secretKey, 32, 'private seed') : secretKey;
  if (!(seed instanceof Uint8Array) || seed.byteLength !== 32) throw new TypeError('Expected 32 seed bytes');
  const key = createPrivateKey({ key: Buffer.concat([pkcs8, seed]), format: 'der', type: 'pkcs8' });
  return sign(null, hexBytes(digestHex, 32, 'digest'), key).toString('hex');
}

/** Verify a hex-encoded Ed25519 signature over a SHA-256 digest. */
export function verifyBundleSignature(digestHex, signature, rootPubKeyHex) {
  try {
    const key = createPublicKey({
      key: Buffer.concat([spki, hexBytes(rootPubKeyHex, 32, 'root public key')]),
      format: 'der', type: 'spki',
    });
    return verify(null, hexBytes(digestHex, 32, 'digest'), key, hexBytes(signature, 64, 'signature'));
  } catch {
    return false;
  }
}

/** The patch signing message binds the old state, operations and new state. */
export function patchDigest({ baseDigest, ops, newDigest }) {
  return digest(['intercom-gator/source-bundle/patch/v1', baseDigest, ops, newDigest]);
}

function pointer(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || /~(?![01])/.test(path)) {
    throw new TypeError('Expected an absolute JSON Pointer');
  }
  const parts = path.slice(1).split('/').map(s => s.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (!currentDatasets.includes(parts[0]) || parts.some(k => ['__proto__', 'prototype', 'constructor'].includes(k))) {
    throw new TypeError('Invalid patch path');
  }
  return parts;
}

function arrayIndex(key, length, append) {
  if (append && key === '-') return length;
  if (!/^(0|[1-9][0-9]*)$/.test(key)) throw new TypeError('Invalid array index');
  const index = Number(key);
  if (index >= length + Number(append)) throw new RangeError('Array index out of range');
  return index;
}

function applyOperation(document, operation) {
  if (!plainObject(operation)) throw new TypeError('Expected a patch operation');
  const { op, path, value } = operation;
  const keys = op === 'remove' ? ['op', 'path'] : ['op', 'path', 'value'];
  if (!['add', 'replace', 'remove'].includes(op) || Object.keys(operation).length !== keys.length ||
      !keys.every(key => Object.hasOwn(operation, key))) throw new TypeError('Invalid patch operation');
  const parts = pointer(path);
  const key = parts.pop();
  let parent = document;
  for (const part of parts) {
    if (Array.isArray(parent)) arrayIndex(part, parent.length, false);
    if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, part)) {
      throw new RangeError('Missing patch parent');
    }
    parent = parent[part];
  }
  if (Array.isArray(parent)) {
    const i = arrayIndex(key, parent.length, op === 'add');
    if (op === 'remove') parent.splice(i, 1);
    else parent.splice(i, Number(op === 'replace'), structuredClone(value));
  } else {
    if (!plainObject(parent) || (op !== 'add' && !Object.hasOwn(parent, key))) {
      throw new RangeError('Missing patch target');
    }
    if (op === 'remove') delete parent[key];
    else parent[key] = structuredClone(value);
  }
}

/** Signer side of applyPatch: apply ops to a copy with the same semantics, validate the result and sign
 * base + ops + new digest. The bundle argument is not modified. Returns the four-field patch. */
export function signPatch(bundle, ops, secretKey) {
  if (!Array.isArray(ops)) throw new TypeError('Expected patch operations');
  const copy = JSON.parse(canonical(ops));
  const baseDigest = bundleDigest(bundle);
  const next = structuredClone(bundle);
  for (const op of copy) applyOperation(next, op);
  validateBundle(next);
  const newDigest = bundleDigest(next);
  return { baseDigest, ops: copy, newDigest, signature: signBundle(patchDigest({ baseDigest, ops: copy, newDigest }), secretKey) };
}

/** Apply an authenticated patch atomically. Trust comes from loadBundle or the caller. */
export function applyPatch(bundle, input, rootPubKeyHex = trustedRoots.get(bundle)) {
  const pinned = trustedRoots.get(bundle);
  if (pinned && pinned !== rootPubKeyHex?.toLowerCase()) throw new Error('Trusted root mismatch');
  // Sign and apply the same snapshot, including for objects supplied directly by a caller.
  const patch = JSON.parse(canonical(input));
  if (!plainObject(patch) || Object.keys(patch).length !== 4 ||
      !['baseDigest', 'ops', 'newDigest', 'signature'].every(k => Object.hasOwn(patch, k)) ||
      !Array.isArray(patch.ops)) throw new TypeError('Invalid patch envelope');
  if (patch.baseDigest !== bundleDigest(bundle)) throw new Error('Patch base digest mismatch');
  if (!verifyBundleSignature(patchDigest(patch), patch.signature, rootPubKeyHex)) {
    throw new Error('Invalid patch signature or missing trusted root');
  }
  const next = structuredClone(bundle);
  for (const op of patch.ops) applyOperation(next, op);
  validateBundle(next);
  if (bundleDigest(next) !== patch.newDigest) throw new Error('Patch result digest mismatch');
  trustedRoots.set(next, rootPubKeyHex.toLowerCase());
  return freeze(next);
}

/** Select URL strings. Numeric IDs refer to EVM chains. Health is a URL-to-score map.
 * @param {object} bundle @param {number|string} chainId
 * @param {{endpoints?: Record<string,string[]>, health?: Record<string,number>}} [userConfig] */
export function selectEndpoints(bundle, chainId, { endpoints = {}, health = {} } = {}) {
  const key = String(chainId);
  const chain = bundle.chains.find(c => c.id === key || (c.family === 'evm' && String(c.chainId) === key));
  const aliases = [key];
  if (chain) aliases.push(chain.id);
  if (chain?.family === 'evm') aliases.push(String(chain.chainId));
  const configured = [];
  for (const alias of new Set(aliases)) {
    if (!Object.hasOwn(endpoints, alias)) continue;
    const urls = endpoints[alias];
    if (!Array.isArray(urls)) throw new TypeError('Configured endpoints must be a URL list');
    for (const url of urls) {
      if (typeof url !== 'string' || !['http:', 'https:', 'ws:', 'wss:'].includes(new URL(url).protocol)) {
        throw new TypeError('Invalid configured RPC URL');
      }
      configured.push(url);
    }
  }
  const score = url => Object.hasOwn(health, url) && Number.isFinite(health[url]) ? health[url] : 0;
  const publicUrls = chain?.endpoints.map(e => e.url).sort((a, b) => score(b) - score(a)) ?? [];
  return [...new Set([...configured, ...publicUrls])];
}
