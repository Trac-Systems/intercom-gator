import { ROOT_KEY } from '@gator/bundle/src/root-key.js';
import { channelPolicy, MAX_FRAME_BYTES } from '../vendor/intercom-sidechannel/channel-options.js';

const keyHex = /^[a-f0-9]{64}$/;
const product = /^(dex|reset|dmw|gator)$/;

/** @typedef {{ownerKey?: string, ownerWriteOnly?: boolean, verifySignature?: boolean,
 * maxReceiveBytes?: number, powDifficulty?: number, powBitsPerKiB?: number}} ChannelPolicy */

function owner(key, maxReceiveBytes) {
  if (typeof key !== 'string' || !keyHex.test(key)) throw new TypeError('Invalid channel owner key');
  return { ownerKey: key, ownerWriteOnly: true, verifySignature: true, maxReceiveBytes };
}

function open(maxReceiveBytes, powDifficulty) {
  return { verifySignature: true, maxReceiveBytes, powDifficulty };
}

/** @returns {ChannelPolicy} DESIGN §5 defaults. Invalid names in the reserved namespaces fail closed. */
export function policyFor(channel, { rootKey = ROOT_KEY } = {}) {
  if (typeof channel !== 'string' || !channel || channel.trim() !== channel || Buffer.byteLength(channel) > 256) {
    throw new TypeError('Invalid channel name');
  }
  if (channel === 'gator/ctl') return owner(rootKey, 65536);
  if (channel === 'soc/official') return owner(rootKey, 4096);
  // Rare, long-lived messages carry more work: 16 bits, the vendored Intercom maximum.
  if (channel === 'soc/dir') return open(4096, 16);
  if (channel === 'soc/all') return open(4096, 12);
  if (channel === 'gator/new') return open(8192, 16);
  if (channel === 'gator/pools/1') return open(8192, 10);
  if (channel === 'gator/meta') return open(8192, 10);
  if (/^gator\/px\/(?:[0-9]|1[0-5])$/.test(channel)) return { ...open(16384, 8), powBitsPerKiB: 1 };
  const [space, kind, id, ...extra] = channel.split('/');
  if (space === 'soc' && !extra.length) {
    if (kind === 'p' && product.test(id)) return owner(rootKey, 4096);
    if (kind === 'pr' && product.test(id)) return open(2048, 12);
    if (kind === 'u' && keyHex.test(id)) return owner(id, 4096);
    if (kind === 'r' && keyHex.test(id)) return open(2048, 12);
  }
  if (space === 'soc' || space === 'gator') throw new RangeError('Unknown application channel');
  return { verifySignature: true, maxReceiveBytes: MAX_FRAME_BYTES };
}

// Runtime policies may tighten caps and supply the application's trusted root.
export function joinPolicy(channel, options = {}, rootKey, skipPow = false) {
  const requested = channelPolicy(channel, options) ?? {};
  const defaults = policyFor(channel, { rootKey: requested.ownerKey ?? rootKey });
  const result = {
    ...defaults, ...requested, verifySignature: true,
    maxReceiveBytes: Math.min(defaults.maxReceiveBytes, requested.maxReceiveBytes ?? MAX_FRAME_BYTES),
  };
  if (defaults.ownerWriteOnly) {
    result.ownerWriteOnly = true;
    result.ownerKey = defaults.ownerKey;
  }
  if (skipPow) {
    result.powDifficulty = 0;
    delete result.powBitsPerKiB;
  }
  return result;
}
