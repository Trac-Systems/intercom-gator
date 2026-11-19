// A small hash router. Pure: parse() and href() run in Node for tests.
//
//   #/                      markets (tab "all")
//   #/markets/:tab          markets with a tab (watch, trending, gainers, losers, categories, chains, derivatives, nfts, exchanges)
//   #/token/:id             token page (id = asset id, e.g. "eth:0x6982…", "btc:native")
//   #/nft/:id               NFT collection page (id = "<chain>:<contract>")
//   #/new                   new tokens
//   #/exchanges             exchanges
//   #/feed[/:lane]          feed: following | official | mentions
//   #/post/:key/:id         thread view
//   #/u/:key                profile (key = 64-hex, or "me")
//   #/channels              explore channels
//   #/portfolio             portfolio
//   #/settings[/:section]   settings
// Query strings after "?" inside the hash are kept in `query` (e.g. #/markets?cat=Meme).

export const ROUTES = [
  ['markets', ''],
  ['markets', 'markets/:tab'],
  ['token', 'token/:id'],
  ['nft', 'nft/:id'],
  ['new', 'new'],
  ['exchanges', 'exchanges'],
  ['feed', 'feed'],
  ['feed', 'feed/:lane'],
  ['post', 'post/:key/:id'],
  ['profile', 'u/:key'],
  ['channels', 'channels'],
  ['portfolio', 'portfolio'],
  ['settings', 'settings'],
  ['settings', 'settings/:section'],
];

/** @typedef {{ name: string, params: Record<string,string>, query: Record<string,string>, path: string }} Route */

/**
 * @param {string} hash e.g. "#/token/eth%3A0xabc?x=1"
 * @returns {Route}
 */
export function parse(hash) {
  let h = String(hash || '').replace(/^#/, '').replace(/^\/+/, '');
  let qs = '';
  const qi = h.indexOf('?');
  if (qi >= 0) { qs = h.slice(qi + 1); h = h.slice(0, qi); }
  h = h.replace(/\/+$/, '');
  /** @type {Record<string,string>} */
  const query = {};
  for (const [k, v] of new URLSearchParams(qs)) query[k] = v;
  const parts = h ? h.split('/') : [];
  for (const [name, pattern] of ROUTES) {
    const pp = pattern ? pattern.split('/') : [];
    if (pp.length !== parts.length) continue;
    /** @type {Record<string,string>} */
    const params = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i][0] === ':') {
        let v;
        try { v = decodeURIComponent(parts[i]); } catch { ok = false; break; }
        if (!v) { ok = false; break; }
        params[pp[i].slice(1)] = v;
      } else if (pp[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { name, params, query, path: '/' + h };
  }
  return { name: 'notfound', params: {}, query, path: '/' + h };
}

/**
 * Build a hash href.
 * @param {string} name
 * @param {Record<string,string|undefined>} [params]
 * @param {Record<string,string|undefined>} [query]
 */
export function href(name, params = {}, query = {}) {
  const e = (v) => encodeURIComponent(String(v));
  let p;
  switch (name) {
    case 'markets': p = params.tab && params.tab !== 'all' ? 'markets/' + e(params.tab) : ''; break;
    case 'token': p = 'token/' + e(params.id); break;
    case 'nft': p = 'nft/' + e(params.id); break;
    case 'feed': p = params.lane && params.lane !== 'following' ? 'feed/' + e(params.lane) : 'feed'; break;
    case 'post': p = 'post/' + e(params.key) + '/' + e(params.id); break;
    case 'profile': p = 'u/' + e(params.key); break;
    case 'settings': p = params.section ? 'settings/' + e(params.section) : 'settings'; break;
    default: p = name;
  }
  const q = Object.entries(query).filter(([, v]) => v != null && v !== '');
  return '#/' + p + (q.length ? '?' + new URLSearchParams(/** @type {any} */ (q)).toString() : '');
}

/** Which main nav item a route belongs to. @param {Route} r */
export function navKey(r) {
  switch (r.name) {
    case 'post': return 'feed';
    case 'profile': return r.params.key === 'me' ? 'settings' : 'channels';
    case 'token': return 'markets';
    case 'nft': return 'markets';
    case 'notfound': return 'markets';
    default: return r.name;
  }
}
