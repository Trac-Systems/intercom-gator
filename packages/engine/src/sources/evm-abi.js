import { keccak256 } from '../intel/keccak.js'

const addressPattern = /^0x[0-9a-f]{40}$/i
const wordPattern = /^0x[0-9a-f]{64}$/i
export const ZERO = '0x' + '0'.repeat(40)
export const word = (n) => BigInt(n).toString(16).padStart(64, '0')
export function address(value) {
  if (typeof value !== 'string') return null
  if (addressPattern.test(value)) return value.toLowerCase()
  if (/^0x0{24}[0-9a-f]{40}$/i.test(value)) return '0x' + value.slice(-40).toLowerCase()
  return null
}
const magnitude = (n) => (n < 0n ? -n : n)
const signed = (n) => BigInt.asIntN(256, n)
const addrWord = (words, i) => address(words[i] == null ? '' : '0x' + word(words[i]))

/** Decode one bundle-declared topic. Addresses in indexed topics use the low 20 bytes. */
export function decodeEvent(log, event) {
  const signature = typeof event === 'string' ? event : event.signature
  if (
    log.removed ||
    !address(log.address) ||
    !Array.isArray(log.topics) ||
    !log.topics.every((t) => wordPattern.test(t)) ||
    !/^0x(?:[a-f0-9]{64}){1,16}$/i.test(log.data) ||
    (event.topicCount != null && (log.topics.length !== event.topicCount || log.data.length !== 2 + 64 * event.dataWords))
  )
    return null
  const words = log.data
    .slice(2)
    .match(/.{64}/g)
    .map((s) => BigInt('0x' + s))
  const [, a, b, c] = log.topics
  const emitter = address(log.address)
  if (signature.startsWith('Sync(') && words.length === 2 && words[0] && words[1])
    return { type: 'sync', emitter, pool: emitter, amount0: words[0], amount1: words[1] }
  if (signature === 'PlainPoolDeployed(address[4],uint256,uint256,address)') {
    const coins = curveCoins(log.data.slice(0, 258))
    return coins ? { type: 'curve-deployment', emitter, coins } : null
  }
  if (signature === 'TokenExchange(address,int128,uint256,int128,uint256)') {
    const [sold, input, bought, output] = words
    // One market per pool. The classic factory's first two coin slots define its wire pair.
    if (!input || !output || !((sold === 0n && bought === 1n) || (sold === 1n && bought === 0n))) return null
    return { type: 'swap', emitter, pool: emitter, amount0: sold === 0n ? input : output,
      amount1: sold === 0n ? output : input }
  }
  if (/^(PairCreated|PoolCreated|Initialize\(bytes32)/.test(signature)) {
    const v4 = signature.startsWith('Initialize')
    const v3 = signature.startsWith('PoolCreated(address,address,uint24,')
    const solidly = signature === 'PairCreated(address,address,bool,address,uint256)'
    const pool = v4 ? a : addrWord(words, v3 || solidly ? 1 : 0)
    const token0 = address(v4 ? b : a),
      token1 = address(v4 ? c : b)
    if (!pool || !token0 || !token1 || token0 === token1) return null
    const result = { type: 'pool', emitter, pool: pool.toLowerCase(), token0, token1 }
    if (v4 && words[1] > 0n && words[1] <= 32767n) result.spacing = Number(words[1])
    if (solidly || signature.startsWith('PoolCreated(address,address,bool,')) {
      const flag = solidly ? words[0] : c && BigInt(c)
      if (flag !== 0n && flag !== 1n) return null
      result.stable = Number(flag)
    }
    return result
  }
  let amount0,
    amount1,
    sqrt,
    pool = emitter,
    pair
  if (/^Swap\(address,(uint256|address,uint256)/.test(signature) && words.length === 4) {
    amount0 = words[0] - words[2]
    amount1 = words[1] - words[3]
    if (amount0 * amount1 >= 0n) return null
  } else if (/^Swap\((address,address,int256|bytes32,address,int128)/.test(signature) && words.length >= 5) {
    if (signature.startsWith('Swap(bytes32')) pool = a?.toLowerCase()
    amount0 = signed(words[0])
    amount1 = signed(words[1])
    if (amount0 * amount1 >= 0n) return null
    sqrt = words[2]
  } else if (signature === 'Swap(bytes32,address,address,uint256,uint256)' && words.length === 2) {
    pool = a?.toLowerCase()
    pair = [address(b), address(c)]
    if (!pair[0] || !pair[1] || pair[0] === pair[1]) return null
    ;[amount0, amount1] = words
  } else return null
  if (!pool || !amount0 || !amount1 || sqrt === 0n) return null
  return { type: 'swap', emitter, pool, pair, amount0: magnitude(amount0), amount1: magnitude(amount1), sqrt }
}

/** Decode the fixed address[4] from Curve's classic plain factory. */
export function curveCoins(data) {
  if (typeof data !== 'string' || !/^0x(?:0{24}[a-f0-9]{40}){4}$/i.test(data)) return null
  const slots = data.slice(2).match(/.{64}/g).map(w => address('0x' + w))
  const end = slots.indexOf(ZERO)
  const coins = end < 0 ? slots : slots.slice(0, end)
  if (coins.length < 2 || new Set(coins).size !== coins.length || slots.slice(coins.length).some(a => a !== ZERO)) return null
  return coins
}

function reservePrice(x, y, stable) {
  const r = y / x
  // Marginal dy/dx for the normalized Solidly invariant x³y + xy³.
  return stable ? r * ((3 + r ** 2) / (1 + 3 * r ** 2)) : r
}

/** Convert raw amounts with ERC-20/native decimals; price is always in quote units per base. */
export function swapValue(swap, pool, decimals0, decimals1, inverse) {
  if (![decimals0, decimals1].every((d) => Number.isInteger(d) && d >= 0 && d <= 77)) return null
  let a = swap.amount0,
    b = swap.amount1
  if (swap.pair) {
    if (swap.pair[0] === pool.token1 && swap.pair[1] === pool.token0) [a, b] = [b, a]
    else if (swap.pair[0] !== pool.token0 || swap.pair[1] !== pool.token1) return null
  }
  const size0 = Number(a) / 10 ** decimals0,
    size1 = Number(b) / 10 ** decimals1
  const rate = swap.sqrt ? (Number(swap.sqrt) / 2 ** 96) ** 2 * 10 ** (decimals0 - decimals1) :
    reservePrice(size0, size1, swap.type === 'sync' && pool.stable)
  const price = inverse ? 1 / rate : rate
  return Number.isFinite(price) && price > 0 ? { price, baseVolume: inverse ? size1 : size0 } : null
}

/** ABI for aggregate3((address,bool,bytes)[]), allowFailure=true for each read. */
export function encodeAggregate(calls) {
  let offset = calls.length * 32
  const offsets = [],
    tuples = []
  for (const { to, data } of calls) {
    if (!addressPattern.test(to) || !/^0x(?:[a-f0-9]{2})+$/i.test(data)) throw new TypeError('Invalid multicall')
    const payload = data.slice(2)
    const tuple =
      word(to) +
      word(1) +
      word(96) +
      word(payload.length / 2) +
      payload.padEnd(Math.ceil(payload.length / 64) * 64, '0')
    offsets.push(word(offset))
    tuples.push(tuple)
    offset += tuple.length / 2
  }
  return '0x82ad56cb' + word(32) + word(calls.length) + offsets.join('') + tuples.join('')
}

export function decodeAggregate(data, count) {
  if (typeof data !== 'string' || !/^0x(?:[a-f0-9]{64})+$/i.test(data))
    throw new TypeError('Invalid multicall response')
  const hex = data.slice(2)
  function uint(pos) {
    if (!Number.isSafeInteger(pos) || pos < 0 || pos % 64 || pos + 64 > hex.length)
      throw new RangeError('Invalid ABI offset')
    const n = Number(BigInt('0x' + hex.slice(pos, pos + 64)))
    if (!Number.isSafeInteger(n)) throw new RangeError('Invalid ABI size')
    return n
  }
  const array = uint(0) * 2,
    start = array + 64
  if (uint(array) !== count) throw new Error('Incomplete multicall')
  return Array.from({ length: count }, (_, i) => {
    const tuple = start + uint(start + i * 64) * 2
    const ok = uint(tuple),
      bytes = tuple + uint(tuple + 64) * 2,
      size = uint(bytes) * 2
    if (ok > 1 || bytes + 64 + size > hex.length) throw new RangeError('Truncated multicall')
    return ok ? '0x' + hex.slice(bytes + 64, bytes + 64 + size) : null
  })
}

export async function multiRead(rpc, chain, calls, block = 'latest') {
  if (!calls.length) return []
  if (!chain.multicall)
    return rpc.batch(
      chain.id,
      calls.map((call) => ({ method: 'eth_call', params: [call, block] }))
    )
  const data = encodeAggregate(calls)
  return decodeAggregate(await rpc.call(chain.id, 'eth_call', [{ to: chain.multicall, data }, block]), calls.length)
}

/** The v4 pool key is ABI encoded in currency order, with a zero hook for deterministic probes. */
export function v4PoolId(token0, token1, fee, spacing) {
  const encoded = [token0, token1, fee, spacing, ZERO].map(word).join('')
  return keccak256(Buffer.from(encoded, 'hex'))
}

/** Uniswap v4-core StateLibrary: _pools is mapping slot 6, active liquidity is at offset 3. */
export function v4StateCall(manager, id, offset = 0) {
  const slot = keccak256(Buffer.from(word(id) + word(6), 'hex'))
  return { to: manager, data: '0x1e2eaeaf' + word(BigInt.asUintN(256, BigInt(slot) + BigInt(offset))) }
}

const RESERVES = ['v2', 'velodrome-v2', 'solidly-v1']
const CONCENTRATED = ['v3', 'pancake-v3', 'slipstream']
export const STATE_KINDS = [...RESERVES, ...CONCENTRATED, 'v4']
const Q96 = 2 ** 96
export const field = (data, i) =>
  typeof data === 'string' && /^0x(?:[0-9a-f]{64})+$/i.test(data) && data.length >= 66 + i * 64
    ? BigInt('0x' + data.slice(2 + i * 64, 66 + i * 64)) : null

/** Reads at one block tag. A V4 seed already has its packed slot0 from the lookup. */
export function poolStateCalls(p) {
  if (p.kind === 'v4') {
    const active = v4StateCall(p.manager, p.pool, 3)
    return p.slot0 ? [active] : [v4StateCall(p.manager, p.pool), active]
  }
  if (RESERVES.includes(p.kind)) {
    const calls = [{ to: p.pool, data: '0x0902f1ac' }]
    if (p.kind !== 'v2' && p.stable == null) calls.push({ to: p.pool, data: '0x22be3de1' })
    return calls
  }
  return [{ to: p.pool, data: '0x3850c7bd' }, { to: p.pool, data: '0x1a686502' },
    ...[p.token0, p.token1].map(to => ({ to, data: '0x70a08231' + word(p.pool) }))]
}

/** Decode spot price in token1 per token0 and funded amounts in token units. */
export function poolStateValue(p, values, decimals) {
  if (!decimals.every(d => Number.isInteger(d) && d >= 0 && d <= 77)) return null
  const [u, v] = decimals.map(d => 10 ** d)
  const first = field(values[0], 0)
  if (first == null) return null
  let x, y, rate
  if (RESERVES.includes(p.kind)) {
    const second = field(values[0], 1)
    if (second == null) return null
    x = Number(first) / u
    y = Number(second) / v
    let stable = p.stable
    if (p.kind !== 'v2' && stable == null) {
      const flag = field(values[1], 0)
      if (flag !== 0n && flag !== 1n) return null
      stable = flag === 1n
    }
    rate = reservePrice(x, y, stable)
  } else {
    const liquidity = field(values[1], 0)
    if (liquidity == null) return null
    if (!liquidity || !first) return { empty: true }
    const sqrt = Number(p.kind === 'v4' ? BigInt.asUintN(160, first) : first) / Q96
    if (!(sqrt > 0)) return { empty: true }
    rate = sqrt ** 2 * u / v
    if (p.kind === 'v4') {
      // Manager balances are shared. These are amounts guaranteed by the active liquidity in
      // the current tick-spacing interval, a conservative lower bound on pool-specific capital.
      const tick = Number(BigInt.asIntN(24, first >> 160n))
      const spacing = p.spacing ?? 1
      const lower = Math.floor(tick / spacing) * spacing
      const lo = 1.0001 ** (Math.max(-887272, lower) / 2)
      const hi = 1.0001 ** (Math.min(887272, lower + spacing) / 2)
      x = Math.max(0, Number(liquidity) * (1 / sqrt - 1 / hi)) / u
      y = Math.max(0, Number(liquidity) * (sqrt - lo)) / v
    } else {
      const a = field(values[2], 0), b = field(values[3], 0)
      if (a == null || b == null) return null
      x = Number(a) / u
      y = Number(b) / v
    }
  }
  if (!(rate > 0 && Number.isFinite(rate)) || !(x + y > 0)) return { empty: true }
  return { price: rate, reserve0: x, reserve1: y }
}
