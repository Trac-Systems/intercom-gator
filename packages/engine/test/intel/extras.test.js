import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from '../../src/intel/keccak.js';
import { contentHash, createExtrasVerifier, decodeCurrent, EXTRAS_INTERVAL_MS } from '../../src/intel/extras.js';

const addr = '0x' + '1'.repeat(40), candidate = { slot: 'promoted-token', assetId: 'ethereum:native' };
const digest = '0x8305e045a079a3a07307e6ff04bc0c0e9864a3eaad3e98a0672c08e75028a884';
const word = n => BigInt(n).toString(16).padStart(64, '0');
const empty = '0x' + word(32) + word(0);
function response(hash = digest, start = 1000, end = 9000) {
  return '0x' + [32, 1, 7, addr, hash, start, end, 2n ** 240n].map(word).join('');
}

test('Ethereum Keccak vectors, including the exact sponge rate', () => {
  assert.equal(keccak256(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256(Buffer.from('abc')), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(keccak256('a'.repeat(136)), '0xa6c4d403279fe3e0af03729caada8374b5ca54d8065329a3ebcaeb4b60aa386e');
});

test('content identity is domain separated and follows the UTF-8 preimages', () => {
  assert.equal(contentHash(candidate.slot, candidate), digest);
  assert.equal(contentHash('spotlight', candidate), keccak256('gator:spotlight:ethereum:native'));
  const authorKey = 'a'.repeat(64);
  assert.equal(contentHash('pinned-news', { authorKey, envelopeId: 'abc' }), keccak256('gator:pinned-news:' + authorKey + ':abc'));
  assert.throws(() => contentHash('pinned-news', candidate));
});

test('ABI decoding bounds the offset, capacity, timestamps and tuple size', () => {
  assert.deepEqual(decodeCurrent(empty, 1), []);
  assert.equal(decodeCurrent(response(), 0)[0].price, String(2n ** 240n));
  for (const bad of [empty + word(1), '0x' + word(64) + word(0), response().slice(0, -2),
    response(digest, 10, 10), response(digest, 1, 2n ** 64n)]) assert.throws(() => decodeCurrent(bad, 0));
});

test('only the right slot, match, deployment and half-open interval are eligible', async () => {
  let time = 1_000_000;
  const calls = [], bundle = { paidExtras: { eth: addr, base: '', arb: null } };
  const rpc = { async call(...args) {
    calls.push(args);
    const n = Number(BigInt('0x' + args[2][0].data.slice(10)));
    return n === 1 ? empty : response();
  } };
  const verifier = createExtrasVerifier({ bundle, rpc, now: () => time });
  await Promise.all([verifier.start(), verifier.refresh()]);
  verifier.stop();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], ['eth', 'eth_call', [{ to: addr, data: '0x94d5a979' + word(0) }, 'latest']]);
  assert.equal(verifier.active([candidate, candidate]).length, 1);
  assert.equal(verifier.active([candidate])[0].label, 'Promoted');
  assert.deepEqual(verifier.active([{ ...candidate, slot: 'spotlight' }]), []);
  time += EXTRAS_INTERVAL_MS;
  assert.deepEqual(verifier.active([candidate]), []);
  time = 9_000_000;
  await verifier.refresh();
  assert.deepEqual(verifier.active([candidate]), []);
  time = 1_000_000;
  await verifier.refresh();
  bundle.paidExtras.eth = '';
  assert.deepEqual(verifier.active([candidate]), []);
});

test('failed or dormant contracts yield no active purchases', async () => {
  let calls = 0, fail = false;
  const bundle = { paidExtras: { eth: '' } };
  const verifier = createExtrasVerifier({ bundle, now: () => 1_002_000, rpc: {
    async call() { calls++; if (fail) throw Error('offline'); return response(); },
  } });
  await verifier.refresh();
  assert.equal(calls, 0);
  bundle.paidExtras.eth = addr;
  await verifier.refresh();
  assert.equal(verifier.active([candidate]).length, 1);
  fail = true;
  await verifier.refresh();
  assert.deepEqual(verifier.active([candidate]), []);
});

test('Purchased decoding rejects malformed, reverted and unrelated logs without treating them as purchases', async () => {
  const { purchasedLogs } = await import('../../src/intel/extras.js');
  const txHash = '0x' + word(42), signature = keccak256('Purchased(bytes32,uint8,uint8,address,bytes32,uint256,uint256,uint256)');
  const log = { address: addr, topics: [signature,'0x' + word(3),'0x' + word(1),'0x' + word(addr)],
    data: '0x' + [1, digest, 1000, 2000, 2n ** 200n].map(word).join('') };
  const receipt = { transactionHash: txHash, status:'0x1', logs:[log] };
  assert.equal(purchasedLogs(receipt, txHash, addr)[0].price, String(2n ** 200n));
  for (const invalid of [null, { ...log, address:1 }, { ...log, topics:[1,2,3,4] }, { ...log, transactionHash:1 },
    { ...log, removed:true }, { ...log, data:log.data.slice(0,-2) },
    { ...log, data:'0x' + [2, digest, 1000, 2000, 1].map(word).join('') }]) {
    assert.deepEqual(purchasedLogs({ ...receipt, logs:[invalid] },txHash,addr),[]);
  }
  assert.deepEqual(purchasedLogs({ ...receipt, status:'0x0' },txHash,addr),[]);
  assert.deepEqual(purchasedLogs(receipt,'0x' + word(41),addr),[]);
});
