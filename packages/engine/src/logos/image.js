/** Logo image checks. Only the container header is decoded: the bytes are stored and served exactly as fetched. */

export const LOGO_LIMITS = Object.freeze({ maxBytes: 64 * 1024, maxSide: 512, minSide: 16, maxAspect: 1.25 })

/** File extension → content type. These are the only types a logo may have (no SVG from the internet). */
export const LOGO_TYPES = Object.freeze({ png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg' })

export class ImageRejected extends Error {}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const reject = (reason) => {
  throw new ImageRejected(reason)
}

function png(b) {
  if (b.length < 33 || b.readUInt32BE(8) !== 13 || b.toString('latin1', 12, 16) !== 'IHDR') reject('bad PNG header')
  const width = b.readUInt32BE(16)
  const height = b.readUInt32BE(20)
  // Walk the chunk list up to the first image data: an animation control chunk means APNG.
  let at = 8
  for (let n = 0; n < 64 && at + 8 <= b.length; n++) {
    const length = b.readUInt32BE(at)
    const type = b.toString('latin1', at + 4, at + 8)
    if (type === 'acTL') reject('animated PNG')
    if (type === 'IDAT' || type === 'IEND') return { ext: 'png', width, height }
    at += 12 + length
  }
  return reject('PNG without image data')
}

function jpeg(b) {
  let at = 2
  for (let n = 0; n < 256 && at + 4 <= b.length; n++) {
    if (b[at] !== 0xff) reject('bad JPEG marker')
    const marker = b[at + 1]
    if (marker === 0xff) {
      at++
      continue
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) break
    const length = b.readUInt16BE(at + 2)
    if (length < 2) reject('bad JPEG segment')
    // Start-of-frame markers carry the dimensions (C4 = Huffman tables, C8 = reserved, CC = arithmetic tables).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (at + 9 > b.length) break
      return { ext: 'jpg', width: b.readUInt16BE(at + 7), height: b.readUInt16BE(at + 5) }
    }
    at += 2 + length
  }
  return reject('JPEG without frame header')
}

function webp(b) {
  if (b.length < 30 || b.readUInt32LE(4) + 8 > b.length) reject('truncated WebP')
  const chunk = b.toString('latin1', 12, 16)
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) reject('bad VP8 frame')
    return { ext: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) reject('bad VP8L header')
    const bits = b.readUInt32LE(21)
    return { ext: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') {
    if (b[20] & 0x02) reject('animated WebP')
    return { ext: 'webp', width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 }
  }
  return reject('unknown WebP chunk')
}

/**
 * Identify a PNG, WebP or JPEG by its magic bytes and read the dimensions from its header.
 * Throws ImageRejected for any other format (SVG, GIF, ICO, HTML error pages), for oversize files and for images that
 * are not roughly square or exceed LOGO_LIMITS.maxSide.
 * @param {Uint8Array} bytes
 * @returns {{ ext: 'png'|'webp'|'jpg', type: string, width: number, height: number }}
 */
export function inspectImage(bytes) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (b.length > LOGO_LIMITS.maxBytes) reject('larger than ' + LOGO_LIMITS.maxBytes + ' bytes')
  let info
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG)) info = png(b)
  else if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) info = jpeg(b)
  else if (b.length >= 16 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP')
    info = webp(b)
  else reject('not a PNG, WebP or JPEG image')
  const { width, height } = info
  const { minSide, maxSide, maxAspect } = LOGO_LIMITS
  if (!(width >= minSide && height >= minSide)) reject('smaller than ' + minSide + ' px')
  if (width > maxSide || height > maxSide) reject('larger than ' + maxSide + ' px')
  if (Math.max(width, height) / Math.min(width, height) > maxAspect) reject('not square')
  return { ...info, type: LOGO_TYPES[info.ext] }
}
