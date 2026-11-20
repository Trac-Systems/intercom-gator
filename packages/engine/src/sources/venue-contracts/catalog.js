import { symbolPattern } from '../../obs/index.js'

// Paths are relative to the signed ticker origin. Coinbase's public Exchange directory is a separate first-party API.
const directories = new Map(Object.entries({
  'hyperliquid-spot': { path: '/info', body: { type: 'spotMeta' }, cost: 20, list: 'tokens', label: 'name' },
  gate:     { path: '/api/v4/spot/currencies', label: 'currency', networks: 'chains', chain: 'name', address: 'addr' },
  binance:  { path: 'https://www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll', list: 'data', code: '000000', label: 'coin', networks: 'networkList', chain: 'network', address: 'contractAddress' },
  bitget:   { path: '/api/v2/spot/public/coins', list: 'data', code: '00000', label: 'coin', networks: 'chains', chain: 'chain', address: 'contractAddress' },
  weex:     { path: '/api/v3/coins', label: 'coin', networks: 'networkList', chain: 'network', address: 'contractAddress' },
  kucoin:   { path: '/api/v3/currencies', list: 'data', code: '200000', cost: 3, label: 'currency', networks: 'chains', chain: 'chainId', address: 'contractAddress' },
  htx:      { path: '/v2/reference/currencies', list: 'data', code: 200, label: 'currency', networks: 'chains', chain: 'baseChain', address: 'contractAddress' },
  hitbtc:   { path: '/api/3/public/currency', keyed: true, networks: 'networks', chain: 'network', address: 'contract_address' },
  'cex-io': { path: '/api/spot/rest-public/get_processing_info', cost: 10, body: {}, list: 'data', keyed: true, networks: 'blockchains' },
  poloniex: { path: '/v2/currencies', label: 'coin', networks: 'networkList', chain: 'blockchain', address: 'contractAddress' },
  backpack: { path: '/api/v1/assets', label: 'symbol', networks: 'tokens', chain: 'blockchain', address: 'contractAddress' },
  coinbase: { path: 'https://api.exchange.coinbase.com/currencies', label: 'id', networks: 'supported_networks', chain: 'id', address: 'contract_address' },
  xt:       { path: '/v4/public/wallet/support/currency', list: 'result', label: 'currency', networks: 'supportChains', chain: 'chain', address: 'contract' },
}))

export function directoryFor(venue) {
  return venue.derivativeOnly ? undefined : directories.get(venue.id)
}

// Exact network identifiers only. A generic token standard on another L1 and an explorer/deposit URL are not chain IDs.
const aliases = {
  ethereum: ['ETH', 'ETHEREUM', 'ERC20', 'ERC-20'],
  bsc: ['BSC', 'BNB SMART CHAIN', 'BINANCESMARTCHAIN', 'BEP20', 'BEP20(BSC)'],
  arbitrum: ['ARBITRUM', 'ARBITRUM ONE', 'ARBITRUMONE', 'ARB', 'ARBEVM', 'ETHARB'],
  optimism: ['OP', 'OPTIMISM', 'OPETH', 'ETHOP'],
  base: ['BASE', 'BASEEVM', 'ETHBASE'],
  polygon: ['POLYGON', 'POLYGON POS', 'MATIC', 'POLPOLY'],
  avalanche: ['AVAX_C', 'AVAXC', 'AVAC', 'AVACCHAIN', 'AVAX_CCHAIN', 'AVAXCCHAIN', 'AVAXC-CHAIN', 'AVAX C-CHAIN'],
  zksync: ['ZKSYNC ERA', 'ZKSERA', 'ZKSYNCERA', 'ZKSYNC2'],
  linea: ['LINEA', 'LINEAETH', 'ETHLINEA'],
  mantle: ['MNT', 'MANTLE'],
  berachain: ['BERA', 'BERACHAIN'],
  robinhood: ['ROBINHOOD', 'ROBINHOODCHAIN', 'ETHROB'],
  hyperevm: ['HYPEREVM', 'HYPEEVM'],
  celo: ['CELO'], sonic: ['SONIC'], fantom: ['FTM', 'FANTOM'], solana: ['SOL', 'SOLANA'],
  tron: ['TRON', 'TRC20', 'TRX'], sui: ['SUI', 'SUINEW'], aptos: ['APT', 'APTOS'], ton: ['TON', 'TONCOIN', 'THE OPEN NETWORK'],
  blast: ['BLAST'], scroll: ['SCROLL'], unichain: ['UNICHAIN'], gnosis: ['GNOSIS'],
}
const chainIds = new Map(Object.entries(aliases).flatMap(([id, names]) => names.map(n => [n, id])))
const evm = /^0x[0-9a-fA-F]{40}$/
const sol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const move = /^0x[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/
const trc20 = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const jetton = /^(?:[EU]Q[A-Za-z0-9_-]{46}|0:[0-9a-fA-F]{64})$/
const evmPlaceholder = /^0x(?:0{40}|e{40}|0{36}dead)$/i

function contractAddress(family, raw) {
  if (raw.length > 200) return null
  if (family === 'evm' && evm.test(raw) && !evmPlaceholder.test(raw)) return raw.toLowerCase()
  if (family === 'solana' && sol.test(raw) && raw !== '11111111111111111111111111111111') return raw
  if (family === 'tron' && trc20.test(raw)) return raw
  if (family === 'ton' && jetton.test(raw)) return raw
  if (family === 'aptos' && /^0x[0-9a-fA-F]{64}$/.test(raw)) return raw.toLowerCase()
  if ((family === 'sui' || family === 'aptos') && move.test(raw)) {
    const [address, module, type] = raw.split('::')
    return [address.toLowerCase(), module, type].join('::')
  }
  return null
}

/** Normalize a complete first-party response. A repeated currency row with different deployments, or two
 * contracts on the same network, quarantines the entire label. Empty, delisted and unsupported rows cannot bind.
 * @returns {Map<string,string[]|null>} venue label → supported asset IDs, or null for contradictory evidence */
export function currencyContracts(venue, json, chains) {
  const spec = directoryFor(venue)
  const list = spec.list ? json?.[spec.list] : json
  if ((spec.code != null && json?.code !== spec.code) || (venue.id === 'xt' && json?.rc !== 0) ||
      (venue.id === 'cex-io' && json?.ok !== 'ok') ||
      (spec.keyed ? !list || typeof list !== 'object' || Array.isArray(list) : !Array.isArray(list)))
    throw new Error('Invalid currency directory for ' + venue.id)
  const rows = Object.entries(list)
  if (!rows.length || rows.length > 25_000) throw new Error('Unexpected currency directory size')
  const result = new Map(), owners = new Map(), conflicts = new Set()
  for (const [key, row] of rows) {
    const raw = spec.keyed ? key : row?.[spec.label]
    if (typeof raw !== 'string' || !symbolPattern.test(raw.toUpperCase())) continue
    const label = venue.format?.aliases?.[raw.toUpperCase()] ?? raw.toUpperCase()
    let networks = row?.[spec.networks]
    if (venue.id === 'hyperliquid-spot') networks = [{ chain: 'HYPEREVM', address: row?.evmContract?.address }]
    if (venue.id === 'cex-io') {
      const entries = networks && typeof networks === 'object' && !Array.isArray(networks) ? Object.entries(networks) : []
      networks = entries.map(([name, net]) => ({
        chain: name === 'avalanche' && net?.type === 'ERC20' ? 'AVAXC' : name,
        address: net?.contract,
      }))
    }
    const ids = new Map()
    let conflict = false, hasAddress = false
    const inactive = row?.delisted === true || row?.trade_disabled === true || row?.tradeEnable === false ||
      row?.instStatus === 'delisted' || (venue.id === 'coinbase' && row?.status !== 'online')
    if (!inactive && Array.isArray(networks) && networks.length <= 128) {
      for (const network of networks) {
        const name = network?.[spec.chain ?? 'chain']
        const slug = typeof name === 'string' ? chainIds.get(name.toUpperCase()) : null
        const family = chains.get(slug)?.family
        const address = network?.[spec.address ?? 'address']
        if (typeof address !== 'string' || !address) continue
        if (family === 'evm' && evmPlaceholder.test(address)) continue
        hasAddress = true
        const normalized = contractAddress(family, address)
        if (!normalized) continue
        const id = slug + ':' + normalized
        if ((venue.id === 'binance' || venue.id === 'weex') && network.coin != null && network.coin !== raw) conflict = true
        // Some venue units stand for a multiple of the on-chain token. A plain ERC-20 price cannot represent them.
        if (network.denomination != null && Number(network.denomination) !== 1) conflict = true
        const other = owners.get(id)
        if (other && other !== label) {
          conflicts.add(label)
          conflicts.add(other)
        } else owners.set(id, label)
        if (ids.has(slug) && ids.get(slug) !== id) conflict = true
        ids.set(slug, id)
      }
    }
    const contracts = [...ids.values()].sort()
    if (conflict || (hasAddress && !contracts.length) || (result.has(label) && result.get(label).join() !== contracts.join())) conflicts.add(label)
    result.set(label, contracts)
  }
  for (const label of conflicts) result.set(label, null)
  if (!result.size) throw new Error('Missing currency labels')
  return result
}
