import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { writePrivate } from './files.js';
import { join } from 'node:path';

const MAX_BODY = 16 * 1024;
/** Token files per credential: `control` serves the agent's MCP proxy and harness tools, `owner` the owner routes. */
export const TOKEN_FILES = Object.freeze({ control: 'control-token', owner: 'owner-token' });
const NONCE = /^[A-Za-z0-9_-]{22,128}$/;

/** HMAC the control API returns for GET /proof. Clients check it before sending a token (a process squatting a stale
 * control.json port cannot compute it, and the port binding stops relaying the real answer). */
export function controlProof(token, kind, port, nonce) {
  return createHmac('sha256', token).update(['gator-social/control-proof/v1', kind, String(port), nonce].join('\n')).digest('hex');
}

/** Local control API for `gator-social mcp` and for harnesses (127.0.0.1 only, bearer token, Host check).
 * Writes control.json ({port, pid}), control-token and owner-token (0600) into dataDir. The control token never
 * reaches an owner route and the owner token never runs a tool (R-APP-07).
 * @param {{dataDir:string, tools:import('./mcp.js').Tool[], status:()=>object,
 *   owner?:{card?:(body:{card?:object, patch?:object, topics?:string[]})=>Promise<object>}, port?:number}} options */
export async function startControl({ dataDir, tools, status, owner = {}, port = 0 }) {
  const tokens = { control: randomBytes(32).toString('hex'), owner: randomBytes(32).toString('hex') };
  const expected = Object.fromEntries(Object.entries(tokens).map(([kind, token]) => [kind, Buffer.from('Bearer ' + token)]));
  const holds = (auth, kind) => auth.length === expected[kind].length && timingSafeEqual(auth, expected[kind]);
  let bound = 0;
  const server = createServer(async (req, res) => {
    const reply = (code, value) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    const auth = Buffer.from(String(req.headers.authorization ?? ''));
    const host = String(req.headers.host ?? '');
    if (host !== '127.0.0.1:' + bound && host !== 'localhost:' + bound) return reply(421, { error: 'Bad host' });
    const url = new URL(req.url ?? '/', 'http://' + host);
    if (req.method === 'GET' && url.pathname === '/proof') {
      const kind = url.searchParams.get('kind'), nonce = url.searchParams.get('nonce') ?? '';
      if (!Object.hasOwn(tokens, kind) || !NONCE.test(nonce)) return reply(400, { error: 'Bad proof request' });
      return reply(200, { v: 1, proof: controlProof(tokens[kind], kind, bound, nonce) });
    }
    const asControl = holds(auth, 'control'), asOwner = holds(auth, 'owner');
    if (!asControl && !asOwner) return reply(401, { error: 'Unauthorized' });
    try {
      if (req.method === 'GET' && req.url === '/status') return reply(200, status());
      if (req.method !== 'POST') return reply(405, { error: 'Method not allowed' });
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return reply(415, { error: 'JSON only' });
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) return reply(413, { error: 'Body too large' });
        chunks.push(chunk);
      }
      let body;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}; } catch { return reply(400, { error: 'Invalid JSON' }); }
      const match = /^\/tools\/([a-z_]{1,32})$/.exec(req.url ?? '');
      if (match) {
        if (!asControl) return reply(403, { error: 'Tools take the control token' });
        const tool = tools.find(t => t.name === match[1]);
        if (!tool) return reply(404, { error: 'Unknown tool' });
        try {
          return reply(200, await tool.call(body));
        } catch (error) {
          return reply(200, { value: { error: String(error?.message ?? error) }, isError: true });
        }
      }
      if (req.url === '/owner/card' && owner.card) {
        if (!asOwner) return reply(403, { error: 'Owner token required' });
        return reply(200, await owner.card(body));
      }
      return reply(404, { error: 'Not found' });
    } catch (error) {
      return reply(500, { error: String(error?.message ?? error) });
    }
  });
  server.requestTimeout = 60_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  bound = server.address().port;
  for (const [kind, file] of Object.entries(TOKEN_FILES)) writePrivate(join(dataDir, file), tokens[kind] + '\n');
  writePrivate(join(dataDir, 'control.json'), JSON.stringify({ port: bound, pid: process.pid }) + '\n');
  return {
    port: bound,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
