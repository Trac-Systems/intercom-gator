// Identify native fee assets by settlement network. EVM compatibility alone says nothing about
// settlement. New networks need review. Polygon PoS is a sidechain with its own validator set.
const layer1 = new Set([
  'aptos', 'avalanche', 'berachain', 'bitcoin', 'bsc', 'cardano', 'cosmos', 'dogecoin', 'ethereum',
  'fantom', 'hyperevm', 'litecoin', 'near', 'solana', 'sonic', 'sui', 'ton', 'tron', 'xrpl',
  'algorand', 'bitcoin-cash', 'bittensor', 'ethereum-classic', 'filecoin', 'hedera', 'hyperliquid',
  'internet-computer', 'kaspa', 'monero', 'pearl', 'pi', 'polkadot', 'stellar', 'terra-classic', 'trac', 'zcash', 'zilliqa',
])
const layer2 = new Set([
  'arbitrum', 'base', 'blast', 'celo', 'linea', 'mantle', 'optimism', 'robinhood', 'scroll', 'unichain', 'whitechain', 'zksync',
])

/** Primary category of a known network's native fee asset, including Gnosis's DAI-backed xDAI. */
export function nativeCategoryId(id) {
  if (!id.endsWith(':native')) return null
  const chain = id.slice(0, -':native'.length)
  if (chain === 'gnosis') return 'stablecoin'
  if (chain === 'polygon') return 'infrastructure'
  if (layer1.has(chain)) return 'layer-1'
  if (layer2.has(chain)) return 'layer-2'
  return null
}
