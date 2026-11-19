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

/** The private directory inherits its Windows ACL from the user's data directory. */
export function windowsDirectory(dir) {
  const stat = windowsLstat(dir);
  if (!stat.isDirectory()) throw new Error('Expected a data directory');
  return stat;
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
