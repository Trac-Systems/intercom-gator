import { CETUS, TURBOS, SUI, digest, moveType, natural, objectId, units } from './identity.js'
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
    this.pairs = coins.flatMap(a => coins.filter(b => b !== a).map(b => CETUS + '::pool::Pool<' + a + ',' + b + '>'))
    this.tasks = [() => this.swaps('cetus'), () => source.state(), () => this.events('cetus'), () => source.state(),
      () => this.swaps('turbos'), () => source.state(), () => this.events('turbos'), () => this.seed(), () => this.origins(),
      () => source.state(), () => this.events('cetus', true), () => source.state(), () => this.events('turbos', true)]
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
    const swaps = [], candidates = []
    for (const n of data.events.nodes) {
      const v = n.contents?.json, tx = n.transaction?.digest, at = Date.parse(n.timestamp)
      if (n.contents?.type?.repr !== type || n.transaction?.effects?.status !== 'SUCCESS' ||
          !objectId(v?.pool) || !digest(tx) || !natural(n.sequenceNumber) || !natural(at) || at > data.at) continue
      const a = dex === 'turbos' ? v.amount_a : v.atob ? v.amount_in : v.amount_out
      const b = dex === 'turbos' ? v.amount_b : v.atob ? v.amount_out : v.amount_in
      swaps.push({ pool: v.pool, event: tx + '/' + n.sequenceNumber, at, a, b })
      candidates.push({ dex, kind: 'clmm', pool: v.pool, firstSeen: at, priority: 2 })
    }
    s.page(key, { next: now + MIN }, candidates, swaps)
    return true
  }

  async seed() {
    const s = this.source, key = 'cetus/seeds', cursor = s.cursor(key), start = cursor.index ?? 0
    if (cursor.next > s.engine.clock() || !this.pairs.length || s.backlog() >= 96) return false
    const batch = this.pairs.slice(start, start + 3)
    const fields = batch.map((_, i) => 'p' + i + ':objects(first:12,filter:{type:$t' + i + '}){nodes{address}}')
    const data = await this.client.sui('query(' + batch.map((_, i) => '$t' + i + ':String!').join(',') + '){' +
      HEAD + ' ' + fields.join(' ') + '}', Object.fromEntries(batch.map((t, i) => ['t' + i, t])))
    const pools = batch.flatMap((_, i) => data['p' + i].nodes.filter(n => objectId(n.address)).map(n =>
      ({ pool: n.address, dex: 'cetus', kind: 'clmm', firstSeen: data.at, priority: 1 })))
    const end = start + batch.length
    s.page(key, end < this.pairs.length ? { index: end } : { next: data.at + 6 * 60 * MIN }, pools)
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
