import { DAY } from './supply-api.js'
import { units } from './supply-emission.js'

const decimal = /^(?:0|[1-9]\d{0,14})(?:\.\d{1,24})?$/
function quantity(raw) {
  const text = typeof raw === 'number' ? String(raw) : raw
  if (typeof text !== 'string' || !decimal.test(text)) throw new Error('Invalid circulation quantity')
  return text
}
const scaled = text => {
  const [whole, fraction = ''] = quantity(text).split('.')
  return BigInt(whole + fraction.padEnd(24, '0'))
}
function uint(raw, length = 36) {
  if (typeof raw !== 'string' || raw.length > length || !/^\d+$/.test(raw)) throw new Error('Invalid supply units')
  return BigInt(raw)
}

/** Only these chain:address identities may consume each feed. Dates are measurement times, in UTC.
 * A missing source timestamp means a current-state request and is valid only from its receipt. */
export const CIRCULATION_FEEDS = [
  { api: 'bnb-burn', asset: 'bsc:native', method: 'bnb-post-burn', read(data) {
    // BNB Chain directs readers to BNBBurn for combined post-burn circulation after Beacon Chain fusion.
    // WBNB is a redeemable wrapper. Its contract supply would measure only the wrapped subset.
    if (data?.bcSupply !== 0 || scaled(data.bscSupply) > scaled('200000000')) throw new Error('Unexpected BNB supply')
    return { value: quantity(data.bscSupply) }
  } },
  { api: 'tronscan-funds', asset: 'tron:native', method: 'tron-circulation', read(data) {
    // The native explorer accounts for rewards, burns and non-circulating balances in circulationSupply.
    if (data?.genesisBlockIssue !== 1e11 || scaled(data.circulationSupply) > scaled(data.totalTurnOver))
      throw new Error('Unexpected TRX supply')
    return { value: quantity(data.circulationSupply) }
  } },
  { api: 'avax-supply', asset: 'avalanche:native', method: 'avax-unlocked-issuance', read(data) {
    // The explorer labels all net issuance as circulating, including separately reported locked AVAX.
    // Deduct vesting once. Staked AVAX stays in circulation. P/X/C burns already reduced totalSupply.
    const total = scaled(data?.totalSupply), locked = scaled(data.totalLocked), unlocked = total - locked
    const circulation = scaled(data.circulatingSupply)
    if (unlocked <= 0n || total > scaled('720000000') || (circulation !== total && circulation !== unlocked))
      throw new Error('Inconsistent AVAX issuance')
    return { value: units(unlocked, 24), total: data.totalSupply, at: Date.parse(data.lastUpdated), estimate: true }
  } },
  { api: 'tontech-circulation', asset: 'ton:native', method: 'tontech-circulating', read(data) {
    // TON's Foundation-endorsed float excludes the Believers Fund, Telegram and Foundation reserves.
    return { value: quantity(data?.result) }
  } },
  { api: 'sui-circulation', asset: 'sui:native', method: 'sui-release-schedule', read(data, now) {
    // The Foundation publishes the end-of-month release estimate. Unreleased allocations stay excluded.
    const date = new Date(now), total = '10000000000', value = quantity(data?.circulatingSupplyValue)
    if (data.year !== date.getUTCFullYear() || data.month !== date.getUTCMonth() + 1 ||
        typeof data.circulatingSupplyPercentage !== 'number' || !Number.isFinite(data.circulatingSupplyPercentage) ||
        scaled(value) > scaled(total) || Math.abs(Number(value) / 1e10 - data.circulatingSupplyPercentage) > 1e-12)
      throw new Error('Unexpected Sui circulation schedule')
    return { value, total, estimate: true, validUntil: Date.UTC(data.year, data.month, 1) }
  } },
  { api: 'ripple-distribution', asset: 'xrpl:native', method: 'ripple-distributed', maxAge: 35 * DAY, read(data) {
    // Ripple reports whole XRP distributed outside its escrow and directly held undistributed balance.
    if (data?.result !== 'success' || data.count !== 1 || data.rows?.length !== 1) throw new Error('Missing XRP distribution')
    const row = data.rows[0], distributed = uint(row?.distributed)
    if (distributed + uint(row.undistributed) + uint(row.escrowed) !== uint(row.total) || uint(row.total) > 100_000_000_000n)
      throw new Error('Inconsistent XRP distribution')
    // The newer validated ledger remains the source of total XRP.
    return { value: row.distributed, at: Date.parse(row.date) }
  } },
  { api: 'near-circulation', asset: 'near:native', method: 'near-unlocked', read(data) {
    // NearBlocks' dated lockup-adjusted series, denominated in yoctoNEAR.
    return { value: units(uint(data?.circulating_supply_in_yoctonear), 24), at: Number(uint(data.timestamp, 20) / 1000000n) }
  } },
  { api: 'aptos-circulation', asset: 'aptos:native', method: 'aptos-foundation-float', read(data) {
    // The Foundation applies its monthly unlock schedule to mainnet supply at the given ledger version.
    const value = quantity(data?.current_circulating_supply)
    if (scaled(value) > scaled(data.current_total_supply) || !Number.isSafeInteger(data.blockchain_time_microseconds) ||
        !Number.isSafeInteger(data.ledger_version) || data.ledger_version < 1) throw new Error('Invalid Aptos supply')
    return { value, at: Math.floor(data.blockchain_time_microseconds / 1000), block: data.ledger_version }
  } },
  { api: 'aptos-usd1', asset: 'aptos:0x05fabd1b12e39967a3c24e91b7b8f67719a6dacee74f3c8b9fb7d93e855437d2',
    method: 'aptos-issued-usd1', body: { function: '0x1::fungible_asset::supply',
      type_arguments: ['0x1::fungible_asset::Metadata'],
      arguments: ['0x05fabd1b12e39967a3c24e91b7b8f67719a6dacee74f3c8b9fb7d93e855437d2'] }, read(data) {
      // USD1 is issued on deposit and burned on redemption. This estimate covers only the Aptos deployment.
      if (!Array.isArray(data) || data.length !== 1 || !Array.isArray(data[0]?.vec) || data[0].vec.length !== 1)
        throw new Error('Invalid Aptos USD1 supply')
      const value = units(uint(data[0].vec[0]), 6)
      return { value, total: value, estimate: true }
    } },
  { api: 'kamino-circulation', asset: 'solana:KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS',
    method: 'kamino-released', read(raw) {
      if (scaled(raw) > scaled('10000000000')) throw new Error('Invalid KMNO supply')
      return { value: quantity(raw) }
    } },
  { api: 'jup-circulation', asset: 'solana:JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    method: 'jup-released', read(data) {
      if (scaled(data?.circulating) > scaled(data.total) || scaled(data.total) > scaled('10000000000'))
        throw new Error('Invalid JUP supply')
      return { value: quantity(data.circulating), total: quantity(data.total) }
    } },
]

export function readCirculation(feed, payload, now) {
  const { at = now, validUntil = Infinity, ...row } = feed.read(payload, now)
  const expiresAt = Math.min(validUntil, at + (feed.maxAge ?? 2 * DAY))
  if (!Number.isSafeInteger(at) || at <= 0 || at > now || expiresAt <= now || scaled(row.value) === 0n)
    throw new Error('Expired or invalid circulating supply')
  return { ...row, at, expiresAt, source: feed.api, method: feed.method }
}
