// `gator-social key import`: run an identity that another harness created (normally `gator key export`).
import { randomBytes } from 'node:crypto';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadOrCreateKey } from '@gator/net';
import { readIdentityDocument } from '@gator/social';
import { acquireLock, createDataDir, readConfig, readPrivate, writeConfig, writePrivate } from './files.js';

/** The public key of this data directory's own identity, or null when it has none (never creates one). */
export async function ownPublicKey(dataDir) {
  if (!existsSync(join(dataDir, 'keys', 'peer.json'))) return null;
  return (await loadOrCreateKey(dataDir)).publicKey.toString('hex');
}

// The keystore must decrypt to the file's public key. loadOrCreateKey is the one keystore reader, so check the copy
// in a private scratch directory inside the (private) data directory and delete it afterwards.
async function keystoreKey(dataDir, keystore) {
  const scratch = join(dataDir, '.import-' + randomBytes(8).toString('hex'));
  try {
    writePrivate(join(scratch, 'keys', 'peer.json'), JSON.stringify(keystore));
    return (await loadOrCreateKey(scratch)).publicKey.toString('hex');
  } catch {
    throw new Error('The identity file holds no valid keystore');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Import an identity file into a stopped gator-social data directory. The secret stays in files (0600), never in
 * output. The newest signed card in the file becomes the saved card, so `run` publishes the same profile (plus this
 * product's harness tag) instead of a blank one. A different existing identity is kept aside, never overwritten.
 * @param {{dataDir:string, file:string, rootKey:string, replace?:boolean, now?:()=>number}} options
 */
export async function importIdentity({ dataDir, file, rootKey, replace = false, now = Date.now }) {
  createDataDir(dataDir);
  const release = acquireLock(dataDir); // refuses while gator-social runs on this directory
  try {
    const doc = readIdentityDocument(readPrivate(file, 64 * 1024), rootKey);
    if (await keystoreKey(dataDir, doc.keystore) !== doc.publicKey) throw new Error('The keystore does not match the file\'s public key');
    const current = await ownPublicKey(dataDir);
    let replaced = null;
    if (current && current !== doc.publicKey) {
      if (!replace) {
        throw new Error(`This data directory already has identity ${current.slice(0, 12)}…; importing replaces it. ` +
          'Add --replace to keep it aside (keys/peer.<key>.json) and switch, or use another --data directory.');
      }
      // Keep the old identity recoverable. Its feed database and network key belong to it and move aside too.
      const stamp = current.slice(0, 12) + '-' + now();
      renameSync(join(dataDir, 'keys', 'peer.json'), join(dataDir, 'keys', `peer.${stamp}.json`));
      for (const suffix of ['', '-wal', '-shm']) {
        const db = join(dataDir, 'social.db' + suffix);
        if (existsSync(db)) renameSync(db, join(dataDir, `social.${stamp}.db${suffix}`));
      }
      rmSync(join(dataDir, 'keys', 'swarm.json'), { force: true });
      rmSync(join(dataDir, 'seen'), { recursive: true, force: true });
      replaced = current;
    }
    if (current !== doc.publicKey) writePrivate(join(dataDir, 'keys', 'peer.json'), JSON.stringify(doc.keystore));
    const config = readConfig(dataDir);
    // A saved card of another identity must never go out under this key.
    const keepOwn = current === doc.publicKey && config.card;
    const next = { ...config, identity: { publicKey: doc.publicKey, importedAt: new Date(now()).toISOString(),
      ...(doc.from && { from: doc.from }), ...(!doc.card && !keepOwn && { awaitCard: true }) } };
    if (doc.card) Object.assign(next, { card: doc.card, topics: doc.topics ?? config.topics ?? [] });
    else if (!keepOwn) { delete next.card; delete next.topics; }
    writeConfig(dataDir, next);
    const { avatar, ...shown } = next.card ?? {};
    return { imported: true, publicKey: doc.publicKey, ...(replaced && { replaced }),
      card: next.card ? { ...shown, ...(avatar && { avatar: true }) } : null,
      note: doc.card ? 'gator-social run publishes this card with its product tag added.' :
        'No card in the file: gator-social run adopts the card when another harness of this identity publishes it.' };
  } finally {
    release();
  }
}
