// Data layer. Talks to the local API (DESIGN §7, same origin, session cookie from /auth?t=).
// Sample data is used ONLY when asked (?demo=1). A browser that is not signed in, or a node that
// does not answer, is 'offline': every call fails and the shell explains how to connect. Real users
// must never see invented tokens or prices as if they were live. Works in Node too (tests inject `fetch`).

import { createDemoServer } from './demo-server.js';

/** @typedef {'live'|'demo'|'offline'} Mode */
/** @typedef {{ limit?: number, offset?: number }} Paging */

export class ApiError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) { super(message); this.name = 'ApiError'; this.status = status; }
}

/**
 * @param {{
 *   fetch?: typeof fetch, base?: string, demo?: boolean, timeoutMs?: number,
 *   now?: () => number, EventSource?: any, still?: boolean
 * }} [opts]
 */
export function createApi(opts = {}) {
  const base = opts.base ?? '/api/v1';
  const doFetch = opts.fetch ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  // A local node can be busy for a few seconds (a storage upgrade, a large import): wait long enough not to show
  // "Could not load" for a slow answer, and retry a timed-out read once.
  const timeoutMs = opts.timeoutMs ?? 15000;
  /** @type {Mode} */
  let mode = opts.demo ? 'demo' : 'live';
  /** @type {null|'asked'|'unreachable'|'signin'} */
  let reason = opts.demo ? 'asked' : null;
  /** @type {ReturnType<typeof createDemoServer>|null} */
  let demo = null;
  const ensureDemo = () => (demo ||= createDemoServer({ now: opts.now }));
  let probed = !!opts.demo;

  /**
   * Decide live vs offline once (demo only when asked). A network error, a timeout, a non-JSON
   * answer or a 404 means "no API here" → offline 'unreachable'. A 401/403 means the API is there
   * but this browser is not signed in → offline 'signin'. `recheck()` probes again.
   */
  async function probe() {
    if (probed) return mode;
    probed = true;
    if (!doFetch) { mode = 'offline'; reason = 'unreachable'; return mode; }
    try {
      const r = await timed(doFetch(base + '/me', { credentials: 'same-origin', headers: { accept: 'application/json', 'x-gator': '1' } }));
      if (r.status === 401 || r.status === 403) { mode = 'offline'; reason = 'signin'; return mode; }
      const type = r.headers?.get?.('content-type') || '';
      if (!r.ok || !type.includes('json')) { mode = 'offline'; reason = 'unreachable'; return mode; }
      mode = 'live'; reason = null;
    } catch {
      mode = 'offline'; reason = 'unreachable';
    }
    return mode;
  }
  /** Probe again (offline only); resolves to the new mode. */
  async function recheck() {
    if (mode === 'demo') return mode;
    probed = false;
    return probe();
  }

  /** @template T @param {Promise<T>} p @param {number} [ms] @returns {Promise<T>} */
  function timed(p, ms = timeoutMs) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new ApiError(0, 'timeout')), ms);
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  /**
   * @param {string} method @param {string} path @param {Record<string, any>} [query] @param {any} [body] @param {number} [ms]
   */
  async function req(method, path, query, body, ms) {
    await probe();
    const q = {};
    for (const [k, v] of Object.entries(query || {})) if (v != null && v !== '') q[k] = String(v);
    if (mode === 'offline') throw new ApiError(reason === 'signin' ? 401 : 0, reason === 'signin' ? 'not signed in' : 'node not reachable');
    if (mode === 'demo') {
      const srv = ensureDemo();
      try {
        // Copy, so callers can never mutate the demo world by accident.
        return structuredClone(srv.route(method, path, q, body == null ? null : structuredClone(body)));
      } catch (e) {
        throw new ApiError(/** @type {any} */ (e).status || 500, /** @type {any} */ (e).message);
      }
    }
    const qs = new URLSearchParams(q).toString();
    const send = () => timed(doFetch(base + path + (qs ? '?' + qs : ''), {
      method, credentials: 'same-origin',
      headers: body == null ? { accept: 'application/json', 'x-gator': '1' } : { accept: 'application/json', 'x-gator': '1', 'content-type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    }), ms);
    let r;
    try { r = await send(); } catch (e) {
      // Reads are safe to repeat; a write that timed out may still have happened, so it is reported instead.
      if (method !== 'GET' || /** @type {any} */ (e)?.message !== 'timeout') throw e;
      r = await send();
    }
    let data = null;
    try { data = await r.json(); } catch { /* empty body */ }
    if (!r.ok) throw new ApiError(r.status, data?.error || r.statusText || 'request failed');
    return data;
  }

  const enc = encodeURIComponent;
  const get = (p, q) => req('GET', p, q);
  const post = (p, b) => req('POST', p, null, b);

  return {
    get mode() { return mode; },
    get reason() { return reason; },
    probe,
    recheck,
    // market data
    global: () => get('/global'),
    network: () => get('/network'),
    fearGreed: () => get('/fear-greed'),
    // Lists take ?limit=&offset= (API default 100, max 500); /markets also ?sort=&order=.
    markets: (/** @type {{tab?:string, category?:string, chain?:string, sort?:string, order?:string, limit?:number, offset?:number}} */ q = {}) => get('/markets', q),
    categories: (/** @type {Paging} */ q = {}) => get('/categories', q),
    chains: (/** @type {Paging} */ q = {}) => get('/chains', q),
    newTokens: (/** @type {Paging} */ q = {}) => get('/new', q),
    trending: (/** @type {Paging} */ q = {}) => get('/trending', q),
    movers: () => get('/movers'),
    exchanges: (/** @type {Paging & {kind?:string}} */ q = {}) => get('/exchanges', q),
    derivatives: (/** @type {Paging} */ q = {}) => get('/derivatives', q),
    nfts: (/** @type {Paging} */ q = {}) => get('/nfts', q),
    nft: (/** @type {string} */ id) => get('/nfts/' + enc(id)),
    sources: () => get('/sources'),
    asset: (/** @type {string} */ id) => get('/assets/' + enc(id)),
    // A first chart load can import venue history before answering; allow it longer than ordinary reads.
    candles: (/** @type {string} */ id, /** @type {string} */ tf, /** @type {number} */ limit) => req('GET', '/assets/' + enc(id) + '/candles', { tf, limit }, undefined, Math.max(timeoutMs, 20000)),
    // ?limit=&offset= (max 500); side=base|quote keeps the pairs where the asset is the base or the quote.
    assetMarkets: (/** @type {string} */ id, /** @type {{limit?:number, offset?:number, side?:string}} */ q = {}) => get('/assets/' + enc(id) + '/markets', q),
    // look: let the node start its by-address lookup for an unknown contract address; otherwise only read its status.
    search: (/** @type {string} */ q, look = false) => get('/search', look ? { q } : { q, lookup: '0' }),
    extras: () => get('/extras'),
    // social
    feed: (q = {}) => get('/feed', q),
    thread: (/** @type {string} */ key, /** @type {string} */ id) => get('/posts/' + enc(key) + '/' + enc(id)),
    profile: (/** @type {string} */ key) => get('/profiles/' + enc(key)),
    directory: (q = {}) => get('/directory', q),
    publish: (/** @type {string} */ text) => post('/posts', { text }),
    reply: (/** @type {string} */ text, /** @type {{key:string,id:string}} */ parent) => post('/replies', { text, parent }),
    like: (/** @type {{key:string,id:string}} */ target, on = true) => post('/likes', on ? { target } : { target, undo: true }),
    repost: (/** @type {{key:string,id:string}} */ target, on = true) => post('/reposts', on ? { target } : { target, undo: true }),
    follow: (/** @type {string} */ key, on = true) => post(on ? '/follow' : '/unfollow', { key }),
    mute: (/** @type {string} */ key, on = true) => post(on ? '/mute' : '/unmute', { key }),
    // Avatars travel inside signed profile cards and are addressed by SHA-256.
    avatar: (/** @type {string} */ hash) => get('/avatars/' + enc(hash)),
    setAvatar: (/** @type {string} */ data) => post('/avatar', { data }),
    removeAvatar: () => post('/avatar', { remove: true }),
    collisions: () => get('/collisions'),
    // me
    me: () => get('/me'),
    watchlist: () => get('/watchlist'),
    setWatch: (/** @type {string} */ asset, on = true) => post('/watchlist', { asset, on }),
    portfolio: () => get('/portfolio'),
    portfolioOp: (/** @type {object} */ body) => post('/portfolio', body),
    alerts: () => get('/alerts'),
    addAlert: (/** @type {{asset:string, op:string, value:number}} */ a) => post('/alerts', a),
    removeAlert: (/** @type {string} */ id) => post('/alerts', { id, remove: true }),
    settings: () => get('/settings'),
    putSettings: (/** @type {object} */ patch) => req('PUT', '/settings', null, patch),

    /**
     * Live updates. Real API: SSE `/api/v1/stream` (events price, post, notice, alert).
     * Demo: a gentle simulated price tick every few seconds (off with `still`).
     * @param {(type: string, data: any) => void} on
     * @returns {() => void} close
     */
    stream(on) {
      if (mode === 'offline') return () => {};
      if (mode === 'demo') {
        if (opts.still) return () => {};
        const srv = ensureDemo();
        const t = setInterval(() => { const e = srv.tick(); on(e.type, e.data); }, 3500);
        return () => clearInterval(t);
      }
      const ES = opts.EventSource ?? globalThis.EventSource;
      if (!ES) return () => {};
      const es = new ES(base + '/stream', { withCredentials: true });
      for (const type of ['price', 'post', 'notice', 'alert']) {
        es.addEventListener(type, (/** @type {MessageEvent} */ ev) => {
          try { on(type, JSON.parse(ev.data)); } catch { /* ignore malformed */ }
        });
      }
      es.onerror = () => on('status', { connected: false });
      es.onopen = () => on('status', { connected: true });
      return () => es.close();
    },
  };
}

/** @typedef {ReturnType<typeof createApi>} Api */

/**
 * Options from the page URL: ?demo=1, ?still=1.
 * @param {string} search
 */
export function urlOptions(search) {
  const p = new URLSearchParams(search);
  return { demo: p.get('demo') === '1', still: p.get('still') === '1' };
}
