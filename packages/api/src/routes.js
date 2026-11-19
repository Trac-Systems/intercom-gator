import { createHash } from 'node:crypto';
import { RpcClient } from '@gator/engine';
import { cleanTopics } from '@gator/social';
import { addressKind, isKey } from '../../dashboard/public/js/lib/text.js';
import { isCard } from '../../social/src/validate.js';
import { socialViews } from './social.js';
import { avatarInput } from './avatar.js';
import { marketViews, integer } from './markets.js';
import { extrasRoutes } from './extras.js';
import { editedCard, patchConfig, profiles, rpcEndpoints, saveConfig } from './config.js';
import { check, HttpError } from './local.js';
import { withLogos } from '../../engine/src/logos/rows.js';
import { FocusError } from '../../engine/src/focus/index.js';

const socialWrites = ['posts','replies','likes','reposts','follow','unfollow','mute','unmute'];
const AVATAR_HASH = /^[0-9a-f]{64}$/;
const items = rows => ({ items: rows });

/** Plain caveat for any price that is not green (R-APP-01): agents must not act on it alone. */
export function priceCaveat(trust, price) {
  if (trust === 'green') return null;
  if (price == null) return 'No USD price has been observed for this asset.';
  if (trust === 'red') return 'Low trust (red): sources disagree or the observations are stale. Do not act on this price.';
  return 'Low trust (' + (trust ?? 'unrated') + '): too few independent reporters confirm this price. Verify it before acting on it.';
}
const withCaveat = (value, trust, price) => { const caveat = priceCaveat(trust, price); return caveat ? { ...value, caveat } : value; };

/** Shared dashboard and MCP dispatch. Only a dashboard session or the local owner CLI can change agent policy. */
export function createRouter(app) {
  const { store, social, engine, intel, release, account } = app;
  const people = socialViews(app), market = marketViews(app, people), own = app.transport.publicKey;
  const extra = extrasRoutes(app, market);
  // Distinct keys active in the last 24 h: market reports, social messages and profile cards, plus this node.
  // One key per agent (reports and posts are signed with the same identity). Cached for a minute.
  const activeQuery = store.reader.prepare(`SELECT count(*) AS n FROM (
    SELECT reporter AS key FROM store_reporters_seen WHERE at>=:since UNION SELECT key FROM social_seen WHERE first_at>=:since
    UNION SELECT key FROM profiles WHERE received_at>=:since UNION SELECT :own)`);
  let active = { at: -Infinity, n: 0 };
  const agents24h = () => {
    if (app.clock() - active.at >= 60_000) active = { at: app.clock(), n: activeQuery.get({ since: app.clock() - 86_400_000, own }).n };
    return active.n;
  };
  for (const type of ['post','notice']) social.on(type, post => app.events.emit(type, people.decorate(post)));
  const watchlist = () => store.listWatchlist().map(r => r.asset);
  function assetState(id) {
    const { visibility, staleSince } = store.getAsset(id);
    return { visibility, staleSince };
  }
  function watchRows() {
    engine.book.refresh();
    const ids = watchlist();
    return { items: ids, states: Object.fromEntries(ids.map(id => [id, assetState(id)])) };
  }
  function withStates(result, field) {
    return { ...result, [field]: result[field].map(row => ({ ...row, ...assetState(row.asset) })) };
  }
  // The effective bundle: the signed release plus accepted root patches.
  const publicEndpoints = () => engine.bundle.chains.flatMap(c => c.endpoints);
  function authorKey(input) {
    if (input === 'me') return own;
    check(typeof input === 'string', 'unknown key', 404);
    if (isKey(input)) return input;
    const key = social.resolveHandle(input);
    if (key) return key;
    // The shared resolver returns null for both cases. Preserve the HTTP conflict response for a visible tie.
    const handle = input.replace(/^@/, '').toLowerCase();
    const known = store.reader.prepare('SELECT 1 FROM profiles WHERE handle=? AND key NOT IN social_hidden LIMIT 1').get(handle);
    if (known) throw new HttpError(409, 'ambiguous handle');
    throw new HttpError(404, 'unknown key');
  }
  function settings(owner) {
    const patches = engine.patches.status();
    return { ...app.config, agent: { ...app.config.agent, filesHourly: true }, profileDetected: app.detected, profiles,
      endpoints: app.config.endpoints.map(e => {
        const id = createHash('sha256').update(e.url).digest('hex').slice(0,16);
        const health = store.getEndpointHealth(id);
        return { ...e, url: owner ? e.url : new URL(e.url).origin, health: health?.failures ? 'down' : health?.lastSuccess ? 'ok' : 'checking', latencyMs: null };
      }), bundle: { version: engine.patches.digest().slice(0,16), endpoints: publicEndpoints().length,
        healthy: publicEndpoints().filter(e => e.verified?.ok).length, patch: patches.patches, patches,
        verified: true },
      follows: people.follows(), mutes: people.mutes() };
  }
  async function publishCard(card, topics) {
    if (card.avatar) {
      const room = social.avatarRoom(card, { topics });
      const size = Buffer.from(card.avatar, 'base64').length;
      check(size <= room, 'avatar: ' + size + ' bytes; this card has room for ' + room + ' (the image travels inside the signed card)', 413);
    }
    check(await social.setCard(card, { topics }), 'profile update rate limited', 429);
  }
  async function editProfile(patch) {
    let topics;
    if (patch.topics !== undefined) {
      try { topics = cleanTopics(patch.topics ?? []); }
      catch (error) { throw new HttpError(400, error.message); }
    }
    const card = editedCard(social.card(own), patch, own);
    check(isCard(card, own, release.rootKey), 'invalid profile card');
    await publishCard(card, topics);
  }
  /** POST /avatar: { data } base64, { path } an absolute local file the node reads, or { remove: true }. */
  async function setAvatar(b, owner) {
    if (!owner) check(app.config.agent.agentPosting, 'agent posting is disabled', 403);
    const remove = b.remove === true;
    const image = remove ? null : await avatarInput(b);
    const card = editedCard(social.card(own), { avatar: image?.base64 ?? null }, own);
    check(isCard(card, own, release.rootKey), 'invalid profile card');
    await publishCard(card);
    return { ...people.profile(own), avatarRoom: social.avatarRoom(card) };
  }
  async function updateSettings(b) {
    const previous = app.config;
    const next = patchConfig(previous, b, app.detected);
    if (b.card) await editProfile(b.card);
    saveConfig(app.dataDir, next);
    app.config = next;
    social.setUseRootMutes(next.officialMutes);
    if (previous.profile !== next.profile) {
      engine.profile = next.profile;
      engine.focus.resize();
      engine.budget.ceiling = profiles[next.profile].budgetPerMin;
      social.followCap = social.limits.followCap = profiles[next.profile].follows;
      await social.maintain();
    }
    engine.localLimit = next.budgetPerMin;
    engine.budget.setLimit(next.budgetPerMin);
    engine.control(store.getSetting('engine-settings'));
    if (JSON.stringify(previous.endpoints) !== JSON.stringify(next.endpoints)) {
      const rpc = engine.rpc;
      const replacement = new RpcClient({ endpoints: Object.fromEntries(engine.catalog.chains.map(c => [c.id,c.endpoints])),
        userEndpoints: rpcEndpoints(release, next, engine.bundle), aliases: rpc.aliases, loadHealth: id => store.getEndpointHealth(id),
        clock: app.clock, budget: engine.budget });
      // Preserve accumulated per-endpoint limits and in-flight calls when reordering.
      for (const entries of replacement.chains.values()) for (const entry of entries) {
        if (rpc.buckets.has(entry.url)) entry.bucket = rpc.buckets.get(entry.url);
        replacement.buckets.set(entry.url, entry.bucket);
      }
      rpc.chains = replacement.chains;
      rpc.buckets = replacement.buckets;
    }
    return settings(true);
  }
  async function get(parts, q, owner) {
    const [route, key, sub] = parts;
    if (route === 'assets' && key && parts.length <= 3) {
      if (sub === 'coverage') return engine.focus.coverage(focusId(key));
      const id = market.resolve(key);
      if (!sub) { const t = market.detail(id); return withCaveat(t, t.trust, t.price); }
      if (sub === 'markets') return market.marketPage(id, { limit: integer(q.limit, 100, 500, 1), offset: integer(q.offset, 0, 1_000_000) });
      if (sub === 'candles') return market.candles(id, q);
      if (sub === 'posts') return people.feed({ asset: id }, integer(q.limit,100,100,1));
      if (sub === 'price') {
        engine.book.refresh();
        const p = store.getAsset(id);
        const price = p?.price == null ? null : +p.price, trust = p?.trust ?? null;
        return withCaveat({ id, symbol: p?.symbol ?? null, price, trust, at: p?.at ?? null, change24h: p?.change24h ?? null,
          visibility: p?.visibility ?? 'unconfirmed', staleSince: p?.staleSince ?? null }, trust, price);
      }
      if (sub === 'why-trusted') return { id, why: market.why(id) };
      // GET is side-effect free (R-APP-10): the last result only. POST runs a fresh check, which spends budget.
      if (sub === 'risk') return risk(id, false);
      if (sub === 'sentiment') return intel.sentiment(id);
    }
    if (route === 'nfts' && parts.length === 2) {
      const collection = engine.nfts.detail(key, { limit: integer(q.limit, 50, 200, 1) });
      check(collection, 'unknown collection', 404);
      return collection;
    }
    if (route === 'profiles' && parts.length === 2) {
      check(key === 'me' || /^[0-9a-f]{64}$/.test(key), 'unknown profile', 404);
      const profileKey = key === 'me' ? own : key;
      social.profile(profileKey, { verify: true });
      return people.profile(profileKey);
    }
    if (route === 'posts' && parts.length === 3) return people.thread({ key, id: sub });
    if (route === 'avatars' && parts.length === 2) {
      // Content-addressed: the same hash always names the same bytes.
      const image = AVATAR_HASH.test(key) ? social.avatar(key) : null;
      check(image, 'unknown avatar', 404);
      return { hash: image.hash, type: image.type, data: image.base64 };
    }
    check(parts.length === 1, 'no route', 404);
    const limit = integer(q.limit, 100, 500, 1), offset = integer(q.offset, 0, 1_000_000);
    const paging = { include: q.include, limit, offset, now: app.clock?.() };
    switch (route) {
      case 'me': return { ...people.profile(own), watchlist: watchlist(), profile: app.config.profile,
        avatarRoom: social.avatarRoom(social.card(own)) };
      case 'global': return engine.global();
      case 'network': return { ...engine.network(), peers: app.transport.peerCount(), storageCapMB: app.config.storageCapMB,
        agents24h: agents24h(), blindRelay: app.transport.relayStats?.() ?? null, patches: engine.patches.status() };
      case 'fear-greed': return intel.fearGreed.snapshot();
      // GET only reads. POST /briefing also records the read (MCP acknowledges its reads that way).
      case 'briefing': return briefing(q, false);
      case 'markets': {
        const tab = q.tab ?? 'all';
        check(['all','watch','trending','gainers','losers'].includes(tab), 'unknown markets tab');
        const category = q.category === 'Stablecoins' ? 'Stablecoin' : q.category;
        const chain = engine.bundle.chains.find(c => c.name === q.chain)?.id ?? q.chain;
        const options = { tab, category, chain, sort: q.sort, order: q.order, ...paging };
        // One row per coin: the counters cover the collapsed list.
        const { items: rows, total, hidden } = engine.queries.marketList(options);
        return { items: rows, total, hidden };
      }
      case 'categories': case 'chains': {
        const rows = engine.markets({ tab: route, ...paging });
        return { items: rows, hidden: store.marketCounts({ categorized: route === 'categories', now: paging.now }).hidden };
      }
      // Collections measured from this node's own marketplace log scans; "floor" is a sale floor, never a listing floor.
      case 'nfts': {
        const chain = engine.bundle.chains.find(c => c.name === q.chain)?.id ?? q.chain;
        const { items: rows, total } = engine.nftCollections({ chain, limit, offset });
        return { items: rows.map(t => ({ ...t, collection: t.name })), total, status: engine.nfts.status() };
      }
      // Upstreams by host name only: never paths, keys or a user's full endpoint URL.
      case 'sources': return engine.sources();
      case 'derivatives': return engine.queries.derivativeList(paging);
      case 'new': return market.newTokens(paging);
      case 'exchanges': return engine.queries.exchangeList({ ...paging, kind: q.kind });
      case 'trending': return items(people.trending().slice(offset, offset + limit));
      case 'movers': {
        const up = engine.queries.marketList({ tab: 'gainers', ...paging }), down = engine.queries.marketList({ tab: 'losers', ...paging });
        const hidden = { ...up.hidden };
        for (const reason of Object.keys(hidden)) hidden[reason] += down.hidden[reason];
        return { gainers: up.items, losers: down.items, hidden };
      }
      case 'search': {
        const query = (q.q ?? '').trim();
        if (!query) return { tokens: [], profiles: [], posts: [], address: null };
        check(query.length <= 256, 'query too long');
        const kind = addressKind(query);
        return { tokens: engine.search(query.replace(/^\$/, ''), { limit: 6 }), profiles: people.directory({ q: query }).items.slice(0,5),
          posts: people.searchPosts(query), address: kind ? { kind, value: query } : null };
      }
      case 'feed': return people.feed(q.author && !q.asset ? { ...q, author: authorKey(q.author) } : q, Math.min(100,limit));
      case 'directory': return people.directory(q);
      case 'watchlist': return watchRows();
      case 'focus': return engine.focus.list();
      case 'portfolio': engine.book.refresh(); return withStates(account.portfolio(), 'holdings');
      case 'alerts': engine.book.refresh(); return withStates(account.alerts(), 'items');
      case 'extras': return extra.list(q.slot);
      case 'settings': return settings(owner);
      case 'collisions': return { items: engine.collisions() };
      default: throw new HttpError(404, 'no route');
    }
  }
  function focusId(asset) {
    return engine.focus.tokenChain(asset) ? asset : market.resolve(asset, false);
  }
  async function risk(id, fresh) {
    const token = engine.registry.assets.get(id);
    const supported = engine.registry.chains.get(token?.chain)?.family === 'evm' && /^0x[0-9a-f]{40}$/.test(token.address);
    if (!supported) return { asset: id, risk: null, reason: 'This check requires an EVM token contract.' };
    if (fresh) return { asset: id, risk: await intel.risk.checkRisk(id) };
    const last = intel.risk.get(id) ?? store.getRisk(id);
    return last ? { asset: id, risk: last } : { asset: id, risk: null, reason: 'Not checked yet. POST to this route runs a check.' };
  }
  async function briefing(q, acknowledge) {
    const since = q.since === undefined || q.since === '' ? app.lastBriefingRead() : integer(q.since, 0, app.clock());
    const facts = await intel.briefing({ since });
    if (acknowledge) store.setSetting('intel:briefing:lastRead', Math.max(facts.at, store.getSetting('intel:briefing:lastRead') ?? 0));
    return facts;
  }
  let writes = Promise.resolve();
  async function change(method, parts, b, owner) {
    check(parts.length === 1, 'no route', 404);
    const [route] = parts;
    if (method === 'POST' && route === 'briefing') return briefing(b, true);
    if (method === 'POST' && route === 'avatar') return setAvatar(b, owner);
    if (method === 'POST' && route === 'profile') {
      if (!owner) check(app.config.agent.agentPosting, 'agent posting is disabled', 403);
      check(b && typeof b === 'object' && !Array.isArray(b) && Object.keys(b).length &&
        Object.keys(b).every(k => ['handle','name','bio','links','topics'].includes(k)), 'bad profile edit');
      await editProfile(b);
      return people.profile(own);
    }
    if (method === 'PUT' && route === 'settings') {
      check(owner, 'owner session required', 403);
      return updateSettings(b);
    }
    check(method === 'POST', 'no route', 404);
    if (socialWrites.includes(route)) {
      if (!owner) {
        const rules = app.config.agent;
        if (['posts','replies','likes','reposts'].includes(route)) check(rules.agentPosting, 'agent posting is disabled', 403);
        if (route === 'replies') check(rules.agentReplies, 'agent replies are disabled', 403);
        if (['follow','unfollow'].includes(route)) check(rules.agentFollow, 'agent follow is disabled', 403);
      }
      if (route === 'follow' || route === 'unfollow') return people.write(route, { ...b, key: authorKey(b.key) });
      return people.write(route, b);
    }
    if (route === 'watchlist') {
      const id = market.resolve(b.asset, false);
      if (b.on === false) store.unwatch(id); else store.watch(id, app.clock());
      return watchRows();
    }
    if (route === 'alerts') { engine.book.refresh(); return withStates(account.editAlert(b), 'items'); }
    if (route === 'portfolio') { engine.book.refresh(); return withStates(account.editPortfolio(b), 'holdings'); }
    throw new HttpError(404, 'no route');
  }
  return async function request(method, path, q = {}, body = {}, owner = false) {
    let parts;
    try { parts = path.replace(/^\//, '').split('/').map(decodeURIComponent); }
    catch { throw new HttpError(400, 'bad path'); }
    if (method === 'GET') {
      const result = await get(parts, q, owner);
      return withLogos(engine.logos, parts[0], result, parts[0] === 'assets' ? parts[2] : undefined);
    }
    // A risk check waits on RPCs; it must not hold up the serialized social and settings writes.
    if (method === 'POST' && parts.length === 3 && parts[0] === 'assets' && parts[2] === 'risk') return risk(market.resolve(parts[1]), true);
    if (method === 'POST' && path === '/extras/quote') return extra.quote(body);
    if (method === 'POST' && path === '/extras/receipt') return extra.receipt(body);
    if (method === 'POST' && path === '/focus') {
      check(typeof body.asset === 'string', 'asset required');
      try { return await engine.focus.set(focusId(body.asset), body); }
      catch (error) {
        if (error instanceof FocusError) throw new HttpError(error.status, error.message);
        throw error;
      }
    }
    if (method === 'POST' && path === '/placements') {
      try { return await intel.announcePlacement(body); }
      catch (error) {
        if (error instanceof TypeError) throw new HttpError(400, 'Invalid token placement');
        if (error instanceof RangeError) throw new HttpError(422, error.message);
        throw new HttpError(503, 'Placement verification unavailable');
      }
    }
    const result = writes.then(() => change(method, parts, body, owner));
    writes = result.catch(() => {});
    return result;
  };
}
