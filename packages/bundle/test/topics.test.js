import assert from 'node:assert/strict';
import test from 'node:test';
import { loadBundle } from '../src/index.js';

// Keccak-f[1600], 24 rounds. Lanes are little-endian; index is x + 5*y.
const rotations = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39,
  41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];
const constants = [
  0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n,
  0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn,
  0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x800an,
  0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n,
  0x80000001n, 0x8000000080008008n,
];
function rotate(lane, amount) {
  const n = BigInt(amount);
  return BigInt.asUintN(64, (lane << n) | (lane >> (64n - n)));
}
function permute(state) {
  for (const rc of constants) {
    const parity = Array(5).fill(0n);
    for (let i = 0; i < 25; i++) parity[i % 5] ^= state[i];
    const b = Array(25);
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = x + 5 * y;
        const theta = parity[(x + 4) % 5] ^ rotate(parity[(x + 1) % 5], 1);
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotate(state[i] ^ theta, rotations[i]);
      }
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const row = 5 * y;
        state[row + x] = b[row + x] ^ (~b[row + (x + 1) % 5] & b[row + (x + 2) % 5]);
      }
    }
    state[0] ^= rc;
  }
}
function keccak256(text) {
  const input = Buffer.from(text);
  const rate = 136;
  const padded = Buffer.alloc(Math.ceil((input.length + 1) / rate) * rate);
  input.copy(padded);
  padded[input.length] = 0x01;
  padded[padded.length - 1] |= 0x80;
  const state = Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate / 8; i++) state[i] ^= padded.readBigUInt64LE(offset + 8 * i);
    permute(state);
  }
  const result = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) result.writeBigUInt64LE(state[i], i * 8);
  return '0x' + result.toString('hex');
}
test('Ethereum Keccak-256 vectors and every published event topic', () => {
  assert.equal(keccak256(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256('Transfer(address,address,uint256)'),
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
  for (const event of loadBundle().dex.events) assert.equal(keccak256(event.signature), event.topic0, event.id);
});
