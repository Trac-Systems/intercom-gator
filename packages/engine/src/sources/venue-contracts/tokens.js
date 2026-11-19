import { multiRead, word } from '../evm-abi.js'
import { abiDecimals, abiLabel } from '../names/evm.js'
import { solanaNames } from '../names/solana.js'
import { contractName } from '../names/contracts.js'
import { labels } from '../names/text.js'

const uint = /^0x[0-9a-f]{64}$/i

/** Local registration seam for WP-addtoken. Verify a bounded batch on one chain through public, budgeted RPC.
 * No venue strings become token metadata. The allowance selector also distinguishes ERC-20s from enumerable NFTs.
 * stillWanted is checked after the asynchronous read in case a directory or listing changed meanwhile. */
export async function registerVenueTokens(engine, chain, ids, stillWanted, reads, rotation) {
  const rpc = engine.rpc.publicOnly
  const assets = ids.map(id => ({ id, address: id.slice(chain.id.length + 1) }))
  let rows
  if (chain.family === 'solana') {
    rows = await solanaNames(chain, assets, rpc)
  } else if (chain.family === 'evm') {
    const calls = assets.flatMap(({ address }) => {
      const account = word(address)
      return ['0x06fdde03', '0x95d89b41', '0x313ce567', '0x18160ddd', '0xdd62ed3e' + account + account]
        .map(data => ({ to: address, data }))
    })
    const values = await multiRead(rpc, chain, calls)
    rows = assets.map((_, i) => {
      const [name, symbol, units, supply, allowance] = values.slice(5 * i, 5 * i + 5)
      if (!uint.test(supply) || !uint.test(allowance)) return null
      const decimals = abiDecimals(units)
      return { name: abiLabel(name), symbol: abiLabel(symbol), decimals, method: 'erc20',
        totalSupply: decimals != null ? Number(BigInt(supply)) / 10 ** decimals : null }
    })
  } else {
    // Existing chain-specific readers validate TRC-20 methods, Move coin types/objects and jetton state.
    // A venue-discovered address cannot opt this job into fetching off-chain metadata.
    const raw = engine.bundle.chains.find(c => c.id === chain.id)
    rows = [await contractName(raw, assets[0], engine.http, reads, rotation, async () => null)]
  }
  engine.store.transaction(() => {
    for (const [i, asset] of assets.entries()) {
      const row = rows[i], fields = labels(row, asset.address)
      if (!fields || !Number.isInteger(row.decimals) || row.decimals > 77 || !stillWanted(asset.id)) continue
      const saved = engine.registry.registerToken(chain.id, asset.address, { ...fields, decimals: row.decimals })
      engine.names.recordVerified(saved, { ...row, ...fields })
    }
  })
}
