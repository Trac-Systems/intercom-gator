import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

// A profile card may carry one small square image inside the signed card (no separate fetch, no URL).
export const AVATAR_SIZE = 96;
export const AVATAR_MAX_BYTES = 6144;
export const AVATAR_RULE = 'avatar: a square 96×96 WebP or PNG of at most 6 KB, without animation or metadata';
// Bytes an Intercom envelope adds around the message: ids, keys, signature, PoW nonce, TTL and the length prefix.
// Measured at 500 bytes on soc/dir (MemoryTransport, PoW 16); the rest covers a relay stamp (relayedBy) and the
// frame length prefix.
export const ENVELOPE_ALLOWANCE = 640;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Critical chunks plus colour metadata. Text, EXIF, time and animation chunks are refused: they can carry data
// the owner never saw in the picture.
const PNG_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs', 'bKGD']);
const PNG_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

/** @param {Buffer} b @returns {{type:'image/png', width:number, height:number} | null} */
function png(b) {
  if (b.length < 57 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let offset = 8, info = null, idat = false, palette = false;
  while (offset + 12 <= b.length) {
    const length = b.readUInt32BE(offset), type = b.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (length > b.length || end > b.length || !PNG_CHUNKS.has(type)) return null;
    if (crc32(b.subarray(offset + 4, offset + 8 + length)) !== b.readUInt32BE(offset + 8 + length)) return null;
    const data = b.subarray(offset + 8, offset + 8 + length);
    if ((type === 'IHDR') !== (offset === 8)) return null;
    if (type === 'IHDR') {
      if (length !== 13) return null;
      const [depth, color, compression, filter, interlace] = data.subarray(8);
      if (!PNG_DEPTHS[color]?.includes(depth) || compression || filter || interlace > 1) return null;
      info = { type: 'image/png', width: data.readUInt32BE(0), height: data.readUInt32BE(4), color };
    }
    if (type === 'PLTE') palette = true;
    if (type === 'IDAT') idat = true;
    if (type === 'IEND') {
      if (length || end !== b.length || !idat || (info.color === 3 && !palette)) return null;
      return { type: info.type, width: info.width, height: info.height };
    }
    offset = end;
  }
  return null;
}

/** Frame size from a 'VP8 ' or 'VP8L' payload. @param {string} type @param {Buffer} d */
function frame(type, d) {
  if (type === 'VP8 ') {
    // Key frame (bit 0 clear), then the start code 9d 01 2a and two 14-bit sizes.
    if (d.length < 10 || (d[0] & 1) || d[3] !== 0x9d || d[4] !== 0x01 || d[5] !== 0x2a) return null;
    return { width: d.readUInt16LE(6) & 0x3fff, height: d.readUInt16LE(8) & 0x3fff };
  }
  if (type === 'VP8L') {
    if (d.length < 5 || d[0] !== 0x2f) return null;
    const bits = d.readUInt32LE(1);
    if (bits >>> 29) return null; // version 0 only
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/** @param {Buffer} b @returns {{type:'image/webp', width:number, height:number} | null} */
function webp(b) {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP' ||
      b.readUInt32LE(4) + 8 !== b.length) return null;
  const chunks = [];
  for (let offset = 12; offset < b.length;) {
    if (offset + 8 > b.length) return null;
    const type = b.toString('latin1', offset, offset + 4), size = b.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (end > b.length) return null;
    chunks.push({ type, data: b.subarray(offset + 8, end) });
    offset = end + (size & 1);
    if (offset > b.length) return null;
  }
  const [first, ...rest] = chunks;
  if (!first) return null;
  if (first.type === 'VP8 ' || first.type === 'VP8L') {
    const size = rest.length ? null : frame(first.type, first.data);
    return size && { type: 'image/webp', ...size };
  }
  if (first.type !== 'VP8X' || first.data.length !== 10) return null;
  const flags = first.data[0];
  // Refuse animation, EXIF and XMP; allow an ICC profile and an alpha plane.
  if (flags & ~0x30) return null;
  const width = first.data.readUIntLE(4, 3) + 1, height = first.data.readUIntLE(7, 3) + 1;
  const order = rest.map(c => c.type).join(',');
  const allowed = ['VP8 ', 'VP8L', 'ALPH,VP8 '].flatMap(tail => [tail, 'ICCP,' + tail]);
  if (!allowed.includes(order) || order.includes('ICCP') !== !!(flags & 0x20) ||
      order.includes('ALPH') && !(flags & 0x10)) return null;
  const last = rest[rest.length - 1];
  const size = frame(last.type, last.data);
  return size && size.width === width && size.height === height ? { type: 'image/webp', width, height } : null;
}

/** Image type and header dimensions of a PNG or WebP file, or null. @param {Buffer} bytes */
export function imageInfo(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  try { return png(bytes) ?? webp(bytes); } catch { return null; }
}

/** Canonical base64 only (one encoding per image, so the signed card and the hash agree). @param {unknown} value */
export function decodeBase64(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(AVATAR_MAX_BYTES / 3) * 4 || !BASE64.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : null;
}

/**
 * Check an avatar given as raw bytes or the card's base64 string: PNG or WebP by magic bytes, 96×96 in the header,
 * at most 6 KB. Returns the image and its SHA-256, or null.
 * @param {unknown} value
 * @returns {{type:'image/png'|'image/webp', bytes:Buffer, base64:string, hash:string, width:number, height:number} | null}
 */
export function parseAvatar(value) {
  const bytes = Buffer.isBuffer(value) ? value : decodeBase64(value);
  if (!bytes || bytes.length > AVATAR_MAX_BYTES) return null;
  const info = imageInfo(bytes);
  if (!info || info.width !== AVATAR_SIZE || info.height !== AVATAR_SIZE) return null;
  return { ...info, bytes, base64: bytes.toString('base64'), hash: createHash('sha256').update(bytes).digest('hex') };
}

export const isAvatar = value => typeof value === 'string' && parseAvatar(value) !== null;
export const avatarHash = value => parseAvatar(value)?.hash ?? null;

/**
 * Largest avatar (raw bytes) that still fits a card and its directory announcement into `limit` envelope bytes.
 * @param {object} card the card without an avatar @param {string} channel own channel @param {string[]} topics
 * @param {number} limit the smaller of the owner and directory caps
 */
export function avatarRoom(card, channel, topics, limit) {
  const { avatar, ...rest } = card;
  const announce = { t: 'announce', v: 1, channel, card: { ...rest, avatar: '' }, topics };
  const free = limit - ENVELOPE_ALLOWANCE - Buffer.byteLength(JSON.stringify(announce));
  return Math.max(0, Math.min(AVATAR_MAX_BYTES, Math.floor(free / 4) * 3));
}

/**
 * Read a local avatar file for an owner or agent command: an absolute path to a regular file of at most 64 KiB.
 * Throws a TypeError with a short reason; nothing about the file's content is echoed.
 * @param {unknown} path @returns {Promise<Buffer>}
 */
export async function readAvatarFile(path) {
  const { constants } = await import('node:fs');
  const { open } = await import('node:fs/promises');
  const { isAbsolute } = await import('node:path');
  if (typeof path !== 'string' || path.length > 1024 || !isAbsolute(path) || path.includes('\0')) {
    throw new TypeError('avatar: path must be an absolute file path');
  }
  let handle;
  // O_NONBLOCK: a FIFO must not hang the caller.
  try { handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)); }
  catch { throw new TypeError('avatar: file not readable'); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new TypeError('avatar: path is not a regular file');
    if (stat.size > 64 * 1024) throw new TypeError(AVATAR_RULE);
    return await handle.readFile();
  } finally { await handle.close(); }
}
