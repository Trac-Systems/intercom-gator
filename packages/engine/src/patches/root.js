import { createPrivateKey, createPublicKey, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { bundleDigest, canonical, patchDigest, signPatch, verifyBundleSignature } from '../../../bundle/src/index.js'
import { MAX_CHAIN, patchShapeProblem, patchUrlProblem, replayChain } from './index.js'
import { MAX_FEED_BYTES, verifiedPatchEnvelope } from './feed-format.js'
import { openPrivateRead } from '../../../net/src/private-file.js'

/** Root tool helpers behind `gator root patch` / `gator root publish`. The seed is read in-process into a Buffer,
 * never printed, logged or written anywhere, and no error message contains any part of it. */

const space = (byte) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
function nibble(byte) {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37
  return -1
}

/** Read a raw 32-byte Ed25519 seed stored as 64 hex characters (surrounding whitespace allowed). The file must be a
 * regular file readable by its owner only (Windows: no mode check). The caller zeroes the returned Buffer. */
export function readSeedFile(path) {
  let raw
  let tooOpen = false
  try {
    const fd = process.platform === 'win32' ? openPrivateRead(path) : openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > 1024) throw new Error()
      tooOpen = process.platform !== 'win32' && (stat.mode & 0o077) !== 0
      if (!tooOpen) raw = readFileSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    throw new Error('Cannot read the seed file')
  }
  if (tooOpen) throw new Error('The seed file must be private (chmod 600)')
  const seed = Buffer.alloc(32)
  try {
    let start = 0
    let end = raw.length
    while (start < end && space(raw[start])) start++
    while (end > start && space(raw[end - 1])) end--
    let ok = end - start === 64
    for (let i = 0; ok && i < 32; i++) {
      const hi = nibble(raw[start + 2 * i])
      const lo = nibble(raw[start + 2 * i + 1])
      ok = hi >= 0 && lo >= 0
      seed[i] = ok ? hi * 16 + lo : 0
    }
    if (!ok) {
      seed.fill(0)
      throw new Error('The seed file must hold a 32-byte seed as 64 hex characters')
    }
    return seed
  } finally {
    raw.fill(0)
  }
}

const pkcs8 = Buffer.from('302e020100300506032b657004220420', 'hex')
/** Ed25519 public key (64 hex) of a 32-byte seed. */
export function seedPublicKey(seed) {
  const der = Buffer.concat([pkcs8, seed])
  try {
    const key = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }))
    return key.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')
  } finally {
    der.fill(0)
  }
}

function storedRows(dataDir, withEnvelopes) {
  const file = join(dataDir, 'gator.db')
  if (!existsSync(file)) return []
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='engine_patches'").get()) return []
    if (withEnvelopes && !db.prepare("SELECT 1 FROM pragma_table_info('engine_patches') WHERE name='envelope'").get())
      throw new Error('Missing signed envelopes. Upgrade the node and receive the patches again.')
    return db.prepare(withEnvelopes ? 'SELECT message,envelope FROM engine_patches ORDER BY pos' :
      'SELECT message FROM engine_patches ORDER BY pos').all()
  } finally {
    db.close()
  }
}

/** Patch messages a local data directory accepted, in chain order (read-only; works while the daemon runs). */
export function readStoredChain(dataDir) {
  return storedRows(dataDir, false).map(row => {
    try { return JSON.parse(row.message) } catch { return null }
  })
}

/** Export one consistent snapshot of the accepted chain. A failed check leaves the previous output in place. */
export function exportRootFeed({ dataDir, out, release, rootKey }) {
  const digest = bundleDigest(release)
  const rows = storedRows(dataDir, true)
  if (!rows.length) throw new Error('No published patches stored for export')
  if (rows.length > MAX_CHAIN) throw new Error('Stored patch chain exceeds its limit')
  const envelopes = rows.map(row => {
    if (!row.envelope) throw new Error('Missing signed envelope. Receive the patch again or publish a cumulative patch.')
    const env = verifiedPatchEnvelope(JSON.parse(row.envelope), rootKey)
    if (!env || canonical(env.message) !== row.message) throw new Error('Invalid stored patch envelope')
    return env
  })
  const replay = replayChain(release, digest, envelopes.map(e => e.message), rootKey)
  if (replay.status !== 'ok') throw new Error('Stored chain does not verify against this release')
  const json = JSON.stringify({ v: 1, release: digest, envelopes }) + '\n'
  if (Buffer.byteLength(json) > MAX_FEED_BYTES) throw new Error('Feed exceeds 1 MiB. Publish a cumulative patch.')
  const temp = out + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(temp, json, { flag: 'wx' })
    renameSync(temp, out)
  } finally { rmSync(temp, { force: true }) }
  return { out, release: digest, envelopes: rows.length, seq: replay.chain.at(-1).seq }
}

/** Build and sign a `patch` ctl message against the current effective bundle: the verified release plus the chain
 * stored in the local data directory (`fromRelease` builds a cumulative patch on the release digest instead).
 * Receiver checks (shape, caps, URL policy, schema) run before anything is returned.
 * @param {{release: object, releaseDigest?: string, stored?: object[], ops: object[], seed: Uint8Array,
 *   rootKey: string, seq?: number, fromRelease?: boolean, now?: number}} options */
export function buildRootPatch({
  release,
  releaseDigest = bundleDigest(release),
  stored = [],
  ops,
  seed,
  rootKey,
  seq,
  fromRelease = false,
  now = Date.now(),
}) {
  if (seedPublicKey(seed) !== rootKey) throw new Error('The seed file does not belong to the root key')
  if (!Array.isArray(ops) || !ops.length) throw new Error('The ops file must hold a non-empty JSON array of operations')
  const local = replayChain(release, releaseDigest, stored, rootKey)
  const lastSeq = local.chain.at(-1)?.seq ?? -1
  if (seq === undefined) seq = Math.max(now, lastSeq + 1)
  if (!Number.isSafeInteger(seq) || seq <= lastSeq) throw new Error('seq must be an integer above ' + lastSeq)
  if (!fromRelease && local.chain.length >= MAX_CHAIN)
    throw new Error('The patch chain is full (' + MAX_CHAIN + '); build a cumulative patch with --from-release')
  const base = fromRelease ? release : local.bundle
  const patch = signPatch(base, ops, seed)
  const message = { t: 'patch', v: 1, seq, patch }
  const shape = patchShapeProblem(message)
  const url = patchUrlProblem(patch.ops, base)
  if (shape || url) throw new Error('Receivers would reject this patch: ' + (shape ?? 'url (' + url + ')'))
  return { message, chain: fromRelease ? 0 : local.chain.length, stored: local.status }
}

/** Join `gator/ctl` with the root identity, wait for a peer, send the message once and linger so it can flush.
 * @param {{message: object, transport: object, rootKey: string, wait?: number, linger?: number}} options */
export async function publishRootPatch({ message, transport, rootKey, wait = 30_000, linger = 3_000 }) {
  const problem = patchShapeProblem(message)
  if (problem) throw new Error('Invalid patch file: ' + problem)
  if (!verifyBundleSignature(patchDigest(message.patch), message.patch.signature, rootKey))
    throw new Error('The patch is not signed by the root key')
  if (transport.publicKey !== rootKey) throw new Error('The seed file does not belong to the root key')
  const policy = { ownerKey: rootKey, ownerWriteOnly: true, verifySignature: true, maxReceiveBytes: 65536 }
  if (!(await transport.join('gator/ctl', policy))) throw new Error('Cannot join gator/ctl')
  const deadline = performance.now() + wait
  while (!transport.peerCount()) {
    if (performance.now() >= deadline) throw new Error('No peer joined gator/ctl in time; nothing was sent')
    await delay(100)
  }
  if (!transport.send('gator/ctl', message)) throw new Error('The transport refused the patch message')
  await delay(linger)
  return { peers: transport.peerCount() }
}
