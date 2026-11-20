import { keccak256 } from '../../intel/keccak.js'
import { abiAddress, tronAddress, tronHex } from './address.js'
import { FACTORIES } from './deployments.js'

const topics = {
  v2: keccak256('PairCreated(address,address,address,uint256)').slice(2),
  v3: keccak256('PoolCreated(address,address,uint24,int24,address,uint256)').slice(2),
}
const uint = n => Number.isSafeInteger(n) && n > 0
// Wire hashes carry 0x. Legacy New-token readers can otherwise mistake hex without a zero for a Solana signature.
const txId = s => typeof s === 'string' && /^0x[0-9a-f]{64}$/.test(s)
const validFee = n => Number.isSafeInteger(n) && n > 0 && n < 1_000_000
const fromWord = s => typeof s === 'string' && /^0{24}[0-9a-f]{40}$/i.test(s) && !/^0+$/.test(s)
  ? tronAddress('0x' + s.slice(24)) : null

export function hintFactory(p) {
  if (p.chain !== 'tron' || !uint(p.block) || !txId(p.tx)) return null
  const [pool, a, b] = [p.pool, p.token0, p.token1].map(tronHex)
  const zero = '41' + '0'.repeat(40)
  if (!pool || !a || !b || pool === zero || a === zero || a >= b || pool === a || pool === b) return null
  return FACTORIES.find(f => f.event && f.dex === p.dex && f.kind === p.kind)
}

export const PAGE_SIZE = 16

/** Keep the complete immutable query across pages. Never follow a URL supplied by the index. */
export function eventPath(f, { from, until, fingerprint }) {
  const params = new URLSearchParams({ event_name: f.event, only_confirmed: 'true', order_by: 'block_timestamp,asc',
    limit: String(PAGE_SIZE), min_block_timestamp: String(from), max_block_timestamp: String(until) })
  if (fingerprint) params.set('fingerprint', fingerprint)
  return '/v1/contracts/' + f.address + '/events?' + params
}

export function parsePage(f, json, window) {
  if (json?.success !== true || !Array.isArray(json.data) || json.data.length > PAGE_SIZE ||
      !json.meta || json.meta.page_size !== json.data.length) throw new Error('Invalid TronGrid event page')
  const fingerprint = json.meta.fingerprint ?? null
  if ((json.meta.links?.next && !fingerprint) || (fingerprint != null &&
      (typeof fingerprint !== 'string' || !/^[A-Za-z0-9_+/=-]{1,4096}$/.test(fingerprint) ||
       fingerprint === window.fingerprint))) throw new Error('Invalid TronGrid continuation')
  const pools = json.data.map(e => {
    const r = e?.result
    const p = { chain: 'tron', dex: f.dex, kind: f.kind, block: e?.block_number, tx: '0x' + e?.transaction_id,
      pool: tronAddress(f.kind === 'v2' ? r?.pair ?? r?.[2] : r?.pool ?? r?.[4]), token0: tronAddress(r?.token0 ?? r?.[0]),
      token1: tronAddress(r?.token1 ?? r?.[1]), fee: f.kind === 'v3' ? Number(r?.fee ?? r?.[2]) : 0, firstSeen: e?.block_timestamp }
    if (e?.contract_address !== f.address || e.event_name !== f.event || !uint(p.firstSeen) ||
        p.firstSeen < window.from || p.firstSeen > window.until || (f.kind === 'v3' && !validFee(p.fee)) ||
        hintFactory(p) !== f) throw new Error('Invalid TronGrid factory event')
    return p
  })
  return { pools, fingerprint }
}

/** A solidified successful TRON transaction with the exact factory log. The V3 data includes poolLength. */
export function creationReceipt(p, receipt) {
  const f = hintFactory(p)
  if (!f || receipt?.id !== p.tx.slice(2) || receipt.blockNumber !== p.block || receipt.receipt?.result !== 'SUCCESS' ||
      !uint(receipt.blockTimeStamp) || !Array.isArray(receipt.log) || receipt.log.length > 1024) return null
  const v3 = f.kind === 'v3'
  for (const log of receipt.log) {
    if (log?.address !== abiAddress(f.address).slice(2) || !Array.isArray(log.topics) ||
        log.topics.length !== (v3 ? 4 : 3) || log.topics[0] !== topics[f.kind] ||
        fromWord(log.topics[1]) !== p.token0 || fromWord(log.topics[2]) !== p.token1 ||
        typeof log.data !== 'string' || log.data.length !== (v3 ? 192 : 128) || !/^[0-9a-f]+$/.test(log.data)) continue
    if (fromWord(log.data.slice(v3 ? 64 : 0, v3 ? 128 : 64)) !== p.pool) continue
    const fee = v3 && /^[0-9a-f]{64}$/.test(log.topics[3]) ? Number(BigInt('0x' + log.topics[3])) : 0
    if (!v3 || validFee(fee)) return { fee, firstSeen: receipt.blockTimeStamp }
  }
  return null
}
