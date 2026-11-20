import { base58 } from '@scure/base'
import { createHash } from 'node:crypto'
import { labels } from '../names/text.js'

export const CETUS = '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb'
export const TURBOS = '0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1'
export const HYPERION = '0x8b4a2c4bb53857c718a04c020b98f8c2e1f99a68b0f57389a8bf5434cd22e05c'
export const THALA = '0x7730cd28ee1cdc9e999336cbc430f99e7c44397c0aa77516f6f23a78559bb5'
export const THALA_LENS = '0x2ee2526b8035890ebf30510aae8891d41116d83d2b5b7d774a3bc73d2b751d61'
export const CAKE = '0xc7efb4076dbe143cbcd98cfaaa929ecfc8f299203dfff63b95ccb6bfe19850fa'
export const LIQUID = '0x190d44266241744264b964a37b8f09863167a12d3e70cda39376cfb4e3561e12'
export const LIQUID_ACCOUNT = '0x05a97986a9d031c4567e15b797be516910cfcb4156312482efc6a19c0a30c948'
export const SUI = '0x2::sui::SUI', APT = '0x1::aptos_coin::AptosCoin'
export const STABLES = {
  sui: ['0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN'],
  aptos: ['0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b',
    '0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b'],
}
export const APTOS_BRIDGED_USD = '0xf22bede237a07e121b56d91a491eb7bcdfd1f5907926a9e58338f964a01b17fa::asset::'
const secondaryQuotes = {
  aptos: new Set([APTOS_BRIDGED_USD + 'USDC', APTOS_BRIDGED_USD + 'USDT']),
  sui: new Set([STABLES.sui[1],
    '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN',
    '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT']),
}

// Every peer must publish a given pool in the same direction. This ordering grants no USD value.
export function moveQuoteRank(chain, asset) {
  if (asset.stable) return 3
  if (asset.address === 'native') return 2
  return Number(secondaryQuotes[chain].has(asset.address))
}
const TYPES = { sui: { cetus: 'clmm', turbos: 'clmm' }, aptos: { hyperion: 'clmm', thalaswap: 'v2',
  'pancakeswap-aptos': 'v2', liquidswap: 'uncorrelated' } }
export const moveChain = chain => chain === 'sui' || chain === 'aptos'
export const objectId = v => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v)
export const digest = v => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) && base58.decode(v).length === 32
export const natural = n => Number.isSafeInteger(n) && n >= 0
export const units = n => typeof n === 'string' && /^\d{1,39}$/.test(n) ? Number(n) : NaN

/** Package identifiers are hex, Move identifiers are case-sensitive. Framework addresses are short. */
export function moveType(value) {
  if (typeof value !== 'string' || value.length > 230) return null
  const m = /^(?:0x)?([0-9a-fA-F]{1,64})(::[a-zA-Z_][a-zA-Z_0-9]{0,79}::[a-zA-Z_][a-zA-Z_0-9]{0,79})$/.exec(value)
  if (!m) return null
  const hex = BigInt('0x' + m[1]).toString(16)
  return '0x' + (hex.length === 1 ? hex : hex.padStart(64, '0')) + m[2]
}
export function fa(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{1,64}$/.test(value)) return null
  const full = '0x' + value.slice(2).padStart(64, '0')
  return BigInt(full) === 10n ? '0xa' : full
}
export const assetAddress = (chain, token) => (chain === 'sui' ? token === SUI : token === '0xa' || token === APT) ? 'native' : token
export const validToken = (chain, v) => typeof v === 'string' && (moveType(v) === v || (chain === 'aptos' && fa(v) === v))
export function validPool(p, seed = false) {
  return moveChain(p.chain) && Object.hasOwn(TYPES[p.chain], p.dex) &&
    (TYPES[p.chain][p.dex] === p.kind || (p.dex === 'liquidswap' && p.kind === 'stable')) &&
    objectId(p.pool) && validToken(p.chain, p.token0) && validToken(p.chain, p.token1) &&
    assetAddress(p.chain, p.token0) !== assetAddress(p.chain, p.token1) &&
    ((seed && p.tx == null && p.block == null) || (natural(p.block) && (p.chain === 'sui' ? digest(p.tx) : objectId(p.tx))))
}
export function metadata(row, address) {
  const text = labels(row, address)
  return text && !/[<>]/u.test(text.name + text.symbol) && Number.isInteger(row.decimals) &&
    row.decimals >= 0 && row.decimals <= 77 ? { ...text, decimals: row.decimals } : null
}
export function resourcePool(account, type) {
  return '0x' + createHash('sha256').update(account + '/' + type).digest('hex')
}
export const rawRatio = (sqrt, d0, d1) => (units(sqrt) / 2 ** 64) ** 2 * 10 ** (d0 - d1)
