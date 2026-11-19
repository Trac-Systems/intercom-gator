// The file that carries one identity from one harness to another (`gator key export` → `gator-social key import`).
// It holds the secret keystore (Intercom keystore, empty password: the 0600 file is the only protection) and the
// identity's newest signed card and directory announcement, so the importing harness adopts the profile (handle,
// name, avatar, links, proofs, topics) instead of starting a blank one. The card copies are public and signed.
import { isKey } from './policy.js';
import { validEnvelope } from './validate.js';

export const IDENTITY_FORMAT = 'intercom-gator/identity';
const MAX_BYTES = 64 * 1024;

/** @param {{publicKey:string, keystore:object, card?:object|null, announce?:object|null, harness?:string}} parts */
export function identityDocument({ publicKey, keystore, card = null, announce = null, harness }) {
  if (!isKey(publicKey)) throw new TypeError('Expected a public key');
  if (!keystore || typeof keystore !== 'object' || Array.isArray(keystore)) throw new TypeError('Expected a keystore');
  return { format: IDENTITY_FORMAT, v: 1, publicKey, ...(harness && { from: harness }), keystore,
    ...(card && { card }), ...(announce && { announce }) };
}

/**
 * Parse and check an identity file. Signed card copies must verify for this key; a bad copy is dropped, not fatal.
 * The keystore itself is checked by the importer (it must decrypt to `publicKey`).
 * @param {string} text @param {string} rootKey
 * @returns {{publicKey:string, keystore:object, from?:string, card:object|null, topics:string[]|null, cardTs:number|null}}
 */
export function readIdentityDocument(text, rootKey) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) throw new TypeError('Not an identity file');
  let doc;
  try { doc = JSON.parse(text); } catch { throw new TypeError('Not an identity file'); }
  if (doc?.format !== IDENTITY_FORMAT || doc.v !== 1 || !isKey(doc.publicKey) || !doc.keystore ||
      typeof doc.keystore !== 'object' || Array.isArray(doc.keystore)) {
    throw new TypeError('Not an identity file (expected the output of gator key export)');
  }
  const own = 'soc/u/' + doc.publicKey;
  const signed = (envelope, channel, type) => envelope?.from === doc.publicKey && envelope.message?.t === type &&
    validEnvelope(channel, envelope, rootKey) ? envelope : null;
  const card = signed(doc.card, own, 'card');
  const announce = signed(doc.announce, 'soc/dir', 'announce');
  // The newer signed card wins; the announcement carries the directory topics.
  const latest = [card && { ts: card.ts, card: (({ t, v, ...rest }) => rest)(card.message) },
    announce && { ts: announce.ts, card: announce.message.card }].filter(Boolean).sort((a, b) => b.ts - a.ts)[0];
  return { publicKey: doc.publicKey, keystore: doc.keystore, ...(typeof doc.from === 'string' && { from: doc.from.slice(0, 32) }),
    card: latest?.card ?? null, cardTs: latest?.ts ?? null, topics: announce ? announce.message.topics : null };
}
