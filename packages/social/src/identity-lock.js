// One identity, one local process. Several harnesses may share an identity (gator key export → gator-social key
// import), but two processes on one machine signing as the same key would double every rate charge and fight over
// the card. Every harness takes this per-user lock for its identity before it opens the network.
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Per-user lock directory: $GATOR_IDENTITY_LOCKS or ~/.intercom-locks. */
export function identityLockDir(env = process.env) {
  return resolve(env.GATOR_IDENTITY_LOCKS || join(homedir(), '.intercom-locks'));
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

const held = new Map();

/**
 * Lock `publicKey` for this process. Throws when another live local process (or this one) already runs it.
 * The lock names the harness and data directory that holds it; a lock left by a crash is taken over.
 * @param {string} publicKey @param {{dir?:string, harness?:string, dataDir?:string, isAlive?:(pid:number)=>boolean}} [options]
 * @returns {() => void} release
 */
export function lockIdentity(publicKey, { dir = identityLockDir(), harness = 'unknown', dataDir = '', isAlive = alive } = {}) {
  if (typeof publicKey !== 'string' || !/^[a-f0-9]{64}$/.test(publicKey)) throw new TypeError('Expected a public key');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || (process.platform !== 'win32' &&
      ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())))) {
    throw new Error('Identity lock directory must be a private directory of this user (chmod 700): ' + dir);
  }
  const file = join(dir, createHash('sha256').update('intercom-gator/identity-lock/v1\n' + publicKey).digest('hex').slice(0, 32) + '.lock');
  const busy = owner => new Error(`This identity (${publicKey.slice(0, 12)}…) already runs in ${owner.harness ?? 'another harness'} ` +
    `(pid ${owner.pid}${owner.dataDir ? ', data ' + owner.dataDir : ''}). One identity runs in one process per machine: ` +
    'stop that process first. A harness that runs gator already reaches every product channel through gator. ' +
    'Stale lock: ' + file);
  if (held.has(file)) throw busy(held.get(file));
  const token = randomBytes(12).toString('hex');
  const owner = { pid: process.pid, harness, dataDir, since: Date.now(), token };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, JSON.stringify(owner) + '\n', { flag: 'wx', mode: 0o600 });
      held.set(file, owner);
      return () => {
        if (held.get(file)?.token !== token) return;
        held.delete(file);
        try { if (JSON.parse(readFileSync(file, 'utf8')).token === token) rmSync(file, { force: true }); } catch {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let other = null;
      try { other = JSON.parse(readFileSync(file, 'utf8')); } catch {}
      // A torn or unreadable lock (crash during the single small write) counts as stale.
      if (other && Number.isSafeInteger(other.pid) && other.pid > 0 && other.pid !== process.pid && isAlive(other.pid)) {
        throw busy(other);
      }
      rmSync(file, { force: true });
    }
  }
  throw new Error('Could not lock the identity: ' + file);
}
