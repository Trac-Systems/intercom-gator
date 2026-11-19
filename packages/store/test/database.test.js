import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { detectProfile } from '../src/index.js';
import { storeOpener, fixture } from './fixture.js';

test('weakest RAM, CPU or disk resource sets the profile', () => {
  const GiB = 1024 ** 3;
  const detect = (ram, cpus, disk) => detectProfile({ totalMemBytes: ram * GiB, cpus, freeDiskBytes: disk * GiB });
  assert.deepEqual(detect(2, 8, 20), { profile: 'small', limits: { storeBudgetMB: 150, keptAssets: 100, requestsPerMinute: 60 } });
  assert.deepEqual(detect(4, 2, 2), { profile: 'normal', limits: { storeBudgetMB: 400, keptAssets: 500, requestsPerMinute: 240 } });
  assert.deepEqual(detect(16, 8, 8), { profile: 'large', limits: { storeBudgetMB: 1024, keptAssets: 2000, requestsPerMinute: 900 } });
  assert.equal(detect(32, 4, 10).profile, 'normal');
  assert.equal(detect(32, 8, 1).profile, 'small');
  assert.throws(() => detect(4, -1, 2), RangeError);
});

const create = { id: 'example:001', up: db => db.exec('CREATE TABLE example (value TEXT)') };
const seed = { id: 'example:002', up: db => db.exec("INSERT INTO example VALUES ('once')") };

test('package migrations run in declared order and survive reopens', t => {
  const open = storeOpener(t);
  for (let i = 0; i < 2; i++) {
    const store = open({ migrations: [create, seed] });
    try {
      assert.deepEqual(store.reader.prepare('SELECT value FROM example').all().map(row => row.value), ['once']);
      assert.deepEqual(store.reader.prepare("SELECT id FROM meta WHERE id LIKE 'example:%' ORDER BY rowid").all().map(row => row.id), [create.id, seed.id]);
    } finally { store.close(); }
  }
});

test('failed migration rolls back its schema and id and can be retried', t => {
  const open = storeOpener(t);
  const bad = { id: seed.id, up(db) { db.exec('CREATE TABLE partial (a)'); throw new Error('interrupted'); } };
  assert.throws(() => open({ migrations: [create, bad] }), /interrupted/);
  const store = open({ migrations: [create, seed] });
  assert.equal(store.reader.prepare("SELECT name FROM sqlite_schema WHERE name = 'partial'").get(), undefined);
  assert.equal(store.reader.prepare('SELECT count(*) AS n FROM example').get().n, 1);
});

test('a WAL read transaction sees the same snapshot across a write commit', t => {
  const { writer, reader, transaction } = fixture(t, { migrations: [create, seed] });
  for (const db of [writer, reader]) {
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.ok(db.prepare('PRAGMA busy_timeout').get().timeout > 0);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  }
  assert.equal(writer.prepare('PRAGMA journal_size_limit').get().journal_size_limit, 16 * 1024 * 1024);
  const read = reader.prepare('SELECT value FROM example');
  reader.exec('BEGIN');
  transaction(db => {
    db.exec("UPDATE example SET value = 'committed'");
    assert.equal(read.get().value, 'once');
  });
  assert.equal(read.get().value, 'once');
  reader.exec('COMMIT');
  assert.equal(read.get().value, 'committed');
  assert.throws(() => reader.exec('DELETE FROM example'), /readonly/i);
});

test('transactions return results and isolate nested rollbacks', t => {
  const { transaction, reader } = fixture(t, { migrations: [create] });
  assert.equal(transaction(db => {
    db.exec("INSERT INTO example VALUES ('outer')");
    assert.throws(() => transaction(inner => {
      inner.exec("INSERT INTO example VALUES ('inner')");
      throw new Error('abort');
    }), /abort/);
    return 42;
  }), 42);
  assert.equal(reader.prepare('SELECT count(*) AS n FROM example').get().n, 1);
  assert.throws(() => transaction(async () => {}), /synchronous/);
});

test('temporary WAL store cleans up on close and keeps warnings off normal output', t => {
  const dir = mkdtempSync(fileURLToPath(new URL('./.store-test-', import.meta.url)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const entry = new URL('../src/index.js', import.meta.url).href;
  const source = `
    import { openStore } from ${JSON.stringify(entry)};
    const store = openStore({ file: ':memory:' });
    try {
      store.setSetting('value', 42);
      console.log(store.getSetting('value'));
    } finally { store.close(); }
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: dir, env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir }, encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '42');
  assert.deepEqual(readdirSync(dir), []);
});
