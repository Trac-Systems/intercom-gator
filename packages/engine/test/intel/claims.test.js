import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createClaimService, onchainMetadata, verifyDeployer } from '../../src/intel/claims.js';
import { selector, word } from '../../src/intel/values.js';

const f = JSON.parse(readFileSync(new URL('./fixtures/claim-recovery.json', import.meta.url)));
const { asset, value, signature } = f, deployer = '0x' + f.response.result.slice(-40);
const keys = ['a', 'b', 'c', 'd'].map(x => x.repeat(64)), channel = 'gator/meta';
const msg = (from, ts, props = {}) => ({ channel, from, ts, message: { v: 1, t: 'claim', asset, kind: 'website', value, ...props } });
const recovery = { async call(chain, method, params) {
  assert.equal(chain, 'ethereum'); assert.equal(method, 'eth_call');
  return JSON.stringify(params) === JSON.stringify(f.params) ? f.response.result : '0x';
} };

test('UTF-8 deployer proof matches independently encoded personal_sign and recorded ecrecover', async () => {
  const input = { rpc: recovery, asset, value, signature, deployer };
  assert.equal(await verifyDeployer(input), true);
  assert.equal(await verifyDeployer({ ...input, value: value + '/' }), false);
  assert.equal(await verifyDeployer({ ...input, deployer: '0x' + '1'.repeat(40) }), false);
  assert.equal(await verifyDeployer({ ...input, signature: '0x' + 'f'.repeat(130) }), false);
  const service = createClaimService({ publicRpc: recovery, getDeployer: () => deployer });
  assert.ok(await service.consume(channel, msg(keys[0], 1, { proof: { type: 'deployer', signature } })));
  assert.equal(service.list(asset)[0].trust, 'green');
});

test('one current vote per authenticated reporter and kind, with wrong reports red', async () => {
  const service = createClaimService({ now: () => 10 });
  const send = (i, t, body) => service.consume(channel, msg(keys[i], t, body));
  await send(0, 1, { reporter: keys[3], proof: { type: 'on-chain', verified: true } });
  await send(0, 1);
  await send(1, 2);
  assert.deepEqual(service.list(asset)[0], { asset, kind: 'website', value, reporters: 2, wrong: 0, verified: false, trust: 'yellow' });
  await send(2, 3);
  assert.equal(service.list(asset)[0].trust, 'green');
  await send(2, 4, { value: value + '/' });
  assert.equal(service.list(asset)[0].trust, 'yellow');
  assert.equal(await send(2, 3), false);
  await send(3, 5, { proof: { type: 'wrong' } });
  assert.equal(service.list(asset)[0].trust, 'red');
  assert.equal(await send(3, 11), false);
});

test('DNS proof binds the exact asset and URL on the project website', async () => {
  const proof = { type: 'dns' }, kind = 'docs', prefix = 'intercom-gator:' + asset + ':';
  let records = [[prefix, value]];
  const service = createClaimService({ websiteFor: () => 'https://project.example', resolveTxt(host) {
    assert.equal(host, 'project.example'); return records;
  } });
  await service.consume(channel, msg(keys[0], 1, { kind, proof }));
  assert.equal(service.list(asset)[0].trust, 'green');
  records = [[prefix], [value]];
  await service.consume(channel, msg(keys[0], 2, { kind, proof }));
  assert.equal(service.list(asset)[0].trust, 'yellow');
});

test('locally read metadata and token lists verify claims and publish wire assertions', async () => {
  const sent = [];
  const transport = { publicKey: keys[0], send(c, m) { sent.push([c, m]); return true; } };
  const service = createClaimService({ transport, bundle: { tokens: { tokens: [{ id: asset, logoURI: 'https://example.org/logo.png' }] } },
    metadataFor: () => ({ website: value, docs: 'javascript:example', supply: '0' }), now: () => 9 });
  const claims = await service.syncAutomatic(asset);
  assert.deepEqual(claims.map(r => [r.kind, r.trust]), [['logo', 'green'], ['website', 'green'], ['supply', 'green']]);
  assert.equal(sent.length, 3);
  assert.ok(await service.publish({ asset, kind: 'docs', value }));
  assert.equal(service.list(asset).at(-1).trust, 'yellow');
  assert.equal(sent.at(-1)[0], channel);
  assert.equal(sent.at(-1)[1].t, 'claim');
  assert.equal(await service.publish({ asset, kind: 'website', value: 'https://user:pass@example.org' }), false);
});

test('on-chain getters decode bounded ABI strings and preserve exact ERC-20 supply', async () => {
  const bytes = Buffer.from(value);
  const encoded = '0x' + word(32) + word(bytes.length) + bytes.toString('hex').padEnd(64 * Math.ceil(bytes.length / 32), '0');
  const table = new Map([['website()', encoded], ['logoURI()', '0x' + word(1)], ['totalSupply()', '0x' + word(505001000)], ['decimals()', '0x' + word(6)]].map(([k, v]) => [selector(k), v]));
  const rpc = { async call(_, method, params) {
    if (method === 'eth_blockNumber') return '0xf';
    assert.equal(params[1], '0xf'); return table.get(params[0].data);
  } };
  assert.deepEqual(await onchainMetadata(asset, rpc), { website: value, logo: null, supply: '505.001' });
});


test('direct contract creation receipt can establish deployer identity independently', async () => {
  const tx = '0x' + '3'.repeat(64);
  let contractAddress = asset.split(':')[1];
  const rpc = { call(chain, method, params) {
    if (method === 'eth_getTransactionReceipt') {
      assert.deepEqual(params, [tx]);
      return { transactionHash: tx, to: null, contractAddress, from: deployer, status: '0x1' };
    }
    return recovery.call(chain, method, params);
  } };
  const service = createClaimService({ publicRpc: rpc });
  const proof = { type: 'deployer', signature, tx };
  await service.consume(channel, msg(keys[0], 1, { proof }));
  assert.equal(service.list(asset)[0].verified, true);
  contractAddress = deployer;
  await service.consume(channel, msg(keys[0], 2, { proof }));
  assert.equal(service.list(asset)[0].verified, false);
});

test('an unanchored or sender-selected DNS host cannot provide project authority', async () => {
  let calls = 0;
  const service = createClaimService({ resolveTxt() { calls++; return [['intercom-gator:' + asset + ':' + value]]; } });
  await service.consume(channel, msg(keys[0], 1, { proof: { type: 'dns', domain: 'example.org' } }));
  assert.equal(service.list(asset)[0].trust, 'yellow');
  assert.equal(calls, 0);
});


test('a failed metadata RPC retains independent token-list claims', async () => {
  const service = createClaimService({ rpc: { call() { throw Error('offline'); } },
    bundle: { tokens: { tokens: [{ id: asset, website: value }] } } });
  const [row] = await service.syncAutomatic(asset);
  assert.equal(row.value, value);
  assert.equal(row.trust, 'green');
});
