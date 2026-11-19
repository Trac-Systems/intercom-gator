// SPDX-License-Identifier: MIT
// Keccak-f[1600], little-endian lanes, 1088-bit rate and Ethereum's 0x01 suffix.
const rotations = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];
const rounds = [
  0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an,
  0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n,
];

function rotate(lane, bits) {
  return BigInt.asUintN(64, lane << BigInt(bits)) | (lane >> BigInt(64 - bits));
}

function permute(state) {
  const columns = Array(5), lanes = Array(25);
  for (const round of rounds) {
    for (let x = 0; x < 5; x++) {
      columns[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = x + 5 * y;
        const theta = columns[(x + 4) % 5] ^ rotate(columns[(x + 1) % 5], 1);
        lanes[y + 5 * ((2 * x + 3 * y) % 5)] = rotate(state[i] ^ theta, rotations[i]);
      }
    }
    for (let i = 0; i < 25; i++) {
      const row = i - i % 5;
      state[i] = lanes[i] ^ (~lanes[row + (i + 1) % 5] & lanes[row + (i + 2) % 5]);
    }
    state[0] ^= round;
  }
}

/** Ethereum Keccak-256 of a UTF-8 string or raw bytes, as 0x-prefixed hex.
 * @param {string | Uint8Array} input */
export function keccak256(input) {
  const bytes = Buffer.from(input);
  const rate = 136;
  const padded = Buffer.alloc((Math.floor(bytes.length / rate) + 1) * rate);
  bytes.copy(padded);
  padded[bytes.length] = 1;
  padded[padded.length - 1] |= 128;
  const state = Array(25).fill(0n);
  for (let block = 0; block < padded.length; block += rate) {
    for (let i = 0; i < rate / 8; i++) state[i] ^= padded.readBigUInt64LE(block + i * 8);
    permute(state);
  }
  const digest = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) digest.writeBigUInt64LE(state[i], i * 8);
  return '0x' + digest.toString('hex');
}
