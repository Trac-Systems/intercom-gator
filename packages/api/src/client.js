import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { CREDENTIALS, DEFAULT_PORT, HttpError, readJson, readToken, serverProof } from './local.js';

export function daemonPort(dataDir, override) {
  const port = override ?? readJson(join(dataDir, 'daemon.json'), {}).port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid daemon port');
  return port;
}

const unavailable = () => new HttpError(503, 'Daemon unavailable. Run gator start with the same data directory.');

/** Ask the listener to prove it holds `token` before the token is sent (R-APP-11). Works on every OS: plain TCP,
 * no Unix socket or named pipe. A process squatting the port cannot compute the HMAC. */
export async function verifyServer(port, kind, token) {
  const nonce = randomBytes(24).toString('base64url');
  const url = new URL('http://127.0.0.1:' + port + '/proof');
  url.searchParams.set('kind', kind);
  url.searchParams.set('nonce', nonce);
  let proof;
  try {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    proof = res.ok ? (await res.json())?.proof : null;
  } catch { throw unavailable(); }
  const expected = Buffer.from(serverProof(token, kind, port, nonce));
  const given = Buffer.from(typeof proof === 'string' ? proof : '');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new HttpError(502, 'The process on 127.0.0.1:' + port + ' is not this data directory\'s gator daemon. No credential was sent.');
  }
}

/** All clients use a literal loopback address, verify the listener first and decline redirects carrying credentials.
 * @param {string} dataDir @param {{port?:number, owner?:boolean, credential?:'agent'|'owner'|'stop'}} [options] */
export function httpClient(dataDir, { port, owner = false, credential = owner ? 'owner' : 'agent' } = {}) {
  if (!Object.hasOwn(CREDENTIALS, credential)) throw new TypeError('Unknown credential');
  return async (method, path, query = {}, body) => {
    const bound = daemonPort(dataDir, port);
    const url = new URL('http://127.0.0.1:' + bound);
    url.pathname = '/api/v1' + path;
    for (const [key,v] of Object.entries(query)) if (v != null) url.searchParams.set(key,String(v));
    let token;
    try { token = readToken(dataDir, CREDENTIALS[credential]); }
    catch { throw new HttpError(503, 'Daemon credentials unavailable. Run gator start with the same data directory.'); }
    await verifyServer(bound, credential, token);
    let result;
    try {
      result = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Authorization: 'Bearer ' + token, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body) });
    } catch { throw unavailable(); }
    let value;
    try { value = await result.json(); } catch { throw new HttpError(502, 'Invalid daemon response'); }
    if (!result.ok) throw new HttpError(result.status, typeof value?.error === 'string' ? value.error : 'Request failed');
    return value;
  };
}
