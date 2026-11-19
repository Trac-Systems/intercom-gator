import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  applyPatch, applyReleaseExtensions, bundleDigest, loadBundle, loadReleaseExtensions, signPatch, validateBundle,
  validateReleaseExtensions, verifyBundleSignature,
} from '../src/index.js';
import { ROOT_KEY } from '../src/root-key.js';

// A release NEVER changes the signed base data: every release ships the six data files and bundle.sig of v0.1.0, so
// every version starts on one digest and the root-signed patch feed moves all of them to the same next digest.
const V010_RELEASE = '2e7fd025868071e3a31a8dc5f6b8041f7e9a359dbacffc00bb43db39e721a7bb';
// The shared TAP Protocol / Trac Network patch (ops only; the root signs it) and its result on the v0.1.0 base.
const TAP_TNK_DIGEST = 'e0269781cd50d2d8d03833eae9971bbca096ce7b37c3c9ede4177cfb63f4b9f7';
const ops = JSON.parse(readFileSync(new URL('./fixtures/tap-tnk-ops.json', import.meta.url), 'utf8'));
const tap = 'tap-protocol:native', tnk = 'trac:native';
const tapErc20 = 'ethereum:0x5e7f6e008c6d9d7ad4c7eb75bd4ce62864cc7454';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
const root = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
const patched = base => applyPatch(base, signPatch(base, ops, seed), root);

test('the shipped data is the v0.1.0 release: same digest, bundle.sig verifies against the compiled root key', () => {
  const digest = bundleDigest(loadBundle());
  assert.equal(digest, V010_RELEASE);
  const signature = readFileSync(new URL('../data/bundle.sig', import.meta.url), 'utf8').trim();
  assert.ok(verifyBundleSignature(digest, signature, ROOT_KEY));
});

test('the signed schema rejects venue maps, as v0.1.0 does, so no root patch can split versions on it', () => {
  const bundle = structuredClone(loadBundle());
  bundle.exchanges.find(e => e.id === 'gate').symbolMap = { TNK: 'bitcoin:native' };
  assert.throws(() => validateBundle(bundle), /unknown field symbolMap/);
});

test('the shared TAP/TNK patch: chains, natives, the ERC-20 as a plain token and the TAP reader APIs', () => {
  const base = loadBundle();
  assert.deepEqual(ops.map(o => [o.op, o.path, o.value.id]), [
    ['add', '/chains/-', 'tap-protocol'], ['add', '/chains/-', 'trac'],
    ['add', '/tokens/tokens/-', tap], ['add', '/tokens/tokens/-', tnk], ['add', '/tokens/tokens/-', tapErc20],
    ['add', '/apis/-', 'tap-reader-deployment'], ['add', '/apis/-', 'tap-reader-mint-left'],
  ]);
  // No coin group in signed data: v0.1.0 would fall back to the bridged ERC-20's cap for the whole coin.
  for (const o of ops) assert.equal(JSON.stringify(o.value).includes('"coin'), false, o.value.id);
  const next = patched(base);
  assert.equal(bundleDigest(next), TAP_TNK_DIGEST);
  assert.equal(next.tokens.coinGroups.some(g => g.id === 'tap-protocol-tap'), false);
  assert.equal(next.exchanges.some(e => Object.hasOwn(e, 'symbolMap')), false);
});

test('the release extension is outside the digest and only names TAP/TNK venue labels and the TAP coin group', () => {
  const ext = loadReleaseExtensions();
  assert.deepEqual(ext.symbolMap, {
    gate: { TAPPROTOCOL: tap, TNK: tnk },
    mexc: { TAP: tap, TNK: tnk },
  });
  assert.deepEqual(ext.coinGroups, [{ id: 'tap-protocol-tap', source: 'https://bridge.tapscope.io',
    members: { [tap]: 'issuance', [tapErc20]: 'escrow-backed' } }]);
  // loadBundle reads the six data files only; the extension never enters the digest.
  assert.equal(bundleDigest(loadBundle()), V010_RELEASE);
});

test('on the unpatched release every extension entry names an unknown asset and is skipped quietly', () => {
  const base = loadBundle();
  const { bundle, applied, skipped } = applyReleaseExtensions(base, loadReleaseExtensions());
  assert.equal(bundle, base);
  assert.deepEqual(applied, []);
  assert.equal(skipped.length, 5);
  assert.ok(skipped.every(s => /unknown (tap-protocol|trac):native/.test(s)), skipped.join('; '));
});

test('after the shared patch the extension maps the venue labels and groups TAP, without touching the input', () => {
  const next = patched(loadBundle());
  const { bundle, applied, skipped } = applyReleaseExtensions(next, loadReleaseExtensions());
  assert.deepEqual(skipped, []);
  assert.deepEqual(applied, ['coinGroup:tap-protocol-tap', 'symbolMap:gate:TAPPROTOCOL', 'symbolMap:gate:TNK',
    'symbolMap:mexc:TAP', 'symbolMap:mexc:TNK']);
  const token = id => bundle.tokens.tokens.find(t => t.id === id);
  assert.deepEqual([token(tap).coin, token(tap).coinSupply], ['tap-protocol-tap', 'issuance']);
  assert.deepEqual([token(tapErc20).coin, token(tapErc20).coinSupply], ['tap-protocol-tap', 'escrow-backed']);
  assert.equal(token(tnk).coin, undefined);
  assert.deepEqual(bundle.exchanges.find(e => e.id === 'gate').symbolMap, { TAPPROTOCOL: tap, TNK: tnk });
  assert.deepEqual(bundle.exchanges.find(e => e.id === 'mexc').symbolMap, { TAP: tap, TNK: tnk });
  // The signed input is unchanged: same digest, no venue map, no coin fields.
  assert.equal(bundleDigest(next), TAP_TNK_DIGEST);
  assert.equal(next.exchanges.some(e => Object.hasOwn(e, 'symbolMap')), false);
  assert.equal(Object.hasOwn(next.tokens.tokens.find(t => t.id === tap), 'coin'), false);
  assert.ok(Object.isFrozen(bundle));
});

test('partial knowledge: unknown venues, assets and groups are skipped, signed groups win, bad files are refused', () => {
  const next = patched(loadBundle());
  const ext = {
    v: 1,
    symbolMap: { gate: { TNK: tnk, NEWCOIN: 'newchain:native' }, 'no-such-venue': { TAP: tap } },
    coinGroups: [
      { id: 'later-coin', source: 'https://example.org', members: { 'newchain:native': 'issuance', [tapErc20]: 'escrow-backed' } },
      // A signed group already holds USDT0 members: the extension never regroups signed deployments.
      { id: 'tether-again', source: 'https://example.org', members: { [tap]: 'issuance',
        [next.tokens.tokens.find(t => t.coin === 'tether-usdt').id]: 'escrow-backed' } },
    ],
  };
  const { bundle, applied, skipped } = applyReleaseExtensions(next, ext);
  assert.deepEqual(applied, ['symbolMap:gate:TNK']);
  assert.deepEqual(skipped, ['coinGroup:later-coin (unknown newchain:native)', 'coinGroup:tether-again (signed)',
    'symbolMap:gate:NEWCOIN (unknown newchain:native)', 'symbolMap:no-such-venue:TAP (unknown venue)']);
  assert.deepEqual(bundle.exchanges.find(e => e.id === 'gate').symbolMap, { TNK: tnk });
  assert.equal(bundle.tokens.tokens.find(t => t.id === tap).coin, undefined);
  for (const bad of [
    null, { v: 2 }, { v: 1, extra: true }, { v: 1, symbolMap: { gate: { 'tap-lower': tap } } },
    { v: 1, symbolMap: { gate: {} } }, { v: 1, symbolMap: { gate: { TAP: 'not an id' } } },
    { v: 1, coinGroups: [{ id: 'x', source: 'http://insecure.example', members: { [tap]: 'issuance', [tnk]: 'escrow-backed' } }] },
    { v: 1, coinGroups: [{ id: 'x', source: 'https://ok.example', members: { [tap]: 'escrow-backed', [tnk]: 'escrow-backed' } }] },
    { v: 1, coinGroups: [{ id: 'x', source: 'https://ok.example', members: { [tap]: 'issuance' } }] },
  ]) assert.throws(() => validateReleaseExtensions(bad), TypeError, JSON.stringify(bad));
});
