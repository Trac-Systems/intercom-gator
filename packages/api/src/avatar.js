import { AVATAR_RULE, parseAvatar, readAvatarFile } from '@gator/social';
import { check, HttpError } from './local.js';

export { AVATAR_RULE };

/** Base64 as sent by a browser or an agent: an optional data: URL prefix and line breaks are tolerated. */
function fromBase64(data) {
  check(typeof data === 'string' && data.length <= 16384, AVATAR_RULE);
  const body = data.replace(/^data:image\/(?:png|webp);base64,/i, '').replace(/\s+/g, '');
  check(/^[A-Za-z0-9+/]*={0,2}$/.test(body) && body.length % 4 === 0, 'avatar: data must be base64');
  return Buffer.from(body, 'base64');
}

/** An absolute path to a small regular file. The node reads it once; nothing about the file is echoed back. */
async function fromFile(path) {
  try { return await readAvatarFile(path); }
  catch (error) { throw error instanceof TypeError ? new HttpError(400, error.message) : error; }
}

/**
 * The avatar of a request body: `{ data }` (base64) or `{ path }` (absolute local file). Returns the checked image.
 * @param {{data?: unknown, path?: unknown}} body
 */
export async function avatarInput({ data, path }) {
  check((data === undefined) !== (path === undefined), 'avatar: send data (base64) or path, or remove: true');
  const image = parseAvatar(data !== undefined ? fromBase64(data) : await fromFile(path));
  check(image, AVATAR_RULE);
  return image;
}
