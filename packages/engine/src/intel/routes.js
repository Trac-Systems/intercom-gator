import { addressWord, isAddress, readAddress, word, ZERO } from './values.js';

// Mainnet periphery bindings for factory-only bundles. Both are exercised by recorded
// Ethereum eth_calls. The probe independently checks the router's factory and exact pair.
// https://developers.uniswap.org/docs/protocols/v2/deployments
// https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments
const ethereumRouters = new Map([
  ['0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f', '0x7a250d5630b4cf539739df2c5dacb4c659f2488d'],
  ['0x1f98431c8ad98523631ae4a59f267346ea31f984', '0xe592427a0aece92de3edee1f18e0157c05861564'],
]);
export function routerFor(chain, deployment) {
  if (isAddress(deployment?.router)) return deployment.router;
  if (chain === 'ethereum' || chain === 'eth') return ethereumRouters.get(deployment?.address?.toLowerCase());
}

/** Standalone checks can locate a route from the signed factory and quote-token lists: up to 32 factory lookups in
 * one Multicall3 read (individual reads, at most 8, without Multicall3). The engine's indexed pool takes precedence. */
export const V3_KINDS = new Set(['v3', 'uniswap-v3', 'pancake-v3']);
export async function findPool(reader, token, chain, dex, nativeSymbol) {
  const wrapped = 'W' + nativeSymbol;
  const quotes = (dex?.quoteTokens ?? []).toSorted((a, b) => Number(b.symbol === wrapped) - Number(a.symbol === wrapped))
    .map(q => q.address).filter(a => isAddress(a) && a.toLowerCase() !== token);
  const deployments = (dex?.deployments ?? []).toSorted((a, b) =>
    Number(Boolean(routerFor(chain, b))) - Number(Boolean(routerFor(chain, a))));
  const candidates = [];
  for (const d of deployments) {
    if (!isAddress(d.address) || !(d.kind === 'v2' || V3_KINDS.has(d.kind))) continue;
    for (const quote of quotes.slice(0, 4)) {
      const pair = addressWord(token) + addressWord(quote);
      const fees = V3_KINDS.has(d.kind) ? (d.feeTiersPpm ?? [3000, 500, 10000, 100])
        .filter(f => Number.isInteger(f) && f > 0 && f < 1e6) : [null];
      for (const fee of fees) candidates.push({ d, call: fee === null ? [d.address, 'getPair(address,address)', pair]
        : [d.address, 'getPool(address,address,uint24)', pair + word(fee)] });
    }
  }
  const list = candidates.slice(0, reader.multicall ? 32 : 8);
  const results = reader.calls ? await reader.calls(list.map(c => c.call))
    : await Promise.all(list.map(c => reader.call(...c.call)));
  for (const [i, data] of results.entries()) {
    const address = readAddress(data), { d } = list[i];
    if (address && address !== ZERO) return { address, kind: d.kind, routerKind: d.routerKind,
      router: routerFor(chain, d), factory: d.address };
  }
  return null;
}
