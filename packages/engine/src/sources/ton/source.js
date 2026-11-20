import { RateLimited } from '../../scheduler/index.js'
import { labels, validDecimals } from '../names/text.js'
import { FamilyClient, FamilyDex, reserveState } from '../family-dex.js'
import { addressSlice, assetSlice, poolKey, stackAddress, stackAsset, tonAddress } from './address.js'
import { DEDUST_FACTORY, PTON, QUOTES, STONFI_API, STONFI_V1, STONFI_V2, USDT } from './deployments.js'

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 24 * HOUR
const SETTING = 'engine-ton/'
// toncenter documents 1 request/s without a key; the host bucket keeps all engine users at half of that.
const SHARES = { small: 6, normal: 12, large: 20 }
const PAGE = 16

/** toncenter v2 get-methods, jetton data and account transactions plus STON.fi's per-pair pool directory. */
export class TonClient extends FamilyClient {
  constructor(engine) { super(engine, { chain: 'ton', protocol: 'toncenter-v2', shares: SHARES }) }
  /** @returns {Promise<any[]|null>} the stack, or null when the account/method cannot answer (exit code ≠ 0). */
  async run(address, method, stack = []) {
    let json
    try { json = await this.request('/runGetMethod', { address, method, stack }) }
    catch (error) {
      // toncenter answers an uninitialised account or a missing method with a 4xx/5xx JSON error, not a refusal.
      const status = error.status, detail = String(error.detail ?? '')
      if ((status >= 400 && status < 500 && ![403, 429].includes(status)) ||
          (status >= 500 && /exit code|uninit|not init|cannot run|non-?exist|failed to unpack/i.test(detail))) return null
      throw error
    }
    if (json?.ok !== true || !json.result) return null
    return json.result.exit_code === 0 || json.result.exit_code === 1 ? json.result.stack : null
  }
  token(address) { return this.request('/getTokenData?address=' + encodeURIComponent(address)) }
  transactions(address, from, archival = false) {
    const q = new URLSearchParams({ address, limit: String(PAGE), archival: String(archival) })
    if (from) { q.set('lt', from.lt); q.set('hash', from.hash) }
    return this.request('/getTransactions?' + q)
  }
  stonfi(a, b) {
    // Keyless directory with unclear redistribution terms: used only to find addresses, which are then read on-chain.
    return this.request(null, null, { url: STONFI_API + '/v1/pools/by_market/' + a + '/' + b, rpm: 12 })
  }
}

const num = entry => (Array.isArray(entry) && entry[0] === 'num' && /^-?0x[0-9a-f]+$/i.test(entry[1]) ?
  BigInt(entry[1].startsWith('-') ? '-' + entry[1].slice(1) : entry[1]) : null)
const master = address => (PTON.includes(address) ? 'native' : address)

/** Jetton metadata from on-chain TEP-64 content only (off-chain URIs are not fetched). */
export function jettonInfo(json, address) {
  const r = json?.result
  if (json?.ok !== true || r?.contract_type !== 'jetton_master' || tonAddress(r.address) !== address) return null
  const data = r.jetton_content?.type === 'onchain' && r.jetton_content.data && typeof r.jetton_content.data === 'object'
    ? r.jetton_content.data : {}
  const decimals = data.decimals == null ? 9 : Number(data.decimals) // TEP-64 default
  if (!validDecimals(decimals) || decimals > 30) return null
  return { ...(labels({ name: data.name, symbol: data.symbol }, address) ?? {}), decimals }
}

/** STON.fi v1/v2 and DeDust volatile pools on TON through one budgeted job. */
export class TonSource extends FamilyDex {
  constructor(engine, client = new TonClient(engine)) {
    super(engine, 'ton', { anchors: { [USDT]: 1 } })
    this.client = client
    this.turn = 0
    this.tasks = [() => this.state(), () => this.verify(), () => this.pairs(), () => this.state(),
      () => this.factory(), () => this.verify(), () => this.meta(), () => this.history()]
    this.tokenRows = engine.store.writer.prepare(`SELECT token0 AS t FROM engine_family_candidates WHERE chain='ton' AND stage=1 AND funded=1
      UNION SELECT token1 FROM engine_family_candidates WHERE chain='ton' AND stage=1 AND funded=1`)
    this.needMeta = engine.store.writer.prepare(`SELECT token0, token1 FROM engine_family_candidates WHERE chain='ton' AND stage=1 AND due<=?
      AND (funded=1 OR json_extract(extra,'$.wantMeta')=1) ORDER BY funded DESC, due LIMIT 32`)
  }
  setting(key) { return this.engine.store.getSetting(SETTING + key) }
  save(key, value) { this.engine.store.setSetting(SETTING + key, value) }
  info(address) {
    if (address === 'native') return this.engine.registry.assets.get('ton:native')
    const asset = this.engine.registry.assets.get('ton:' + address)
    return asset?.decimals != null ? asset : this.setting('meta/' + address)
  }
  decimals(address) { return this.info(address)?.decimals ?? null }
  /** Signed TON assets and funded discovered jettons against TON and USDT. */
  pairPlan() {
    const signed = this.engine.catalog.assets.filter(a => a.chain === 'ton' && tonAddress(a.address) === a.address)
      .map(a => a.address)
    const tokens = [...new Set([...QUOTES, ...signed, ...this.tokenRows.all().map(r => r.t).filter(Boolean)])]
    const pairs = []
    for (const a of tokens) for (const b of QUOTES) {
      if (a === b || (QUOTES.includes(a) && QUOTES.indexOf(a) > QUOTES.indexOf(b))) continue
      pairs.push([a, b])
    }
    return pairs
  }
  async pairs() {
    const now = this.engine.clock()
    const cursor = this.setting('pairs') ?? { index: 0, step: 0 }
    if (cursor.next > now) return false
    const plan = this.pairPlan()
    const pair = plan[cursor.index]
    if (!pair) { this.save('pairs', { index: 0, step: 0, next: now + 6 * HOUR }); return false }
    const [a, b] = pair, native = a === 'native' || b === 'native'
    const advance = (step) => this.save('pairs', step < (native ? 3 : 2) ? { index: cursor.index, step } :
      { index: cursor.index + 1, step: 0 })
    if (cursor.step === 0) {
      const stack = await this.client.run(DEDUST_FACTORY, 'get_pool_address', [['num', '0'], assetSlice(a), assetSlice(b)])
      const ref = stack && stackAddress(stack[0]), pool = ref && poolKey(ref)
      this.engine.store.transaction(() => {
        if (pool) this.remember({ pool, ref, dex: 'dedust', kind: 'v2', firstSeen: now, extra: { factory: true } })
        advance(1)
      })
      return true
    }
    // STON.fi names TON by its proxy master; v1 pools use pTON v1, v2 pools pTON v2.1.
    const side = x => (x === 'native' ? PTON[cursor.step === 1 ? 1 : 0] : x)
    const json = await this.client.stonfi(side(a), side(b))
    // The directory's own TVL only orders and skips obviously empty pools; on-chain reads decide admission.
    const tvl = row => Number(row?.lp_total_supply_usd)
    const list = (Array.isArray(json?.pool_list) ? json.pool_list : [])
      .filter(row => !Number.isFinite(tvl(row)) || tvl(row) >= 5_000).sort((a, b) => (tvl(b) || 0) - (tvl(a) || 0)).slice(0, 8)
    this.engine.store.transaction(() => {
      for (const row of list) {
        const ref = tonAddress(row?.address), router = tonAddress(row?.router_address)
        if (!ref || !router || !(router === STONFI_V1 || STONFI_V2.has(router))) continue
        this.remember({ pool: poolKey(ref), ref, dex: router === STONFI_V1 ? 'stonfi-v1' : 'stonfi-v2', kind: 'v2',
          firstSeen: now, extra: { router } })
      }
      advance(cursor.step + 1)
    })
    return true
  }
  /** Recent DeDust factory transactions: each deploys a pool or vault (pools are confirmed by the factory itself). */
  async factory() {
    const now = this.engine.clock()
    const cursor = this.setting('factory') ?? { top: '0', back: null, stopAt: '0' }
    if (cursor.next > now) return false
    const json = await this.client.transactions(DEDUST_FACTORY, cursor.back)
    if (json?.ok !== true || !Array.isArray(json.result)) throw new Error('toncenter transactions failed')
    const txs = json.result.filter(tx => /^\d{1,20}$/.test(tx?.transaction_id?.lt ?? '') && Number.isSafeInteger(tx.utime))
    const floor = BigInt(cursor.back ? cursor.stopAt : cursor.top)
    const fresh = txs.filter(tx => BigInt(tx.transaction_id.lt) > floor)
    this.engine.store.transaction(() => {
      for (const tx of fresh) {
        const at = tx.utime * 1000
        for (const m of tx.out_msgs ?? []) {
          const ref = tonAddress(m?.destination)
          if (!ref || ref === tonAddress(tx.in_msg?.source)) continue
          this.remember({ pool: poolKey(ref), ref, dex: 'dedust', kind: 'v2', firstSeen: Math.min(at, now),
            isNew: cursor.top !== '0' || now - at < 7 * DAY, extra: {} })
        }
      }
      const newest = txs[0]?.transaction_id.lt, oldest = txs.at(-1)?.transaction_id
      const more = fresh.length === txs.length && txs.length === PAGE
      if (cursor.back) {
        this.save('factory', more ? { ...cursor, back: { lt: oldest.lt, hash: oldest.hash } } :
          { top: cursor.top, back: null, stopAt: cursor.top, next: now + 3 * MINUTE, bottom: cursor.bottom })
      } else {
        const top = newest && BigInt(newest) > BigInt(cursor.top) ? newest : cursor.top
        // A busy factory produced more than one page since the last poll: page back to the previous top.
        const bottom = cursor.bottom ?? (oldest && { lt: oldest.lt, hash: oldest.hash })
        this.save('factory', more && cursor.top !== '0' ? { top, back: { lt: oldest.lt, hash: oldest.hash }, stopAt: cursor.top, bottom } :
          { top, back: null, stopAt: top, next: now + 3 * MINUTE, bottom })
      }
    })
    return true
  }
  /**
   * Older DeDust creations, newest first from below the live scan's first page, on spare turns: only while the
   * verification queue is short. Each page commits with its candidates; a short page ends the backfill for a week.
   */
  async history() {
    const now = this.engine.clock()
    const live = this.setting('factory'), cursor = this.setting('factory-history') ?? {}
    if (!live?.bottom || cursor.next > now || this.count.get('ton', now).n >= 8) return false
    const from = cursor.from ?? live.bottom
    const json = await this.client.transactions(DEDUST_FACTORY, from, true)
    if (json?.ok !== true || !Array.isArray(json.result)) throw new Error('toncenter transactions failed')
    const txs = json.result.filter(tx => /^\d{1,20}$/.test(tx?.transaction_id?.lt ?? '') && Number.isSafeInteger(tx.utime) &&
      BigInt(tx.transaction_id.lt) <= BigInt(from.lt))
    this.engine.store.transaction(() => {
      for (const tx of txs) {
        for (const m of tx.out_msgs ?? []) {
          const ref = tonAddress(m?.destination)
          if (!ref || ref === tonAddress(tx.in_msg?.source)) continue
          this.remember({ pool: poolKey(ref), ref, dex: 'dedust', kind: 'v2', firstSeen: Math.min(tx.utime * 1000, now), extra: {} })
        }
      }
      const oldest = txs.at(-1)?.transaction_id
      // toncenter repeats the starting transaction; a page with nothing older ends the walk.
      const older = oldest && BigInt(oldest.lt) < BigInt(from.lt)
      this.save('factory-history', older && json.result.length === PAGE ? { from: { lt: oldest.lt, hash: oldest.hash }, pages: (cursor.pages ?? 0) + 1 } :
        { from: null, pages: cursor.pages ?? 0, next: now + 7 * DAY })
    })
    return true
  }
  /** One on-chain step per turn; partial progress survives in the candidate row. */
  async verify() {
    const now = this.engine.clock()
    this.fresh = !this.fresh
    const [p] = this.pending.all('ton', now, 1, Number(this.fresh)).map(r => ({ ...r, extra: JSON.parse(r.extra) }))
    if (!p) return false
    const x = p.extra
    const keep = () => this.setExtra.run(JSON.stringify(x), 'ton', p.pool)
    if (p.dex === 'dedust') {
      if (!x.assets) {
        const stack = await this.client.run(p.ref, 'get_assets')
        const assets = stack?.slice(0, 2).map(stackAsset)
        if (!assets || assets.some(a => !a) || assets[0] === assets[1]) { this.reject(p); return true }
        x.assets = assets
        if (x.factory) { this.verified(p, assets[0], assets[1], x); return true }
        keep()
        return true
      }
      const stack = await this.client.run(DEDUST_FACTORY, 'get_pool_address', [['num', '0'], ...x.assets.map(assetSlice)])
      // Stable-curve pools (type 1) are not constant-product; they are not priced here.
      if (stack && stackAddress(stack[0]) === p.ref) this.verified(p, x.assets[0], x.assets[1], x)
      else this.reject(p)
      return true
    }
    if (!x.wallets) {
      const stack = await this.client.run(p.ref, 'get_pool_data')
      const v1 = p.dex === 'stonfi-v1'
      const router = v1 ? STONFI_V1 : stack && stackAddress(stack[1])
      const wallets = stack && (v1 ? stack.slice(2, 4) : stack.slice(5, 7)).map(stackAddress)
      if (!stack || router !== x.router || !wallets || wallets.some(w => !w) || wallets[0] === wallets[1]) { this.reject(p); return true }
      x.wallets = wallets
      keep()
      return true
    }
    if (!x.member) {
      const stack = await this.client.run(x.router, 'get_pool_address', x.wallets.map(addressSlice))
      if (!stack || stackAddress(stack[0]) !== p.ref) { this.reject(p); return true }
      x.member = true
      keep()
      return true
    }
    x.masters ??= []
    const i = x.masters.length
    const stack = await this.client.run(x.wallets[i], 'get_wallet_data')
    const owner = stack && stackAddress(stack[1]), jetton = stack && stackAddress(stack[2])
    if (owner !== x.router || !jetton) { this.reject(p); return true }
    x.masters.push(master(jetton))
    if (x.masters.length < 2) { keep(); return true }
    if (x.masters[0] === x.masters[1]) this.reject(p)
    else this.verified(p, x.masters[0], x.masters[1], x)
    return true
  }
  /** Jetton identity for verified pools: on-chain name, symbol and decimals (sanitized). */
  async meta() {
    const now = this.engine.clock()
    const missing = this.needMeta.all(now).flatMap(r => [r.token0, r.token1])
      .find(t => t && t !== 'native' && this.decimals(t) == null && !(this.setting('meta-fail/' + t) > now))
    if (!missing) return false
    let json = null
    try { json = await this.client.token(missing) }
    catch (error) {
      // A non-jetton account is an answer (failed metadata), not an endpoint failure to retry every turn.
      if (!(error.status >= 400 && error.status < 500 && ![403, 429].includes(error.status))) throw error
    }
    const info = jettonInfo(json, missing)
    if (info) this.save('meta/' + missing, info)
    else this.save('meta-fail/' + missing, now + DAY)
    return true
  }
  async read(p) {
    const stack = await this.client.run(p.ref, p.dex === 'dedust' ? 'get_reserves' : 'get_pool_data')
    const at = this.engine.clock()
    if (!stack) return { p, at }
    const [r0, r1] = (p.dex === 'stonfi-v2' ? stack.slice(3, 5) : stack.slice(0, 2)).map(num)
    if (r0 == null || r1 == null || r0 < 0n || r1 < 0n) return { p, at }
    const info = { token0: this.info(p.token0), token1: this.info(p.token1) }
    return { p, at, info, state: reserveState(r0, r1, info.token0?.decimals, info.token1?.decimals) }
  }
  /** A side whose decimals and USD price are known can measure depth before any jetton metadata read. */
  priced(address) { return this.decimals(address) != null && this.usd(address) != null }
  async state(pool) {
    const now = this.engine.clock()
    const rows = pool ? [this.candidate(pool)].filter(r => r?.stage === 1) :
      this.verifiedDue.all('ton', now, 8).map(r => ({ ...r, extra: JSON.parse(r.extra) }))
    const known = r => this.decimals(r.token0) != null && this.decimals(r.token1) != null
    const p = rows.find(r => known(r) || (!r.extra.wantMeta && (this.priced(r.token0) || this.priced(r.token1))))
    if (!p) return false
    if (known(p)) {
      const reading = await this.read(p)
      if (!reading.state) { this.reject(p, 60); return true }
      this.measure([reading])
      return true
    }
    // One side is an unnamed jetton: its decimals matter only once the priced side shows the depth floor.
    const stack = await this.client.run(p.ref, p.dex === 'dedust' ? 'get_reserves' : 'get_pool_data')
    const raw = stack && (p.dex === 'stonfi-v2' ? stack.slice(3, 5) : stack.slice(0, 2)).map(num)
    if (!raw || raw.some(r => r == null || r < 0n)) { this.reject(p, 60); return true }
    const side = this.priced(p.token0) ? 0 : 1, token = side ? p.token1 : p.token0
    const depth = 2 * Number(raw[side]) / 10 ** this.decimals(token) * this.usd(token)
    if (depth >= 10_000) this.setExtra.run(JSON.stringify({ ...p.extra, wantMeta: 1 }), 'ton', p.pool)
    else this.reject(p, now - p.firstSeen > DAY ? 360 : 30)
    return true
  }
  refresh() {
    // One get-method per pool: spread refreshes so the funded set fits inside the reader share.
    const funded = this.engine.store.reader.prepare("SELECT count(*) AS n FROM engine_family_candidates WHERE chain='ton' AND funded=1").get().n
    return Math.max(2 * MINUTE, Math.ceil((funded + 4) / (this.client.rpm / 3)) * MINUTE)
  }
  async run() {
    for (let i = 0; i < this.tasks.length; i++) {
      const index = this.turn
      this.turn = (index + 1) % this.tasks.length
      try {
        if (await this.tasks[index]()) return
      } catch (error) {
        if (error instanceof RateLimited) this.turn = index
        throw error
      }
    }
  }
}

export function registerTon(engine) {
  const client = new TonClient(engine)
  if (!client.endpoint) return null
  const source = new TonSource(engine, client)
  engine.registerJob({ id: 'ton:dex', marketChain: 'ton', interval: 2500,
    ready: () => engine.clock() >= client.next && !!client.endpoint,
    run: () => source.run(), spotCheck: id => source.state(id.split(':')[2]) })
  return source
}
