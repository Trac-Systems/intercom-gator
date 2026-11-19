import { mkdtempSync, rmSync, statfsSync, statSync } from 'node:fs';
import { availableParallelism, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { detectProfile, limitsFor } from './profile.js';

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {ReturnType<typeof openDatabase>} StoreDatabase */

/** Run synchronous work on the single writer, nesting via savepoints.
 * @param {DatabaseSync} writer */
function transactions(writer) {
  let depth = 0;
  return function transaction(fn) {
    if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') {
      throw new TypeError('Expected a synchronous transaction callback');
    }
    const savepoint = 'gator_tx_' + depth;
    const nested = depth > 0;
    writer.exec(nested ? 'SAVEPOINT ' + savepoint : 'BEGIN IMMEDIATE');
    depth++;
    try {
      const result = fn(writer);
      if (typeof result?.then === 'function') throw new TypeError('Transaction returned a promise');
      writer.exec(nested ? 'RELEASE ' + savepoint : 'COMMIT');
      return result;
    } catch (error) {
      writer.exec(nested ? 'ROLLBACK TO ' + savepoint + '; RELEASE ' + savepoint : 'ROLLBACK');
      throw error;
    } finally {
      depth--;
    }
  };
}

/** @typedef {{id: string, up: (db: DatabaseSync) => void}} Migration */
function migrate(writer, transaction, migrations) {
  const ids = new Set();
  for (const { id, up } of migrations) {
    if (typeof id !== 'string' || !/^[\w@-]+[:./_-].+$/u.test(id) || typeof up !== 'function') {
      throw new TypeError('Expected a package-prefixed migration id and up(db)');
    }
    if (ids.has(id)) throw new Error('Duplicate migration id ' + id);
    ids.add(id);
  }
  writer.exec('CREATE TABLE IF NOT EXISTS meta (id TEXT PRIMARY KEY, appliedAt INTEGER NOT NULL) STRICT');
  const applied = writer.prepare('SELECT 1 FROM meta WHERE id = ?');
  const remember = writer.prepare('INSERT INTO meta VALUES (?, ?)');
  for (const { id, up } of migrations) {
    transaction(() => {
      if (applied.get(id)) return;
      transaction(up);
      remember.run(id, Date.now());
    });
  }
}

/** @param {{file: string, profile?: string, migrations?: Migration[]}} options
 *  @param {Migration[]} storeMigrations */
export function openDatabase({ file, profile, migrations = [] }, storeMigrations) {
  if (typeof file !== 'string' || !file) throw new TypeError('Expected a database filename');
  // Private SQLite memory databases cannot share WAL snapshots across connections.
  const temporary = file === ':memory:' ? mkdtempSync(join(tmpdir(), 'gator-store-')) : null;
  if (temporary) file = join(temporary, 'gator.db');
  let writer, reader;
  function close() {
    reader?.close();
    reader = undefined;
    writer?.close();
    writer = undefined;
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }

  try {
    if (profile === undefined) {
      const disk = statfsSync(dirname(file));
      profile = detectProfile({
        totalMemBytes: totalmem(), cpus: availableParallelism(), freeDiskBytes: disk.bavail * disk.bsize,
      }).profile;
    }
    const limits = limitsFor(profile);
    // Profile-only commands do not load SQLite. On open, Node owns its warning stream.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    writer = new DatabaseSync(file);
    writer.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA auto_vacuum = INCREMENTAL');
    const { journal_mode } = writer.prepare('PRAGMA journal_mode = WAL').get();
    if (journal_mode !== 'wal') throw new Error('SQLite WAL mode is required');
    // A budget prune deletes many rows in one transaction; without a limit the WAL file keeps that peak size on disk.
    writer.exec('PRAGMA journal_size_limit = 16777216');
    const transaction = transactions(writer);
    // Apply the shared schema first. Packages supply dependent migrations in declaration order.
    migrate(writer, transaction, [...storeMigrations, ...migrations]);
    reader = new DatabaseSync(file, { readOnly: true });
    reader.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA query_only = ON');
    return { writer, reader, profile, limits, transaction, fileBytes: () => statSync(file).size, close };
  } catch (error) {
    close();
    throw error;
  }
}
