import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { openPrivateRead, windowsDirectory } from '@gator/net/src/private-file.js';
import { processAlive } from '@gator/social/src/identity-lock.js';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Default data directory: GATOR_SOCIAL_DATA or ~/.gator-social. */
export function defaultDataDir(env = process.env) {
  return resolve(env.GATOR_SOCIAL_DATA || join(homedir(), '.gator-social'));
}

export function checkDataDir(dir) {
  const stat = process.platform === 'win32' ? windowsDirectory(dir) : lstatSync(dir);
  if (!stat.isDirectory()) throw new Error('Expected a data directory');
  if (process.platform !== 'win32' && (stat.mode & 0o077)) {
    throw new Error('Data directory must be private (chmod 700): ' + dir);
  }
}

/** Atomically replace a file only this user can read. */
export function writePrivate(file, contents) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(tmp, contents, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Read a small private file (a token). Refuses links, non-files and files others can read or write. */
export function readPrivate(file, maxBytes = 4096) {
  const fd = openPrivateRead(file);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Expected a small regular file: ' + file);
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error('File must not be readable by other users (chmod 600): ' + file);
    }
    return readFileSync(fd, 'utf8').trim();
  } finally {
    closeSync(fd);
  }
}

/** config.json in the data dir: { card?, topics?, follow?: string[] }. Missing = {}. */
export function readConfig(dataDir) {
  try {
    const value = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('Invalid config.json in ' + dataDir + ': ' + error.message);
  }
}

export function writeConfig(dataDir, config) {
  writePrivate(join(dataDir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
}

const held = new Set();
/** One running gator-social per data dir. Returns release(); throws if another live process holds it. */
export function acquireLock(dataDir, { isAlive = processAlive } = {}) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = resolve(dataDir, 'run.lock');
  if (held.has(file)) throw new Error('gator-social is already running for ' + dataDir + ' (this process)');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      held.add(file);
      return () => {
        held.delete(file);
        try { if (readFileSync(file, 'utf8') === String(process.pid)) rmSync(file, { force: true }); } catch {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(file, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid)) {
        throw new Error('gator-social is already running for ' + dataDir + ' (pid ' + pid + ')');
      }
      rmSync(file, { force: true });
    }
  }
  throw new Error('Could not lock ' + dataDir);
}
