import { contractRisk, evmReader, simulateSale, UNKNOWN } from './evm.js';
import { findPool } from './routes.js';
import { poolRisk } from './pool.js';
import { isAddress, isAsset, isTime, validMessage } from './values.js';

const method = 'evm:selectors+roles+proxy-slots+router-roundtrip+reserves/v1';
const flagNames = new Set(['unsellable', 'ownerMint', 'ownerPause', 'blacklist', 'upgradeable', 'lpUnlocked', 'veryNew', 'lowLiquidity']);
const isEvmAsset = asset => isAsset(asset) && isAddress(asset.split(':')[1]);
const cap = (map, max) => { if (map.size >= max) map.delete(map.keys().next().value); };

/** Locally resolved pool, prices (USD by lower-case address), LP/role candidates and thresholds.
 * Never derive these inputs from an unconfirmed peer risk message.
 * @typedef {{pool?:object, prices?:Object, lockers?:string[], roleAccounts?:string[], veryNewMs?:number, lowLiquidityUsd?:number}} RiskContext
 */
async function inspect(asset, { rpc, bundle, resolveContext }, at) {
  const [chain, token] = asset.split(':');
  const context = await resolveContext?.(asset) ?? {};
  const block = await Promise.resolve().then(() => rpc.call(chain, 'eth_blockNumber', [])).catch(() => null);
  const pinned = typeof block === 'string' && /^0x[\da-f]{1,16}$/i.test(block);
  // Without a pinned block, a mixture of unrelated node heads would be misleading.
  if (!pinned) return { asset, at, method, flags: Object.fromEntries([...flagNames].map(k => [k, UNKNOWN])),
    evidence: { reason: 'block unavailable' } };
  const reader = evmReader(rpc, chain, block);
  const dex = bundle?.dex?.evm?.find(d => d.chain === chain);
  const chainInfo = bundle?.chains?.find(c => c.id === chain);
  const pool = context.pool ?? bundle?.pools?.[asset] ?? await findPool(reader, token, chain, dex, chainInfo?.native?.symbol);
  const contract = await contractRisk(reader, token, context.roleAccounts);
  const liquidity = await poolRisk(reader, token, pool, { blockTimeSeconds: chainInfo?.blockTimeSeconds, ...context, at,
    lockers: context.lockers ?? dex?.lockers ?? bundle?.lockers?.[chain] });
  const sale = await simulateSale(reader, token, pool, block);
  return { asset, at, method, flags: { ...contract.flags, ...liquidity.flags, unsellable: sale.flag },
    evidence: { block, ...contract.evidence, ...liquidity.evidence, sale: sale.evidence } };
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
        for (const [key, value] of Object.entries(hint.flags)) {
          if (value === UNKNOWN || local.flags[key] === UNKNOWN) unknown.push(key);
          else if (local.flags[key] === value) agrees.push(key);
          else differs.push(key);
        }
        return { reporter: hint.reporter, at: hint.at, agrees, differs, unknown };
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
