// Demo backend: answers the local API routes (DESIGN §7) from the bundled sample data,
// in memory. The client (api.js) talks to this exactly as it talks to the real API, so
// demo mode exercises the same code path and the same response shapes.

import { buildSample, sampleCandles, sampleDetail, sampleMarkets, sampleContracts, coinSymbolOf, mkKey } from './sample.js';
import { tickers as textTickers, isKey, addressKind, validHandle, validUrl } from './lib/text.js';
import { h32 } from './lib/keyprint.js';

export const PROFILES = Object.freeze({
  small: { budgetPerMin: 60, storageCapMB: 1500, follows: 100 },
  normal: { budgetPerMin: 240, storageCapMB: 4000, follows: 300 },
  large: { budgetPerMin: 900, storageCapMB: 10240, follows: 500 },
});
const ORDER = ['small', 'normal', 'large'];

class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) { super(message); this.status = status; }
}

// Four abstract 96×96 WebP pictures (cwebp -q 70) so sample mode shows signed avatars next to key-prints.
const SAMPLE_AVATARS = {
  '@deskmole': 'UklGRhIDAABXRUJQVlA4IAYDAAAwEwCdASpgAGAAPp1Gn0olo6MhrHN5cLATiWgAzQoffsHY9ea6HygWppQf8y5wH23eqh0gPMB+uXUA9AD+odQZ6AH65enB7IP7o+ktqrcIMoHgBpAmUN3Z+xhrnOSohQDCEa1tjv5KcsUiWrhws9yrscoTKUZ7dC38o7Szxk07U23WMFHH5aJEpSsZFQmpLtdcjt2TvMGQvWRBknsM4X/4HQAA/vA4OT41WLKZ8MWQ+AAA1f0uQ+c81W3xfJ5zyX8v+r2SYdkDLo9pJ8MFNjNOtszhDgutTfzZ8oYwSRpwIk5x1Tatr75QLp0OrUqTnlfkCAxoRgYEpA5G7EkFdG7dp5Ru9vcKCJEW/W950b987rlxW3Y+Chy/up2hjEI0crt1k2DJ13Xkn7XoyVLRNdv6OvZp397CHMG8kQxY0WchVDH827wFJfL47oyJdMrNE/PCanM9jP88AwmsXAiVHJ4nPXFHPbs+PNWm2JvTh0L+pfqaHzT7Yd8a5aYZsaZ2VfmbsHX0Lq3A/YWPcbHrJcTY0y/fivo1u8wee84rYf2tBQeYuUPlE/SQkYzhxBH9W+Wi5BG3e9EzAeWxS+wOkNY9N8mGxp8I7+UAsX3hn0E0r3UqfpO3CcfrOtkTWI8hKiV07IT/Pk8ULoG6o16ujTAVbk+O6Y+MWxqGnDg1Oofce4xlJ6rfhCf8MjH03ovZgGvM22XX1O/JpLPQnmQV2BWHVQ3nuAR/+sdExGL/w0aOMxY2zcLWSB/Xrdkjkob3lXXC8JTuuZxEmYcqL5H+UAZWVGcsY97jPZia3w5dGvAie8FGLAatwQsgZe+MU8Jn4szZyh4lABaNoshxAPtO5ZdTWtA5+dWgHBC3EAx44ikUU1ChpmlvPV3PhuQOCu8sUZlcwUK2PfUxLX9bbEAGFVtnkT6Q3zR/LnV/5/yEatS/rd5uoyDKX0pbNa3wTROff8LNcgrABOAWazIkMioOuPWy32FTrg4YulmunaPVeY4K+dAqMDVUIcW6Y5lB14ciHZ8W7oQQAAA=',
  '@tidewatch': 'UklGRnADAABXRUJQVlA4IGQDAAAQEwCdASpgAGAAPp1Enkolo6KhpzgMALATiWIAxfhJsTwYhL9uAyt3fvrqy83YCqi8ANIEyL/LfUI6Jn7mew9+swNmrcTDEhhjdSVSje5wzXWAVSaqcdOILgu6RoqmA/jNT8liu5r+K0/hUFzYkIn6JNNAjzG+wTigxbHC9ZWjdNiNFTeWFggf5x/2+7tlH48Y3Y/g8f4TLpsE9XPj0A6ywAD+w8SAwiQu5Z/ck/70X9xXZEo4o8SaAcqhXbF4ZIFMPeuFypk1NoOTR3ugIDPr5mpGzSCf+fAVrZ94hKmGZByNDOcKDwYbmHyoDnrNOdcjgyLmI6pIizAOhmKaCsEe18AgHKnvKmM8nHEeHDkHdhJVQW8izilJblm10tP4FaOFwZNfyV3Gv+f99M5+0XLtWOnB7Jqhnb7VWPTju/xZmvfXsML5mxlryQ4FWq9aIsRVzkqpltbMByJU8t1faxhEc53f03KjbrN3F5h7nUx/8P0OtFzqMciWFoNpFRKg27a/1ByJbZifbvl/QiGzFEJIWjrPhDf17yiuAecyjSUjTh2ue+UZTr8sFGeORyLJ7o3xADFdARA9pWD1dx4caiLguyz0XJ+isAe9XzbCSmR93K2Frgm5b7OBswoP8Hd/pdOHf9U0NKMIsR7X3v1ffV/W6zPy+taeEWS/Uflf+NYu2l+LKQ03lIOfUbHXp71rsRf6LbIGiUWdabg2hPDjcqCMT+P73zIV/yDgfmBnivjJmA/4BBhf+31xWY3ZZI8t5HGWALBAPZQbcZkDiD0BBJkE8NlhAdDyRXmUQb4xIRM1xhXknf8L5GUX1R0XUB1B/2vY8F/ttcfglfnVnmInAoh6gOLd7orDpKfGeYeSYGmES4vX1fdyUya204qz3AgpugiYH2b141WOpJHs+ChbIjkFNbn4Vxbz3id7XBdVdbsp+pz1ppDh7R7HWqAswPkCWkGanouagwwNPGgN3nKBE7FPxGL5jwSiM6pMVBS+QzPgzanbjXxwUKo8OrdAueYHwftEp7YqxrOTWnFqKzPF6oQAudmdf/emuFYNo890aZgwK3V0nV/bvUDLHfEOQpC/gRKeIF+4UaFuPq+wFq1uhf8p3wTIP7AAAKkk4hOQEFoY++1IydGn5dT3lDYXcBsufoJbcAAA',
  '@marak': 'UklGRrQCAABXRUJQVlA4IKgCAAAwDwCdASpgAGAAPp1EmkglpCKhMProALATiWIAyrIuX/6A0m22r56KyfcAdz1hyDfA4j+8GOgf0HiR1B+iL+0XsjHMHM4ZS81ejfCvfiv5vSt0oiyuwjWiNvVYFTUuy46/UXon0CC1AGOCPp7KGvy0lZDzo3B/rnU2JbAQGMxI9J6gAP7yqX4ufpwBs0WMDJ5PhHbdi0bkinhV37yLPHoSGGhh9NLzNCvB1yxwXbxHvpGGuIdUGJ+HTi4lkdkRYm25iANDLD6kmpom2Bf991EK0Nf296RsJiTuQeWBmlAOwkYjPL+4qUjzl9YrhhsfLdW95tRxPl7T6lfqkgz/JQw/62GkI3zZAPfXwpmFQUr9gk2nurIaCjjffxcVX+++O8b39Xh+i57SYqwpFsFtjeBjDhxflZ++BuMlR34Imu/7MyXAJTuka5B1ub8LNe5e3FVKXqgo0pJhAR6liH2xYinvj3N+uX/gJiNhll8XXp8jFrRCjf+zUV3yDUJboRsWxvlqTC0LdWFoKr7Gb8WjX2qwRNr3U/bJ5oczo70mceiA2L0JXUwvb2Q8qcdniUvEUsWeXSAjyNgvwXx/1V7zs8OwC9+tkXr0JJkgfQF7KCQvL1vfVAofmuqwh48K9RqHNsCBJSDyahR3JF0Z7pqrcghvwh9Z5rYFc08y2yE4AspdHxuvYX0+kL7BWThY+GC/AFu0x4PcRZsx1Nhu9mXFWwwvyVFY6QnrGsIOYFB2wZx/uIYrN5DkwoD+3Tqj85L373eV9w/1t/MsPHkjBsykJrkr2i9JrgomJoFGhv4V4s2wc7fOX+CJBU8Q6NXzHk826R+hVHZQqKouNaYez/BOUvvzYgHIAABihZ93Hem0AmzRFxPxng59MLCuwz/WvZscI37rTb2hiLgAAA==',
  '@ledgerlark': 'UklGRtAFAABXRUJQVlA4IMQFAACQHgCdASpgAGAAPpU8mkglo6KhN/L6qLASiWIAxvINWx6uE0Ot/Qpz//RBz4HnleoB//+py5+P2Uf8FhNv9m7Ef7B+M3QLSSqVP8H7Z+wH8Hy04lTIC/UWAQ69/b+IX83/4X/l9wX9X/Qa///8G/9HxP/YD/7e4x+lf//Nz/zx0bZCmJgtPQQ8/RA5F/bSfQZMdjESXuTg7T4NYNyNL7XRBxOmCm4WrJP3rIwYtYTpVBc59a9MfBMLD3J/H1zRbA1aOHUQmh+E8HImYnLwAgRMfP9W5TuSAyJDjZwPRpst1zCcRniifzN3w9u6euSB33A2A4xMxMG7yUU2fNyAAP7d3Pdk4G/bGy2oz7Xaprkf8LNrNxWfjMaCu47COfoKpUAEcsLnbKl2Pio5yLIOzqugZ3kbTmaATCKAeVhq1hF33PZkrjlD5T2aI1LwqO4IdHPNxOAEzqGbKlbhcrRJXNQZYYwXjK102f9W1jXH5Ud/MGc4aqaacF1bKOggFzYOHNNAvOEEmmPZFJlgRgnN//2M0BsRYqqc6JILPjbGi8Qn+XgeISz3HNgJIkQGLPVFt2TswgSzTrW4QcoOOFFP4moBzthX49EC8qYqxxWTqCteJbHmwqQK3KWBTCj9NPl/YHq4CHopm0qdtXSqYo0k3ZqdMN1CWrDMvHarxBxryVSyXn5m+SrRH2sBs1K84bBteIk26qyl/EaFsZwW74G8NF1fbEaFp5CEAToYaTxlFJEsV9bi7gBDbfd5AB2abuMiadW8qCtImkr4Ql60nO1srIIN2ZcBj2qOSbnF3Ov2mFj1e/aCQiUgoCzzHxpTJTmxf1N7Ohe3qIkvPHEX5iVrn3kekLzH/aPwnv+l7+7qfCroQYlOu0+dEXRlQbodaeea/5j+v1y70+382Z38W9O48xCCYTOgTvMARfpU9vJsYeZQXVeDlFIXCaqbY4ohz3EmpXos2E8bm2zPtiXVoRkR+HyaESLwamPRApDnu11PLk3ttD5e0E5pKDmYsRFkjWbC7mmMNTVBgsHTagS0Vai9uaqZ7goV6to9v2C/+u+U31sGUalaVZc6XfOITnXa8n84usfKCpyKWnX0Zd++JZxii2/ELS6To0BWRBo+zG+LuHfX/4a//0uxxaATJm1x3wJCGnzYkajCkK3NbFn9O09BfZh8u/vDQew6zdkwvLuwKURvBR9Omb7omABUfdKZluVR2SwNXOYMwoVX/MsgQhZY1BX4A6yXpNKp0OYESNPH43aVjpzdT7d75G7MvQmszwmZDp2/jSUT4dh2Zm1AGJ/CAIqvZYsstXoUc9Y/EA2BjfRw0r9P5S6RSlWyxCheb1S3oSZP0H/di3G7bQ4cR/x3Jp25eCpUJvCVr0N1jEmT96yQivW8LVvbD5EqrfdRuomw9she3Xu1bLknC9qGxjhPIPzTjKXUUQT5tpniikkBamcchoeHBwuDPvg/xKA7uvkSNXrF+DHDuN9RTEKwa+a3tKqH3cx5IXiLpyjsrJwetoFazS2X9u98j0s8LM5O1VJi5FK+gGtoFMESnVC3XCNJs0NCYV8BCT9//Y7czXgqdkSMBQBnm8Myr0cWDri8dW8JsAgh+lQ8LH4cV2SkKrHDhe699EBDW+6f0bhGZ2wDnNqyxdYcYLpnTjK+X6zTxDQdGxF82LOzK5+HXpQAc91tdU1NKKXjRvhyVtv474awTLPRQ7DlYx3RumujCEnH2usqVL0sCMwe/6JA3TXiEqiE8My/l12i2THYcK8VrWyvDIK3b51ZltphsJlc3VY240aZjVB4EEOnpBYMgN+2eD0tOJMvzGZkCZt2HnGp78TxsDKmJF0N1vd/wBv1GmoVcIV6sXSCMvEy1+l1inXiofsWwkKHfUyGUVt4xrH2Hh/INTUYfEcv3qMo6TGUnBifJeKAAADm/zPA/azRVx5mgechBpWH1ScwbRFXfUPDkufkdYg1OK0gAAA=',
};

/**
 * @param {{ now?: () => number }} [opts]
 */
export function createDemoServer(opts = {}) {
  const now = opts.now || (() => Date.now());
  const W = buildSample(now());
  const liked = new Set();
  const reposted = new Set();
  const watch = new Set(W.me.watchlist);
  const mutes = new Map(W.mutes.map((m) => [m.key, m]));
  /** @type {Map<string, {type: string, data: string}>} demo avatars by name */
  const avatars = new Map();
  for (const p of W.people) {
    const data = SAMPLE_AVATARS[p.handle];
    if (!data) continue;
    const hash = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => h32(i + data).toString(16).padStart(8, '0')).join('');
    avatars.set(hash, { type: 'image/webp', data });
    p.avatar = hash;
  }
  let seq = 0;

  const allTokens = () => W.tokens.concat(W.newTokens);
  const tokenById = (id) => allTokens().find((t) => t.id === id) || null;
  const tokenBySym = (s) => allTokens().find((t) => t.symbol === String(s).toUpperCase()) || null;
  const person = (key) => W.people.find((p) => p.key === key) || null;
  const meP = () => W.people.find((p) => p.me);
  const allPosts = () => W.posts.concat(W.replies, W.official);
  const muted = (key) => mutes.has(key);

  /** @param {any} p */
  const decorate = (p) => ({
    ...p, avatar: person(p.key)?.avatar ?? null,
    liked: liked.has(p.id), reposted: reposted.has(p.id),
    likes: p.likes + (liked.has(p.id) ? 1 : 0), reposts: p.reposts + (reposted.has(p.id) ? 1 : 0),
    replies: W.replies.filter((r) => r.parent && r.parent.id === p.id).length || p.replies,
    tickers: textTickers(p.text).map((sym) => ({ sym, asset: tokenBySym(sym)?.id || null })),
  });
  const newest = (a, b) => b.ts - a.ts;
  const organic = (p) => p.kind !== 'promoted';

  const lanes = {
    following: () => W.posts.filter((p) => organic(p) && !muted(p.key) && (person(p.key)?.followed || person(p.key)?.me)),
    official: () => W.official.concat(W.posts.filter((p) => p.product)),
    mentions: () => allPosts().filter((p) => organic(p) && !muted(p.key) && !person(p.key)?.me && (p.text.includes(meP().handle) || (p.parent && p.parent.key === meP().key))),
  };

  /** @param {any} p */
  const profileOut = (p) => ({ ...p, muted: muted(p.key), posts: allPosts().filter((x) => x.key === p.key && organic(x)).length });

  const marketsTab = (tab, q) => {
    let list = W.tokens.slice();
    if (tab === 'watch') list = list.filter((t) => watch.has(t.id));
    if (tab === 'trending') {
      const tp = Object.fromEntries(W.trendingTags.filter((x) => x.tag[0] === '$').map((x) => [x.tag.slice(1), x.posts]));
      list = list.map((t) => ({ ...t, posts: tp[t.symbol] || 0 })).sort((a, b) => b.posts - a.posts || b.volume24h / b.marketCap - a.volume24h / a.marketCap).slice(0, 10);
    }
    if (tab === 'gainers') list = list.filter((t) => t.change24h > 0).sort((a, b) => b.change24h - a.change24h).slice(0, 10);
    if (tab === 'losers') list = list.filter((t) => t.change24h < 0).sort((a, b) => a.change24h - b.change24h).slice(0, 10);
    if (q.category) { const c = q.category === 'Stablecoins' ? 'Stablecoin' : q.category; list = list.filter((t) => t.category === c); }
    if (q.chain) list = list.filter((t) => t.chains.includes(q.chain));
    return list;
  };

  /** ?limit=&offset= as in the real API (default 100, max 500). */
  const page = (list, q) => {
    const limit = q.limit == null ? 100 : Number(q.limit), offset = q.offset == null ? 0 : Number(q.offset);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, 'bad range');
    return list.slice(offset, offset + limit);
  };
  const SORTS = ['rank', 'symbol', 'name', 'price', 'change1h', 'change24h', 'change7d', 'volume24h', 'marketCap', 'fdv'];
  /** ?sort=&order= as in the real API: nulls last, then by id. */
  const sorted = (list, q) => {
    if (!q.sort) return list;
    if (!SORTS.includes(q.sort) || (q.order && !['asc', 'desc'].includes(q.order))) throw new HttpError(400, 'Unknown markets sort');
    const k = q.sort, asc = (q.order || (['rank', 'symbol', 'name'].includes(k) ? 'asc' : 'desc')) === 'asc';
    const v = (t) => (k === 'name' || k === 'symbol' ? String(t[k]).toLowerCase() : t[k]);
    return list.slice().sort((x, y) => {
      const a = v(x), b = v(y);
      if (a == null || b == null) return a == null && b == null ? 0 : a == null ? 1 : -1;
      return (a < b ? -1 : a > b ? 1 : 0) * (asc ? 1 : -1) || String(x.id).localeCompare(String(y.id));
    });
  };

  const assetPosts = (t) => allPosts().filter((p) => organic(p) && !muted(p.key) && new RegExp('\\$' + t.symbol + '\\b').test(p.text));

  const portfolioOut = () => {
    const holdings = W.portfolio.holdings.map((h) => {
      const t = tokenById(h.asset) || tokenBySym(h.symbol);
      return { ...h, name: t?.name, price: t?.price ?? null, change24h: t?.change24h ?? t?.change ?? null, value: t ? h.amount * t.price : null, trust: t?.trust };
    });
    const value = holdings.reduce((s, h) => s + (h.value || 0), 0);
    const prev = holdings.reduce((s, h) => s + (h.value ? h.value / (1 + (h.change24h || 0) / 100) : 0), 0);
    return { value, change24h: prev ? (value / prev - 1) * 100 : 0, holdings, addresses: W.portfolio.addresses };
  };

  /**
   * @param {string} method
   * @param {string} path  e.g. "/assets/btc%3Anative/candles"
   * @param {Record<string,string>} q
   * @param {any} body
   */
  function route(method, path, q, body) {
    const seg = path.replace(/^\/+|\/+$/g, '').split('/').map(decodeURIComponent);
    const [a, b, c] = seg;
    const GET = method === 'GET', POST = method === 'POST';

    if (GET && a === 'global') return W.global;
    if (GET && a === 'network') return { ...W.network, lastUpdate: now() - 2000 };
    if (GET && a === 'fear-greed') return W.fearGreed;
    if (GET && a === 'markets') {
      const tab = q.tab || 'all', list = sorted(marketsTab(tab, q), q);
      // Like the real API: total counts every token, whatever the tab or filter.
      return { items: page(list, q), total: W.tokens.length };
    }
    if (GET && a === 'categories') return { items: page(W.categories, q) };
    if (GET && a === 'chains') return { items: page(W.chains, q) };
    if (GET && a === 'new') return { items: page(W.newTokens.slice().sort((x, y) => x.ageMin - y.ageMin), q) };
    if (GET && a === 'trending') return { items: page(W.trendingTags, q) };
    if (GET && a === 'movers') return { gainers: marketsTab('gainers', {}), losers: marketsTab('losers', {}) };
    if (GET && a === 'exchanges') return { items: page(W.exchanges.filter((e) => !q.kind || e.kind === q.kind.toUpperCase()), q) };
    if (GET && a === 'derivatives') return { items: page(W.derivatives.map((d) => ({ ...d, asset: tokenBySym(d.symbol)?.id })), q) };
    if (GET && a === 'nfts' && !b) return { items: page(W.nfts, q) };
    if (GET && a === 'nfts' && b) throw Object.assign(new Error('unknown collection'), { status: 404 });
    if (GET && a === 'sources') return { at: Date.now(), counts: { ok: 0, slow: 0, failing: 0, 'rate-limited': 0, off: 0 }, groups: [] };

    if (a === 'assets' && b) {
      // A coin's other deployments open the same coin page (the API answers each member with all contracts).
      const member = !tokenById(b) && coinSymbolOf(b);
      const t = tokenById(b) || tokenBySym(b) || (member ? tokenBySym(member) : null);
      if (!t) throw new HttpError(404, 'unknown asset');
      if (GET && !c) return { ...t, watched: watch.has(t.id), ...sampleDetail(t, now()), ...sampleContracts(t, member ? b : undefined), ...(member ? { id: b, contract: b.slice(b.indexOf(":") + 1) } : {}) };
      if (GET && c === 'candles') {
        const tf = ['1m', '5m', '1h', '1d'].includes(q.tf) ? q.tf : '1h';
        return { asset: t.id, tf, candles: sampleCandles(t, tf, Math.min(5000, Number(q.limit) || 0), now()) };
      }
      if (GET && c === 'markets') return { items: sampleMarkets(t) };
      if (GET && c === 'posts') return { items: assetPosts(t).sort(newest).map(decorate) };
    }

    if (GET && a === 'search') {
      const l = String(q.q || '').trim().toLowerCase();
      if (!l) return { tokens: [], profiles: [], posts: [], address: null };
      const s = l.replace(/^\$/, '');
      const tokens = allTokens().filter((t) => t.symbol.toLowerCase().includes(s) || t.name.toLowerCase().includes(l) || (l.length >= 8 && t.id.toLowerCase().includes(l))).sort((x, y) => (x.symbol.toLowerCase() === s ? -1 : 0) - (y.symbol.toLowerCase() === s ? -1 : 0) || (x.rank || 999) - (y.rank || 999)).slice(0, 6);
      const handle = l.replace(/^@/, '');
      const profiles = W.people.filter((p) => !p.me && (p.handle.slice(1).includes(handle) || p.name.toLowerCase().includes(l) || p.key.startsWith(l))).slice(0, 5).map(profileOut);
      const posts = allPosts().filter((p) => organic(p) && p.text.toLowerCase().includes(l)).sort(newest).slice(0, 5).map(decorate);
      const kind = addressKind(q.q);
      return { tokens, profiles, posts, address: kind ? { kind, value: String(q.q).trim() } : null };
    }

    if (GET && a === 'feed') {
      let list;
      if (q.author) list = allPosts().filter((p) => p.key === q.author && organic(p));
      else if (q.asset) { const t = tokenById(q.asset); list = t ? assetPosts(t) : []; }
      else list = (lanes[q.lane] || lanes.following)();
      // ?before=<ts> cursor and ?limit= (max 100), as in the real API.
      const before = q.before == null ? Infinity : Number(q.before), limit = Math.min(100, Number(q.limit) || 100);
      return { items: list.filter((p) => q.asset || p.ts < before).sort(newest).slice(0, limit).map(decorate) };
    }
    if (GET && a === 'posts' && b && c) {
      const p = allPosts().find((x) => x.key === b && x.id === c);
      if (!p) throw new HttpError(404, 'post not found or expired');
      const parents = [];
      let cur = p;
      while (cur.parent) { const up = allPosts().find((x) => x.id === cur.parent.id); if (!up) break; parents.unshift(decorate(up)); cur = up; }
      const replies = W.replies.filter((r) => r.parent && r.parent.id === p.id && !muted(r.key)).sort((x, y) => x.ts - y.ts).map(decorate);
      return { post: decorate(p), parents, replies };
    }
    if (GET && a === 'profiles' && b) {
      const p = b === 'me' ? meP() : person(b);
      if (!p) {
        if (isKey(b)) return { key: b, handle: null, name: null, unknown: true, followed: false, muted: muted(b), posts: 0, followers: 0, following: 0, proofs: {}, harnesses: [] };
        throw new HttpError(404, 'unknown profile');
      }
      return profileOut(p);
    }
    if (GET && a === 'directory') {
      const l = String(q.q || '').toLowerCase().replace(/^@/, '');
      const list = W.people.filter((p) => !p.me && (!q.topic || p.topics.includes(q.topic)) && (!l || p.handle.includes(l) || p.name.toLowerCase().includes(l) || p.bio.toLowerCase().includes(l) || p.topics.some((t) => t.includes(l))));
      const topics = [...new Set(W.people.flatMap((p) => p.topics))].filter((t) => t !== 'official');
      return { items: list.map(profileOut), topics };
    }

    if (GET && a === 'me') return { ...W.me, watchlist: [...watch], ...profileOut(meP()), profile: W.settings.profile, avatarRoom: 2436 };
    if (GET && a === 'avatars' && b) {
      const image = avatars.get(b);
      if (!image) throw new HttpError(404, 'unknown avatar');
      return { hash: b, ...image };
    }
    if (GET && a === 'collisions') return { items: [] };
    if (GET && a === 'watchlist') return { items: [...watch] };
    if (GET && a === 'portfolio') return portfolioOut();
    if (GET && a === 'alerts') return { items: W.alerts.map((x) => ({ ...x, price: tokenById(x.asset)?.price ?? null })) };
    if (GET && a === 'extras') {
      return {
        items: W.extras.filter((x) => x.until > now()).map((x) => {
          if (x.post) { const p = allPosts().find((y) => y.id === x.post.id); return p ? { ...x, post: decorate(p) } : null; }
          return { ...x, token: tokenById(x.asset) };
        }).filter(Boolean),
      };
    }
    if (GET && a === 'settings') return { ...W.settings, profiles: PROFILES, mutes: [...mutes.values()], follows: W.people.filter((p) => p.followed && !p.me).map(profileOut) };

    // ---- writes ----
    if (POST && a === 'avatar') {
      const m = meP();
      if (body?.remove) m.avatar = null;
      else {
        const hit = /^data:(image\/(?:png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(body?.data || ''));
        if (!hit || hit[2].length > 8192) throw new HttpError(400, 'avatar: a square 96×96 WebP or PNG of at most 6 KB, without animation or metadata');
        // The demo has no SHA-256 at hand synchronously; any stable 64-hex name will do here.
        const hash = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => h32(i + hit[2]).toString(16).padStart(8, '0')).join('');
        avatars.set(hash, { type: hit[1], data: hit[2] });
        m.avatar = hash;
      }
      return { ...profileOut(m), avatarRoom: 2436 };
    }
    if (POST && (a === 'posts' || a === 'replies')) {
      const text = String(body?.text || '');
      if (!text.trim()) throw new HttpError(400, 'empty');
      if ([...text].length > 500) throw new HttpError(400, 'too long');
      const m = meP();
      const p = { id: h32('mine' + seq++ + text).toString(16).padStart(16, '0'), key: m.key, author: m.name, handle: m.handle, agent: true, verified: false, official: false, product: null, kind: a === 'replies' ? 'reply' : 'post', ts: now(), text, likes: 0, replies: 0, reposts: 0 };
      if (a === 'replies') {
        if (!body?.parent?.id) throw new HttpError(400, 'parent required');
        p.parent = { key: body.parent.key, id: body.parent.id };
        W.replies.push(p);
      } else W.posts.unshift(p);
      return decorate(p);
    }
    if (POST && (a === 'likes' || a === 'reposts')) {
      const id = body?.target?.id;
      const set = a === 'likes' ? liked : reposted;
      if (!id) throw new HttpError(400, 'target required');
      if (body.undo) set.delete(id); else set.add(id);
      const p = allPosts().find((x) => x.id === id);
      return p ? decorate(p) : { ok: true };
    }
    if (POST && (a === 'follow' || a === 'unfollow')) {
      const p = person(body?.key);
      if (!p) throw new HttpError(404, 'unknown key');
      if (p.official && a === 'unfollow') throw new HttpError(400, 'the official channel cannot be unfollowed');
      p.followed = a === 'follow';
      p.followers += a === 'follow' ? 1 : -1;
      return profileOut(p);
    }
    if (POST && (a === 'mute' || a === 'unmute')) {
      const key = body?.key;
      if (!isKey(key)) throw new HttpError(400, 'bad key');
      const p = person(key);
      if (p?.official) throw new HttpError(400, 'the official channel cannot be muted');
      if (a === 'mute') mutes.set(key, { key, handle: p?.handle || null, name: p?.name || null, by: 'you', ts: now() });
      else mutes.delete(key);
      return { key, muted: a === 'mute' };
    }
    if (POST && a === 'watchlist') {
      const t = tokenById(body?.asset);
      if (!t) throw new HttpError(404, 'unknown asset');
      if (body.on === false) watch.delete(t.id); else watch.add(t.id);
      return { items: [...watch] };
    }
    if (POST && a === 'alerts') {
      if (body?.remove) { W.alerts = W.alerts.filter((x) => x.id !== body.id); return { items: W.alerts }; }
      const t = tokenById(body?.asset);
      const v = Number(body?.value);
      if (!t || !['above', 'below', 'move'].includes(body?.op) || !(v > 0)) throw new HttpError(400, 'bad alert');
      W.alerts.push({ id: 'al' + (100 + seq++), asset: t.id, symbol: t.symbol, op: body.op, value: v, created: now() });
      return { items: W.alerts };
    }
    if (POST && a === 'portfolio') {
      const op = body?.op;
      if (op === 'add-holding') {
        const t = tokenById(body.asset); const amt = Number(body.amount);
        if (!t || !(amt > 0)) throw new HttpError(400, 'bad holding');
        const ex = W.portfolio.holdings.find((h) => h.asset === t.id && h.source === 'manual');
        if (ex) ex.amount = amt; else W.portfolio.holdings.push({ asset: t.id, symbol: t.symbol, amount: amt, source: 'manual' });
      } else if (op === 'remove-holding') {
        W.portfolio.holdings = W.portfolio.holdings.filter((h) => !(h.asset === body.asset && h.source === 'manual'));
      } else if (op === 'add-address') {
        const kind = addressKind(body.address);
        if (!kind) throw new HttpError(400, 'not an address');
        W.portfolio.addresses.push({ id: 'a' + (10 + seq++), chain: body.chain || (kind === 'evm' ? 'Ethereum' : kind === 'sol' ? 'Solana' : 'Bitcoin'), address: String(body.address).trim(), label: String(body.label || '').slice(0, 40), value: null });
      } else if (op === 'remove-address') {
        W.portfolio.addresses = W.portfolio.addresses.filter((x) => x.id !== body.id);
      } else throw new HttpError(400, 'bad op');
      return portfolioOut();
    }
    if (method === 'PUT' && a === 'settings') {
      const s = W.settings, p = body || {};
      if (p.profile) {
        if (!ORDER.includes(p.profile) || ORDER.indexOf(p.profile) > ORDER.indexOf(s.profileDetected)) throw new HttpError(400, 'profile can only be lowered');
        s.profile = p.profile;
        s.budgetPerMin = Math.min(s.budgetPerMin, PROFILES[p.profile].budgetPerMin);
        s.storageCapMB = Math.min(s.storageCapMB, PROFILES[p.profile].storageCapMB);
      }
      if (p.budgetPerMin != null) {
        const v = Math.round(Number(p.budgetPerMin));
        if (!(v >= 10) || v > PROFILES[s.profile].budgetPerMin) throw new HttpError(400, 'budget out of range');
        s.budgetPerMin = v;
      }
      if (p.storageCapMB != null) {
        const v = Math.round(Number(p.storageCapMB));
        if (!(v >= 100) || v > PROFILES[s.profile].storageCapMB) throw new HttpError(400, 'storage out of range');
        s.storageCapMB = v;
      }
      if (p.agent) for (const k of Object.keys(s.agent)) if (typeof p.agent[k] === 'boolean') s.agent[k] = p.agent[k];
      if (typeof p.officialMutes === 'boolean') s.officialMutes = p.officialMutes;
      if (p.theme && ['system', 'light', 'dark'].includes(p.theme)) s.theme = p.theme;
      if (p.endpoint) {
        const e = p.endpoint;
        if (e.remove) s.endpoints = s.endpoints.filter((x) => x.id !== e.id);
        else {
          if (!validUrl(e.url)) throw new HttpError(400, 'bad url');
          s.endpoints.unshift({ id: 'e' + (10 + seq++), kind: e.kind || 'rpc', chain: e.chain || 'Ethereum', url: e.url, label: String(e.label || '').slice(0, 40), health: 'checking', latencyMs: null });
        }
      }
      if (p.moveEndpoint) {
        const i = s.endpoints.findIndex((x) => x.id === p.moveEndpoint.id), j = i + (p.moveEndpoint.by < 0 ? -1 : 1);
        if (i >= 0 && j >= 0 && j < s.endpoints.length) [s.endpoints[i], s.endpoints[j]] = [s.endpoints[j], s.endpoints[i]];
      }
      if (p.card) {
        const m = meP(), cd = p.card;
        if (cd.handle != null) { if (!validHandle(cd.handle)) throw new HttpError(400, 'handle: 2–24 of a–z, 0–9, _'); m.handle = '@' + cd.handle; W.me.handle = m.handle; }
        if (cd.name != null) { m.name = String(cd.name).slice(0, 40); W.me.name = m.name; }
        if (cd.bio != null) { if ([...String(cd.bio)].length > 160) throw new HttpError(400, 'bio: 160 characters max'); m.bio = String(cd.bio); }
        if (cd.dns != null) m.proofs = { ...m.proofs, dns: cd.dns ? { value: String(cd.dns), ok: false } : undefined };
        if (cd.github != null) m.proofs = { ...m.proofs, github: cd.github ? { value: String(cd.github), ok: false } : undefined };
      }
      return route('GET', '/settings', {}, null);
    }
    throw new HttpError(404, 'no route');
  }

  /** Simulated live updates for the SSE stream. */
  function tick() {
    const t = W.tokens[Math.floor(Math.random() * 12)];
    const step = (Math.random() - 0.5) * (t.category === 'Stablecoin' ? 0.0002 : 0.002);
    t.price = t.price * (1 + step);
    t.change24h = Math.round((t.change24h + step * 100) * 100) / 100;
    return { type: 'price', data: { id: t.id, symbol: t.symbol, price: t.price, change24h: t.change24h } };
  }

  return { route, tick, world: W, HttpError, mkKey };
}
