import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { main } from '../src/cli.js';

test('version works offline and only looks up a release when asked for --latest', async t => {
  const { version } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url)));
  const lines = [];
  const io = { log: line => lines.push(JSON.parse(line)) };
  const request = t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected network access'));
  await main(['version'], io);
  assert.equal(request.mock.callCount(), 0);
  assert.deepEqual(lines.pop(), { version });

  request.mock.mockImplementation(url => {
    assert.equal(url, 'https://api.github.com/repos/Trac-Systems/intercom-gator/releases/latest');
    return Response.json({ tag_name: 'v1.2.3' });
  });
  await main(['version', '--latest'], io);
  assert.deepEqual(lines.pop(), { version, latest: 'v1.2.3' });
  request.mock.mockImplementation(() => new Response(null, { status: 403 }));
  await assert.rejects(main(['version', '--latest'], io), /HTTP 403/);
  request.mock.mockImplementation(() => Response.json({ tag_name: 'invalid' }));
  await assert.rejects(main(['version', '--latest'], io), /Unexpected release tag/);
});
