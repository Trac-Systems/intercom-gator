// R-app review proof, inverted into a regression test: the agentPosting gate against an agent that has a shell.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fixture } from '../fixtures.js';
import { readToken } from '../../src/local.js';

const binary = fileURLToPath(new URL('../../../../bin/gator.js', import.meta.url));
const cli = new URL('../../src/cli.js', import.meta.url).href;
const exec = promisify(execFile);

test('R-APP-06: a non-interactive agent cannot obtain an owner credential via `gator open`', async t => {
  const app = await fixture(t).start('gate');
  // Exactly what an agent with a shell tool runs: no TTY on stdin/stdout.
  const run = async (...words) => (await exec(process.execPath, [binary, '--data', app.dataDir, ...words],
    { timeout: 10_000 })).stdout.trim();
  await assert.rejects(run('post', 'blocked'), e => e.stderr.includes('agent posting is disabled'));
  // 1. Asking for the link to be printed is refused without a terminal, before any credential is touched.
  await assert.rejects(run('open', '--print'), e => e.stdout === '' && /interactive terminal/.test(e.stderr));
  // 2. Plain `open` in the same non-TTY child (browser launch stubbed so no app starts) prints nothing usable.
  const code = `import { main } from ${JSON.stringify(cli)};
    await main(JSON.parse(process.argv[1]), { launch: async () => {} });`;
  const argv = JSON.stringify(['--data', app.dataDir, 'open']);
  const { stdout, stderr } = await exec(process.execPath, ['--input-type=module', '-e', code, argv],
    { timeout: 10_000, cwd: fileURLToPath(new URL('../../../../', import.meta.url)) });
  const output = stdout + stderr;
  assert.doesNotMatch(output, /auth\?t=/);
  assert.ok(!output.includes(readToken(app.dataDir, 'dashboard-token')));
  // The attack step: try every token-shaped word the agent saw as an owner bearer.
  const candidates = output.match(/[A-Za-z0-9_-]{32,}/g) ?? [];
  for (const owner of [...candidates, readToken(app.dataDir, 'api-token')]) {
    const res = await fetch('http://127.0.0.1:' + app.port + '/api/v1/settings', { method: 'PUT',
      headers: { Authorization: 'Bearer ' + owner, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentPosting: true }) });
    assert.ok([401, 403].includes(res.status), 'settings changed with ' + owner.slice(0, 4));
  }
  // The agent's own bearer cannot mint a sign-in ticket either.
  const ticket = await fetch('http://127.0.0.1:' + app.port + '/api/v1/login-ticket', { method: 'POST',
    headers: { Authorization: 'Bearer ' + readToken(app.dataDir), 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(ticket.status, 403);
  assert.equal(app.config.agent.agentPosting, false);
  await assert.rejects(run('post', 'posted', 'without', 'the', 'owner'), e => e.stderr.includes('agent posting is disabled'));
});
