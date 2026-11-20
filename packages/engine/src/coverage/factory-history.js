import { address, decodeEvent, STATE_KINDS, word, ZERO } from '../sources/evm-abi.js'
import { logWindow } from '../sources/bundle-adapter.js'
import { errorKind } from '../rpc/index.js'
import { RateLimited } from '../scheduler/index.js'

export const HISTORY_FLOOR = 100
export const PAGE_SIZE = 32
export const MAX_SPAN = 65_536
export const hex = n => '0x' + n.toString(16)
export const quantity = value =>
  typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null

// allPairsLength / allPairs(i), and the Velodrome/Aerodrome allPools equivalents.
const arrays = {
  v2: ['0x574f2ba3', '0x1e3dd18b'],
  'solidly-v1': ['0x574f2ba3', '0x1e3dd18b'],
  'velodrome-v2': ['0xefde4e64', '0x41d1de97'],
  slipstream: ['0xefde4e64', '0x41d1de97'],
}
export function historyFactories(source) {
  return source.chain.deployments.filter(d => STATE_KINDS.includes(d.kind)).map(d => ({
    ...d, array: arrays[d.kind], topics: d.topics.filter(topic => {
      const e = source.chain.events[topic]
      return e && (e.emitter === 'factory' || e.signature.startsWith('Initialize('))
    }),
  }))
}

/** Stable half-open ranges across independent heads. Double the width every 128 ranges.
 * Even a chain at Number.MAX_SAFE_INTEGER needs fewer than 6,144 progress rows per factory. */
export function historyRanges(chain, factory, mode, end) {
  const result = []
  let width = mode === 'index' ? PAGE_SIZE : 4096
  for (let start = 0; start < end;) {
    result.push({ start, end: Math.min(end, start + width), key: ['history', chain, factory, mode, start].join(':') })
    start += width
    if (result.length % 128 === 0) width *= 2
  }
  if (mode === 'logs') result.reverse()
  return result
}

/** Keep the cursor at the first unread block on a span/size refusal, as in the add-token creation search. */
export async function logPage({ source, factory, rpc, from, end, after = -1, span, topics = [factory.topics] }) {
  const endpoints = source.rpc.chains?.get(source.chain.id)?.filter(e => !e.user) ?? source.chain.endpoints
  const width = Math.max(1, Math.min(end - from, span, MAX_SPAN, logWindow(endpoints ?? [])))
  const to = from + width - 1
  let logs
  try {
    logs = await rpc.call(source.chain.id, 'eth_getLogs', [{ address: factory.address, topics, fromBlock: hex(from), toBlock: hex(to) }])
  } catch (error) {
    if (error instanceof RateLimited) throw error
    if (width > 1 && ['range', 'too-large', 'timeout'].includes(errorKind(error).kind))
      return { retrySpan: Math.max(1, Math.floor(width / 2)) }
    throw error
  }
  if (!Array.isArray(logs)) throw new Error('Invalid factory history response')
  const entries = []
  for (const log of logs) {
    const block = quantity(log?.blockNumber), idx = quantity(log?.logIndex)
    const event = source.chain.events[log?.topics?.[0]]
    if (block === null || idx === null || block < from || block > to || log.removed ||
        !/^0x[0-9a-f]{64}$/i.test(log.transactionHash) || !/^0x[0-9a-f]{64}$/i.test(log.blockHash) ||
        log.address?.toLowerCase() !== factory.address || !factory.topics.includes(event?.topic))
      throw new Error('Invalid factory creation log')
    if (block === from && idx <= after) continue
    const p = decodeEvent(log, event)
    if (p?.type !== 'pool') throw new Error('Unreadable factory creation log')
    entries.push({ chain: source.chain.id, pool: p.pool, token0: p.token0 === ZERO ? 'native' : p.token0,
      token1: p.token1 === ZERO ? 'native' : p.token1, manager: factory.address, dex: factory.name, kind: factory.kind,
      spacing: p.spacing, stable: p.stable, block, idx, tx: log.transactionHash.toLowerCase() })
  }
  entries.sort((a, b) => a.block - b.block || a.idx - b.idx)
  if (entries.length > PAGE_SIZE) {
    const page = entries.slice(0, PAGE_SIZE), last = page.at(-1)
    return { pools: page, next: last.block, after: last.idx, span: Math.max(1, Math.floor(width * PAGE_SIZE / entries.length)) }
  }
  return { pools: entries, next: to + 1, after: -1, span: Math.min(MAX_SPAN, width * 2) }
}

/** An in-bounds missing array entry is a failed page. Never advance past an incomplete factory read. */
export async function indexPage(source, factory, from, end, read) {
  const size = Math.min(PAGE_SIZE, end - from)
  const values = await read(Array.from({ length: size }, (_, i) => ({ to: factory.address, data: factory.array[1] + word(from + i) })))
  const ids = values.map(address)
  if (ids.length !== size || ids.some(id => !id || id === ZERO)) throw new Error('Incomplete factory array')
  const tokens = await read(ids.flatMap(to => [{ to, data: '0x0dfe1681' }, { to, data: '0xd21220a7' }]))
  const pools = ids.flatMap((pool, i) => {
    const token0 = address(tokens[i * 2]), token1 = address(tokens[i * 2 + 1])
    // Some historical pairs have destroyed their contract. A failing optional pool call is local to that pair.
    if (!token0 || !token1 || token0 === ZERO || token1 === ZERO || token0 === token1) return []
    return [{ chain: source.chain.id, pool, token0, token1, manager: factory.address, kind: factory.kind,
      dex: factory.name, index: from + i }]
  })
  return { pools, next: from + size, after: -1 }
}
