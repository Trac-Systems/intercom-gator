import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const paths = [
  'LICENSE.md', 'SKILL.md', 'package.json', 'package-lock.json', 'bin/gator.js',
  ':(top,glob)packages/*/package.json', ':(top,glob)packages/*/src/**/*.js',
  'packages/bundle/data', 'packages/dashboard/public', 'packages/net/vendor',
  'packages/social-addon/bin/gator-social.js',
];

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

// Git's tree archives use wall time. Normalize the ustar headers it emitted, including directory
// and extended headers. This also works on Git versions predating "git archive --mtime".
function clearTarTimes(tar) {
  const block = 512;
  for (let offset = 0; offset < tar.length && tar[offset] !== 0;) {
    const header = tar.subarray(offset, offset + block);
    const size = Number.parseInt(header.toString('ascii', 124, 136), 8);
    header.write('00000000000\0', 136, 'ascii');
    header.fill(0x20, 148, 156); // ustar sums a header with its checksum field set to spaces.
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    offset += block * (1 + Math.ceil(size / block));
  }
}

/** Pack a single committed Git tree, including its workspace links' target packages.
 * @param {string} output Directory for the archive and SHA256SUMS. */
export function packRelease(output) {
  const tree = git('rev-parse', 'HEAD^{tree}');
  const { version } = JSON.parse(git('show', tree + ':package.json'));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('Invalid release version in package.json');
  }
  const lock = JSON.parse(git('show', tree + ':package-lock.json'));
  if (lock.version !== version || lock.packages[''].version !== version) {
    throw new Error('Update the root version in package-lock.json before packing');
  }

  const name = 'intercom-gator-' + version + '.tgz';
  mkdirSync(output, { recursive: true });
  const temp = mkdtempSync(join(output, '.pack-'));
  try {
    // A tree ID omits Git's commit/timestamp header. Git orders paths and preserves executable bits.
    const tar = join(temp, 'runtime.tar');
    git('-c', 'tar.umask=0022', '-c', 'core.autocrlf=false', 'archive', '--format=tar',
      '--output=' + tar, tree, '--', ...paths);
    const entries = readFileSync(tar);
    clearTarTimes(entries);
    const bytes = gzipSync(entries, { level: 9 });
    bytes[9] = 255; // RFC 1952 OS = unknown, independent of the host building the archive.
    const digest = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(temp, name), bytes);
    writeFileSync(join(temp, 'SHA256SUMS'), digest + '  ' + name + '\n');
    renameSync(join(temp, name), join(output, name));
    renameSync(join(temp, 'SHA256SUMS'), join(output, 'SHA256SUMS'));
    return name;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (git('status', '--porcelain', '--untracked-files=normal')) {
    throw new Error('Release packing requires a clean Git worktree');
  }
  console.log('Built dist/' + packRelease(join(root, 'dist')) + ' and dist/SHA256SUMS');
}
