import { DAY } from './supply-api.js'

// Bittensor subnet tokens (dTAO alpha). Each subnet's pool holds TAO and the subnet's alpha token. SubtensorModule
// storage gives the reserves, the alpha outside the pool and the cumulative TAO volume
// (opentensor/subtensor v492, pallets/subtensor/src/lib.rs: maps keyed by NetUid u16 with the Identity hasher;
// SubnetIdentitiesV3 uses Blake2_128Concat and starts with `subnet_name: Vec<u8>`). Price in TAO = TAO in pool /
// alpha in pool (both in rao, 9 decimals). An archive node also answers at the block 24 h back, so the 24 h move
// and volume exist from the first read.
export const SUBTENSOR_API = 'subtensor-archive'
const BLOCKS_PER_DAY = 7200 // 12 s blocks
const REFRESH_MS = 5 * 60_000
const MAX_SUBNETS = 1000 // the node's state_getKeysPaged maximum
const SCALE = 10n ** 18n

// xxHash64, for the twox128 storage prefixes (twox128 = xxh64 seed 0 ++ xxh64 seed 1, little-endian).
const P1 = 11400714785074694791n, P2 = 14029467366897019727n, P3 = 1609587929392839161n,
  P4 = 9650029242287828579n, P5 = 2870177450012600261n, M = (1n << 64n) - 1n
const rotl = (x, r) => ((x << BigInt(r)) | (x >> BigInt(64 - r))) & M
const lane = (acc, v) => (rotl((acc + v * P2) & M, 31) * P1) & M
const merge = (acc, v) => ((((acc ^ lane(0n, v)) * P1) & M) + P4) & M
function xxh64(bytes, seed) {
  const n = bytes.length
  const u64 = (i) => { let v = 0n; for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(bytes[i + k]); return v }
  const u32 = (i) => BigInt(bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16)) + (BigInt(bytes[i + 3]) << 24n)
  let i = 0, h
  if (n >= 32) {
    let v1 = (seed + P1 + P2) & M, v2 = (seed + P2) & M, v3 = seed, v4 = (seed - P1) & M
    for (; i + 32 <= n; i += 32) [v1, v2, v3, v4] = [lane(v1, u64(i)), lane(v2, u64(i + 8)), lane(v3, u64(i + 16)), lane(v4, u64(i + 24))]
    h = merge(merge(merge(merge((rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) & M, v1), v2), v3), v4)
  } else h = (seed + P5) & M
  h = (h + BigInt(n)) & M
  for (; i + 8 <= n; i += 8) h = (rotl(h ^ lane(0n, u64(i)), 27) * P1 + P4) & M
  for (; i + 4 <= n; i += 4) h = (rotl(h ^ ((u32(i) * P1) & M), 23) * P2 + P3) & M
  for (; i < n; i++) h = (rotl(h ^ ((BigInt(bytes[i]) * P5) & M), 11) * P1) & M
  h = ((h ^ (h >> 33n)) * P2) & M
  h = ((h ^ (h >> 29n)) * P3) & M
  return h ^ (h >> 32n)
}
const leHex = (v) => Array.from({ length: 8 }, (_, k) => Number((v >> BigInt(8 * k)) & 255n).toString(16).padStart(2, '0')).join('')
export function twox128(text) {
  const bytes = new TextEncoder().encode(text)
  return leHex(xxh64(bytes, 0n)) + leHex(xxh64(bytes, 1n))
}
const PALLET = twox128('SubtensorModule')
export const storagePrefix = (item) => '0x' + PALLET + twox128(item)
const netuidHex = (n) => (n & 255).toString(16).padStart(2, '0') + (n >> 8).toString(16).padStart(2, '0')
export const storageKey = (item, netuid) => storagePrefix(item) + netuidHex(netuid)

const hexBytes = (hex) => (typeof hex === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(hex) ? Buffer.from(hex.slice(2), 'hex') : null)
/** Little-endian unsigned integer of `width` bytes, or null. */
function uint(hex, width) {
  const b = hexBytes(hex)
  if (!b || b.length !== width) return null
  let v = 0n
  for (let k = width - 1; k >= 0; k--) v = (v << 8n) | BigInt(b[k])
  return v
}
/** SCALE `Vec<u8>` at the start of the value (compact length prefix, single- and two-byte modes). */
function bytesAt(b) {
  if (!b?.length) return null
  const mode = b[0] & 3
  const [len, start] = mode === 0 ? [b[0] >> 2, 1] : mode === 1 && b.length >= 2 ? [b.readUInt16LE(0) >> 2, 2] : [-1, 0]
  return len >= 0 && start + len <= b.length ? b.subarray(start, start + len) : null
}
const text = (b, max) => {
  const s = b ? new TextDecoder('utf-8', { fatal: false }).decode(b).trim() : ''
  return s && s.length <= max && /^[^\p{Cc}<>]+$/u.test(s) ? s : null
}
/** Decimal string of a 10^-18 fixed-point BigInt. */
function fixed(v) {
  const whole = v / SCALE, frac = (v % SCALE).toString().padStart(18, '0').replace(/0+$/, '')
  return frac ? whole + '.' + frac : String(whole)
}
const rao = (v) => fixed(v * 10n ** 9n)

/** Subnet records from `state_queryStorageAt` changes now and 24 h back. Pure; skips empty or malformed pools. */
export function readSubnets(netuids, nowValues, thenValues, identities = new Map()) {
  const get = (values, item, n) => values.get(storageKey(item, n))
  const out = []
  for (const n of netuids) {
    if (n === 0 || uint(get(nowValues, 'NetworksAdded', n), 1) !== 1n) continue
    const taoIn = uint(get(nowValues, 'SubnetTAO', n), 8), alphaIn = uint(get(nowValues, 'SubnetAlphaIn', n), 8)
    const alphaOut = uint(get(nowValues, 'SubnetAlphaOut', n), 8), volume = uint(get(nowValues, 'SubnetVolume', n), 16)
    if (!(taoIn > 0n) || !(alphaIn > 0n) || alphaOut == null) continue
    const price = (taoIn * SCALE) / alphaIn
    const oldTao = uint(get(thenValues, 'SubnetTAO', n), 8), oldAlpha = uint(get(thenValues, 'SubnetAlphaIn', n), 8)
    const oldVolume = uint(get(thenValues, 'SubnetVolume', n), 16)
    const oldPrice = oldTao > 0n && oldAlpha > 0n ? (oldTao * SCALE) / oldAlpha : null
    const traded = volume != null && oldVolume != null && volume >= oldVolume ? volume - oldVolume : null
    out.push({
      netuid: n,
      symbol: 'SN' + n,
      name: text(bytesAt(hexBytes(identities.get(n))), 64) ?? 'Subnet ' + n,
      priceTao: fixed(price),
      // The pool's own 24 h move in TAO terms; null for a subnet younger than a day.
      ratio: oldPrice ? Number((price * 10n ** 12n) / oldPrice) / 1e12 : null,
      taoIn: rao(taoIn),
      circulating: rao(alphaOut),
      total: rao(alphaIn + alphaOut),
      // 24 h volume in alpha (TAO traded / price), the base unit of an observation.
      volume24h: traded == null ? null : fixed((traded * 10n ** 9n * SCALE) / price),
    })
  }
  return out
}

/** One job every five minutes: all subnets at the finalized block and 24 h back; own observations, pools, supply. */
export function registerSubnets(engine) {
  const { registry, store, clock, book } = engine
  const spec = engine.bundle.apis?.some((a) => a.id === SUBTENSOR_API) && engine.catalog.apis.find((a) => a.id === SUBTENSOR_API)
  if (!spec || !registry.assets.has('bittensor:native') || !registry.chains.has('bittensor')) return null
  if (engine.scheduler.backgroundJobs && !engine.scheduler.backgroundJobs.has('subnets:bittensor')) return null
  const ticks = new Map()
  book.subnetTicks = ticks
  let next = clock() + 30_000, last = null, pending = null
  const call = async (method, params) => {
    const reply = await engine.http.get(spec.url, spec.rpm, 1, { jsonrpc: '2.0', id: 1, method, params })
    if (!reply || reply.error || reply.result === undefined) throw new Error('Subtensor ' + method + ' failed')
    return reply.result
  }
  const changes = (result) => new Map((Array.isArray(result) ? result[0]?.changes ?? [] : []).filter((c) => Array.isArray(c)))
  engine.registerJob({ id: 'subnets:bittensor', interval: 1000, relevance: 2,
    ready: () => clock() >= next,
    run: async () => {
      // The six reads share one request bucket: each answer is kept, so a budget deferral resumes at the next read
      // instead of starting over (a restart from the first read would never finish at one request per bucket slot).
      if (!pending || clock() - pending.started > 2 * 60_000) pending = { started: clock() }
      const step = async (key, read) => {
        if (pending[key] === undefined) pending[key] = await read()
        return pending[key]
      }
      const head = await step('head', () => call('chain_getFinalizedHead', []))
      const number = parseInt((await step('header', () => call('chain_getHeader', [head])))?.number, 16)
      if (!Number.isSafeInteger(number) || number <= BLOCKS_PER_DAY) throw new Error('Subtensor head unavailable')
      const before = await step('before', () => call('chain_getBlockHash', [number - BLOCKS_PER_DAY]))
      const added = await step('added', () => call('state_getKeysPaged', [storagePrefix('NetworksAdded'), MAX_SUBNETS, null, head]))
      const netuids = (Array.isArray(added) ? added : []).filter((k) => typeof k === 'string' && k.length === 70)
        .map((k) => parseInt(k.slice(68, 70) + k.slice(66, 68), 16)).filter((n) => n > 0)
      const identityKeys = (await step('identities', () =>
        call('state_getKeysPaged', [storagePrefix('SubnetIdentitiesV3'), MAX_SUBNETS, null, head])) ?? [])
        .filter((k) => typeof k === 'string' && k.length === 102)
      const items = ['NetworksAdded', 'SubnetTAO', 'SubnetAlphaIn', 'SubnetAlphaOut', 'SubnetVolume']
      const now = changes(await step('now', () => call('state_queryStorageAt',
        [[...items.flatMap((item) => netuids.map((n) => storageKey(item, n))), ...identityKeys], head])))
      const then = changes(await step('then', () => call('state_queryStorageAt',
        [['SubnetTAO', 'SubnetAlphaIn', 'SubnetVolume'].flatMap((item) => netuids.map((n) => storageKey(item, n))), before])))
      pending = null
      const identities = new Map(identityKeys.map((k) => [parseInt(k.slice(100, 102) + k.slice(98, 100), 16), now.get(k)]))
      const at = clock(), tao = book.snapshots.get('bittensor:native')?.price
      const rows = []
      for (const s of readSubnets(netuids, now, then, identities)) {
        const asset = registry.registerToken('bittensor', 'sn' + s.netuid, { symbol: s.symbol, name: s.name, decimals: 9 })
        if (!asset.category) { asset.category = 'ai'; registry.saveAsset(asset) }
        const market = registry.register({ id: 'dex:bittensor:sn' + s.netuid, base: asset.id, quote: 'bittensor:native',
          chain: 'bittensor', exchange: 'subtensor', kind: 'dex', inverse: false })
        store.upsertPool({ chain: 'bittensor', pool: 'sn' + s.netuid, dex: 'subtensor', kind: 'subnet', token0: 'sn' + s.netuid,
          token1: 'native', firstSeen: at, liquidity: tao > 0 ? 2 * Number(s.taoIn) * tao : null })
        if (s.ratio > 0) ticks.set(market.id, { at, ratio: s.ratio })
        rows.push([market.id, s.priceTao, s.volume24h ?? '0', null, null, null, at])
        engine.supply?.record?.(asset.id, { value: s.circulating, total: s.total, method: 'subtensor-alpha',
          source: 'bittensor/subtensor', at, expiresAt: at + 2 * DAY })
      }
      engine.publish(rows)
      last = { at, block: number, subnets: rows.length }
      next = at + REFRESH_MS
    },
  })
  return { status: () => last }
}
