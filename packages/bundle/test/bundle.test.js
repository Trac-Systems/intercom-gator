import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  applyPatch, bundleDigest, canonical, loadBundle, patchDigest, selectEndpoints,
  signBundle, signPatch, validateBundle, verifyBundleSignature,
} from '../src/index.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
const root = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
const bundle = loadBundle({ rootPubKeyHex: root });
const baseDigest = bundleDigest(bundle);

function issue(base, ops, result) {
  const patch = { baseDigest: bundleDigest(base), ops, newDigest: bundleDigest(result) };
  return { ...patch, signature: signBundle(patchDigest(patch), seed) };
}

test('shipped datasets validate and are deeply immutable', () => {
  assert.equal(validateBundle(bundle), bundle);
  assert.throws(() => { bundle.chains[0].endpoints[0].verified.ok = false; }, TypeError);
  assert.throws(() => bundle.tokens.tokens[0].links.push('other:native'), TypeError);
  assert.ok(bundle.exchanges.length >= 40);
  assert.ok(bundle.tokens.tokens.length >= 500);
  assert.ok(bundle.chains.some(c => c.chainId === 4663 && c.family === 'evm'));
});

test('strict nested schemas and cross-file references', () => {
  for (const [edit, expected] of [
    [b => { delete b.exchanges[0].terms.note; }, /terms.*missing note/],
    [b => { b.exchanges[0].tickers.mapping.fields.vol = 'volume'; }, /unknown field/],
    [b => { b.apis[0].terms.redistribution = 'public'; }, /redistribution/],
    [b => { b.chains[0].endpoints[0].url = 'file:///cache'; }, /HTTPS|https/],
    [b => { b.chains[0].endpoints[0].verified.date = '2025-02-29'; }, /ISO/],
    [b => { b.chains[0].endpoints[0].verified = { ok: true, date: '2026-01-01', result: '0x0' }; }, /chain ID mismatch/],
    [b => { b.chains[1].chainId = b.chains[0].chainId; }, /duplicate/],
    [b => { b.dex.evm[0].deployments[0].kind = 'unknown'; }, /pool kind/],
    [b => { delete b.paidExtras.ethereum; }, /missing ethereum/],
    [b => { b.paidExtras.custom = ''; }, /unknown field custom/],
    [b => { b.paidExtras.solana = b.dex.evm[0].deployments[0].address; }, /requires EVM/],
    [b => { b.paidExtras.ethereum = '0x' + '0'.repeat(40); }, /zero contract/],
    [b => { delete b.dex.evm[0].deployments.find(d => d.router).routerKind; }, /supplied together/],
    [b => { b.dex.evm[0].deployments.find(d => d.routerKind === 'v2').routerKind = 'v3'; }, /disagrees/],
    [b => { b.dex.evm[0].lockers.push(b.dex.evm[0].lockers[0]); }, /duplicate/],
    [b => { b.tokens.tokens[0].website = 'file:///token'; }, /https/],
    [b => { b.dex.evm[0].quoteTokens[0].decimals = 300; }, /decimals/],
    [b => { b.dex.solana[0].api = 'unknown'; }, /pool API/],
    [b => { b.tokens.tokens[0].links = ['invalid:native']; }, /link/],
    [b => { b.tokens.tokens.find(t => t.coin).coin = 'unknown-coin'; }, /coin/],
    [b => { delete b.tokens.tokens.find(t => t.coin).coinSupply; }, /coin/],
    [b => { b.tokens.tokens.find(t => t.coin).coinSupply = 'mint'; }, /coinSupply/],
    [b => { b.tokens.coinGroups[0].source = 'http://issuer.invalid'; }, /https/],
    [b => { for (const t of b.tokens.tokens.filter(t => t.coin === 'tether-usdt')) t.coinSupply = 'escrow-backed'; },
      /issuance member/],
    [b => { b.tokens.tokens.push({
      id: 'sui:0x1::module', name: 'Example', symbol: 'EX', decimals: 9, source: 'protocol-native', links: [],
    }); }, /Sui coin type/],
    [b => { b.tokens.tokens[0].source = 'unknown'; }, /source/],
    [b => { b.tokens.sources.find(s => s.url).license = null; }, /license references/],
    [b => { b.tokens.tokens[0].unexpected = true; }, /unknown field/],
  ]) {
    const detached = structuredClone(bundle);
    edit(detached);
    assert.throws(() => validateBundle(detached), expected);
  }
});

test('CEX-only chains carry an unambiguous signed native currency without an RPC', () => {
  const zec = bundle.chains.find(c => c.id === 'zcash');
  assert.equal(zec.family, 'cex-only');
  assert.equal(zec.chainId, null);
  assert.deepEqual(zec.endpoints, []);
  assert.ok(bundle.tokens.tokens.some(t => t.id === 'zcash:native' && t.symbol === zec.native.symbol));
  for (const [edit, expected] of [
    [(c, b) => c.endpoints.push(b.chains[0].endpoints[0]), /RPC endpoints/],
    [c => { c.native.symbol = 'BTC'; }, /ambiguous/],
    [(c, b) => { b.tokens.tokens.find(t => t.id === 'zcash:native').id = 'zcash:peg'; }, /native identity only/],
  ]) {
    const b = structuredClone(bundle);
    edit(b.chains.find(c => c.id === 'zcash'), b);
    assert.throws(() => validateBundle(b), expected);
  }
});

test('canonical JSON orders object keys by code unit and preserves array order', () => {
  assert.equal(canonical({ z: 1, 2: 2, 10: 10, n: [0, { b: 4, a: 3 }] }),
    '{"10":10,"2":2,"n":[0,{"a":3,"b":4}],"z":1}');
  assert.notEqual(canonical([1, 2]), canonical([2, 1]));
  assert.equal(canonical([-0, null, '🌍']), '[0,null,"🌍"]');
  const cycle = [];
  cycle.push(cycle);
  for (const bad of [undefined, 1n, NaN, Infinity, new Date(), Array(2), cycle, { get n() { return 1; } }]) {
    assert.throws(() => canonical(bad), TypeError);
  }
});

test('digest is independent of formatting, member order and file creation order', t => {
  const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.data-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const names = ['exchanges', 'chains', 'dex', 'tokens', 'apis', 'paidExtras'];
  for (const name of names.toReversed()) writeFileSync(join(dir, name + '.json'), canonical(bundle[name]));
  assert.equal(bundleDigest(loadBundle({ dir })), baseDigest);
  assert.equal(bundleDigest(), baseDigest);
  const wire = canonical(names.map(name => [name + '.json', bundle[name]]));
  assert.equal(baseDigest, createHash('sha256').update(wire).digest('hex'));
  const changed = structuredClone(bundle);
  changed.chains.reverse();
  assert.notEqual(bundleDigest(changed), baseDigest);
  writeFileSync(join(dir, 'chains.json'), '{}');
  assert.throws(() => loadBundle({ dir }), /bundle.chains/);
});

test('old five-file digests still verify and a signed patch can activate one dormant chain', t => {
  const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.data-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const names = ['exchanges', 'chains', 'dex', 'tokens', 'apis'];
  for (const name of names) writeFileSync(join(dir, name + '.json'), canonical(bundle[name]));
  const archived = loadBundle({ dir, rootPubKeyHex: root });
  const oldWire = canonical(names.map(name => [name + '.json', archived[name]]));
  const oldDigest = createHash('sha256').update(oldWire).digest('hex');
  assert.ok(verifyBundleSignature(bundleDigest(archived), signBundle(oldDigest, seed), root));
  const dormantMap = Object.fromEntries(Object.keys(bundle.paidExtras).map(chain => [chain, '']));
  const addMap = [{ op: 'add', path: '/paidExtras', value: dormantMap }];
  const dormant = applyPatch(archived, issue(archived, addMap, { ...archived, paidExtras: dormantMap }));
  assert.deepEqual(Object.keys(dormant.paidExtras).sort(), bundle.chains.filter(c => c.family !== 'cex-only').map(c => c.id).sort());
  assert.ok(Object.values(dormant.paidExtras).every(value => value === ''));
  const next = structuredClone(dormant);
  next.paidExtras.ethereum = '0x' + '1'.repeat(40);
  const ops = [{ op: 'replace', path: '/paidExtras/ethereum', value: next.paidExtras.ethereum }];
  assert.deepEqual(applyPatch(dormant, issue(dormant, ops, next)).paidExtras, next.paidExtras);
  assert.equal(verifyBundleSignature(bundleDigest(next), signBundle(bundleDigest(dormant), seed), root), false);
});

test('raw Ed25519 keys and binary digest interoperate with node:crypto', () => {
  const signature = signBundle(baseDigest, seed.toString('hex'));
  assert.ok(verify(null, Buffer.from(baseDigest, 'hex'), publicKey, Buffer.from(signature, 'hex')));
  assert.ok(verifyBundleSignature(baseDigest, signature, root));
  for (const args of [
    ['00'.repeat(32), signature, root], [baseDigest, '99'.repeat(64), root],
    [baseDigest, signature, '00'.repeat(32)], [baseDigest, signature + '00', root],
    ['x'.repeat(64), signature, root], [baseDigest, signature, 'ab'],
  ]) assert.equal(verifyBundleSignature(...args), false);
  assert.throws(() => signBundle(baseDigest, seed.subarray(0, 31)));
});

test('signed add, replace and remove apply atomically and preserve the trusted root', () => {
  const draft = structuredClone(bundle);
  const newApi = { ...structuredClone(draft.apis[0]), id: 'price-history' };
  const ops = [
    { op: 'add', path: '/apis/-', value: newApi },
    { op: 'replace', path: '/apis/0/name', value: 'New name' },
    { op: 'remove', path: '/apis/1' },
  ];
  draft.apis.push(newApi);
  draft.apis[0].name = 'New name';
  draft.apis.splice(1, 1);
  const patch = issue(bundle, ops, draft);
  const result = applyPatch(bundle, patch);
  assert.equal(bundleDigest(result), patch.newDigest);
  assert.equal(bundleDigest(bundle), baseDigest);
  assert.ok(Object.isFrozen(result.apis.at(-1).terms));
  assert.equal(bundleDigest(applyPatch(result, issue(result, [], result))), patch.newDigest);
  assert.throws(() => applyPatch(result, patch), /base digest/);
  patch.ops[0].value.name = 'Detached';
  assert.notEqual(result.apis.at(-1).name, 'Detached');
});

test('signature binds both digests and every operation; caller supplies trust', () => {
  const patch = issue(bundle, [], bundle);
  assert.throws(() => applyPatch(bundle, { ...patch, baseDigest: '0'.repeat(64) }), /base digest/);
  assert.throws(() => applyPatch(bundle, { ...patch, signature: '0'.repeat(128) }), /signature/);
  assert.throws(() => applyPatch(bundle, { ...patch, newDigest: '0'.repeat(64) }), /signature/);
  assert.throws(() => applyPatch(bundle, { ...patch, ops: [{ op: 'remove', path: '/apis/0' }] }), /signature/);
  assert.throws(() => applyPatch(bundle, { ...patch, rootPubKeyHex: root }), /envelope/);
  assert.throws(() => applyPatch(loadBundle(), patch), /trusted root/);
  assert.throws(() => applyPatch(bundle, patch, '00'.repeat(32)), /root mismatch/);
  const wrongResult = { ...patch, newDigest: '0'.repeat(64) };
  wrongResult.signature = signBundle(patchDigest(wrongResult), seed);
  assert.throws(() => applyPatch(bundle, wrongResult), /result digest/);
});

test('signPatch signs exactly what applyPatch applies and refuses invalid results', () => {
  const i = bundle.chains.findIndex(c => c.id === 'ethereum');
  const ops = [{ op: 'replace', path: '/chains/' + i + '/endpoints/0/url', value: 'https://rpc.patched.example/eth' }];
  const patch = signPatch(bundle, ops, seed);
  assert.deepEqual(Object.keys(patch), ['baseDigest', 'ops', 'newDigest', 'signature']);
  assert.equal(patch.baseDigest, baseDigest);
  assert.equal(bundleDigest(bundle), baseDigest);
  const result = applyPatch(bundle, patch);
  assert.equal(bundleDigest(result), patch.newDigest);
  assert.equal(result.chains[i].endpoints[0].url, 'https://rpc.patched.example/eth');
  ops[0].value = 'https://changed.example';
  assert.equal(patch.ops[0].value, 'https://rpc.patched.example/eth');
  assert.throws(() => signPatch(bundle, [{ op: 'remove', path: '/chains/' + i + '/endpoints/0/url' }], seed), /missing url/);
  assert.throws(() => signPatch(bundle, { op: 'add' }, seed), /operations/);
});

test('JSON Pointer escape handling and rejection of malformed paths and invalid final states', () => {
  const i = bundle.exchanges.findIndex(e => e.id === 'hyperliquid');
  const path = '/exchanges/' + i + '/tickers/body';
  const ops = [
    { op: 'add', path: path + '/a~1b~0c', value: 1 },
    { op: 'replace', path: path + '/a~1b~0c', value: 2 },
  ];
  const result = structuredClone(bundle);
  result.exchanges[i].tickers.body['a/b~c'] = 2;
  assert.equal(applyPatch(bundle, issue(bundle, ops, result)).exchanges[i].tickers.body['a/b~c'], 2);
  for (const op of [
    { op: 'remove', path: '/apis/-' }, { op: 'remove', path: '/apis/01' },
    { op: 'add', path: '/apis/99999', value: 1 }, { op: 'add', path: '/apis/-/id', value: 'bad' },
    { op: 'remove', path: '/apis/0/name/missing' }, { op: 'remove', path: path + '/a~2b' },
    { op: 'add', path: path + '/__proto__', value: {} }, { op: 'remove', path: '/apis/0/base' },
    { op: 'move', path: '/apis/0' }, { op: 'remove', path: '/chains/0', value: null },
  ]) assert.throws(() => applyPatch(bundle, issue(bundle, [op], bundle)));
  assert.equal(bundleDigest(bundle), baseDigest);
});

test('user priority, exact URL deduplication, health order, stable ties and EVM ID aliases', () => {
  const chain = bundle.chains.find(c => c.id === 'ethereum');
  const urls = chain.endpoints.map(e => e.url);
  const custom = 'http://127.0.0.1:8545';
  const config = { endpoints: { 1: [custom, urls[1], custom] }, health: { [urls[2]]: 8, [urls[0]]: -1 } };
  const expected = [custom, urls[1], urls[2], ...urls.slice(3), urls[0]];
  assert.deepEqual(selectEndpoints(bundle, 'ethereum', config), expected);
  assert.deepEqual(selectEndpoints(bundle, 1, config), expected);
  const aliases = { endpoints: { 1: [urls[0]], ethereum: [custom, urls[0]] } };
  assert.deepEqual(selectEndpoints(bundle, 'ethereum', aliases), [custom, ...urls]);
  assert.deepEqual(selectEndpoints(bundle, 1, aliases), [urls[0], custom, ...urls.slice(1)]);
  assert.deepEqual(selectEndpoints(bundle, 'ethereum'), urls);
  assert.deepEqual(selectEndpoints(bundle, 'custom', { endpoints: { custom: [custom] } }), [custom]);
  assert.deepEqual(selectEndpoints(bundle, 'unknown'), []);
  assert.throws(() => selectEndpoints(bundle, 1, { endpoints: { ethereum: ['file:///api'] } }));
});

test('CEX-only networks validate without RPCs and cannot register a token or an RPC endpoint', () => {
  const b = structuredClone(bundle), c = b.chains.find(c => c.id === 'zcash');
  assert.deepEqual(c.endpoints, []);
  assert.equal(validateBundle(b), b);
  c.endpoints.push(b.chains[0].endpoints[0]);
  assert.throws(() => validateBundle(b), /CEX-only chain/);
  c.endpoints = [];
  b.tokens.tokens.push({ id: 'zcash:invented', symbol: 'ZEC', name: 'Copy', decimals: 8, source: 'protocol-native', links: [] });
  assert.throws(() => validateBundle(b), /native identity only/);
});
