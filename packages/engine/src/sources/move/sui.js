import { CETUS, TURBOS, SUI, STABLES, digest, moveType, natural, objectId, units } from './identity.js'
import { once } from './client.js'

const VENUES = {
  cetus: { pkg: CETUS, creation: CETUS + '::factory::CreatePoolEvent' },
  turbos: { pkg: TURBOS, creation: TURBOS + '::pool_factory::PoolCreatedEvent' },
}
const HEAD = 'chainIdentifier checkpoint { sequenceNumber timestamp }'
const EVENT = 'sequenceNumber timestamp contents { type { repr } json } transaction { digest effects { status checkpoint { sequenceNumber } } }'
const PAGE = 'pageInfo { hasNextPage hasPreviousPage startCursor endCursor }'
const OBJECT = 'address asMoveObject { contents { type { repr } json } }'
const MIN = 60_000
function creation(dex, node) {
  const { transaction: tx, contents } = node ?? {}, v = contents?.json, block = tx?.effects?.checkpoint?.sequenceNumber
  if (contents?.type?.repr !== VENUES[dex].creation || tx?.effects?.status !== 'SUCCESS' ||
      !digest(tx.digest) || !natural(block)) return null
  const pool = dex === 'cetus' ? v?.pool_id : v?.pool
  const firstSeen = Date.parse(node.timestamp)
  if (!objectId(pool) || !natural(firstSeen)) return null
  const token0 = moveType(v?.coin_type_a), token1 = moveType(v?.coin_type_b)
  return { chain: 'sui', dex, kind: 'clmm', pool, token0, token1, block, tx: tx.digest, firstSeen }
}
function swap(dex, n, tx, at) {
  const contents = n.contents, v = contents?.json
  if (contents?.type?.repr !== VENUES[dex].pkg + '::pool::SwapEvent' || !objectId(v?.pool) ||
      !digest(tx) || !natural(n.sequenceNumber) || !natural(at)) return null
  if (dex === 'cetus' && typeof v.atob !== 'boolean') return null
  const a = dex === 'turbos' ? v.amount_a : v.atob ? v.amount_in : v.amount_out
  const b = dex === 'turbos' ? v.amount_b : v.atob ? v.amount_out : v.amount_in
  return { pool:v.pool, event:tx + '/' + n.sequenceNumber, at, a, b }
}

export function suiState(dex, pool, obj) {
  if (!obj) return null
  const contents = obj.asMoveObject?.contents, v = contents?.json
  const prefix = VENUES[dex].pkg + '::pool::Pool<', type = contents?.type?.repr
  if (obj.address !== pool || v?.id !== pool || !type?.startsWith(prefix) || !type.endsWith('>')) return null
  const types = type.slice(prefix.length, -1).split(',').map(t => moveType(t.trim()))
  if (types.length !== (dex === 'cetus' ? 2 : 3) || types.some(t => !t)) return null
  const [token0, token1] = types
  if (token0 === token1) return null
  return { pool, token0, token1, dex, kind: 'clmm', raw0: v.coin_a, raw1: v.coin_b,
    sqrt: dex === 'cetus' ? v.current_sqrt_price : v.sqrt_price,
    active: units(v.liquidity) > 0 && (dex === 'cetus' ? v.is_pause === false : v.unlocked === true) }
}

export class SuiReader {
  constructor(source) {
    this.source = source
    this.client = source.client
    const coins = source.engine.catalog.assets.filter(a => a.chain === 'sui').map(a => a.address === 'native' ? SUI : a.address)
    const type = (a,b) => CETUS + '::pool::Pool<' + a + ',' + b + '>'
    const anchors = coins.includes(SUI) && coins.includes(STABLES.sui[0]) ? [type(STABLES.sui[0],SUI),type(SUI,STABLES.sui[0])] : []
    this.pairs = [...new Set([...anchors, ...coins.flatMap(a => coins.filter(b => b !== a).map(b => type(a,b)))])]
    this.tasks = [() => this.swaps('cetus'), () => source.state(), () => this.events('cetus'), () => source.state(),
      () => this.swaps('turbos'), () => source.state(), () => this.events('turbos'), () => this.seed(), () => this.origins(),
      () => source.state(), () => this.events('cetus', true), () => source.state(), () => this.events('turbos', true), () => this.poolSwaps()]
  }

  async events(dex, history = false) {
    const s = this.source, key = dex + '/events', saved = s.cursor(key), now = s.engine.clock()
    if ((history ? !saved.before || saved.historyNext > now : saved.next > now) || s.backlog() >= 128) return false
    const initial = saved.height == null, reverse = history || initial
    const vars = { type: VENUES[dex].creation, cursor: (history ? saved.before === 'restart' ? null : saved.before : saved.after) ?? null,
      from: history ? null : saved.height ?? null, to: history ? saved.historyTo ?? null : saved.until ?? null }
    const query = 'query($type:String!,$cursor:String,$from:UInt53,$to:UInt53){' + HEAD +
      ' events(' + (reverse ? 'last:12,before' : 'first:12,after') + ':$cursor,filter:{type:$type,afterCheckpoint:$from,beforeCheckpoint:$to}){nodes{' + EVENT + '}' + PAGE + '}}'
    let data
    try { data = await this.client.sui(query, vars) }
    catch (error) {
      // An indexer may expire a snapshot. Reopen the checkpoint boundary inclusively.
      if (error.message === 'Invalid Sui GraphQL response' && vars.cursor) {
        if (history) s.saveCursor(key, { ...saved, before: 'restart', historyTo: saved.oldest + 1, historyNext: now + MIN })
        else s.saveCursor(key, { ...saved, after: null, height: saved.lastBlock != null ? Math.max(0, saved.lastBlock - 1) : saved.height })
      }
      throw error
    }
    const { nodes, pageInfo: pg } = data.events
    if (!Array.isArray(nodes) || nodes.length > 12 || !pg) throw new Error('Invalid Sui events page')
    const candidates = nodes.map(n => creation(dex, n))
    if (candidates.some(p => !p || p.firstSeen > data.at)) throw new Error('Invalid Sui creation')
    const next = { ...saved }
    if (reverse) {
      if (pg.hasPreviousPage && (!pg.startCursor || pg.startCursor === vars.cursor)) throw new Error('Stalled Sui history')
      next.before = pg.hasPreviousPage ? pg.startCursor : null
      next.oldest = candidates[0]?.block ?? saved.oldest ?? null
      next.historyNext = now + 3 * MIN
    }
    if (!history) {
      if (!reverse && pg.hasNextPage) {
        if (!pg.endCursor || pg.endCursor === vars.cursor) throw new Error('Stalled Sui cursor')
        next.after = pg.endCursor
        // A GraphQL continuation pins its checkpoint. Retain the original filter exactly.
        next.lastBlock = candidates.at(-1)?.block ?? saved.lastBlock
        next.snapshot = saved.snapshot ?? data.checkpoint.sequenceNumber
      } else {
        next.height = saved.snapshot ?? data.checkpoint.sequenceNumber
        next.after = null
        next.snapshot = null
        next.lastBlock = null
      }
      next.next = now + (next.after ? 0 : 3 * MIN)
    }
    s.page(key, next, candidates)
    return true
  }

  async origins() {
    const s = this.source, pools = s.probes.all('sui', s.engine.clock())
    if (!pools.length) return false
    const query = 'query(' + pools.map((_, i) => '$a' + i + ':SuiAddress!').join(',') + '){' + HEAD + ' ' +
      pools.map((_, i) => 'p' + i + ':objectVersions(first:1,address:$a' + i +
        '){nodes{previousTransaction{effects{events(first:40){nodes{' + EVENT + '}}}}}}').join(' ') + '}'
    const data = await this.client.sui(query, Object.fromEntries(pools.map((p, i) => ['a' + i, p.pool])))
    s.engine.store.transaction(() => {
      pools.forEach((p, i) => {
        const events = data['p' + i]?.nodes?.[0]?.previousTransaction?.effects?.events?.nodes ?? []
        const event = events.map(n => creation(p.dex, n)).find(c => c?.pool === p.pool &&
          (p.dex !== 'cetus' || (c.token0 === p.token0 && c.token1 === p.token1)))
        if (event) s.remember({ ...event, token0: p.token0, token1: p.token1 })
        s.originDone(p.pool, !!event)
      })
    })
    return true
  }

  async swaps(dex) {
    const s = this.source, key = dex + '/swaps', now = s.engine.clock()
    if (s.cursor(key).next > now) return false
    const type = VENUES[dex].pkg + '::pool::SwapEvent'
    const data = await this.client.sui('query($type:String!){' + HEAD +
      ' events(last:40,filter:{type:$type}){nodes{' + EVENT + '}}}', { type })
    const swaps = [], candidates = [], seen = new Set()
    const slots = Math.max(0,128 - s.backlog())
    for (const n of data.events.nodes) {
      if (n.transaction?.effects?.status !== 'SUCCESS') continue
      const t = swap(dex,n,n.transaction.digest,Date.parse(n.timestamp))
      if (!t || t.at > data.at) continue
      swaps.push(t)
      if (!seen.has(t.pool) && (seen.size < slots || s.candidate(t.pool))) {
        candidates.push({ dex, kind:'clmm', pool:t.pool, firstSeen:t.at, priority:2 })
        seen.add(t.pool)
      }
    }
    s.page(key, { next: now + MIN }, candidates, swaps)
    return true
  }

  async poolSwaps() {
    const s = this.source, rotation = 'swaps/rotation', p = s.suiVolumeTarget.get(s.cursor(rotation).after ?? '')
    if (!p) return false
    const key = 'swaps/' + p.pool, c = s.cursor(key)
    const query = 'query($id:SuiAddress!,$cursor:String){' + HEAD +
      ' transactions(last:8,before:$cursor,filter:{affectedObject:$id}){nodes{digest effects{status timestamp ' +
      'events(first:24){nodes{sequenceNumber contents{type{repr}json}} pageInfo{hasNextPage}}}} ' + PAGE + '}}'
    let data
    try { data = await this.client.sui(query,{ id:p.pool, cursor:c.before ?? null }) }
    catch (err) {
      if (c.before && err.message === 'Invalid Sui GraphQL response') s.saveCursor(key,{})
      throw err
    }
    const txs = data.transactions, swaps = []
    if (!Array.isArray(txs?.nodes) || txs.nodes.length > 8 || !txs.pageInfo) throw new Error('Invalid Sui pool transactions')
    for (const tx of txs.nodes) {
      if (tx.effects?.status !== 'SUCCESS') continue
      const at = Date.parse(tx.effects.timestamp)
      for (const n of tx.effects.events.nodes) {
        const t = swap(p.dex,n,tx.digest,at)
        if (t?.pool === p.pool && at <= data.at) swaps.push(t)
      }
    }
    const more = txs.pageInfo.hasPreviousPage && Date.parse(txs.nodes[0]?.effects?.timestamp) > data.at - 86400_000
    const before = more ? txs.pageInfo.startCursor : null
    if (more && (!before || before === c.before)) throw new Error('Stalled Sui trade cursor')
    s.engine.store.transaction(() => {
      s.page(key,{before},[],swaps)
      s.saveCursor(rotation,{after:p.pool})
    })
    return true
  }

  async seed() {
    const s = this.source, key = 'cetus/seeds', cursor = s.cursor(key), start = cursor.index ?? 0
    if (cursor.next > s.engine.clock() || !this.pairs.length || s.backlog() >= 96) return false
    const batch = cursor.pending ?? this.pairs.slice(start, start + 3).map((_,i) => ({ index:start + i }))
    const args = batch.map((_,i) => '$t' + i + ':String!,$c' + i + ':String')
    const fields = batch.map((_,i) => 'p' + i + ':objects(first:12,after:$c' + i + ',filter:{type:$t' + i + '}){nodes{address} ' + PAGE + '}')
    const variables = Object.fromEntries(batch.flatMap((p,i) => [['t' + i,this.pairs[p.index]],['c' + i,p.after ?? null]]))
    const data = await this.client.sui('query(' + args.join(',') + '){' + HEAD + ' ' + fields.join(' ') + '}', variables)
    const pools = [], pending = []
    for (const [i,p] of batch.entries()) {
      const page = data['p' + i]
      if (!Array.isArray(page?.nodes) || page.nodes.length > 12 || !page.pageInfo) throw new Error('Invalid Sui pool list')
      for (const node of page.nodes) {
        if (!objectId(node.address)) throw new Error('Invalid Sui pool ID')
        pools.push({ pool:node.address, dex:'cetus', kind:'clmm', firstSeen:data.at, priority:1 })
      }
      if (page.pageInfo.hasNextPage) {
        const after = page.pageInfo.endCursor
        if (!after || after === p.after) throw new Error('Stalled Sui pool list')
        pending.push({ index:p.index, after })
      }
    }
    const end = cursor.pending ? start : start + batch.length
    s.page(key, pending.length || end < this.pairs.length ? { index:end, pending:pending.length ? pending : null } :
      { next:data.at + 6 * 60 * MIN }, pools)
    return true
  }

  async snapshots(pools, cache, peer) {
    const params = pools.map((p, i) => ['$p' + i + ':SuiAddress!', 'p' + i + ':object(address:$p' + i + '){' + OBJECT + '}', p.pool])
    const data = await once(cache, 'objects', () => this.client.sui('query(' + params.map(p => p[0]).join(',') +
      '){' + HEAD + ' ' + params.map(p => p[1]).join(' ') + '}', Object.fromEntries(params.map((p, i) => ['p' + i, p[2]])), peer))
    const rows = pools.map((p, i) => suiState(p.dex, p.pool, data['p' + i]))
    const missing = [...new Set(rows.filter(r => this.source.needsMetadata(r)).flatMap(r => [r.token0, r.token1]))]
      .filter(t => !this.source.info(t))
    const info = new Map()
    if (missing.length) {
      const result = await this.client.sui('query(' + missing.map((_, i) => '$t' + i + ':String!').join(',') + '){' +
        HEAD + ' ' + missing.map((_, i) => 'm' + i + ':coinMetadata(coinType:$t' + i + '){name symbol decimals}').join(' ') + '}',
      Object.fromEntries(missing.map((t, i) => ['t' + i, t])), peer)
      missing.forEach((t, i) => info.set(t, result['m' + i]))
    }
    return { rows, info, at: data.at }
  }

  async receipt(hint) {
    const data = await this.client.sui('query($tx:String!){' + HEAD +
      ' transaction(digest:$tx){digest effects{status checkpoint{sequenceNumber} events(first:50){nodes{' + EVENT + '} ' + PAGE + '}}}}',
    { tx: hint.tx }, true)
    const tx = data.transaction
    if (!tx) return null
    if (tx.digest !== hint.tx || tx.effects?.status !== 'SUCCESS' || tx.effects.checkpoint?.sequenceNumber !== hint.block) return false
    for (const n of tx.effects.events.nodes) {
      const p = creation(hint.dex, n)
      if (p?.pool === hint.pool && p.tx === hint.tx && p.block === hint.block &&
          (hint.dex !== 'cetus' || (p.token0 === hint.token0 && p.token1 === hint.token1))) return p
    }
    return tx.effects.events.pageInfo.hasNextPage ? null : false
  }
}
