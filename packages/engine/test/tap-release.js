import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { applyPatch, loadBundle, loadReleaseExtensions, signPatch } from '../../bundle/src/index.js'
import { seedPublicKey } from '../src/patches/root.js'

/** Shared fixtures for the TAP Protocol / Trac Network release: the signed v0.1.0 base every version ships, the
 * shared root patch (ops from packages/bundle/test/fixtures/tap-tnk-ops.json, signed here with a throwaway test key
 * through the root key test seam) and this release's extension file. */
export const RELEASE = '2e7fd025868071e3a31a8dc5f6b8041f7e9a359dbacffc00bb43db39e721a7bb'
export const PATCHED = 'e0269781cd50d2d8d03833eae9971bbca096ce7b37c3c9ede4177cfb63f4b9f7'
export const tap = 'tap-protocol:native', tnk = 'trac:native'
export const tapErc20 = 'ethereum:0x5e7f6e008c6d9d7ad4c7eb75bd4ce62864cc7454'
export const seed = randomBytes(32)
export const rootKey = seedPublicKey(seed)
export const ops = JSON.parse(readFileSync(new URL('../../bundle/test/fixtures/tap-tnk-ops.json', import.meta.url), 'utf8'))
export const release = loadBundle()
export const extensions = loadReleaseExtensions()

let signed
/** The root's `patch` ctl message for the shared ops on the release (Ed25519 signatures are deterministic). */
export function patchMessage(seq = 1) {
  signed ??= signPatch(release, ops, seed)
  return { t: 'patch', v: 1, seq, patch: signed }
}
let patched
/** The effective signed bundle every version holds after the shared patch. */
export function tapBundle() {
  patched ??= applyPatch(release, patchMessage().patch, rootKey)
  return patched
}
