import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const destination = fileURLToPath(new URL('../vendor/intercom-sidechannel/', import.meta.url));
const source = 'https://github.com/Trac-Systems/intercom.git';
// index.js is the unmodified 0.0.11 release module; managed.js holds the opt-in policies.
export const paths = ['index.js', 'managed.js', 'channel-options.js', 'pow.js', 'seen.js'];
export const rewrites = [
  ["from 'trac-peer/src/artifacts/feature.js'", "from './feature.js'"],
  ["from '../../node_modules/compact-encoding/index.js'", "from 'compact-encoding'"],
];

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function upstream(checkout, revision, path) {
  return execFileSync('git', ['-C', checkout, 'show', revision + ':' + path]);
}

/** Apply (or reverse, for the audit test) the tracked downstream patch, outside the checkout. */
export function patchSeen(contents, reverse = false) {
  const dir = mkdtempSync(join(tmpdir(), 'gator-vendor-'));
  const file = join(dir, 'seen.js');
  const patch = fileURLToPath(new URL('./patches/seen-windows.patch', import.meta.url));
  try {
    writeFileSync(file, contents);
    execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', '--no-index', ...(reverse ? ['--reverse'] : []), patch],
      { cwd: dir, env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } });
    return readFileSync(file, 'utf8');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function sync(checkout, revision) {
  if (!checkout || !revision) throw new Error('Usage: node vendor-sync.mjs <checkout> <commit>');
  const commit = execFileSync('git', ['-C', checkout, 'rev-parse', '--verify', '--end-of-options',
    revision + '^{commit}'], { encoding: 'utf8' }).trim();
  const manifest = { source, commit, files: {} };
  mkdirSync(destination, { recursive: true });
  for (const name of paths) {
    const original = upstream(checkout, commit, 'features/sidechannel/' + name);
    let copy = original.toString('utf8');
    for (const [before, after] of rewrites) copy = copy.replaceAll(before, after);
    if (name === 'seen.js') copy = patchSeen(copy);
    manifest.files[name] = { upstreamSha256: sha256(original), vendoredSha256: sha256(copy) };
    if (name === 'seen.js') manifest.files[name].patch = 'scripts/patches/seen-windows.patch';
    writeFileSync(join(destination, name), copy);
  }
  writeFileSync(join(destination, 'LICENSE.md'), upstream(checkout, commit, 'LICENSE.md'));
  writeFileSync(join(destination, 'VENDOR.json'), JSON.stringify(manifest, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sync(...process.argv.slice(2));
}
