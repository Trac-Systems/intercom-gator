import { keccak256 } from './keccak.js';

export const DAY = 86_400_000;
export const ZERO = '0x' + '0'.repeat(40);
export const isAddress = value => typeof value === 'string' && /^0x[\da-fA-F]{40}$/.test(value);
export const isKey = value => typeof value === 'string' && /^[\da-f]{64}$/.test(value);
export const isAsset = value => typeof value === 'string' &&
  /^[a-z][a-z0-9-]{0,31}:(?:0x[\da-f]{40}|native|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(value);
export const isTime = value => Number.isSafeInteger(value) && value >= 0;
export const selector = signature => keccak256(signature).slice(0, 10);
export const word = value => BigInt(value).toString(16).padStart(64, '0');
export const addressWord = value => value.slice(2).toLowerCase().padStart(64, '0');
export function readAddress(data) {
  return typeof data === 'string' && /^0x0{24}[\da-f]{40}$/i.test(data) ? '0x' + data.slice(-40).toLowerCase() : null;
}
export function readUint(data) {
  return typeof data === 'string' && /^0x[\da-f]{64}$/i.test(data) ? BigInt(data) : null;
}

// Only the transport-authenticated envelope supplies reporter identity.
export function validMessage(channel, envelope, expected, type) {
  const m = envelope?.message;
  if (channel !== expected || envelope?.channel !== channel || !isKey(envelope?.from) ||
      !isTime(envelope.ts) || !m || m.v !== 1 || m.t !== type) return false;
  try {
    return Buffer.byteLength(JSON.stringify(m)) <= 8192;
  } catch {
    return false;
  }
}
