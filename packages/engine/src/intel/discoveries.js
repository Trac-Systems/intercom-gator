import { EvmSource } from '../sources/evm.js';
import { formatUrl } from '../sources/http.js';
import { decimal } from '../obs/index.js';
import { RateLimited } from '../scheduler/index.js';
import { discoveryState } from './schema.js';
import { DAY, isAddress, isAsset, isKey, isTime, validMessage } from './values.js';

export const NEW_THRESHOLDS = Object.freeze({ liquidityUsd: 100_000, ageMs: DAY, trades: 100, reporters: 3 });
const boundedId = v => typeof v === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(v);
function identity(message) {
  if (message.t === 'listing') {
    if (!boundedId(message.exchange) || typeof message.symbol !== 'string' ||
        !/^[\w./:-]{1,64}$/.test(message.symbol) || !isTime(message.firstSeen)) return null;
    return 'cex:' + message.exchange + ':' + message.symbol;
  }
  const { pool, token0, token1, block, tx } = message;
  if (!boundedId(message.chain) || !(typeof message.dex === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,95}$/.test(message.dex)) || !boundedId(message.kind)) return null;
  const evm = isAddress(pool) || (typeof pool === 'string' && /^0x[\da-f]{64}$/i.test(pool));
  if (evm) {
    if (!isTime(block) || typeof tx !== 'string' || ![token0, token1].every(t => isAddress(t) || t === 'native') || token0.toLowerCase() === token1.toLowerCase() ||
        !/^0x[\da-f]{64}$/i.test(tx)) return null;
  } else if (![pool, token0, token1].every(t => typeof t === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t)) ||
      token0 === token1 || (block !== null && !isTime(block)) ||
      (tx !== null && !(typeof tx === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(tx)))) return null;
  return 'dex:' + message.chain + ':' + (evm ? pool.toLowerCase() : pool);
}

/** resolveAssets maps a discovery to canonical asset IDs using the local registry. A listing
 * symbol alone cannot identify a token. metricsFor returns local liquidityUsd, cumulative trades
 * and optionally confirmed createdAt. getRisk supplies locally checked flags. */
export function createNewTokens({ thresholds = {}, resolveAssets, isKnownAsset = () => false,
  metricsFor = () => ({}), getRisk = () => null, store, now = Date.now } = {}) {
  const limits = { ...NEW_THRESHOLDS, ...thresholds };
  for (const key of Object.keys(NEW_THRESHOLDS)) {
    if (!Number.isFinite(limits[key]) || limits[key] < 0) throw new TypeError('Invalid discovery threshold');
  }
  const state = store && discoveryState(store);
  const discoveries = new Map(), assets = new Map();
  function attach(discovery) {
    const m = discovery.message;
    const fallback = m.t === 'pool' ? [m.token0, m.token1].map(a => m.chain + ':' + (isAddress(a) ? a.toLowerCase() : a)) : [];
    const identities = resolveAssets?.(m) ?? fallback;
    for (const asset of new Set(identities ?? [])) {
      if (!isAsset(asset) || isKnownAsset(asset)) continue;
      if (!assets.has(asset)) {
        if (assets.size >= 8192) assets.delete(assets.keys().next().value);
        assets.set(asset, { asset, firstSeen: discovery.firstSeen, reporters: new Set(), markets: new Set(), graduated: state?.graduated(asset) ?? false });
      }
      const row = assets.get(asset);
      row.firstSeen = Math.min(row.firstSeen, discovery.firstSeen);
      if (row.markets.size < 64) row.markets.add(discovery.market);
      for (const key of discovery.reporters) if (row.reporters.size < 128) row.reporters.add(key);
    }
  }
  for (const saved of state?.load() ?? []) {
    const row = { ...saved, reporters: new Set(saved.reporters.filter(isKey)) };
    discoveries.set(row.market, row);
    attach(row);
  }
  return {
    consume(channel, envelope, localFirstSeen) {
      const m = envelope?.message;
      if (!['pool', 'listing'].includes(m?.t) || !validMessage(channel, envelope, 'gator/new', m.t) || envelope.ts > now()) return false;
      const market = identity(m);
      if (!market || (m.t === 'listing' && m.firstSeen > envelope.ts)) return false;
      let row = discoveries.get(market), evicted;
      if (!row) {
        if (discoveries.size >= 8192) evicted = discoveries.keys().next().value;
        const { chain, pool, dex, kind, token0, token1, block, tx, exchange, symbol, firstSeen } = m;
        const message = m.t === 'pool' ? { v: 1, t: 'pool', chain, pool, dex, kind, token0, token1, block, tx } :
          { v: 1, t: 'listing', exchange, symbol, firstSeen };
        const observed = isTime(localFirstSeen) && localFirstSeen <= now() ? localFirstSeen : now();
        row = { message, firstSeen: observed, market, reporters: new Set() };
      } else if (m.t === 'pool') {
        // Competing descriptions of the same pool are not corroboration.
        const original = row.message;
        const normalized = s => s?.startsWith('0x') ? s.toLowerCase() : s;
        if (['token0', 'token1', 'tx'].some(k => normalized(m[k]) !== normalized(original[k])) ||
            ['dex', 'kind', 'block'].some(k => m[k] !== original[k])) return false;
      }
      if (!row.reporters.has(envelope.from) && row.reporters.size < 128) {
        row = { ...row, reporters: new Set([...row.reporters, envelope.from]) };
        state?.save(row, evicted);
        if (evicted) discoveries.delete(evicted);
        discoveries.set(market, row);
      }
      attach(row);
      return true;
    },
    /** Retry unresolved listing identities after the local registry changes. */
    reconcile() { for (const row of discoveries.values()) attach(row); },
    list() {
      const rows = [], time = now();
      for (const row of assets.values()) {
        if (row.graduated || isKnownAsset(row.asset)) continue;
        const metrics = metricsFor(row.asset) ?? {};
        const liquidityUsd = Number.isFinite(metrics.liquidityUsd) && metrics.liquidityUsd >= 0 ? metrics.liquidityUsd : null;
        const trades = Number.isSafeInteger(metrics.trades) && metrics.trades >= 0 ? metrics.trades : null;
        const createdAt = isTime(metrics.createdAt) && metrics.createdAt <= time ? metrics.createdAt : row.firstSeen;
        const ageMs = Math.max(0, time - createdAt), reporters = row.reporters.size;
        if (liquidityUsd !== null && trades !== null && liquidityUsd >= limits.liquidityUsd &&
            ageMs >= limits.ageMs && trades >= limits.trades && reporters >= limits.reporters) {
          state?.graduate(row.asset, time);
          row.graduated = true;
          continue;
        }
        rows.push({ asset: row.asset, firstSeen: row.firstSeen, ageMs, liquidityUsd, trades, reporters,
          markets: [...row.markets], flags: { ...getRisk(row.asset)?.flags } });
      }
      return rows.sort((a, b) => b.firstSeen - a.firstSeen || a.asset.localeCompare(b.asset));
    },
  };
}

// The shared seeder plans all currency combinations for a catalog. Narrow each new pass
// before consuming its first page, so quote/quote probes never consume this token's turns.
class PlacementPoolSeeder extends EvmSource {
  nextProbes() {
    if (!this.plan) {
      super.nextProbes();
      const [asset] = this.registry.catalog.assets;
      this.plan.pairs = this.plan.pairs.filter(pair => pair.includes(asset.address));
    }
    return super.nextProbes();
  }
}

/** Run the normal factory/state seeder for one adopted token using a private cursor and public
 * RPCs. Its factory methods, liquidity checks, probe memo, budgets and price path stay shared. */
function placementEvmSource(engine, asset, update, cursor) {
  const { registry, store } = engine;
  const chain = registry.chains.get(asset.chain), cursorKey = 'engine-seed/' + chain.id;
  const scopedStore = { ...store,
    getSetting(key) { return key === cursorKey ? { next: cursor } : store.getSetting(key); },
    setSetting(key, value) {
      if (key !== cursorKey) return store.setSetting(key, value);
      cursor = value.next;
      update.run(cursor, value.wake, asset.id);
    },
  };
  // Rank limits select the ordinary catalog. This cursor already selected its one retained token.
  const assets = { get(id) {
    const token = registry.assets.get(id);
    return id === asset.id ? { ...token, rank: null } : token;
  } };
  return new PlacementPoolSeeder({ chain, store: scopedStore, clock: engine.clock, dex: engine.bundle.dex,
    rpc: engine.rpc.publicOnly, publish: rows => engine.publish(rows),
    registry: { assets, catalog: { assets: [asset] }, pool: (p, info) => registry.pool(p, info, true) },
  });
}

/** The signed directory is keyed by the mint. Only supported venues and pairs containing
 * the exact mint enter the normal Solana pool registry. State-only pools have no creation tx. */
async function seedSolana(engine, asset) {
  const { chain, address } = asset;
  const api = engine.catalog.apis.find(a => a.id === 'dexscreener');
  if (!api) return;
  const pairs = await engine.http.getPublic(formatUrl(api.url, { chain, address }), api.rpm);
  if (!Array.isArray(pairs)) throw new Error('Invalid pool reference response');
  const rows = [], seen = new Set();
  for (const p of pairs.slice(0, 64)) {
    if (p?.chainId !== chain || !['raydium', 'orca', 'meteora'].includes(p.dexId) ||
        !p.baseToken || !p.quoteToken || seen.has(p.pairAddress)) continue;
    const token0 = p.baseToken.address, token1 = p.quoteToken.address;
    if ((token0 !== address && token1 !== address) || token0 === token1 ||
        ![token0, token1, p.pairAddress].every(s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s))) continue;
    const id = 'dex:' + chain + ':' + p.pairAddress;
    const hint = { chain, pool: p.pairAddress, dex: p.dexId, token0, token1 };
    const existing = engine.registry.markets.get(id);
    if (existing) {
      const saved = engine.store.reader.prepare('SELECT token0,token1 FROM pools WHERE chain=? AND pool=?').get(chain, p.pairAddress);
      if (!saved || !((saved.token0 === token0 && saved.token1 === token1) || (saved.token0 === token1 && saved.token1 === token0))) continue;
    }
    const market = existing ?? engine.hints.registerSolanaPair(hint, p);
    if (!market || market.exchange !== p.dexId) continue;
    const base = engine.registry.token(chain, token0).id, quote = engine.registry.token(chain, token1).id;
    if (!((base === market.base && quote === market.quote) || (quote === market.base && base === market.quote))) continue;
    seen.add(p.pairAddress);
    if (!existing) {
      engine.scheduleMeta(base, true);
      engine.scheduleMeta(quote, true);
    }
    const value = Number(p.priceNative);
    const price = decimal(market.base === base ? value : 1 / value);
    if (value > 0 && Number.isFinite(value) && price) rows.push([id, price, '0', decimal(p.volume?.h24), null, null, engine.clock()]);
  }
  if (rows.length) engine.publish(rows);
}

export function placementSeedJob(engine) {
  const { store, registry, clock } = engine;
  const due = store.reader.prepare(`SELECT asset,seedCursor FROM engine_placement_assets WHERE seedAt<=? AND keepUntil>?
    ORDER BY seedAt,asset LIMIT 1`);
  const update = store.writer.prepare('UPDATE engine_placement_assets SET seedCursor=?,seedAt=? WHERE asset=?');
  const defer = store.writer.prepare('UPDATE engine_placement_assets SET seedAt=max(seedAt,?) WHERE asset=?');
  // Keep at most one partial multicall page in memory across budget turns. The durable cursor
  // advances only after a full page; moving to another asset may repeat reads but cannot skip work.
  let last;
  return { id: 'discovery:placement-pools', interval: 15_000,
    ready: () => !!due.get(clock(), clock()),
    async run() {
      const now = clock(), lease = due.get(now, now);
      if (!lease) { last = undefined; return; }
      const asset = registry.assets.get(lease.asset);
      let interval = 300_000;
      try {
        if (engine.evm.has(asset.chain)) {
          if (last?.id !== asset.id) last = { id: asset.id, source: placementEvmSource(engine, asset, update, lease.seedCursor) };
          await last.source.seed();
          interval = last.source.limits.period;
        } else if (registry.chains.get(asset.chain)?.family === 'solana') await seedSolana(engine, asset);
      } catch (error) {
        interval = error instanceof RateLimited ? Math.max(1000, error.retryAt - clock()) : 300_000;
        throw error;
      } finally { defer.run(clock() + interval, asset.id); }
    },
  };
}

/** Ordinary EVM state jobs cover independently discovered pools. During a placement lease,
 * rotate the peer-origin pools through the same state/swap reader with the budgeted public RPC. */
export function placementTrackingJob(engine) {
  const { store, clock, evm } = engine;
  const candidate = store.reader.prepare(`SELECT l.asset,m.id,m.chain FROM engine_placement_assets l
    JOIN markets m ON (m.base=l.asset OR m.quote=l.asset) JOIN engine_market_data d ON d.market=m.id
    WHERE l.keepUntil>? AND l.checkAt<=? AND d.fromHint=1 AND m.chain IN (SELECT value FROM json_each(?))
    ORDER BY l.checkAt,l.asset,(m.id<=l.lastMarket),m.id LIMIT 1`);
  const advance = store.writer.prepare('UPDATE engine_placement_assets SET checkAt=?,lastMarket=? WHERE asset=?');
  const chains = JSON.stringify([...evm.keys()]);
  const retained = store.reader.prepare('SELECT 1 FROM engine_placement_assets WHERE keepUntil>? LIMIT 1');
  // Checking the join on every scheduler tick is unnecessary even if the node has no retained pools.
  let next = 0;
  return { id: 'discovery:placement-state', interval: 15_000, ready: () => clock() >= next && !!retained.get(clock()),
    async run() {
      const time = clock();
      if (time < next) return;
      next = time + 15_000;
      const row = candidate.get(time, time, chains);
      if (!row) { next = time + 60_000; return; }
      const source = evm.get(row.chain);
      advance.run(time + source.limits.period, row.id, row.asset);
      await source.spotCheck(row.id, engine.rpc.publicOnly);
    },
  };
}

/** Send at most one verifiable record per minute (60 per rolling hour). Persist the turn before
 * doing network work so restarts, timeouts and a busy transport cannot monopolize the rotation. */
export function poolAnnouncementJob(engine) {
  const { store, registry, clock, hints, transport } = engine;
  const minute = 60_000, hour = 60 * minute, key = 'intel:pool-announcement:next';
  let next = store.getSetting(key) ?? 0;
  const evm = JSON.stringify([...engine.evm.keys()]);
  const seeds = JSON.stringify([...registry.seedIds]);
  const venues = JSON.stringify([...registry.venues.values()].filter(v => v.publishMarketData).map(v => v.id));
  const candidate = store.reader.prepare(`SELECT p.* FROM pools p
    JOIN markets m ON m.id='dex:'||p.chain||':'||p.pool
    LEFT JOIN engine_pool_announcements r ON r.chain=p.chain AND r.pool=p.pool AND r.tx=p.tx
    WHERE p.block IS NOT NULL AND length(p.tx)=66 AND p.chain IN (SELECT value FROM json_each(?))
      AND (r.retryAt IS NULL OR r.retryAt<=?)
      AND NOT EXISTS (SELECT 1 FROM engine_history_pools h WHERE h.chain=p.chain AND h.pool=p.pool)
      AND (m.base IN (SELECT asset FROM intel_graduated) OR m.quote IN (SELECT asset FROM intel_graduated)
        OR m.base IN (SELECT value FROM json_each(?))
        OR EXISTS (SELECT 1 FROM engine_placement_assets l WHERE l.asset IN (m.base,m.quote) AND l.keepUntil>?)
        OR EXISTS (SELECT 1 FROM asset_markets a JOIN markets c ON c.id=a.market
          WHERE a.asset=m.base AND c.kind='cex' AND c.exchange IN (SELECT value FROM json_each(?))))
    ORDER BY r.attemptedAt NULLS FIRST,p.firstSeen,p.chain,p.pool LIMIT 1`);
  const mark = store.writer.prepare('INSERT OR REPLACE INTO engine_pool_announcements VALUES (?,?,?,?,?)');
  return { id: 'discovery:reannounce', interval: minute, ready: () => clock() >= next,
    async run() {
      const time = clock();
      if (time < next) return;
      next = time + minute;
      const p = candidate.get(evm, time, seeds, time, venues);
      if (!p) return;
      store.transaction(() => {
        store.setSetting(key, next);
        mark.run(p.chain, p.pool, p.tx, time, time + hour);
      });
      const { chain, dex, kind, pool, token0, token1, block, tx } = p;
      const message = { t: 'pool', v: 1, chain, pool, dex, kind, token0, token1, block, tx };
      if (!identity(message) || !(await hints.hasCreationReceipt(p))) {
        mark.run(chain, pool, tx, time, time + DAY);
        return;
      }
      transport.send('gator/new', message);
    },
  };
}
