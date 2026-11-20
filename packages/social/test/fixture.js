import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Social, migrations } from '../src/index.js';
import { Hub } from './hub.js';

export async function fixture(t) {
  const hub = new Hub();
  const root = hub.peer();
  const dir = await mkdtemp(join(import.meta.dirname, 'scratch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const peers = [];
  t.after(async () => {
    for (const p of peers) { await p.social.close(); await p.net.close(); p.db.close(); }
  });
  async function peer(opts = {}, net = hub.peer()) {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    for (const m of migrations) m.up(db);
    const args = { transport: net, db, rootKey: root.publicKey, dataDir: join(dir, net.publicKey),
      clock: () => hub.now, proofs: false, ...opts };
    const social = new Social(args);
    await social.ready;
    const p = { social, net, db, key: net.publicKey, args };
    peers.push(p);
    return p;
  }
  return { hub, root, dir, peer };
}
