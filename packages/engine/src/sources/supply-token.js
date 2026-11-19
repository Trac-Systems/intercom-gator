import { multiRead, word } from './evm-abi.js'
import { units } from './supply-emission.js'
import { rateLimit } from './bundle-adapter.js'
import { DAY } from './supply-api.js'

const INCINERATOR = '1nc1nerator11111111111111111111111111111111'
const uintWord = value => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value)
const u64 = value => typeof value === 'string' && /^\d{1,20}$/.test(value) && BigInt(value) < 2n ** 64n
const slot = n => Number.isSafeInteger(n) && n >= 0
const base58 = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)
const tokenPrograms = new Set(['spl-token', 'spl-token-2022'])
export const momentum = 'sui:0x35169bc93e1fddfcf3a82a9eae726d349689ed59e4b065369af8789fe59f8608::mmt::MMT'

// Momentum has published the new mint and two emission accounts but no current measurement
// of all locked allocations. The native coin metadata can establish only the issued total.
export async function momentumTotal(endpoint, http, clock) {
  const body = { query: 'query($coin:String!){chainIdentifier checkpoint{sequenceNumber timestamp} coinMetadata(coinType:$coin){name symbol decimals supply}}',
    variables: { coin: momentum.slice(4) } }
  const reply = await http.get(endpoint.url, rateLimit(endpoint.limits), 1, body)
  const data = reply?.data, meta = data?.coinMetadata, block = data?.checkpoint?.sequenceNumber
  const at = Date.parse(data?.checkpoint?.timestamp), now = clock()
  if (reply?.errors || data?.chainIdentifier !== '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S' ||
      meta?.decimals !== 9 || meta.symbol !== 'MMT' || !u64(meta.supply) || !slot(block) ||
      !Number.isFinite(at) || at > now || now - at >= 2 * DAY) throw new Error('Invalid Sui coin supply')
  return { total: units(BigInt(meta.supply), 9), method: 'sui-coin-total', block, at,
    source: 'sui/graphql/' + new URL(endpoint.url).hostname }
}

// Ethereum RNDR held by the Render upgrade portal and Polygon's ERC20 predicate backs tokens
// elsewhere. https://renderfoundation.com/support and https://docs.wormhole.com/reference/contract-addresses/
// https://github.com/maticnetwork/static/blob/master/network/mainnet/v1/index.json
// KuCoin identifies its locked founding allocation and KCC identifies its Ethereum bridge.
// https://www.kucoin.com/announcement/en-kcs-team-to-extend-founders-and-angel-investors-token-lock-up-period
// https://github.com/kcc-community/bridge-contract#eth-mainnet
// Paxos lists the USDG OFT accounts on Arbitrum and Solana. Deduct their custodial balances.
// https://docs.paxos.com/guides/stablecoin/usdg/mainnet
const polygonPredicate = '0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf'
export const reserveAccounts = new Map([
  ['ethereum:0x6de037ef9ad2725eb40118bb1702ebb27e4aeb24', [
    '0x3ee18b2214aff97000d974cf647e7c347e8fa585', polygonPredicate]],
  ['ethereum:0xb62132e35a6c13ee1ee0f84dc5d40bad8d815206', [polygonPredicate]], // Polygon NEXO collateral
  ['ethereum:0xf34960d9d60be18cc1d5afc1a6f012a723a28811', [
    '0x4768b5168a8f2bfdd76de03faa834839ccf75d9f', '0xe61dd9ca7364225afbfb79e15ad33864424e6ae4']],
  ['arbitrum:0x004b506865409877c9fa29bfb1eba929984b9bbc', ['0xc3274ec3f772d8534575eaad5231cf250a48b6b6']],
  ['solana:2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', ['75sq4xbQ1snnWKmwZ9sDZjzaLxgiZedPcegXwCCQ2bnp']],
  // WhiteBIT identifies address 1 as its additional 25M WBT incinerator.
  // https://help.whitebit.com/hc/en-gb/articles/17190215630493-All-about-WBT-Coin
  ['ethereum:0x925206b8a707096ed26ae47c84747fe0bb734f59', ['0x0000000000000000000000000000000000000001']],
  // Bitway locks BEP-20 in its OFT adapter before minting the Ethereum representation.
  // https://repo.sourcify.dev/56/0x76d77531258b4dddfa4087e97a6c89bc0f0f1e50
  ['bsc:0x444045b0ee1ee319a660a5e3d604ca0ffa35acaa', ['0x76d77531258b4dddfa4087e97a6c89bc0f0f1e50']],
  // These four verified Vesting proxies hold the Ethereum allocations until actually withdrawn.
  // https://eth.blockscout.com/token/0x3a63de3572c69a1307ff08394f3ee7702c16d25d?tab=holders
  ['ethereum:0x3a63de3572c69a1307ff08394f3ee7702c16d25d', [
    '0x8549f3c2def32734c27c57f16dc188f8c935bf99', '0x71720ef192f5ae7ff616904feae4a7ec272ab2b4',
    '0x729d894f658a12b562f372bf5cb6c039a1531436', '0x0f614ec11588e9cb53ad3c45de5dd71adc8f6fde']],
  // Undistributed airdrop, ecosystem, treasury, team and rewards. Exchange deposits remain circulating.
  // https://docs.asterdex.com/usdaster-token/tokenomics and https://netsupply.org/tokens/aster
  ['bsc:0x000ae314e2a2172a039b26378814c252734f556a', [
    '0xe8c3e6559513eebac3e05fd75c19a17f4a51a892', '0xdfa61ef61a1af7302b21eaf251f656e5ff2a3463',
    '0x798b293934bf2ab5e0ea979b36cc8c73339269f7', '0x59d851621827dc1dd9e74d13b36d6de1abc03b19',
    '0x0a55c740703a11f42803fb1a05ca1f7f89981ea4']],
])

export const quant = 'ethereum:0x4a220e6096b25eadb88358cb44068a3248254675'
// QNT's totalSupply() is a constant ceiling. The verified crowdsale accounts for sold QNT
// separately from the 14,467,000 founder tokens in its immutable deployment arguments.
// https://etherscan.io/address/0x398e41ac3d5972b4bac2320cd130c7a25ca446f7#code
// https://etherscan.io/token/0x4a220e6096b25eadb88358cb44068a3248254675#code
async function quantSupply(asset, chain, rpc) {
  const sale = '0x398e41ac3d5972b4bac2320cd130c7a25ca446f7'
  const calls = [
    ...['0xfc0c546a', '0x7365e2d7', '0x7df042a2'].map(data => ({ to: sale, data })),
    ...[0, 1, 0xdead, asset.address].map(account => ({ to: asset.address, data: '0x70a08231' + word(account) })),
  ]
  const values = await multiRead(rpc, chain, calls)
  if (values.length !== calls.length || !values.every(uintWord) || values[0] !== '0x' + word(asset.address))
    throw new Error('Invalid Quant crowdsale')
  const [, presale, regular, ...burns] = values.map(BigInt)
  const issued = 14_467_000n * 10n ** 18n + presale + regular
  const excluded = burns.reduce((sum, amount) => sum + amount, 0n)
  if (issued > 45_467_000n * 10n ** 18n || excluded > issued) throw new Error('Invalid Quant distribution')
  return { value: units(issued - excluded, 18), total: units(issued, 18), method: 'quant-sold-minus-burn',
    estimate: true, source: 'ethereum/qnt-crowdsale' }
}

// Bootstrap reads for missing top-cap deployments identified against the November 2026 mainnet
// snapshot. These IDs affect queue ordering only. All amounts still come from the individual mint.
export const priorityDeployments = new Set([
  ...reserveAccounts.keys(), quant,
  'ethereum:0x2af5d2ad76741191d15dfe7bf6ac92d4bd912ca3', // LEO
  'bsc:0x22b1458e780f8fa71e2f84502cee8b5a3cc731fa', // M
  'solana:ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB', // OUSD
  'ethereum:0x9f6f3991d525015a6f8caf062c83b62fd3ac4436', // OUSD
  'solana:5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW', // PAXG
])

/** Preserve intermediate reads across budget deferrals. The caller bounds the age of one attempt. */
export async function tokenSupply(asset, chain, rpc, reads) {
  if (asset.id === quant) return quantSupply(asset, chain, rpc)
  if (chain.family === 'evm' && /^0x[\da-f]{40}$/.test(asset.address)) {
    const reserves = reserveAccounts.get(asset.id) ?? []
    const balances = [0, 0xdead, ...reserves].map(address => '0x70a08231' + word(address))
    const calls = ['0x313ce567', '0x18160ddd', ...balances]
      .map(data => ({ to: asset.address, data }))
    let results, block
    if (chain.multicall) {
      results = await multiRead(rpc, chain, calls)
    } else {
      reads.block ??= await rpc.call(chain.id, 'eth_blockNumber', [])
      if (!/^0x[\da-f]{1,13}$/i.test(reads.block)) throw new Error('Invalid token supply block')
      block = Number(reads.block)
      reads.results ??= []
      while (reads.results.length < calls.length) {
        const result = await rpc.call(chain.id, 'eth_call', [calls[reads.results.length], reads.block])
        reads.results.push(result)
      }
      results = reads.results
    }
    if (!results.every(uintWord)) throw new Error('Incomplete token supply')
    const [places, total, ...amounts] = results.map(BigInt)
    const excluded = amounts.reduce((sum, value) => sum + value, 0n)
    if (places > 77n || excluded > total) throw new Error('Invalid token supply')
    return { value: units(total - excluded, Number(places)), total: units(total, Number(places)),
      method: reserves.length ? 'erc20-minus-known-reserves' : 'total-minus-burn', estimate: true, source: chain.id + '/erc20', ...(block === undefined ? {} : { block }) }
  }
  if (chain.family !== 'solana' || !base58(asset.address)) throw new Error('Unsupported supply asset')
  reads.mint ??= await rpc.call(chain.id, 'getTokenSupply', [asset.address, { commitment: 'finalized' }])
  const { amount, decimals } = reads.mint?.value ?? {}, block = reads.mint?.context?.slot
  if (!slot(block) || !u64(amount) || !Number.isInteger(decimals) || decimals < 0 || decimals > 77)
    throw new Error('Invalid SPL mint supply')
  // Burn instructions already reduce the mint supply. Also subtract tokens parked at the incinerator.
  const reserves = reserveAccounts.get(asset.id) ?? []
  reads.exclusions ??= new Map()
  const seen = new Set()
  let excluded = 0n
  for (const owner of [INCINERATOR, ...reserves]) {
    const accounts = reads.exclusions.get(owner) ?? await rpc.call(chain.id, 'getTokenAccountsByOwner', [owner,
      { mint: asset.address }, { encoding: 'jsonParsed', commitment: 'finalized', minContextSlot: block }])
    excluded += excludedSpl(accounts, block, asset.address, owner, decimals, seen)
    reads.exclusions.set(owner, accounts)
  }
  if (excluded > BigInt(amount)) throw new Error('Burn or reserve balance exceeds supply')
  return { value: units(BigInt(amount) - excluded, decimals), total: units(BigInt(amount), decimals),
    method: reserves.length ? 'spl-minus-known-reserves' : 'total-minus-burn', estimate: true,
    source: chain.id + '/spl-token', block, burnSlot: reads.exclusions.get(INCINERATOR).context.slot,
    ...(reserves.length && { reserveSlot: Math.max(...reserves.map(owner => reads.exclusions.get(owner).context.slot)) }) }
}

function excludedSpl(accounts, block, mint, owner, decimals, seen) {
  if (!slot(accounts?.context?.slot) || accounts.context.slot < block || accounts.context.slot - block > 150 ||
      !Array.isArray(accounts.value) || accounts.value.length > 4096) throw new Error('Invalid SPL burn accounts')
  let burned = 0n
  for (const row of accounts.value) {
    const data = row?.account?.data, info = data?.parsed?.info
    if (!base58(row?.pubkey) || seen.has(row.pubkey) || !tokenPrograms.has(data?.program) ||
        data.parsed.type !== 'account' || info?.mint !== mint || info.owner !== owner ||
        info.tokenAmount?.decimals !== decimals || !u64(info.tokenAmount.amount)) throw new Error('Invalid SPL burn balance')
    seen.add(row.pubkey)
    burned += BigInt(info.tokenAmount.amount)
  }
  return burned
}
