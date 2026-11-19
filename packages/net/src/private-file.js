import fs from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

// libuv reports all Windows reparse points as links in directory entries. Its
// lstat treats some reparse tags (e.g. cloud files) as ordinary files.
export function windowsLstat(file) {
  file = resolve(file);
  const stat = fs.lstatSync(file, { bigint: true });
  if (stat.isSymbolicLink() || !stat.ino) throw new Error('Expected a plain file or directory with a stable identity');
  if (file === dirname(file)) return stat;
  const name = basename(file).toLowerCase();
  const dir = fs.opendirSync(dirname(file));
  try {
    let found = false;
    for (let entry; (entry = dir.readSync());) {
      if (entry.name.toLowerCase() !== name) continue;
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
        throw new Error('Expected a plain file or directory without reparse points');
      }
      found = true;
    }
    if (!found) {
      fs.lstatSync(file); // Preserve ENOENT when a lock was released during inspection.
      throw new Error('File changed during inspection');
    }
  } finally { dir.closeSync(); }
  return stat;
}

/** Native Windows needs Node.js 22.17+: on older releases a new file's descriptor and path report different file IDs. */
export const WINDOWS_MIN_NODE = '22.17';
export function windowsNodeProblem(version = process.versions.node, platform = process.platform) {
  if (platform !== 'win32') return null;
  const [major, minor] = version.split('.').map(Number), [needMajor, needMinor] = WINDOWS_MIN_NODE.split('.').map(Number);
  if (major > needMajor || (major === needMajor && minor >= needMinor)) return null;
  return `native Windows needs Node.js ${WINDOWS_MIN_NODE} or newer (this is ${version}); install the current Node.js 22 LTS or use WSL`;
}

/** The private directory inherits its Windows ACL from the user's data directory. */
export function windowsDirectory(dir) {
  const stat = windowsLstat(dir);
  if (!stat.isDirectory()) throw new Error('Expected a data directory');
  return stat;
}

/** Create missing directories beneath a checked parent, tolerating a concurrent creator. */
export function ensureWindowsDirectory(dir) {
  let stat = null;
  try { stat = windowsLstat(dir); }
  catch (error) {
    if (error.code !== 'ENOENT' || dir === dirname(dir)) throw error;
  }
  if (stat) {
    // Like mkdir on POSIX, a non-directory in the way is EEXIST.
    if (!stat.isDirectory()) throw Object.assign(new Error('EEXIST: not a directory: ' + dir), { code: 'EEXIST' });
    return stat;
  }
  const parent = dirname(dir), before = ensureWindowsDirectory(parent);
  try { fs.mkdirSync(dir, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const created = windowsDirectory(dir);
  if (!sameIdentity(before, windowsDirectory(parent))) throw new Error('Directory changed during create');
  return created;
}

/** Keep the full Windows file ID; adjacent NTFS IDs can exceed Number's precision. */
export function sameIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Open a local credential for reading. Callers check size/mode and read through the returned descriptor. */
export function openPrivateRead(file, platform = process.platform) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  if (platform !== 'win32') return fs.openSync(file, O_RDONLY | (O_NOFOLLOW ?? 0) | (O_NONBLOCK ?? 0));
  const parent = windowsDirectory(dirname(file));
  const before = windowsLstat(file);
  if (!before.isFile()) throw new Error('Expected a regular file');
  const fd = fs.openSync(file, O_RDONLY);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened) || !sameIdentity(opened, windowsLstat(file)) ||
        !sameIdentity(parent, windowsDirectory(dirname(file)))) {
      throw new Error('File identity changed during open');
    }
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
