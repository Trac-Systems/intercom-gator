import { createHash } from 'node:crypto'
import { applyPatch, bundleDigest, canonical } from '../../../bundle/src/index.js'
import { ROOT_KEY } from '../../../bundle/src/root-key.js'
import { adaptBundle } from '../sources/bundle-adapter.js'
import { patchUrlProblem } from './urls.js'
import { takeEffect } from './live.js'
import { PatchFeed } from './feed.js'

export { migrations } from './schema.js'
export { publicHost, urlProblem, patchUrlProblem } from './urls.js'

/** Hard limits for root bundle patches on `gator/ctl` (the channel itself caps frames at 64 KiB). */
export const MAX_PATCH_BYTES = 65536
export const MAX_PATCH_OPS = 256
export const MAX_CHAIN = 64

const hex64 = /^[0-9a-f]{64}$/
const hex128 = /^[0-9a-f]{128}$/
const plain = (v) =>
  v !== null && typeof v === 'object' && [null, Object.prototype].includes(Object.getPrototypeOf(v))
const exactly = (v, keys) =>
  plain(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k))

class Rejected extends Error {
  constructor(reason) {
    super(reason)
    this.reason = reason
  }
}

/** Stateless checks of a `patch` ctl message: exact shape, types and size caps. Returns a reason or null.
 * Shape: `{ t: 'patch', v: 1, seq, patch: { baseDigest, ops, newDigest, signature } }`. */
export function patchShapeProblem(msg) {
  if (!exactly(msg, ['t', 'v', 'seq', 'patch']) || msg.t !== 'patch' || msg.v !== 1) return 'shape'
  if (!Number.isSafeInteger(msg.seq) || msg.seq < 0) return 'shape'
  const p = msg.patch
  if (
    !exactly(p, ['baseDigest', 'ops', 'newDigest', 'signature']) ||
    typeof p.baseDigest !== 'string' ||
    !hex64.test(p.baseDigest) ||
    typeof p.newDigest !== 'string' ||
    !hex64.test(p.newDigest) ||
    typeof p.signature !== 'string' ||
    !hex128.test(p.signature) ||
    !Array.isArray(p.ops) ||
    !p.ops.length
  )
    return 'shape'
  if (p.ops.length > MAX_PATCH_OPS) return 'size'
  let text
  try {
    text = canonical(msg)
  } catch {
    return 'shape'
  }
  return Buffer.byteLength(text) > MAX_PATCH_BYTES ? 'size' : null
}

function reasonOf(error) {
  const message = String(error?.message)
  if (/base digest/.test(message)) return 'base'
  if (/signature|trusted root|root mismatch/i.test(message)) return 'signature'
  if (/result digest/.test(message)) return 'digest'
  if (/patch (operation|path|parent|target|envelope)|JSON Pointer|array index/i.test(message)) return 'ops'
  return 'schema'
}

/** Verify and apply one patch message on top of `base` (whose digest the caller already matched).
 * The result must also adapt into an engine catalog, so an accepted patch can never stop the next start.
 * Throws Rejected with a short reason. */
function applyChecked(base, msg, rootKey) {
  const url = patchUrlProblem(msg.patch.ops, base)
  if (url) throw new Rejected('url')
  let next
  try {
    next = applyPatch(base, msg.patch, rootKey)
  } catch (error) {
    throw new Rejected(reasonOf(error))
  }
  try {
    adaptBundle(next)
  } catch {
    throw new Rejected('adapt')
  }
  return next
}

/** Re-apply stored patch messages on top of the signed release bundle. Every link is verified again (shape, caps,
 * increasing seq, base = previous digest, URL policy, signature, schema, new digest). Stops at the first broken link.
 * @param {object} release the verified release bundle @param {string} releaseDigest
 * @param {object[]} messages ctl messages in chain order @param {string} rootKey
 * @returns {{bundle: object, chain: Array<{seq:number, baseDigest:string, newDigest:string}>,
 *   status: 'ok'|'release'|'broken'}} `release` = the chain does not start at this release (all dropped) */
export function replayChain(release, releaseDigest, messages, rootKey) {
  if (messages.length && messages[0]?.patch?.baseDigest !== releaseDigest)
    return { bundle: release, chain: [], status: 'release' }
  let bundle = release
  const chain = []
  for (const msg of messages) {
    try {
      const reason =
        patchShapeProblem(msg) ??
        (msg.seq > (chain.at(-1)?.seq ?? -1) ? null : 'seq') ??
        (msg.patch.baseDigest === (chain.at(-1)?.newDigest ?? releaseDigest) ? null : 'base')
      if (reason) throw new Rejected(reason)
      bundle = applyChecked(bundle, msg, rootKey)
      chain.push({ seq: msg.seq, baseDigest: msg.patch.baseDigest, newDigest: msg.patch.newDigest })
    } catch (error) {
      if (!(error instanceof Rejected)) throw error
      return { bundle, chain, status: 'broken' }
    }
  }
  return { bundle, chain, status: 'ok' }
}

/** Root-signed source-bundle patches for one engine (DESIGN §3, §5.2 `patch` on `gator/ctl`).
 * Trust is the compiled ROOT_KEY. `rootKey` is a programmatic test seam only; the daemon never passes it and it is
 * never read from settings, config or the network. `log` receives one line per distinct rejected message (never the
 * payload), at most 32 lines per hour. `maxChain` is a test seam for the chain cap. */
export class BundlePatches {
  /** @param {import('../index.js').Engine} engine
   * @param {{rootKey?: string, log?: (line: string) => void, maxChain?: number, patchFeed?: boolean|string}} [options] */
  constructor(engine, { rootKey = ROOT_KEY, log = (line) => process.emitWarning(line), maxChain = MAX_CHAIN, patchFeed } = {}) {
    if (typeof rootKey !== 'string' || !hex64.test(rootKey)) throw new TypeError('Expected a root public key')
    Object.assign(this, { engine, rootKey, log, maxChain })
    this.release = engine.bundle
    this.current = engine.bundle
    this.feed = new PatchFeed(this, patchFeed)
    /** @type {Array<{seq:number, baseDigest:string, newDigest:string}>} */
    this.chain = []
    this.logged = new Set()
    this.logWindow = { start: -Infinity, lines: 0 }
    const db = engine.store.writer
    this.enabled = !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='engine_patches'")
      .get()
    if (!this.enabled) return
    this.rows = db.prepare('SELECT pos,message FROM engine_patches ORDER BY pos')
    this.insert = db.prepare(
      'INSERT INTO engine_patches (seq,baseDigest,newDigest,message,appliedAt,envelope) VALUES (?,?,?,?,?,?)'
    )
    this.fillEnvelope = db.prepare('UPDATE engine_patches SET envelope=? WHERE seq=? AND envelope IS NULL AND message=?')
    this.clear = db.prepare('DELETE FROM engine_patches')
    this.truncate = db.prepare('DELETE FROM engine_patches WHERE pos>?')
  }
  /** Digest after the last accepted patch, or null while the release is unpatched. */
  get head() {
    return this.chain.at(-1)?.newDigest ?? null
  }
  get seq() {
    return this.chain.at(-1)?.seq ?? -1
  }
  releaseDigest() {
    if (this.cachedRelease === undefined) {
      try {
        this.cachedRelease = bundleDigest(this.release)
      } catch {
        this.cachedRelease = null
      }
    }
    return this.cachedRelease
  }
  /** Current effective digest (release digest when unpatched). */
  digest() {
    return this.head ?? this.releaseDigest()
  }
  status() {
    const active = new Set(this.engine.catalog.chains.map(c => c.id))
    const newChains = this.current.chains.map(c => c.id).filter(id => !active.has(id))
    const restart = newChains.length ? 'restart to use ' + newChains.length + ' new chain' + (newChains.length > 1 ? 's' : '') : null
    return { release: this.releaseDigest(), digest: this.digest(), patches: this.chain.length, seq: this.seq,
      feed: { ...this.feed.state }, newChains, restart }
  }
  /** Startup: re-apply the stored chain on top of the release. Returns the effective bundle. */
  restore() {
    if (!this.enabled) return this.release
    const rows = this.rows.all()
    if (!rows.length) return this.release
    const messages = rows.map((row) => {
      try {
        return JSON.parse(row.message)
      } catch {
        return null
      }
    })
    const { bundle, chain, status } = replayChain(this.release, this.releaseDigest(), messages, this.rootKey)
    if (status === 'release') {
      this.clear.run()
      this.note('Stored bundle patches dropped: they do not start at this release')
    } else if (status === 'broken') {
      this.truncate.run(chain.length ? rows[chain.length - 1].pos : -1)
      this.note('Stored bundle patch chain is broken; using the last good digest')
    }
    this.chain = chain
    this.current = bundle
    return bundle
  }
  /** One `patch` message from `gator/ctl`. Returns true when it was applied. Never throws into the transport. */
  receive(env) {
    try {
      return this.accept(env)
    } catch {
      this.note('Bundle patch handling failed')
      return false
    }
  }
  accept(env, onReject) {
    const msg = env?.message
    let next
    let rebase = false
    try {
      if (env?.from !== this.rootKey) throw new Rejected('sender')
      if (!this.enabled) throw new Rejected('storage')
      const shape = patchShapeProblem(msg)
      if (shape) throw new Rejected(shape)
      if (msg.seq <= this.seq) {
        // Re-sent copies of a patch in the chain are expected (quasi-persistence): ignore them quietly.
        if (this.chain.some((c) => c.seq === msg.seq && c.newDigest === msg.patch.newDigest)) {
          if (env.sig) this.fillEnvelope.run(JSON.stringify(env), msg.seq, canonical(msg))
          return false
        }
        throw new Rejected('seq')
      }
      const release = this.releaseDigest()
      if (!release) throw new Rejected('release')
      if (msg.patch.baseDigest === this.digest()) {
        if (this.chain.length >= this.maxChain) throw new Rejected('chain-full')
      } else if (msg.patch.baseDigest === release) rebase = true
      else throw new Rejected('base')
      next = applyChecked(rebase ? this.release : this.current, msg, this.rootKey)
    } catch (error) {
      if (!(error instanceof Rejected)) throw error
      onReject?.(error.reason)
      this.reject(msg, error.reason)
      return false
    }
    const { seq, patch } = msg
    try {
      this.engine.store.transaction(() => {
        if (rebase) this.clear.run()
        this.insert.run(seq, patch.baseDigest, patch.newDigest, canonical(msg), this.engine.clock(),
          env.sig ? JSON.stringify(env) : null)
      })
    } catch {
      onReject?.('storage')
      this.note('Bundle patch could not be stored; nothing changed')
      return false
    }
    const before = this.current
    this.current = next
    if (rebase) this.chain = []
    this.chain.push({ seq, baseDigest: patch.baseDigest, newDigest: patch.newDigest })
    if (this.engine.obs) this.engine.obs.digest = patch.newDigest.slice(0, 16)
    let restart
    try {
      restart = takeEffect(this.engine, before, next).restart
    } catch {
      // Stored and verified: the next start builds everything from the effective bundle.
      this.engine.bundle = next
      restart = ['all']
      this.note('Bundle patch stored; the live update failed and it takes effect at the next start')
    }
    this.engine.emit('bundlePatch', { seq, digest: patch.newDigest, patches: this.chain.length, restart })
    return true
  }
  reject(msg, reason) {
    let key
    try {
      key = createHash('sha256').update(canonical(msg ?? null)).digest('hex')
    } catch {
      key = 'unencodable:' + reason
    }
    if (this.logged.has(key)) return
    if (this.logged.size >= 256) this.logged.delete(this.logged.values().next().value)
    this.logged.add(key)
    const seq = Number.isSafeInteger(msg?.seq) ? msg.seq : null
    this.note('Bundle patch rejected' + (seq === null ? '' : ' (seq ' + seq + ')') + ': ' + reason)
    this.engine.emit('bundlePatchRejected', { seq, reason })
  }
  /** At most 32 lines per hour reach the log, whatever arrives. */
  note(line) {
    const now = this.engine.clock()
    if (now - this.logWindow.start >= 3_600_000) this.logWindow = { start: now, lines: 0 }
    if (this.logWindow.lines++ < 32) this.log(line)
  }
}
