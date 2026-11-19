import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reclaimSeenLock } from '../src/app.js';

for (const platform of new Set([process.platform, 'win32'])) test(platform + ': a killed daemon\'s seen lock (with its owner record) is reclaimed only when it is the recorded inode', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gator-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = join(dir, 'seen', '.writer.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner'), JSON.stringify({ version: 1, pid: 999999 }));
  const stat = lstatSync(lock, { bigint: platform === 'win32' });
  const record = platform === 'win32'
    ? { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) }
    : { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
  assert.equal(reclaimSeenLock(dir, platform), false, 'no record: leave it alone');
  writeFileSync(join(dir, 'seen-writer.json'), JSON.stringify({ ...record, ino: platform === 'win32' ? String(stat.ino + 1n) : stat.ino + 1 }));
  assert.equal(reclaimSeenLock(dir, platform), false, 'a different inode belongs to someone else');
  assert.ok(existsSync(join(lock, 'owner')));
  writeFileSync(join(dir, 'seen-writer.json'), JSON.stringify(record));
  assert.equal(reclaimSeenLock(dir, platform), true);
  assert.equal(existsSync(lock), false);
  assert.equal(reclaimSeenLock(dir, platform), false, 'already gone');
});

test('a hung shutdown step times out and the remaining steps still run', async t => {
  const { fixture } = await import('./fixtures.js');
  const app = await fixture(t).start('hung', { cleanupTimeoutMs: 200 });
  // Simulate a step that never settles, registered last so it runs first.
  let storeClosed = false;
  const close = app.store.close.bind(app.store);
  app.store.close = () => { storeClosed = true; return close(); };
  app.engine.stop = () => new Promise(() => {});
  const started = Date.now();
  await assert.rejects(app.close(), /shutdown failed/i);
  assert.ok(Date.now() - started < 5_000);
  assert.equal(storeClosed, true);
  app.close = async () => {}; // the fixture's teardown would re-raise the expected failure
});
