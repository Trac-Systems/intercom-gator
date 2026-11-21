import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { publicDir } from '@gator/dashboard';
import { createRouter } from './routes.js';
import { DEFAULT_PORT, HttpError, NONCE, check, serverProof } from './local.js';

const types = { '.html':'text/html; charset=utf-8', '.css':'text/css', '.js':'text/javascript', '.mjs':'text/javascript',
  '.woff2':'font/woff2', '.svg':'image/svg+xml', '.txt':'text/plain', '.png':'image/png', '.webp':'image/webp',
  '.jpg':'image/jpeg' };
const LOGO_PATH = /^\/img\/([0-9a-f]{64})\.(png|webp|jpg)$/;
const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const MAX_BODY = 64 * 1024;
const PRICE_BATCH = 500;
const TICKET_MS = 60_000, MAX_TICKETS = 8;
function equal(input, token) {
  if (typeof input !== 'string' || input.length !== token.length) return false;
  const a = Buffer.from(input), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a,b);
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
async function bodyOf(req, mcp) {
  check(req.headers['content-type']?.split(';')[0].trim().toLowerCase() === 'application/json', 'expected application/json', 415);
  check(!(Number(req.headers['content-length']) > MAX_BODY), 'request too large', 413);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    check(bytes <= MAX_BODY, 'request too large', 413);
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'invalid JSON'); }
  check(body && typeof body === 'object' && (mcp || !Array.isArray(body)), 'expected JSON object');
  return body;
}
async function staticFile(req, res, pathname) {
  check(req.method === 'GET' || req.method === 'HEAD', 'no route', 404);
  let path;
  try { path = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'bad path'); }
  check(!path.includes('\\') && !path.includes('\0') && !path.split('/').some(s => s.startsWith('.')), 'no route', 404);
  const root = resolve(publicDir);
  let file;
  try { file = await realpath(resolve(root, '.' + (path === '/' ? '/index.html' : path))); }
  catch { throw new HttpError(404, 'no route'); }
  check(file.startsWith(root + sep) && Object.hasOwn(types,extname(file)), 'no route', 404);
  const data = await readFile(file);
  res.writeHead(200, { 'Content-Type': types[extname(file)], 'Content-Length': data.length });
  res.end(req.method === 'HEAD' ? undefined : data);
}

/** Logos stored by SHA-256 (the node fetched and checked them). Same rules as the other static assets: Host and
 * Origin are checked by the caller, no credential is needed or read. The bytes never change for a name, so they are
 * cacheable for good; other sites may not embed them (they could otherwise probe which tokens this node displayed). */
function logoFile(app, req, res, path) {
  check(req.method === 'GET' || req.method === 'HEAD', 'no route', 404);
  const site = req.headers['sec-fetch-site'];
  check(!site || site === 'same-origin' || site === 'none', 'no route', 404);
  const match = LOGO_PATH.exec(path);
  const image = match && app.engine?.logos?.image(match[1], match[2]);
  check(image, 'no route', 404);
  res.writeHead(200, { 'Content-Type': image.type, 'Content-Length': image.bytes.length,
    'Cache-Control': 'public, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'same-origin' });
  res.end(req.method === 'HEAD' ? undefined : image.bytes);
}

/** Bind only IPv4 loopback. Host and origin are validated before credentials or request bodies.
 * Credentials: `token` (agent bearer), `login` (owner bearer; mints one-time sign-in tickets), `stop` (POST /stop only). */
export async function serve(app, { port = DEFAULT_PORT, token, login, stop }) {
  check(Number.isInteger(port) && port >= 0 && port <= 65535, 'invalid port');
  const request = createRouter(app);
  const credentials = { agent: token, owner: login, stop };
  // Session cookies derive from the long-lived credentials, so a daemon restart keeps the browser signed in;
  // rotating a credential file ends its sessions. The cookie value never reveals the credential itself.
  const sessionFor = (secret, kind, port) => createHmac('sha256', secret).update('gator-session-v1:' + kind + ':' + port).digest('base64url');
  let ownerSession, agentSession;
  const streams = new Set(), pending = new Set();
  // One-time owner sign-in tickets (gator open). The long-lived owner token never appears in a URL, an argv or a log.
  const tickets = new Map();
  function issueTicket() {
    const now = Date.now();
    for (const [t, until] of tickets) if (until <= now) tickets.delete(t);
    while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value);
    const ticket = randomBytes(32).toString('base64url');
    tickets.set(ticket, now + TICKET_MS);
    return ticket;
  }
  function redeem(ticket) {
    for (const [t, until] of tickets) {
      if (!equal(ticket, t)) continue;
      tickets.delete(t);
      return until > Date.now();
    }
    return false;
  }
  // A rebuild reports every changed coin as one price event: thousands at once on a busy node. Writing each to every
  // dashboard stream at once held the daemon for ~1.4 s (owner node 11-21). Prices are kept per coin (the newest wins,
  // its place in the queue stays) and written in batches of PRICE_BATCH, one write per stream, yielding in between.
  const pricesDue = new Map();
  let priceFlush = null;
  function flushPrices() {
    priceFlush = null;
    if (!streams.size) { pricesDue.clear(); return; }
    let frames = '', n = 0;
    for (const [coin, data] of pricesDue) {
      pricesDue.delete(coin);
      frames += 'event: price\ndata: ' + JSON.stringify(data) + '\n\n';
      if (++n >= PRICE_BATCH) break;
    }
    for (const res of streams) if (!res.write(frames)) res.destroy();
    if (pricesDue.size) priceFlush = setImmediate(flushPrices);
  }
  function publish(type, data) {
    if (!streams.size) return;
    const coin = type === 'price' ? data?.asset : null;
    if (typeof coin === 'string') {
      pricesDue.set(coin, data);
      priceFlush ??= setImmediate(flushPrices);
      return;
    }
    const frame = 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n';
    for (const res of streams) if (!res.write(frame)) res.destroy();
  }
  const listeners = ['price','post','notice','alert'].map(type => {
    const fn = data => publish(type,data);
    app.events.on(type,fn);
    return [type,fn];
  });
  const heartbeat = setInterval(() => {
    for (const res of streams) if (!res.write(': heartbeat\n\n')) res.destroy();
  }, 20_000);
  heartbeat.unref();
  let stopped = false;
  async function handle(req,res) {
    res.setHeader('Content-Security-Policy',csp);
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cache-Control','no-store');
    const host = req.headers.host;
    const bound = server.address()?.port;
    ownerSession ??= login ? sessionFor(login, 'owner', bound) : randomBytes(32).toString('base64url');
    agentSession ??= token ? sessionFor(token, 'agent', bound) : randomBytes(32).toString('base64url');
    check(req.headersDistinct.host?.length === 1 && ['localhost:' + bound,'127.0.0.1:' + bound].includes(host), 'invalid Host', 403);
    check(!req.headers.origin || req.headers.origin === 'http://' + host, 'invalid Origin', 403);
    check(!stopped, 'daemon is stopping', 503);
    const contentLength = Number(req.headers['content-length'] ?? 0);
    check(contentLength <= MAX_BODY, 'request too large', 413);
    if (['GET','HEAD'].includes(req.method)) {
      check(!contentLength && !req.headers['transfer-encoding'], 'unexpected request body');
    }
    check(req.url?.startsWith('/') && !req.url.startsWith('//') && !req.url.includes('\\'), 'bad path');
    const url = new URL(req.url, 'http://' + host), path = url.pathname;
    // Cookies ignore ports: the name carries this daemon's port so other local servers' pages and other gator
    // daemons never share or overwrite it (R-APP-10).
    const cookieName = 'gator_session_' + bound;
    if (path === '/proof') {
      // R-APP-11: clients check this HMAC before they send a bearer. Unauthenticated by design; it reveals nothing.
      const kind = url.searchParams.get('kind'), nonce = url.searchParams.get('nonce') ?? '';
      check(req.method === 'GET' && Object.hasOwn(credentials, kind) && credentials[kind] && NONCE.test(nonce), 'bad proof request');
      return json(res, 200, { v: 1, proof: serverProof(credentials[kind], kind, bound, nonce) });
    }
    if (path === '/auth') {
      check(req.method === 'GET', 'not signed in', 401);
      const ticket = url.searchParams.get('t') ?? '';
      const session = redeem(ticket) ? ownerSession : equal(ticket, token) ? agentSession : null;
      check(session, 'not signed in', 401);
      res.writeHead(303, { 'Set-Cookie': cookieName + '=' + session + '; Path=/; HttpOnly; SameSite=Strict', Location: '/' });
      res.end();
      return;
    }
    if (path.startsWith('/img/')) return logoFile(app, req, res, path);
    if (path !== '/mcp' && !path.startsWith('/api/')) return staticFile(req,res,path);
    const bearer = /^Bearer ([a-zA-Z0-9_-]+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const cookie = bearer ? undefined : req.headers.cookie?.split(';').map(c => c.trim())
      .find(c => c.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    const owner = bearer ? equal(bearer,login) : equal(cookie,ownerSession);
    const agent = bearer ? equal(bearer,token) : equal(cookie,agentSession);
    const stopRoute = path === '/api/v1/stop' && req.method === 'POST';
    // The stop credential is accepted by the stop route and nowhere else.
    const stopper = stopRoute && !!bearer && !!stop && equal(bearer,stop);
    check(owner || agent || stopper, 'not signed in', 401);
    if (!bearer) {
      // Browser session: refuse requests a page on another local port could trigger (SameSite treats every
      // localhost port as the same site). EventSource cannot add headers, so the read-only stream relies on
      // Sec-Fetch-Site alone; foreign pages also fail the Origin check above.
      const site = req.headers['sec-fetch-site'];
      check(!site || site === 'same-origin', 'cross-site request', 403);
      check(req.headers['x-gator'] === '1' || (path === '/api/v1/stream' && req.method === 'GET'), 'X-Gator header required', 403);
    }
    if (path === '/api/v1/stream' && req.method === 'GET') {
      check(streams.size < 64, 'too many streams', 429);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
      res.write(': connected\n\n');
      streams.add(res);
      res.once('close', () => streams.delete(res));
      return;
    }
    const mcp = path === '/mcp';
    if (mcp && req.method !== 'POST') {
      res.setHeader('Allow','POST');
      throw new HttpError(405, 'stateless MCP accepts POST requests');
    }
    const body = ['POST','PUT'].includes(req.method) ? await bodyOf(req, mcp) : {};
    if (mcp) {
      const { handleMcp } = await import('./mcp.js');
      return handleMcp(req,res,body,request);
    }
    check(path.startsWith('/api/v1/'), 'no route', 404);
    if (stopRoute) {
      check(owner || stopper, 'stop credential required', 403);
      json(res,200,{ stopping: true });
      setImmediate(() => app.close().catch(() => { process.exitCode = 1; }));
      return;
    }
    if (path === '/api/v1/login-ticket' && req.method === 'POST') {
      check(owner, 'owner session required', 403);
      return json(res,200,{ ticket: issueTicket(), expiresInSec: TICKET_MS / 1000 });
    }
    const result = await request(req.method,path.slice(7),Object.fromEntries(url.searchParams),body,owner);
    json(res,200,result);
  }
  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 16384 }, (req,res) => {
    const task = handle(req,res).catch(error => {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      const known = error instanceof HttpError;
      const input = error instanceof TypeError || error instanceof RangeError;
      if (known && error.status === 413) { res.setHeader('Connection','close'); req.resume(); }
      json(res,known ? error.status : input ? 400 : 500,{ error: known ? error.message : input ? 'invalid request' : 'request failed' });
    }).finally(() => pending.delete(task));
    pending.add(task);
  });
  server.maxConnections = 256;
  function cleanup() {
    clearInterval(heartbeat);
    clearImmediate(priceFlush);
    pricesDue.clear();
    for (const [type,fn] of listeners) app.events.off(type,fn);
  }
  try {
    await new Promise((ok,fail) => { server.once('error', fail); server.listen(port,'127.0.0.1', () => { server.off('error',fail); ok(); }); });
  } catch (e) { cleanup(); throw e; }
  return { port: server.address().port, async close() {
    stopped = true;
    cleanup();
    for (const res of streams) res.end();
    const closed = new Promise(ok => server.close(ok));
    server.closeAllConnections();
    await Promise.allSettled([...pending,closed]);
  } };
}
