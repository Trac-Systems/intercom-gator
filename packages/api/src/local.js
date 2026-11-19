import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { openPrivateRead, windowsDirectory } from '@gator/net/src/private-file.js';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const defaultDir = () => resolve(process.env.GATOR_DATA || join(homedir(), '.intercom-gator'));
export const DEFAULT_PORT = 7420;
/** Local credential files. `agent` is the agent's bearer, `owner` changes policy, `stop` only stops the daemon. */
export const CREDENTIALS = Object.freeze({ agent: 'api-token', owner: 'dashboard-token', stop: 'stop-token' });
export const NONCE = /^[A-Za-z0-9_-]{22,128}$/;

/** HMAC a listener returns for GET /proof. Only a process that holds the credential can compute it, and it is bound
 * to the port the client dialled, so a squatter can neither answer nor relay the real daemon's answer. */
export function serverProof(token, kind, port, nonce) {
  return createHmac('sha256', token).update(['intercom-gator/server-proof/v1', kind, String(port), nonce].join('\n')).digest('hex');
}
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function check(condition, message, status = 400) {
  if (!condition) throw new HttpError(status, message);
}

export function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}

export function writePrivate(path, value) {
  const tmp = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(tmp, value, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
}

export function readToken(dataDir, filename = 'api-token') {
  const file = join(dataDir, filename);
  const fd = openPrivateRead(file);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 256) throw new Error('Invalid local credential');
    if (process.platform !== 'win32' && (stat.mode & 0o077)) fchmodSync(fd, 0o600);
    const value = readFileSync(fd, 'utf8').trim();
    if (!/^[a-zA-Z0-9_-]{32,128}$/.test(value)) throw new Error('Invalid local credential');
    return value;
  } finally { closeSync(fd); }
}

export function ensureToken(dir, filename) {
  try { return readToken(dir, filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  writePrivate(join(dir, filename), randomBytes(32).toString('base64url') + '\n');
  return readToken(dir, filename);
}

/** An OS-released SQLite lock prevents two daemons sharing keys, config and seen files. */
export function lockDirectory(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = process.platform === 'win32' ? windowsDirectory(dir) : lstatSync(dir);
  if (!stat.isDirectory()) throw new Error('Expected a data directory');
  if (process.platform !== 'win32' && (stat.mode & 0o077)) {
    throw new Error('Data directory must be private (chmod 700)');
  }
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(join(dir, 'daemon.lock.db'));
  try { db.exec('BEGIN EXCLUSIVE'); }
  catch { db.close(); throw new Error('Data directory is already in use'); }
  return () => db.close();
}
