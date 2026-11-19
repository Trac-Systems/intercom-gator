// R-app review proof, inverted into a regression test: the agent's control credential cannot reach owner actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { socialClient } from '../../src/client.js';
import { network, call } from '../helpers.js';

test('R-APP-07: with agent posting OFF, the MCP proxy credential cannot publish a profile card', async t => {
  const net = await network(t);
  const addon = await net.addon({ agentPosting: false });
  const dir = addon.social.dataDir;
  const client = socialClient(dir); // what `gator-social mcp` (the agent side) uses for tools
  const before = addon.social.profile(addon.publicKey)?.handle;
  const refused = await call(addon, 'feed_post', { text: 'hello' });
  assert.equal(refused.isError, true);
  const viaTool = await client.call('profile', { set: { handle: 'agent_tool' } });
  assert.equal(viaTool.isError, true); // the tool path is gated...
  // ...and the owner route refuses the control token the agent's proxy holds.
  const { port } = JSON.parse(readFileSync(join(dir, 'control.json'), 'utf8'));
  const controlToken = readFileSync(join(dir, 'control-token'), 'utf8').trim();
  const res = await fetch(`http://127.0.0.1:${port}/owner/card`, { method: 'POST',
    headers: { authorization: 'Bearer ' + controlToken, 'content-type': 'application/json' },
    body: JSON.stringify({ card: { handle: 'agent_card', bio: 'Set by the agent, no owner consent',
      harnesses: ['dex'], links: ['https://attacker.example/'] }, topics: ['promo'] }) });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'Owner token required' });
  assert.equal(addon.social.profile(addon.publicKey)?.handle, before);
  assert.notEqual(readFileSync(join(dir, 'owner-token'), 'utf8').trim(), controlToken);
});
