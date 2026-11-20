import { RateLimited } from '../../scheduler/index.js'
import { APT, CAKE, HYPERION, LIQUID, LIQUID_ACCOUNT, THALA, THALA_LENS, fa, moveType, natural, objectId, resourcePool, units } from './identity.js'
import { once } from './client.js'

const MIN = 60_000
const PAGE = 20
const ZUSD = '0xf22bede237a07e121b56d91a491eb7bcdfd1f5907926a9e58338f964a01b17fa::asset::'
const CAKE_COIN = '0x159df6b7689437016108a019fd5bef736bac692b6d4a1f10c941f6fbb9a74ca6::oft::CakeOFT'
const cakeModule = CAKE + '::swap::', liquidModule = LIQUID + '::liquidity_pool::'
const thalaModule = THALA + '::pool::', hyperModule = HYPERION + '::pool_v3::'
const cakeHandle = '/accounts/' + CAKE + '/events/' + cakeModule + 'SwapInfo/pair_created'
const resource = (owner, type) => '/accounts/' + owner + '/resource/' + encodeURIComponent(type)
const versioned = (path, version) => version ? path + '?ledger_version=' + version : path
const view = (name, args) => ({ function: name, type_arguments: [], arguments: args })
const canonicalType = type => typeof type === 'string' ? type.replaceAll(', ', ',').replace(/0x[0-9a-f]+(::[A-Za-z_][A-Za-z_0-9]*){2}/g, t => moveType(t) ?? t) : null
const faPool = id => typeof id === 'string' && /^0x[0-9a-f]{1,64}$/.test(id) ? '0x' + id.slice(2).padStart(64, '0') : null

function legacyType(dex, token0, token1, kind) {
  return dex === 'liquidswap' ? liquidModule + 'LiquidityPool<' + [token0, token1, LIQUID + '::curves::' + (kind === 'stable' ? 'Stable' : 'Uncorrelated')].join(',') + '>' :
    cakeModule + 'TokenPairReserve<' + token0 + ',' + token1 + '>'
}
function legacy(dex, a, b, kind = dex === 'liquidswap' ? 'uncorrelated' : 'v2') {
  const token0 = moveType(a), token1 = moveType(b)
  if (!token0 || !token1 || token0 === token1) return null
  const account = dex === 'liquidswap' ? LIQUID_ACCOUNT : CAKE
  const pool = resourcePool(account, legacyType(dex, token0, token1, kind))
  return { pool, dex, token0, token1, kind }
}
function legacyStruct(dex, struct, type) {
  const liquid = dex === 'liquidswap'
  const prefix = (liquid ? liquidModule : cakeModule) + struct + '<'
  const tag = canonicalType(type)
  if (!tag?.startsWith(prefix) || !tag.endsWith('>')) return null
  const args = tag.slice(prefix.length, -1).split(',')
  if (args.length !== (liquid ? 3 : 2)) return null
  if (!liquid) return legacy(dex, args[0], args[1])
  const kind = args[2] === LIQUID + '::curves::Stable' ? 'stable' :
    args[2] === LIQUID + '::curves::Uncorrelated' ? 'uncorrelated' : null
  return kind ? legacy(dex, args[0], args[1], kind) : null
}

/** Marginal dy/dx for Liquidswap's stable invariant x³y + xy³, in human token units. */
export function liquidStableRatio(x, y) {
  const scale = Math.max(x, y)
  x /= scale
  y /= scale
  return y * (3 * x * x + y * y) / (x * (x * x + 3 * y * y))
}
function objectPair(dex, id, a, b) {
  const token0 = fa(a), token1 = fa(b), pool = faPool(id)
  return pool && token0 && token1 && token0 !== token1 ? { pool, dex, token0, token1, kind: dex === 'hyperion' ? 'clmm' : 'v2' } : null
}
function pairFromRow(dex, r) {
  if (dex === 'hyperion') {
    const p = objectPair(dex, r?.pool?.inner, r?.token_a?.inner, r?.token_b?.inner)
    return p && { ...p, raw0: r.token_a_reserve, raw1: r.token_b_reserve, active: units(r.liquidity_total) > 0 }
  }
  if (r?.assets_metadata?.length !== 2 || ![100,101,102].includes(r.pool_type)) return null
  const p = objectPair(dex, r.pool?.inner, r.assets_metadata[0]?.inner, r.assets_metadata[1]?.inner)
  return p && { ...p, raw0: r.balances[0], raw1: r.balances[1], active: units(r.lp_token_supply) > 0, thala: r }
}

/** Derivative of the two-asset stable invariant at fixed D. Normalize balances to avoid large powers. */
export function thalaRatio(r, reserve0, reserve1) {
  if (r.pool_type === 101) {
    const w = r.weights_opt?.vec?.[0]?.map(units)
    return w?.length === 2 && w.every(n => n > 0) ? reserve1 / reserve0 * w[0] / w[1] : NaN
  }
  const normalized = r.balances_normalized_opt?.vec?.[0]?.map(units)
  if (normalized?.length !== 2 || normalized.some(n => !(n > 0))) return NaN
  const [x, y] = normalized.map(n => n / Math.max(...normalized)), ann = 2 * units(r.amp_factor_opt?.vec?.[0])
  if (!(ann > 0)) return NaN
  const sum = x + y
  let d = sum
  for (let i = 0; i < 100; i++) {
    const product = d ** 3 / (4 * x * y)
    const next = d * (ann * sum + 2 * product) / ((ann - 1) * d + 3 * product)
    if (Math.abs(next - d) <= 1e-12 * d) {
      const k = next ** 3 / (4 * x * y)
      return (ann + k / x) / (ann + k / y) * (x / y) * (reserve1 / reserve0)
    }
    d = next
  }
  return NaN
}
export function aptosCreations(tx) {
  if (tx?.type !== 'user_transaction' || tx.success !== true || !objectId(tx.hash) || !natural(Number(tx.version)) ||
      !Array.isArray(tx.events)) return []
  const firstSeen = Math.floor(Number(tx.timestamp) / 1000)
  if (!natural(firstSeen)) return []
  return tx.events.flatMap(e => {
    const v = e.data
    let p
    if (e.type === hyperModule + 'CreatePoolEvent') p = objectPair('hyperion', v?.pool?.inner, v?.token_a?.inner, v?.token_b?.inner)
    else if (e.type === thalaModule + 'PoolCreationEvent' && v?.metadata?.length === 2)
      p = objectPair('thalaswap', v.pool_obj?.inner, v.metadata[0]?.inner, v.metadata[1]?.inner)
    else if (e.type === cakeModule + 'PairCreatedEvent' && e.guid?.account_address === CAKE && e.guid.creation_number === '4')
      p = legacy('pancakeswap-aptos', v?.token_x, v?.token_y)
    else if (faPool(e.guid?.account_address) === LIQUID_ACCOUNT)
      p = legacyStruct('liquidswap', 'PoolCreatedEvent', e.type)
    return p ? [{ ...p, chain: 'aptos', tx: tx.hash, firstSeen }] : []
  })
}
function swaps(tx) {
  if (tx?.type !== 'user_transaction' || tx.success !== true || !objectId(tx.hash)) return []
  const at = Math.floor(Number(tx.timestamp) / 1000)
  return (tx.events ?? []).flatMap((e, i) => {
    const v = e.data
    if (e.type === thalaModule + 'SwapEvent' && v?.metadata?.length === 2) {
      const p = objectPair('thalaswap', v.pool_obj?.inner, ...v.metadata.map(m => m?.inner))
      if (!p || !['0','1'].includes(v.idx_in) || !['0','1'].includes(v.idx_out) || v.idx_in === v.idx_out) return []
      return [{ ...p, at, event: tx.hash + '/' + i, a: v.idx_in === '0' ? v.amount_in : v.amount_out, b: v.idx_in === '1' ? v.amount_in : v.amount_out }]
    }
    if (e.type === hyperModule + 'SwapEventV3' && faPool(v?.pool_id) && fa(v.from_token?.inner) && fa(v.to_token?.inner))
      return [{ pool: faPool(v.pool_id), input: fa(v.from_token.inner), output: fa(v.to_token.inner),
        at, event: tx.hash + '/' + i, amountIn: v.amount_in, amountOut: v.amount_out }]
    return []
  })
}

export class AptosReader {
  constructor(source) {
    this.source = source
    this.client = source.client
    this.tasks = [() => this.inventory('hyperion'), () => source.state(), () => this.legacySeeds(), () => this.inventory('thalaswap'),
      () => source.state(), () => this.origins(), () => source.state(), () => this.recent(),
      () => source.state(), () => this.resources('liquidswap'), () => source.state(),
      () => this.cakeEvents(), () => source.state(), () => this.receiptJob(), () => this.resources('pancakeswap-aptos'), () => this.recent(), () => this.liquidOrigin(), () => this.legacyTrades()]
  }

  legacySeeds() {
    const s = this.source, key = 'legacy/seeds', now = s.engine.clock()
    if (s.cursor(key).next > now || !s.usd(APT)) return false
    const usdc = ZUSD + 'USDC', usdt = ZUSD + 'USDT'
    const pools = [
      legacy('pancakeswap-aptos', APT, usdc), legacy('pancakeswap-aptos', CAKE_COIN, APT),
      legacy('liquidswap', usdc, APT), legacy('liquidswap', usdt, APT), legacy('liquidswap', usdc, usdt, 'stable'),
    ]
    s.page(key, { next:now + 6 * 60 * MIN }, pools.map(p => ({ ...p, firstSeen:now, priority:7 })))
    return true
  }

  async inventory(dex) {
    const s = this.source, key = dex + '/factory', c = s.cursor(key), now = s.engine.clock()
    if (c.next > now || (s.backlog() > 120 && !(c.tail != null && c.poll <= now))) return false
    if (dex === 'thalaswap' && c.tail == null) {
      const { data } = await this.client.aptos('/view', view(THALA_LENS + '::lens::get_pool_count', []))
      const total = Number(data?.[0])
      if (!natural(total)) throw new Error('Invalid Thala pool count')
      s.saveCursor(key, { ...c, tail: Math.max(0, total - PAGE + 1), poll: 0 })
      return true
    }
    // Alternate the forward inventory with its growing tail. A newly appended pool is found while history advances.
    const tail = c.tail != null && c.poll <= now
    const offset = tail ? Math.max(0, c.tail - 1) : c.offset ?? 0
    const hyper = dex === 'hyperion', fn = hyper ? hyperModule + 'all_pools_with_info' : THALA_LENS + '::lens::get_pools_paginated'
    const { data, at } = await this.client.aptos('/view', view(fn, [String(offset), String(PAGE)]))
    const rows = data?.[0]
    if (!Array.isArray(rows) || rows.length > PAGE) throw new Error('Invalid Aptos pool page')
    const total = hyper ? Number(data[1]?.total) : null
    if (hyper && (!natural(total) || Number(data[1]?.offset) !== offset || Number(data[1]?.take) !== rows.length)) throw new Error('Invalid Hyperion page')
    const pools = rows.map((r, i) => {
      const p = pairFromRow(dex, r)
      if (!p) return null
      return { ...p, slot: offset + i, priority: s.priority(p), firstSeen: at }
    }).filter(Boolean)
    const end = offset + rows.length, next = { ...c }
    if (c.tail == null && hyper) { next.tail = Math.max(0, total - PAGE + 1); next.poll = 0 }
    if (tail) { next.tail = end; next.poll = now + 5 * MIN }
    else if (rows.length < PAGE || (hyper && end >= total)) {
      next.tail = end; next.poll = now + 5 * MIN; next.offset = 0; next.next = now + 5 * MIN
    } else next.offset = end
    s.page(key, next, pools)
    return true
  }

  async resources(dex) {
    const s = this.source, key = dex + '/registry', c = s.cursor(key), now = s.engine.clock()
    if (c.next > now || s.backlog() > 120) return false
    const liquid = dex === 'liquidswap'
    const account = liquid ? LIQUID_ACCOUNT : CAKE
    const path = '/accounts/' + account + '/resources?limit=100' + (c.after ? '&start=' + encodeURIComponent(c.after) : '')
    const { data, cursor, at } = await this.client.aptos(path)
    if (!Array.isArray(data) || data.length > 100 || (cursor && (cursor === c.after || cursor.length > 1024))) throw new Error('Invalid resource page')
    const pools = []
    for (const r of data) {
      const p = legacyStruct(dex, liquid ? 'LiquidityPool' : 'TokenPairReserve', r.type)
      if (!p) continue
      const raw0 = liquid ? r.data?.coin_x_reserve?.value : r.data?.reserve_x
      const raw1 = liquid ? r.data?.coin_y_reserve?.value : r.data?.reserve_y
      pools.push({ ...p, firstSeen: at, priority: s.priority({ ...p, raw0, raw1 }) })
    }
    s.page(key, { after: cursor, next: cursor ? 0 : now + 6 * 60 * MIN }, pools)
    return true
  }

  async liquidOrigin() {
    const s = this.source, p = s.legacyOrigin.get(s.engine.clock())
    if (!p) return false
    const handle = legacyType(p.dex, p.token0, p.token1, p.kind).replace('::LiquidityPool<', '::EventsStore<')
    const path = '/accounts/' + LIQUID_ACCOUNT + '/events/' + encodeURIComponent(handle) + '/pool_created_handle?limit=1'
    const { data } = await this.client.aptos(path)
    if (!Array.isArray(data) || data.length > 1) throw new Error('Invalid Liquidswap creation handle')
    const e = data[0]
    if (e && faPool(e.guid?.account_address) === LIQUID_ACCOUNT &&
        legacyStruct('liquidswap', 'PoolCreatedEvent', e.type)?.pool === p.pool && natural(Number(e.version))) {
      s.origin(p.pool, Number(e.version), null)
    } else s.originDone(p.pool, !e)
    return true
  }

  async cakeEvents() {
    const s = this.source, dex = 'pancakeswap-aptos', key = dex + '/events', c = s.cursor(key), now = s.engine.clock()
    if (c.next > now) return false
    const { data, at } = await this.client.aptos(cakeHandle + '?limit=12' + (c.seq == null ? '' : '&start=' + c.seq))
    if (!Array.isArray(data) || data.length > 12) throw new Error('Invalid Pancake factory event page')
    let seq = c.seq
    const pools = []
    for (const e of data) {
      if (e.type !== cakeModule + 'PairCreatedEvent' || e.guid?.account_address !== CAKE ||
          e.guid?.creation_number !== '4' || !natural(Number(e.sequence_number)) || !natural(Number(e.version)) ||
          (seq != null && Number(e.sequence_number) < seq)) throw new Error('Invalid Pancake creation')
      seq = Number(e.sequence_number) + 1
      const p = legacy(dex, e.data?.token_x, e.data?.token_y)
      if (p) pools.push({ ...p, version: Number(e.version), firstSeen: at, priority: 1 })
    }
    s.page(key, { seq: seq ?? null, next: now + (data.length === 12 ? 0 : 5 * MIN) }, pools)
    return true
  }

  // The keyless index omits the generic module-events table. For object pools the first
  // indexed account transaction supplies a candidate version; only its typed creation event is accepted.
  async origins() {
    const s = this.source, pools = s.origins()
    if (!pools.length) return false
    const query = 'query(' + pools.map((_, i) => '$a' + i + ':String!').join(',') + '){' +
      pools.map((_, i) => 'p' + i + ':account_transactions(limit:1,where:{account_address:{_eq:$a' + i + '}},order_by:{transaction_version:asc}){transaction_version user_transaction{block_height}}').join(' ') + '}'
    const result = await this.client.request('/graphql', { query, variables: Object.fromEntries(pools.map((p, i) => ['a' + i, p.pool])) })
    if (result?.errors || !result?.data) throw new Error('Invalid Aptos account transaction index')
    s.engine.store.transaction(() => pools.forEach((p, i) => {
      const list = result.data['p' + i]
      if (!Array.isArray(list) || list.length > 1) throw new Error('Invalid Aptos account origin')
      const v = list[0]?.transaction_version, block = list[0]?.user_transaction?.block_height
      if (natural(v) && v < this.client.oldestVersion) s.originDone(p.pool, true)
      else s.origin(p.pool, natural(v) && natural(block) ? v : null, natural(block) ? block : null)
    }))
    return true
  }

  async receiptJob() {
    const s = this.source, p = s.nextReceipt()
    if (!p) return false
    if (p.version < this.client.oldestVersion) {
      s.originDone(p.pool, true)
      return true
    }
    if (this.receiptWork?.version !== p.version) this.receiptWork = { version: p.version, cache: new Map() }
    let data
    try { ({ data } = await once(this.receiptWork.cache, 'tx', () => this.client.aptos('/transactions/by_version/' + p.version))) }
    catch (error) {
      if (error.status !== 410 && error.status !== 404) throw error
      s.originDone(p.pool, error.status === 410)
      return true
    }
    const creation = aptosCreations(data).find(q => q.pool === p.pool && q.token0 === p.token0 && q.token1 === p.token1 && q.dex === p.dex)
    if (creation && Number(data.version) === p.version) {
      creation.block = await this.block(p.version, false)
      if (p.originBlock == null || creation.block === p.originBlock)
        s.page('receipt/last', { version: p.version }, [creation])
    }
    s.originDone(p.pool, true)
    return true
  }

  async recent() {
    const s = this.source, key = 'recent-swaps', now = s.engine.clock()
    if (s.cursor(key).next > now) return false
    const c = s.cursor(key)
    if (!c.pending?.length) {
      const pools = s.fundedIds.all('aptos', c.after ?? '')
      if (!pools.length) return false
      const query = 'query(' + pools.map((_, i) => '$p' + i + ':String!').join(',') + '){' + pools.map((_, i) =>
        'p' + i + ':account_transactions(limit:2,where:{account_address:{_eq:$p' + i +
        '}},order_by:{transaction_version:desc}){transaction_version user_transaction{timestamp}}').join(' ') + '}'
      const result = await this.client.request('/graphql', { query, variables: Object.fromEntries(pools.map((p, i) => ['p' + i, p.pool])) })
      if (result?.errors || !result?.data) throw new Error('Invalid Aptos trade index')
      const pending = new Set()
      for (let i = 0; i < pools.length; i++) for (const row of result.data['p' + i]) {
        const at = Date.parse(row.user_transaction?.timestamp + 'Z')
        if (natural(row.transaction_version) && at > now - 86400_000 && at <= now) pending.add(row.transaction_version)
      }
      s.saveCursor(key, { after: pools.at(-1).pool, pending: [...pending], next: pending.size ? 0 : now + MIN })
      return true
    }
    const [version, ...pending] = c.pending
    let result
    try { result = await this.client.aptos('/transactions/by_version/' + version) }
    catch (err) {
      if (![404,410].includes(err.status)) throw err
      s.saveCursor(key, { ...c, pending })
      return true
    }
    if (Number(result.data?.version) !== version) throw new Error('Mismatched Aptos transaction')
    const trades = []
    for (const t of swaps(result.data)) {
      if (t.input) {
        const known = s.candidate(t.pool)
        if (known?.dex !== 'hyperion') continue
        if (known.token0 === t.input && known.token1 === t.output) { t.a = t.amountIn; t.b = t.amountOut }
        else if (known.token1 === t.input && known.token0 === t.output) { t.a = t.amountOut; t.b = t.amountIn }
        else continue
      }
      if (t.at <= result.at) trades.push(t)
    }
    s.page(key, { ...c, pending, next: pending.length ? 0 : now + MIN }, trades.filter(t => t.dex).map(t => ({ ...t, firstSeen: t.at, priority: 2 })), trades)
    return true
  }

  // Legacy handles are already indexed by exact pool. Page amounts by sequence and batch
  // their transaction timestamps. A quiet pool can cover its full day in one pair of reads.
  async legacyTrades() {
    const s = this.source, key = 'legacy/trades', rotation = s.cursor(key), now = s.engine.clock()
    const p = this.tradeWork?.p ?? s.legacyTrades.get(rotation.after ?? '')
    if (!p) return false
    const work = this.tradeWork ??= { p, cache:new Map() }
    const stream = 'swaps/' + p.pool, c = s.cursor(stream), count = 64
    const history = c.history && c.before > 0
    const start = history ? Math.max(0,c.before - count) : c.next
    const limit = history ? c.before - start : count
    const liquid = p.dex === 'liquidswap', account = liquid ? LIQUID_ACCOUNT : CAKE
    const handle = legacyType(p.dex,p.token0,p.token1,p.kind)
      .replace('::TokenPairReserve<','::PairEventHolder<').replace('::LiquidityPool<','::EventsStore<')
    const path = '/accounts/' + account + '/events/' + encodeURIComponent(handle) + '/' + (liquid ? 'swap_handle' : 'swap') +
      '?limit=' + limit + (start == null ? '' : '&start=' + start)
    try {
      const { data } = await once(work.cache,'events',() => this.client.aptos(path))
      if (!Array.isArray(data) || data.length > limit) throw new Error('Invalid Aptos swap event page')
      const events = data.map((e,i) => {
        const seq = Number(e.sequence_number), v = e.data, version = Number(e.version)
        if (!natural(seq) || !natural(version) || (i && seq !== Number(data[i-1].sequence_number) + 1) ||
            (start != null && seq < start) || faPool(e.guid?.account_address) !== account ||
            legacyStruct(p.dex,'SwapEvent',e.type)?.pool !== p.pool) throw new Error('Invalid Aptos swap event')
        const [xi,xo,yi,yo] = (liquid ? [v.x_in,v.x_out,v.y_in,v.y_out] :
          [v.amount_x_in,v.amount_x_out,v.amount_y_in,v.amount_y_out]).map(units)
        if (!((xi > 0 && yo > 0 && xo === 0 && yi === 0) || (xo > 0 && yi > 0 && xi === 0 && yo === 0)))
          throw new Error('Invalid Aptos swap amounts')
        return { pool:p.pool, seq, version, event:'swap/' + seq, a:String(xi || xo), b:String(yi || yo) }
      })
      if (events.length) {
        const query = 'query($vs:[bigint!]!){user_transactions(where:{version:{_in:$vs}},limit:64){version timestamp}}'
        const result = await this.client.request('/graphql',{ query, variables:{vs:[...new Set(events.map(e => e.version))]} })
        if (!Array.isArray(result?.data?.user_transactions) || result.errors) throw new Error('Invalid Aptos swap timestamps')
        const times = new Map(result.data.user_transactions.map(t => [t.version,Date.parse(t.timestamp + 'Z')]))
        for (const e of events) {
          e.at = times.get(e.version)
          if (!natural(e.at)) throw new Error('Aptos swap timestamp not indexed')
        }
      }
      const next = { ...c }
      if (!history && events.length) next.next = events.at(-1).seq + 1
      if (history || c.before == null) next.before = events.length && events[0].at > now - 86400_000 ? events[0].seq : 0
      next.history = !history && next.before > 0
      s.engine.store.transaction(() => {
        s.page(stream,next,[],events)
        s.saveCursor(key,{after:p.pool})
      })
      this.tradeWork = null
      return true
    } catch (err) {
      if (!(err instanceof RateLimited)) this.tradeWork = null
      throw err
    }
  }

  async block(version, peer) {
    const { data } = await this.client.aptos('/blocks/by_version/' + version, null, peer)
    const b = Number(data?.block_height)
    if (!natural(b) || !natural(Number(data?.first_version)) || !natural(Number(data?.last_version)) ||
        Number(data.first_version) > version || Number(data.last_version) < version) throw new Error('Invalid Aptos block')
    return b
  }
  async receipt(hint, cache) {
    let result
    try { result = await once(cache, 'receipt', () => this.client.aptos('/transactions/by_hash/' + hint.tx, null, true)) }
    catch (e) { if ([404,410].includes(e.status)) return null; throw e }
    if (result.data?.hash !== hint.tx) return false
    const p = aptosCreations(result.data).find(q => q.pool === hint.pool && q.dex === hint.dex && q.token0 === hint.token0 && q.token1 === hint.token1)
    if (!p) return false
    const block = await this.block(Number(result.data.version), true)
    return block === hint.block ? { ...p, block } : false
  }

  async state(p, cache, peer) {
    const first = (path, body) => once(cache, 'first', () => this.client.aptos(path, body, peer))
    if (p.dex === 'hyperion') {
      let start, pair
      if (natural(p.slot)) {
        start = await first('/view', view(hyperModule + 'all_pools_with_info', [String(p.slot), '1']))
        const r = start.data?.[0]?.[0]
        pair = pairFromRow(p.dex, r)
      } else {
        start = await first('/view', view(hyperModule + 'liquidity_pool_info', [p.pool]))
        const ids = start.data?.[0]
        pair = objectPair(p.dex, p.pool, ids?.[1], ids?.[3])
        if (pair) {
          const { data } = await once(cache, 'balances', () => this.client.aptos(versioned('/view', start.version),
            view(hyperModule + 'pool_reserve_amount', [p.pool]), peer))
          ;[pair.raw0, pair.raw1] = data
        }
      }
      if (!pair || pair.pool !== p.pool) return { row: null, at: start.at }
      const path = resource(p.pool, hyperModule + 'LiquidityPoolV3')
      const { data } = await once(cache, 'resource', () => this.client.aptos(versioned(path, start.version), null, peer))
      const v = data?.type === hyperModule + 'LiquidityPoolV3' ? data.data : null
      return { row: { ...pair, active: v?.unlocked === true && units(v.liquidity) > 0, sqrt: v?.sqrt_price }, at: start.at }
    }
    if (p.dex === 'thalaswap') {
      const r = await first('/view', view(THALA_LENS + '::lens::get_pool_info', [p.pool]))
      return { row: pairFromRow(p.dex, r.data?.[0]), at: r.at }
    }
    const ident = legacy(p.dex, p.token0, p.token1, p.kind)
    if (ident?.pool !== p.pool) return { row: null, at: this.source.engine.clock() }
    const liquid = p.dex === 'liquidswap', type = legacyType(p.dex, p.token0, p.token1, p.kind)
    const r = await first(resource(liquid ? LIQUID_ACCOUNT : CAKE, type))
    if (canonicalType(r.data.type) !== type) return { row: null, at: r.at }
    const v = r.data.data
    return { row: { ...ident, raw0: liquid ? v.coin_x_reserve.value : v.reserve_x,
      raw1: liquid ? v.coin_y_reserve.value : v.reserve_y, active: !liquid || v.locked === false }, at: r.at }
  }

  async snapshots([p], cache, peer) {
    const { row, at } = await this.state(p, cache, peer), info = new Map()
    if (this.source.needsMetadata(row)) for (const token of [row.token0, row.token1]) {
      if (this.source.info(token)) continue
      const coin = !!moveType(token), type = coin ? '0x1::coin::CoinInfo<' + token + '>' : '0x1::fungible_asset::Metadata'
      const { data } = await once(cache, token, () => this.client.aptos(resource(coin ? token.split('::')[0] : token, type), null, peer))
      if (canonicalType(data.type) === canonicalType(type)) info.set(token, data.data)
    }
    return { rows: [row], info, at }
  }
}
