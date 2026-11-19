import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { controlProof, TOKEN_FILES } from './control.js';
import { checkDataDir, defaultDataDir, readPrivate } from './files.js';

const NOT_RUNNING = 'gator-social is not running (start it with: gator-social run)';

/** Client for a running `gator-social run` (its local control API). Harnesses use this from their own MCP
 * server: `const feed = socialClient(dir); await feed.call('feed_read', { scope: 'official' })`.
 * Tools and status use `control-token`; `card` is an owner action and uses `owner-token`. Before a token is sent the
 * listener must prove it holds it (GET /proof), so a process on a stale port never receives it.
 * @param {string} [dataDir] @param {{timeoutMs?:number}} [options] */
export function socialClient(dataDir = defaultDataDir(), { timeoutMs = 30_000 } = {}) {
  async function send(port, path, init) {
    try {
      return await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), ...init });
    } catch (error) {
      if (error.cause?.code === 'ECONNREFUSED') throw new Error(NOT_RUNNING);
      throw error;
    }
  }
  async function request(method, path, body, kind = 'control') {
    let control, token;
    try {
      checkDataDir(dataDir);
      control = JSON.parse(readFileSync(join(dataDir, 'control.json'), 'utf8'));
      token = readPrivate(join(dataDir, TOKEN_FILES[kind]), 256);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(NOT_RUNNING);
      throw error;
    }
    if (!Number.isSafeInteger(control?.port) || control.port < 1 || control.port > 65535) throw new Error('Invalid control.json');
    const nonce = randomBytes(24).toString('base64url');
    const answer = await send(control.port, `/proof?kind=${kind}&nonce=${nonce}`, { method: 'GET' });
    const proof = answer.ok ? (await answer.json().catch(() => null))?.proof : null;
    const wanted = Buffer.from(controlProof(token, kind, control.port, nonce));
    const given = Buffer.from(typeof proof === 'string' ? proof : '');
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
      throw new Error(`The process on 127.0.0.1:${control.port} is not this gator-social (stale control.json?). No token was sent.`);
    }
    const response = await send(control.port, path, {
      method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value?.error ?? 'gator-social HTTP ' + response.status);
    return value;
  }
  return {
    dataDir,
    status: () => request('GET', '/status'),
    /** @returns {Promise<{value:unknown, isError?:boolean}>} */
    call: (tool, args = {}) => request('POST', '/tools/' + tool, args),
    /** Owner action (reads owner-token). Agents never call this. Replaces the whole card (other harnesses' tags kept). */
    card: (card, topics = []) => request('POST', '/owner/card', { card, topics }, 'owner'),
    /** Owner action: merge `patch` into the identity's newest card; omitted fields and topics keep their value. */
    editCard: (patch, topics) => request('POST', '/owner/card', { patch, ...(topics !== undefined && { topics }) }, 'owner'),
  };
}

/** Proxy tools for a stdio MCP server that forwards to the running daemon. */
export function proxyTools(client, definitions) {
  return definitions.map(({ name, description, inputSchema }) => ({
    name, description, inputSchema, call: args => client.call(name, args),
  }));
}
