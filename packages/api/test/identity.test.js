// One identity, several harnesses: gator's card edit uses the shared rules, and `gator key export` hands the
// identity with its newest signed card to `gator-social key import`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { main as social } from '@gator/social-addon';
import { editedCard } from '../src/config.js';
import { httpClient } from '../src/client.js';
import { main } from '../src/cli.js';
import { fixture } from './fixtures.js';

const key = 'a'.repeat(64);

test('editedCard: links and proofs are editable, other harnesses\' tags stay, messages name the field', () => {
  const old = { handle: 'atlas', harnesses: ['dex'], links: ['https://a.example/'] };
  assert.deepEqual(editedCard(old, { name: 'Atlas', dns: 'atlas.example' }, key),
    { handle: 'atlas', name: 'Atlas', harnesses: ['dex', 'gator'], links: ['https://a.example/'], proofs: { dns: 'atlas.example' } });
  assert.deepEqual(editedCard(old, { links: [] }, key).links, undefined);
  assert.deepEqual(editedCard(old, { links: ['https://b.example/'] }, key).links, ['https://b.example/']);
  assert.throws(() => editedCard(old, { links: ['javascript:alert(1)'] }, key), /links: at most 4/);
  assert.throws(() => editedCard(old, { github: '-x-' }, key), /github: a GitHub user/);
  assert.throws(() => editedCard(old, { handle: 'No Way' }, key), /handle: 2–24/);
  assert.throws(() => editedCard(old, { name: 'x'.repeat(81) }, key), /name: one line/);
});

test('gator key export → gator-social key import: same key, same card, product tag added on run', async t => {
  const app = await fixture(t).start('node');
  const owner = httpClient(app.dataDir, { owner: true });
  await owner('PUT', '/settings', {}, { card: { handle: 'atlas', name: 'Atlas', bio: 'maker', dns: 'atlas.example',
    links: ['https://atlas.example/'] } });
  const me = await owner('GET', '/me');
  assert.deepEqual(me.links, ['https://atlas.example/']);
  assert.deepEqual(me.harnesses, ['gator']);
  const out = join(app.dataDir, '..', 'atlas.identity.json');
  const lines = [], log = line => lines.push(line);
  await assert.rejects(main(['key', 'export', '--data', app.dataDir, '--out', out], { log }), /Add --yes/);
  await main(['key', 'export', '--data', app.dataDir, '--out', out, '--yes'], { log });
  const printed = JSON.parse(lines.at(-1));
  assert.equal(printed.exported, true);
  assert.equal(printed.publicKey, app.transport.publicKey);
  assert.equal(printed.card, true);
  if (process.platform !== 'win32') assert.equal(statSync(out).mode & 0o777, 0o600);
  const secret = JSON.parse(readFileSync(join(app.dataDir, 'keys', 'peer.json'), 'utf8')).ciphertext;
  assert.ok(!lines.join('\n').includes(secret), 'the secret is never printed');
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).keystore.ciphertext, secret);
  await assert.rejects(main(['key', 'export', '--data', app.dataDir, '--out', out, '--yes'], { log }), /exists/);

  const dir = join(app.dataDir, '..', 'addon');
  const written = [];
  const io = { stdout: { write: s => written.push(s) }, stderr: { write: s => written.push(s) } };
  assert.equal(await social(['key', 'import', out, '--data', dir, '--yes'], io), 0);
  const imported = JSON.parse(written.join(''));
  assert.equal(imported.publicKey, app.transport.publicKey);
  assert.deepEqual(imported.card, { handle: 'atlas', name: 'Atlas', bio: 'maker', harnesses: ['gator'],
    links: ['https://atlas.example/'], proofs: { dns: 'atlas.example' } });
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  assert.equal(config.card.handle, 'atlas');
  assert.equal(config.identity.from, 'gator');
});
