export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const PRODUCTS = ['dex', 'reset', 'dmw', 'gator'];
// Each follow is one Intercom channel; Intercom allows 256 per peer, minus fixed, market and temporary channels.
export const FOLLOW_CAP = { small: 100, normal: 200, large: 200 };

// Each tuple is [default, hard minimum, hard maximum].
// Through v0.1.12, a root net message containing pow.public or caps.public is rejected in full.
// Omit both on mixed-version networks to change settings for all peers.
export const BOUNDS = {
  pow: { reply: [12, 8, 16], directory: [16, 12, 16], public: [12, 8, 16] },
  caps: {
    owner: [4096, 1024, 4096], official: [4096, 1024, 4096], product: [4096, 1024, 4096],
    reply: [2048, 1024, 2048], directory: [4096, 1024, 4096], public: [4096, 2048, 4096]
  },
  rates: { posts: [10, 1, 100], likes: [60, 1, 240], cards: [12, 1, 60], follows: [60, 1, 240] }
};

export function settingsFor(message = {}) {
  // relays: Hyperswarm keys of blind relays; null keeps the release's list.
  const settings = { seq: message.seq ?? -1, relayTtl: Math.max(1, Math.min(8, message.relayTtl ?? 3)),
    relays: Array.isArray(message.relays) ? [...message.relays] : null };
  for (const [group, bounds] of Object.entries(BOUNDS)) {
    settings[group] = {};
    for (const [key, [initial, min, max]] of Object.entries(bounds)) {
      settings[group][key] = Math.max(min, Math.min(max, message[group]?.[key] ?? initial));
    }
  }
  return settings;
}

export function lane(channel) {
  if (channel === 'soc/official') return 'official';
  if (channel === 'soc/dir') return 'directory';
  if (channel === 'soc/all') return 'public';
  if (typeof channel !== 'string') return null;
  const [prefix, type, name, extra] = channel.split('/');
  if (prefix !== 'soc' || extra !== undefined) return null;
  if (PRODUCTS.includes(name) && type === 'p') return 'product';
  if (PRODUCTS.includes(name) && type === 'pr') return 'reply';
  if (!isKey(name)) return null;
  return type === 'u' ? 'owner' : type === 'r' ? 'reply' : null;
}

export const isKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && value.length === 64;

export function policyFor(channel, rootKey, settings) {
  const kind = lane(channel);
  if (!kind) throw new TypeError('Unknown social channel');
  const policy = { verifySignature: true, maxReceiveBytes: settings.caps[kind] };
  if (Object.hasOwn(settings.pow, kind)) return { ...policy, powDifficulty: settings.pow[kind] };
  return { ...policy, ownerWriteOnly: true, ownerKey: kind === 'owner' ? channel.slice(6) : rootKey };
}
