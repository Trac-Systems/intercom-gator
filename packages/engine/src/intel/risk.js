import { CHECK_LIMITS, contractRisk, evmReader, simulateSale, UNKNOWN } from './evm.js';
import { findPool } from './routes.js';
import { poolRisk } from './pool.js';
import { isAddress, isAsset, isTime, validMessage } from './values.js';

// v2: definite false answers (dispatcher evidence, measured LP shares, lower-bound liquidity), immutable-forwarder and
// ZeppelinOS proxies, bounded waiting reads. Same flag names and wire shape as v1; see DESIGN.md "Risk check".
export const METHOD = 'evm:selectors+roles+proxy-slots+router-roundtrip+reserves/v2';
const method = METHOD;
export const FLAG_NAMES = Object.freeze(['unsellable', 'ownerMint', 'ownerPause', 'blacklist', 'upgradeable', 'lpUnlocked', 'veryNew', 'lowLiquidity']);
const flagNames = new Set(FLAG_NAMES);
const isEvmAsset = asset => isAsset(asset) && isAddress(asset.split(':')[1]);
// Same stablecoin rule as the engine's EVM source (sources/evm.js USD_QUOTE): a bundle quote token with a USD-stable
// symbol is valued at $1 when no measured price is supplied.
const USD_QUOTE = /^(?:USDC(?:\.E)?|USDBC|USDT0?|USD₮0|DAI|USDG|USDB|BUSD|CUSD)$/i;
const positivePrices = prices => Object.fromEntries(Object.entries(prices ?? {}).filter(([k, v]) =>
  isAddress(k) && Number.isFinite(Number(v)) && Number(v) > 0).map(([k, v]) => [k.toLowerCase(), Number(v)]));
const cap = (map, max) => { if (map.size >= max) map.delete(map.keys().next().value); };

/** Locally resolved pool, prices (USD by lower-case address), LP/role candidates and thresholds.
 * Never derive these inputs from an unconfirmed peer risk message.
 * @typedef {{pool?:object, prices?:Object, lockers?:string[], roleAccounts?:string[], veryNewMs?:number,
 * lowLiquidityUsd?:number, liquidityUsd?:number}} RiskContext
 */
async function inspect(asset, { rpc, bundle, resolveContext, limits = CHECK_LIMITS, now = Date.now }, at) {
  const [chain, token] = asset.split(':');
  const context = await resolveContext?.(asset) ?? {};
  const chainInfo = bundle?.chains?.find(c => c.id === chain);
  const reader = evmReader(rpc, chain, undefined, { maxCalls: limits.maxCalls, deadline: now() + limits.timeoutMs, now,
    multicall: chainInfo?.multicall3 });
  const block = await reader.read('eth_blockNumber', []);
  const pinned = typeof block === 'string' && /^0x[\da-f]{1,16}$/i.test(block);
  const rpcEvidence = () => ({ calls: reader.stats.calls, refused: reader.stats.refused, reverted: reader.stats.reverted,
    reasons: [...reader.stats.reasons] });
  // Without a pinned block, a mixture of unrelated node heads would be misleading.
  if (!pinned) {
    const reason = 'block unavailable (' + (reader.stats.reasons[0] ?? 'no answer') + ')';
    return { asset, at, method, flags: Object.fromEntries(FLAG_NAMES.map(k => [k, UNKNOWN])),
      evidence: { reason, rpc: rpcEvidence(), why: Object.fromEntries(FLAG_NAMES.map(k => [k, reason])) } };
  }
  reader.block = block;
  const dex = bundle?.dex?.evm?.find(d => d.chain === chain);
  const contract = await contractRisk(reader, token, context.roleAccounts);
  const pool = context.pool ?? bundle?.pools?.[asset] ?? await findPool(reader, token, chain, dex, chainInfo?.native?.symbol);
  const sale = await simulateSale(reader, token, pool, block);
  const owner = contract.evidence.owner;
  const stable = (dex?.quoteTokens ?? []).filter(q => isAddress(q.address) && USD_QUOTE.test(q.symbol ?? ''))
    .map(q => [q.address.toLowerCase(), 1]);
  const liquidity = await poolRisk(reader, token, pool, { blockTimeSeconds: chainInfo?.blockTimeSeconds, ...context, at,
    prices: { ...Object.fromEntries(stable), ...positivePrices(context.prices) },
    lockers: context.lockers ?? dex?.lockers ?? bundle?.lockers?.[chain],
    holders: [...(context.holders ?? []), token, ...(owner ? [owner] : [])] });
  const flags = { ...contract.flags, ...liquidity.flags, unsellable: sale.flag };
  const why = { ...contract.why, ...liquidity.why };
  if (sale.flag === UNKNOWN) why.unsellable = sale.evidence.reason;
  // A refused read leaves its flag unknown; name the budget or deadline as the cause.
  if (reader.stats.refused) for (const k of Object.keys(why)) why[k] += ' [' + reader.stats.reasons.join('; ') + ']';
  return { asset, at, method, flags, evidence: { block, ...contract.evidence, ...liquidity.evidence, sale: sale.evidence,
    rpc: rpcEvidence(), why } };
}

/** A service instance scopes cached checks and peer hints to one node and configuration.
 * @param {{rpc:object,bundle:object,resolveContext?:(asset:string)=>RiskContext|Promise<RiskContext>,
 * transport?:object, store?:object, now?:()=>number, ttlMs?:number}} options */
export function createRiskService(options) {
  const { transport, now = Date.now, ttlMs = 300_000 } = options;
  const results = new Map(), pending = new Map(), hints = new Map();
  function get(asset) {
    const row = results.get(asset), age = now() - row?.at;
    return age >= 0 && age < ttlMs ? structuredClone(row) : null;
  }
  async function checkRisk(asset, { force = false, rpc = options.rpc } = {}) {
    if (!isEvmAsset(asset)) throw new TypeError('Expected a canonical EVM token ID');
    const cached = get(asset);
    if (!force && cached) return cached;
    if (!pending.has(asset)) {
      pending.set(asset, inspect(asset, { ...options, rpc }, now()).then(result => {
        cap(results, 4096);
        if (options.store && options.store.getAsset(asset)) options.store.upsertRisk(result);
        results.set(asset, result);
        const { at, flags, method } = result;
        transport?.send('gator/meta', { t: 'risk', v: 1, asset, at, flags: { ...flags }, method });
        return result;
      }).finally(() => pending.delete(asset)));
    }
    return structuredClone(await pending.get(asset));
  }
  function recentHints(asset) {
    return structuredClone([...(hints.get(asset)?.values() ?? [])].filter(h => now() - h.at < ttlMs));
  }
  return { checkRisk, get,
    /** The scheduler selects an asset for a local spot check. Unknown flags cannot confirm peer claims. */
    async spotCheck(asset, rpc = options.rpc) {
      const local = await checkRisk(asset, { force: true, rpc });
      const comparisons = recentHints(asset).map(hint => {
        const agrees = [], differs = [], unknown = [];
        // A hint decided by another method version (a v0.1.0 peer's /v1) is not comparable flag by flag.
        const comparable = hint.method === method;
        for (const [key, value] of Object.entries(hint.flags)) {
          if (!comparable || value === UNKNOWN || local.flags[key] === UNKNOWN) unknown.push(key);
          else if (local.flags[key] === value) agrees.push(key);
          else differs.push(key);
        }
        return { reporter: hint.reporter, at: hint.at, method: hint.method, agrees, differs, unknown };
      });
      return { local, comparisons };
    },
    consume(channel, envelope) {
      if (!validMessage(channel, envelope, 'gator/meta', 'risk')) return false;
      const { asset, at, flags, method } = envelope.message;
      if (!isEvmAsset(asset) || !isTime(at) || at > now() || now() - at >= ttlMs ||
          typeof method !== 'string' || method.length > 256 || !flags || typeof flags !== 'object' || Array.isArray(flags)) return false;
      const entries = Object.entries(flags);
      if (!entries.length || !entries.every(([k, v]) => flagNames.has(k) && (typeof v === 'boolean' || v === UNKNOWN))) return false;
      if (!hints.has(asset)) { cap(hints, 4096); hints.set(asset, new Map()); }
      const reporters = hints.get(asset);
      if ((reporters.get(envelope.from)?.at ?? -1) >= at) return false;
      if (!reporters.has(envelope.from)) cap(reporters, 16);
      reporters.set(envelope.from, { reporter: envelope.from, at, flags: { ...flags }, method });
      return true;
    },
    hints: recentHints,
  };
}

// The convenience entry point reuses the service for the same RPC and bundle.
const byRpc = new WeakMap();
/** @param {string} assetId @param {{rpc:object,bundle:object}} options */
export function checkRisk(assetId, { rpc, bundle }) {
  if (!byRpc.has(rpc)) byRpc.set(rpc, new WeakMap());
  const services = byRpc.get(rpc);
  if (!services.has(bundle)) services.set(bundle, createRiskService({ rpc, bundle }));
  return services.get(bundle).checkRisk(assetId);
}
