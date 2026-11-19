import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT_KEY } from '../../bundle/src/root-key.js';

export { ROOT_KEY };

/** rootKey and dir are programmatic fixture seams, never read from daemon settings. */
export async function verifyRelease({ dir, rootKey = ROOT_KEY } = {}) {
  let api;
  try { api = await import('@gator/bundle'); }
  catch (cause) { throw new Error('The source bundle package is unavailable', { cause }); }
  dir ??= join(dirname(fileURLToPath(import.meta.resolve('@gator/bundle'))), '../data');
  const bundle = api.loadBundle({ dir, rootPubKeyHex: rootKey });
  const digest = api.bundleDigest(bundle);
  let signature;
  try { signature = readFileSync(join(dir, 'bundle.sig'), 'utf8').trim(); }
  catch (cause) { throw new Error('Release bundle signature is unavailable', { cause }); }
  if (!api.verifyBundleSignature(digest, signature, rootKey)) throw new Error('Invalid release bundle signature');
  // The release extension is outside the digest; a broken one leaves this node on the signed data alone.
  let extensions = null;
  try { extensions = api.loadReleaseExtensions({ dir }); }
  catch (error) { process.emitWarning('Release extensions ignored: ' + error.message); }
  // The release's shipped copy of its patch feed file, applied at startup when present (DESIGN "Bundle patch feed").
  const snapshot = join(dir, 'patches', digest + '.json');
  return { bundle, digest, rootKey, selectEndpoints: api.selectEndpoints, extensions, snapshot };
}
