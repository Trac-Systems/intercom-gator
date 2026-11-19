import { createRiskService } from './risk.js';
import { createClaimService } from './claims.js';
import { createNewTokens, placementSeedJob, placementTrackingJob, poolAnnouncementJob } from './discoveries.js';
import { createExtrasVerifier, createPlacements } from './extras.js';
import { createFearGreed, partialFearGreed } from './fear-greed.js';
import { buildBriefing, writeBriefing } from './briefing.js';
import { sentiment } from './sentiment.js';
import { engineData, independentMarketDays } from './market-data.js';
import { migrations as intelMigrations } from './schema.js';
import { DAY, isAddress, isAsset, isKey, isTime, validMessage } from './values.js';
import { settleWithin } from '../grace.js';

export { checkRisk, createRiskService } from './risk.js';
export { createClaimService, verifyDeployer, onchainMetadata } from './claims.js';
export { createNewTokens, NEW_THRESHOLDS } from './discoveries.js';
export { createExtrasVerifier, decodeCurrent, contentHash, EXTRAS_INTERVAL_MS } from './extras.js';
export { createFearGreed, computeFearGreed, fearGreedLabel } from './fear-greed.js';
export { buildBriefing, briefingMarkdown, writeBriefing } from './briefing.js';
export { sentiment } from './sentiment.js';
export { keccak256 } from './keccak.js';
export const migrations = [...intelMigrations, independentMarketDays, partialFearGreed];

const HOUR = 3_600_000;
const STOP_GRACE_MS = 2_000;

/** Node-scoped entry point. Pass the shared store opened with intel migrations and an
 * engine or independent adapters. start() joins missing data channels. Adapter hooks:
 * resolveContext(asset), resolveAssets(discovery), metricsFor(asset), getDeployer(asset),
 * websiteFor(asset), metadataFor(asset), dailyMarket({from,to}), postsSince({from,to}),
 * isFollowed(key), isProven(key), isReputable(key), resolveSymbol(symbol).
 * Standalone adapters can supply publicRpc for remote checks. All times use epoch ms. */
export function createIntel(options) {
  if (options.engine) options = { ...engineData(options.engine), ...options };
  const { rpc, bundle = {}, store, transport, now = Date.now, dailyMarket, postsSince, dataDir,
    isFollowed, isReputable, resolveSymbol, onError = () => process.emitWarning('Market intel refresh failed') } = options;
  const risk = createRiskService({ ...options, bundle });
  const publicRpc = options.publicRpc ?? rpc?.publicOnly;
  const claims = createClaimService({ ...options, bundle });
  const extras = createExtrasVerifier({ rpc: publicRpc ?? rpc, bundle, now, candidatesFor: options.candidatesFor });
  const placements = options.engine && createPlacements({ engine: options.engine, verifier: extras, publicRpc, now });
  const fearGreed = createFearGreed({ dailyMarket: dailyMarket ?? (() => []), postsSince, store, now,
    isFollowed, isProven: options.isProven });
  const newTokens = createNewTokens({ ...options,
    metricsFor(asset) {
      const metrics = options.metricsFor?.(asset) ?? {};
      const local = risk.get(asset), evidence = local?.evidence;
      return { ...metrics, liquidityUsd: metrics.liquidityUsd ?? evidence?.liquidity?.usd,
        createdAt: metrics.createdAt ?? (isTime(evidence?.ageMs) ? local.at - evidence.ageMs : undefined) };
    },
    getRisk(asset) {
      const cached = risk.get(asset);
      if (cached) return cached;
      const stored = store?.getRisk(asset), age = now() - stored?.at;
      return age >= 0 && age < (options.ttlMs ?? 300_000) ? stored : null;
    },
  });

  const queued = new Set(), rates = new Map();
  let remoteAsset = null, nextRemote = 0;
  function queue(asset, local) {
    if (!isAsset(asset) || !isAddress(asset.split(':')[1]) || (store && !store.getAsset(asset)) || risk.get(asset)) return;
    if (local) {
      if (queued.size < 128) {
        queued.add(asset);
        if (remoteAsset === asset) remoteAsset = null;
      }
    } else if (publicRpc && !remoteAsset && now() >= nextRemote && !queued.has(asset)) {
      remoteAsset = asset;
    }
  }
  async function checkNext() {
    const [local] = queued;
    const asset = local ?? remoteAsset;
    if (!asset) return;
    if (local) queued.delete(asset);
    else {
      remoteAsset = null;
      nextRemote = now() + 60_000;
    }
    const check = await risk.spotCheck(asset, local ? rpc : publicRpc);
    if (check.comparisons.length) options.onSpotCheck?.(check);
    if (local) await claims.syncAutomatic(asset);
    return check;
  }
  function admit(key) {
    const minute = Math.floor(now() / 60_000);
    let rate = rates.get(key);
    if (!rate || rate.minute !== minute) {
      if (rates.size >= 4096) {
        for (const [id, old] of rates) if (old.minute !== minute) rates.delete(id);
        if (rates.size >= 4096 && !rate) return false;
      }
      rates.set(key, rate = { minute, count: 0 });
    }
    return ++rate.count <= 60;
  }
  async function consume(channel, envelope) {
    if (!isKey(envelope?.from) || !['gator/meta', 'gator/new'].includes(channel) ||
        envelope.channel !== channel || options.isMuted?.(envelope.from) || !admit(envelope.from)) return false;
    switch (envelope?.message?.t) {
      case 'placement':
        if (!placements || !validMessage(channel, envelope, 'gator/new', 'placement') || envelope.ts > now()) return false;
        return placements.receive(envelope.message, envelope.from);
      case 'pool': case 'listing': return newTokens.consume(channel, envelope);
      case 'risk': {
        const accepted = risk.consume(channel, envelope);
        if (accepted && envelope.from !== transport?.publicKey) queue(envelope.message.asset, false);
        return accepted;
      }
      case 'claim': return claims.consume(channel, envelope);
      default: return false;
    }
  }

  async function briefing({ at = now(), since = store?.getSetting('intel:briefing:lastRead') } = {}) {
    const assets = store ? [...store.movers({ direction: 'gainers', limit: 10 }), ...store.movers({ direction: 'losers', limit: 10 })] : [];
    const [index, posts] = await Promise.all([fearGreed.snapshot(at), postsSince?.({ from: at - DAY + 1, to: at + 1 })]);
    return buildBriefing({ at, since, assets, newTokens: newTokens.list(), fearGreed: index,
      alerts: store?.listAlerts() ?? [], posts: posts ?? [], isFollowed, isReputable });
  }

  let hourly, refresh, starting, removePrune, active = false, lifecycle = Promise.resolve();
  const joined = [];
  const inflight = new Set();
  function onMessage(channel, envelope) {
    if (channel !== 'gator/new' && channel !== 'gator/meta') return;
    const task = consume(channel, envelope).catch(onError).finally(() => inflight.delete(task));
    inflight.add(task);
  }
  function onDiscovery(message, localFirstSeen, fromHint = false, historyReporter) {
    if (historyReporter) newTokens.consume('gator/new', { channel: 'gator/new', from: historyReporter, ts: now(), message }, localFirstSeen);
    newTokens.consume('gator/new', { channel: 'gator/new', from: transport.publicKey, ts: now(), message }, localFirstSeen ?? message.firstSeen);
    if (!historyReporter) for (const asset of options.resolveAssets?.(message) ?? []) queue(asset, !fromHint);
  }
  function refreshMarket() {
    if (!refresh) {
      const job = async () => {
        options.sampleGlobal?.(now());
        newTokens.reconcile();
        if (dataDir) return writeBriefing(dataDir, await briefing());
        if (dailyMarket) return fearGreed.snapshot();
      };
      refresh = job().finally(() => { refresh = undefined; });
    }
    return refresh;
  }
  async function close() {
    transport?.off('message', onMessage);
    options.engine?.off('discovery', onDiscovery);
    clearInterval(hourly);
    removePrune?.();
    active = false;
    // Background reads (paid extras, briefing, Fear & Greed backfill, metadata checks) are best-effort and some do not
    // take an abort signal; leaving a channel waits on the DHT. Both once held the daemon's shutdown for 10 s.
    await settleWithin([extras.stop(), refresh, starting, ...inflight], STOP_GRACE_MS);
    await settleWithin(joined.splice(0).map(channel => transport.leave(channel)), STOP_GRACE_MS);
  }
  async function open() {
    if (active) return;
    try {
      transport?.on('message', onMessage);
      options.engine?.on('discovery', onDiscovery);
      if (options.engine) {
        removePrune = store.onPrune(placements.prune);
        for (const job of [placementSeedJob(options.engine), placementTrackingJob(options.engine), poolAnnouncementJob(options.engine)]) {
          options.engine.registerJob({ ...job, ready: () => active && job.ready(), run() {
            const task = job.run().finally(() => inflight.delete(task));
            inflight.add(task);
            return task;
          } });
        }
        for (const row of store.newPools({ limit: 512 })) {
          const market = options.engine.registry.markets.get('dex:' + row.chain + ':' + row.pool);
          onDiscovery({ ...row, t: 'pool', v: 1 }, row.firstSeen, !market || !!market.fromHint);
        }
        for (const row of store.newListings({ limit: 512 })) onDiscovery({ ...row, t: 'listing', v: 1 }, row.firstSeen);
      }
      const wanted = transport ? ['gator/new', 'gator/meta'].filter(channel => !transport.channels().includes(channel)) : [];
      const results = await Promise.allSettled(wanted.map(channel =>
        transport.join(channel, { verifySignature: true, powDifficulty: channel === 'gator/new' ? 16 : 10, maxReceiveBytes: 8192 })));
      wanted.forEach((channel, i) => { if (results[i].status === 'fulfilled' && results[i].value !== false) joined.push(channel); });
      const failed = results.findIndex(r => r.status === 'rejected' || r.value === false);
      if (failed >= 0) throw results[failed].reason ?? new Error('Could not join ' + wanted[failed]);
      // A background check waits for its reads in the shared endpoint buckets (up to 90 s). It runs beside the
      // scheduler, one at a time, so it never holds one of the profile's job slots (two on small nodes) meanwhile.
      let checking = null;
      options.engine?.registerJob({ id: 'meta:intel', ready: () => active && !checking && (queued.size > 0 || !!remoteAsset), run() {
        const task = checking = checkNext().catch(onError).finally(() => { inflight.delete(task); checking = null; });
        inflight.add(task);
      } });
      // Network work (paid-extras reads, the first briefing and Fear & Greed backfill) runs in the background:
      // awaiting it here held the dashboard closed for minutes on every start.
      starting = Promise.all([extras.start(), refreshMarket()]).catch(onError);
      hourly = setInterval(() => { refreshMarket().catch(onError); }, HOUR);
      hourly.unref?.();
      active = true;
    } catch (error) {
      await close();
      throw error;
    }
  }
  function transition(fn) {
    const next = lifecycle.then(fn);
    lifecycle = next.catch(() => {});
    return next;
  }
  return {
    risk, newTokens, claims, extras, placements, announcePlacement: placements?.announcePlacement, fearGreed, consume, checkNext, briefing, refreshMarket,
    async sentiment(asset, { at = now(), windowMs = DAY } = {}) {
      if (!postsSince) throw new TypeError('A social postsSince callback is required');
      if (!isTime(at) || !Number.isSafeInteger(windowMs) || windowMs <= 0) throw new TypeError('Invalid sentiment window');
      const posts = await postsSince({ from: at - 2 * windowMs, to: at });
      return sentiment(asset, { at, windowMs, posts, resolveSymbol, isFollowed, isReputable });
    },
    start: () => transition(open),
    stop: () => transition(close),
    /** Resolves when the first background refresh after start (extras, briefing, Fear & Greed) settles. */
    settled: () => Promise.resolve(starting),
  };
}
