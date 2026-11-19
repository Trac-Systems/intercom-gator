import { units } from './supply-emission.js'

const rpc = (method, params = []) => ({ id: 1, jsonrpc: '2.0', method, params })
const assert = ok => { if (!ok) throw new Error('Invalid coin supply response') }
const integer = (value, length = 36) => {
  assert(typeof value === 'string' && /^\d+$/.test(value) && value.length <= length)
  return BigInt(value)
}
const height = n => Number.isSafeInteger(n) && n > 0
const result = data => {
  assert(data?.id === 1 && !data.error && data.result != null)
  return data.result
}
const bounded = (value, max) => {
  assert((typeof value === 'string' || typeof value === 'number') && Number(value) > 0 && Number(value) <= max)
  return String(value)
}

// Each endpoint is pinned to an identity in the signed bundle. readCirculation checks measurement
// time and decimal syntax and records a two-day expiry unless the feed specifies a shorter one.
export const COIN_FEEDS = [
  { api: 'zcash-ledger', asset: 'zcash:native', method: 'zcash-chain-supply', body: rpc('getblockchaininfo'), read(data) {
    const r = result(data), zat = r.chainSupply?.chainValueZat
    assert(r.chain === 'main' && height(r.blocks) && r.blocks === r.headers && r.chainSupply.monitored &&
      Number.isSafeInteger(zat) && zat > 0 && zat <= 21e14 && Array.isArray(r.valuePools))
    // ZIP 1015 deferred rewards have not been released. Shielded pools still circulate.
    const locks = r.valuePools.filter(p => p.id === 'lockbox')
    assert(locks.length === 1 && locks[0].monitored && Number.isSafeInteger(locks[0].chainValueZat) &&
      locks[0].chainValueZat >= 0 && locks[0].chainValueZat <= zat)
    return { total: units(BigInt(zat), 8), value: units(BigInt(zat - locks[0].chainValueZat), 8), block: r.blocks }
  } },
  { api: 'etc-blockscout', asset: 'ethereum-classic:native', method: 'etc-explorer-issuance', read(r) {
    assert(r?.status === '1' && r.message === 'OK')
    return { value: bounded(r.result, 210_700_000), estimate: true }
  } },
  { api: 'monero-emission', asset: 'monero:native', method: 'monero-mined-emission', read(r) {
    assert(height(r?.height) && height(r.last_timestamp))
    const value = units(integer(r.total_emission), 12)
    return { value, total: value, block: r.height, at: r.last_timestamp * 1000 }
  } },
  { api: 'hedera-supply', asset: 'hedera:native', method: 'hedera-released', read(r) {
    const total = integer(r?.total_supply), released = integer(r.released_supply)
    assert(total === 50_000_000_000n * 100_000_000n && released <= total && /^\d{10}\.\d{9}$/.test(r.timestamp))
    return { value: units(released, 8), total: units(total, 8), at: Math.floor(Number(r.timestamp) * 1000) }
  } },
  { api: 'bittensor-issuance', asset: 'bittensor:native', method: 'subtensor-total-issuance',
    // twox128("SubtensorModule") ++ twox128("TotalIssuance"). SCALE encoded u64 rao.
    body: rpc('state_getStorage', ['0x658faa385070e074c85bf6b568cf055557c875e4cff74148e4628f264b974c80']),
    read(data) {
      const raw = result(data)
      assert(/^0x[\da-f]{16}$/i.test(raw))
      const value = units(Buffer.from(raw.slice(2), 'hex').readBigUInt64LE(), 9)
      return { value: bounded(value, 21_000_000), total: value, estimate: true }
    } },
  { api: 'icp-ledger', asset: 'internet-computer:native', method: 'icp-ledger-circulating', read(row) {
    assert(Array.isArray(row) && row.length === 2 && height(row[0]))
    return { value: units(integer(row[1]), 8), at: row[0] * 1000 }
  } },
  { api: 'polkadot-issuance', asset: 'polkadot:native', method: 'asset-hub-net-issuance', body: {}, read(r) {
    const dot = r?.data?.detail?.DOT
    assert(r?.code === 0 && height(r.generated_at) && dot?.asset_type === 'native' && dot.symbol === 'DOT' && dot.token_decimals === 10)
    const total = integer(dot.total_issuance), treasury = integer(dot.treasury_balance)
    assert(treasury < total)
    return { value: units(total - treasury, 10), total: units(total, 10), at: r.generated_at * 1000, estimate: true }
  } },
  { api: 'kaspa-supply', asset: 'kaspa:native', method: 'kaspa-circulating', read(r) {
    const issued = integer(r?.circulatingSupply), max = integer(r.maxSupply)
    assert(issued <= max && max === 2870403560500000000n)
    return { value: units(issued, 8) }
  } },
  { api: 'algorand-supply', asset: 'algorand:native', method: 'algorand-foundation-circulating', read(r) {
    assert(r?.Network === 'mainnet' && height(r.Round) && Number.isInteger(r.CirculatingSupply) &&
      r.CirculatingSupply > 0 && r.CirculatingSupply <= 1e16)
    // The Foundation serializes microAlgos as a JSON number above JS safe-integer precision.
    return { value: String(Math.floor(r.CirculatingSupply / 1e6)), block: r.Round, at: Date.parse(r.Datetime), estimate: true }
  } },
  { api: 'filfox-supply', asset: 'filecoin:native', method: 'filecoin-vm-circulating', read(r) {
    assert(height(r?.height) && height(r.timestamp) && r.totalMaxSupply === '2000000000000000000000000000')
    const issued = integer(r.circulatingSupply)
    assert(issued <= BigInt(r.totalMaxSupply))
    return { value: units(issued, 18), block: r.height, at: r.timestamp * 1000 }
  } },
  { api: 'pi-mainnet-supply', asset: 'pi:native', method: 'pi-migrated-circulating', read(r) {
    assert(r?.circulating_supply === r?.total_circulating_supply && r.circulating_supply <= r.total_supply)
    return { value: bounded(r.circulating_supply, 100e9), at: Date.parse(r.updated_at) }
  } },
  { api: 'pearl-blockbook', asset: 'pearl:native', method: 'pearl-scheduled-emission', read(r) {
    const b = r?.blockbook
    assert(b?.coin === 'Pearl' && b.inSync === true && r.backend?.chain === 'mainnet' &&
      height(b.bestHeight) && b.bestHeight === r.backend.blocks)
    const h = BigInt(b.bestHeight)
    const issued = 2100000000n * 100000000n * h / (650226n + h)
    return { value: units(issued, 8), block: b.bestHeight, at: Date.parse(b.lastBlockTime), estimate: true }
  } },
  { api: 'zilliqa-supply', asset: 'zilliqa:native', method: 'zilliqa-net-issuance',
    body: rpc('GetTotalCoinSupply'), read(data) { return { value: bounded(result(data), 21e9), estimate: true } } },
  { api: 'lunc-bank', asset: 'terra-classic:native', method: 'classic-bank-issuance', read(r) {
    assert(r?.amount?.denom === 'uluna')
    return { value: units(integer(r.amount.amount), 6), estimate: true }
  } },
  { api: 'bitfinex-leo', asset: 'ethereum:0x2af5d2ad76741191d15dfe7bf6ac92d4bd912ca3', method: 'bitfinex-leo-after-burn', read(row) {
    assert(Array.isArray(row) && row.length === 2 && height(row[0]))
    const remaining = bounded(row[1], 1e9)
    return { value: remaining, total: remaining, at: row[0] }
  } },
  { api: 'render-foundation', asset: 'solana:rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof', method: 'render-solana-circulating', read(r) {
    assert(r?.solanaCirculatingSupply > 0 && r.solanaCirculatingSupply <= r.solanaSupply &&
      r.solanaSupply <= r.totalSupply && r.totalSupply <= r.maxSupply && r.maxSupply === 644168762)
    return { value: String(r.solanaCirculatingSupply), total: String(r.solanaSupply) }
  } },
  { api: 'chainlink-supply', asset: 'ethereum:0x514910771af9ca656af840dff83e8264ecf986ca', method: 'link-issued-minus-reserves', read(r) {
    const total = integer(r?.totalSupply), issued = integer(r.circulatingSupply)
    assert(total === 10n ** 27n && Array.isArray(r.balances) && r.balances.length > 0 && r.balances.length <= 256 &&
      new Set(r.balances.map(b => b.address.toLowerCase())).size === r.balances.length &&
      r.balances.reduce((n, b) => n + integer(b.balance), issued) === total)
    return { value: units(issued, 18), total: units(total, 18) }
  } },
  { api: 'wlfi-supply', asset: 'ethereum:0xda5e1988097297dcdc1f90d4dfe7909e847cbef6', method: 'wlfi-released',
    read: value => ({ value: bounded(value, 100e9) }) },
  { api: 'htx-tronscan', asset: 'tron:TUPM7K8REVzD2UdV4R5fe5M8XbnR2DdoJ6', method: 'tronscan-token-float',
    read: value => ({ value: bounded(value, 999990000000000) }) },
  { api: 'jst-tronscan', asset: 'tron:TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9', method: 'tronscan-token-float',
    read: value => ({ value: bounded(value, 9900000000) }) },
  { api: 'wbt-tronscan', asset: 'tron:TFptbWaARrWTX5Yvy3gNG5Lm8BmhPx82Bt', method: 'wbt-tron-post-burn',
    read: value => ({ value: bounded(value, 100000000), estimate: true }) },
  { api: 'whitechain-issuance', supplement: 'whitechain-reserve', asset: 'whitechain:native', method: 'whitechain-released',
    read({ primary, supplement }) {
      assert(primary?.status === '1' && primary.message === 'OK' &&
        supplement?.hash?.toLowerCase() === '0x4200000000000000000000000000000000000029' &&
        supplement.implementations?.some(implementation => implementation.name === 'NativeAssetLiquidity'))
      const total = integer(primary.result), reserve = integer(supplement.coin_balance)
      assert(reserve <= total && total <= 400000000n * 10n ** 18n)
      return { value: units(total - reserve, 18), total: units(total, 18), estimate: true }
    } },
]
