import { createPublicKey, verify } from 'node:crypto';
import { isAvatar } from './avatar.js';
import { BOUNDS, isKey, lane, settingsFor } from './policy.js';

const plain = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const fields = (obj, keys) => plain(obj) && Object.keys(obj).every(key => keys.includes(key));
const list = (value, max, check) => Array.isArray(value) && value.length <= max && value.every(check);
const optional = (value, check) => value === undefined || check(value);
const seq = value => Number.isSafeInteger(value) && value >= 0;
const short = (value, max, multiline = false) => typeof value === 'string' && value.length <= max * 2 &&
  value.trim().length > 0 && [...value].length <= max && value.isWellFormed() &&
  !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value) &&
  (multiline || !/[\t\n\u2028\u2029]/u.test(value));
export const isHandle = value => short(value, 24) && /^[a-z0-9_]{2,24}$/.test(value);
export const isId = value => short(value, 192) && /^[A-Za-z0-9_.:@-]+$/.test(value);
export const isRef = ref => fields(ref, ['key', 'id']) && isKey(ref.key) && isId(ref.id);
const topic = value => short(value, 40) && /^[\p{L}\p{N}_-]+$/u.test(value);
const asset = value => short(value, 160) && /^[a-z0-9_-]+:[A-Za-z0-9._:-]+$/.test(value);
const ticker = item => fields(item, ['sym', 'asset']) && short(item.sym, 16) &&
  /^[A-Z0-9][A-Z0-9_]*$/.test(item.sym) && optional(item.asset, asset);
const domain = value => short(value, 253) && value.includes('.') && value.split('.').every(label =>
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
const githubUser = value => short(value, 39) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(value);

export function isHttpUrl(value) {
  if (!short(value, 2048) || !/^https?:\/\//i.test(value) || /[\s\\]/u.test(value)) return false;
  try { return Boolean(new URL(value).hostname); } catch { return false; }
}

// Match explicit URI schemes, including those inside Markdown link destinations.
const uri = /(?<![\p{L}\p{N}_])(?:[a-z][a-z0-9+.\-]*:(?=[^\s])|www\.|\/\/(?=[a-z0-9\[]))(?:\[[\da-f:.]+\]|[^\s<>()\[\]{}|,;\x22\x27`])*/giu;
function linkCount(text) {
  let count = 0;
  for (const [raw] of text.matchAll(uri)) {
    const url = raw.replace(/[.!?]+$/u, '');
    if (!isHttpUrl(/^www\./i.test(url) ? 'https://' + url : url)) return Infinity;
    count++;
  }
  return count;
}
export const isText = text => short(text, 500, true) && linkCount(text) <= 4;
export function extractText(text) {
  const body = text.replace(uri, ' ');
  const extract = (pattern, normalize) => [...new Set(Array.from(body.matchAll(pattern), hit => normalize(hit[1])))];
  return {
    tags: extract(/(?<![\p{L}\p{N}_])#([\p{L}\p{N}_-]{1,40})(?![\p{L}\p{N}_-])/gu, s => s.toLowerCase()),
    tickers: extract(/(?<![\p{L}\p{N}_])\$(?=[a-z0-9_]{0,15}[a-z])([a-z0-9][a-z0-9_]{0,15})(?![a-z0-9_])/giu, s => s.toUpperCase()).map(sym => ({ sym })),
    handles: extract(/(?<![\p{L}\p{N}_@])@([a-z0-9_]{2,24})(?![a-z0-9_])/giu, s => s.toLowerCase())
  };
}

// Normalize separators before reserving brand prefixes and whole role names.
export const reservedHandle = handle =>
  /^(?:gator|intercom|trac)|^(?:official|dex|reset|dmw|root|admin|support|team)$/.test(handle.toLowerCase().replace(/[_-]/g, ''));

const CARD_FIELDS = ['handle', 'name', 'bio', 'harnesses', 'proofs', 'links', 'avatar'];
export function isCard(card, author, rootKey) {
  return fields(card, CARD_FIELDS) && isHandle(card.handle) &&
    (!reservedHandle(card.handle) || (isKey(rootKey) && author === rootKey)) &&
    optional(card.name, s => short(s, 80)) && optional(card.bio, s => s === '' || short(s, 160)) &&
    list(card.harnesses, 12, s => short(s, 32) && /^[a-z0-9_-]+$/i.test(s)) &&
    optional(card.links, urls => list(urls, 4, isHttpUrl)) &&
    (card.links?.length ?? 0) + linkCount(card.name ?? '') + linkCount(card.bio ?? '') <= 4 &&
    optional(card.proofs, p => fields(p, ['dns', 'github']) && optional(p.dns, domain) && optional(p.github, githubUser)) &&
    optional(card.avatar, isAvatar);
}

const perType = {
  card: CARD_FIELDS,
  announce: ['card', 'topics', 'channel'], post: ['text', 'tags', 'tickers', 'quote'],
  reply: ['text', 'parent', 'sourceId'], like: ['target'], repost: ['target', 'original', 'sourceId'],
  mention: ['original'], share: ['original'], want: ['since'], follow: ['key'], notice: ['text', 'severity', 'expires'], revoke: ['id'],
  mutes: ['seq', 'add', 'remove'], net: ['seq', 'pow', 'caps', 'rates', 'relayTtl', 'relays']
};

export function validMessage(msg, author, rootKey) {
  if (!plain(msg) || msg.v !== 1 || typeof msg.t !== 'string' || !Object.hasOwn(perType, msg.t) ||
      !fields(msg, ['t', 'v', ...perType[msg.t]])) return false;
  const { t, v, ...body } = msg;
  switch (t) {
    case 'card': return isCard(body, author, rootKey);
    case 'announce': return isCard(msg.card, author, rootKey) && list(msg.topics, 5, topic) && lane(msg.channel) === 'owner';
    case 'post': return isText(msg.text) && optional(msg.tags, a => list(a, 100, topic)) &&
      optional(msg.tickers, a => list(a, 100, ticker)) && optional(msg.quote, isRef);
    case 'reply': return isText(msg.text) && isRef(msg.parent) && optional(msg.sourceId, isId);
    case 'repost': return isRef(msg.target) && optional(msg.sourceId, isId) && optional(msg.original, plain);
    case 'like': return isRef(msg.target);
    case 'mention':
    case 'share': return plain(msg.original);
    case 'want': return optional(msg.since, seq);
    case 'follow': return isKey(msg.key);
    case 'revoke': return isId(msg.id);
    case 'notice': return optional(msg.expires, seq) && isText(msg.text) && optional(msg.severity, s => ['info', 'warn'].includes(s));
    case 'mutes': return seq(msg.seq) && list(msg.add, 128, isKey) && list(msg.remove, 128, isKey) &&
      msg.add.every(key => !msg.remove.includes(key));
    case 'net': return seq(msg.seq) && optional(msg.relayTtl, Number.isSafeInteger) &&
      optional(msg.relays, relays => list(relays, 8, isKey)) &&
      Object.entries(BOUNDS).every(([group, bounds]) => optional(msg[group], obj =>
        fields(obj, Object.keys(bounds)) && Object.values(obj).every(Number.isSafeInteger)));
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function signed(e) {
  if (typeof e.sig !== 'string' || e.sig.length !== 128 || !/^[\da-f]+$/i.test(e.sig)) return false;
  const key = createPublicKey({ format: 'jwk', key: {
    kty: 'OKP', crv: 'Ed25519', x: Buffer.from(e.from, 'hex').toString('base64url')
  } });
  const input = { kind: 'sidechannel_message_v1', id: e.id, channel: e.channel, from: e.from,
    origin: e.origin ?? null, ts: e.ts, message: e.message };
  return verify(null, Buffer.from(canonical(input)), key, Buffer.from(e.sig, 'hex'));
}

function allowed(e, kind, rootKey) {
  const { message: m, from, channel } = e;
  if (kind === 'official') return from === rootKey && ['notice', 'revoke', 'mutes', 'net'].includes(m.t) &&
    (m.t !== 'notice' || m.expires === undefined || m.expires > e.ts);
  if (kind === 'product') return from === rootKey && m.t === 'post';
  if (kind === 'directory') return m.t === 'announce' && m.channel === 'soc/u/' + from;
  if (kind === 'public') return m.t === 'share' || m.t === 'want';
  if (kind === 'owner') return channel === 'soc/u/' + from && !m.sourceId &&
    ['card', 'post', 'reply', 'repost', 'follow'].includes(m.t) && (m.t !== 'repost' || !!m.original);
  if (channel.startsWith('soc/pr/')) return m.t === 'reply' && m.parent.key === rootKey;
  if (m.t === 'mention') return true;
  const recipient = channel.slice(6);
  return (m.t === 'reply' && m.parent.key === recipient) ||
    (['like', 'repost'].includes(m.t) && m.target.key === recipient);
}

/** Check an Intercom v1 wire envelope, including any independently signed embedded content. */
export function validEnvelope(channel, e, rootKey, settings = settingsFor(), embedded = false) {
  try {
    const kind = lane(channel);
    if (!kind || !plain(e) || e.channel !== channel || !isId(e.id) || !isKey(e.from) ||
        !optional(e.origin, isKey) || !seq(e.ts) || !optional(e.ttl, seq) ||
        !optional(e.type, type => type === 'sidechannel') || !optional(e.pow, plain) ||
        Buffer.byteLength(JSON.stringify(e)) > settings.caps[kind] ||
        !validMessage(e.message, e.from, rootKey) || !allowed(e, kind, rootKey) || !signed(e)) return false;
    const { t, original, target } = e.message;
    if (!original) return true;
    if (t === 'share') return !embedded && original.message?.t === 'post' &&
      original.channel === 'soc/u/' + original.from && validEnvelope(original.channel, original, rootKey, settings, true);
    if (embedded || !['post', 'reply', 'notice'].includes(original.message?.t) ||
        !validEnvelope(original.channel, original, rootKey, settings, true)) return false;
    if (t === 'mention') return e.from === original.from && lane(original.channel) === 'owner' &&
      ['post', 'reply'].includes(original.message.t);
    return original.from === target.key && (original.message.sourceId ?? original.id) === target.id;
  } catch { return false; }
}
