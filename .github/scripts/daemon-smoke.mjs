import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../bin/gator.js', import.meta.url));
const preload = new URL('./offline-daemon.mjs', import.meta.url).href;
const available = createServer();
await new Promise((ok, fail) => available.once('error', fail).listen(0, '127.0.0.1', ok));
const { port } = available.address();
await new Promise((ok, fail) => available.close(error => error ? fail(error) : ok()));

const temp = mkdtempSync(join(tmpdir(), 'gator smoke '));
const data = join(temp, 'data'), log = join(temp, 'daemon.log');
const env = { ...process.env, GATOR_DATA: data, GATOR_IDENTITY_LOCKS: join(temp, 'locks') };
const run = command => JSON.parse(execFileSync(process.execPath, [cli, command], {
  env, encoding: 'utf8', windowsHide: true, timeout: 30_000,
}));

let child, exited;
async function waitForExit(ms) {
  let timer;
  try {
    return await Promise.race([exited, new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error('Daemon did not exit within ' + ms + ' ms')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

try {
  const fd = openSync(log, 'wx', 0o600);
  try {
    child = spawn(process.execPath, ['--import', preload, cli, 'start', '--profile', 'small', '--port', String(port)], {
      env, detached: true, windowsHide: true, stdio: ['ignore', fd, fd],
    });
  } finally { closeSync(fd); }
  let stopped = false;
  exited = new Promise(resolve => {
    child.once('error', error => { stopped = true; resolve({ error: error.message }); });
    child.once('exit', (code, signal) => { stopped = true; resolve({ code, signal }); });
  });
  const nonce = randomBytes(24).toString('base64url');
  const proof = 'http://127.0.0.1:' + port + '/proof?kind=agent&nonce=' + nonce;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (stopped) throw new Error('Daemon exited during startup: ' + JSON.stringify(await exited));
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the loopback API');
    if (existsSync(join(data, 'daemon.json'))) {
      const reply = await fetch(proof, { redirect: 'error', signal: AbortSignal.timeout(3000) });
      assert.equal(reply.status, 200);
      assert.match((await reply.json()).proof, /^[a-f0-9]{64}$/);
      break;
    }
    await delay(100);
  }
  const status = run('status'); // CLI proves the listener, then reads /me and /network.
  assert.equal(status.running, true);
  assert.equal(status.port, port);
  assert.match(status.key, /^[a-f0-9]{64}$/);
  assert.ok(existsSync(join(data, 'seen', '.writer.lock')));
  assert.deepEqual(run('stop'), { stopping: true });
  assert.deepEqual(await waitForExit(30_000), { code: 0, signal: null });
  assert.ok(!existsSync(join(data, 'daemon.json')));
  assert.ok(!existsSync(join(data, 'seen', '.writer.lock')));
  console.log('Verified daemon startup, authenticated API reads and clean shutdown.');
} catch (error) {
  if (existsSync(log)) process.stderr.write(readFileSync(log, 'utf8').slice(-4096));
  throw error;
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await waitForExit(10_000);
  }
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
