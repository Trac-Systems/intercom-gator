import { poolStateCalls, poolStateValue, field, word, ZERO } from '../evm-abi.js'
import { abiDecimals, abiLabel } from '../names/evm.js'
import { labels } from '../names/text.js'
import { abiAddress, tronAddress } from './address.js'
import { FACTORIES, MULTICALL, QUOTES, WTRX } from './deployments.js'

export function seedPlan(assets) {
  const tokens = assets.filter(a => a.chain === 'tron' && a.address !== 'native').map(a => a.address)
  const currencies = new Set([...QUOTES, ...tokens])
  const seen = new Set(), probes = []
  for (const a of currencies) {
    for (const b of QUOTES) {
      if (a === b) continue
      const [token0, token1] = abiAddress(a) < abiAddress(b) ? [a, b] : [b, a]
      const key = token0 + ':' + token1
      if (seen.has(key)) continue
      seen.add(key)
      for (const f of FACTORIES.filter(f => f.event)) {
        for (const fee of f.fees ?? [0]) probes.push({ dex: f.dex, kind: f.kind, token0, token1, fee })
      }
    }
    if (a !== WTRX) probes.push({ dex: 'sunswap-v1', kind: 'v1', token0: a, token1: 'native', fee: 0 })
  }
  return probes
}

export function lookup(p) {
  const f = FACTORIES.find(f => f.dex === p.dex)
  const a = word(abiAddress(p.token0))
  const data = p.kind === 'v1' ? '0x06f2bf62' + a :
    (p.kind === 'v3' ? '0x1698ee82' : '0xe6a43905') + a + word(abiAddress(p.token1)) +
    (p.kind === 'v3' ? word(p.fee) : '')
  return { to: abiAddress(f.address), data }
}

export function lookupAddress(value) {
  if (typeof value !== 'string' || !/^0x0{24}[0-9a-f]{40}$/i.test(value)) throw new Error('Invalid TRON factory response')
  const hex = '0x' + value.slice(-40)
  return hex === ZERO ? null : tronAddress(hex)
}

/** A single solidified block supplies identity, factory membership, state and both token balances. */
export async function snapshots(pools, client, registry) {
  const calls = [], metadata = new Map()
  for (const p of pools) {
    for (const address of [p.token0, p.token1]) {
      if (metadata.has(address)) continue
      const asset = registry.assets.get('tron:' + (address === WTRX ? 'native' : address))
      if (asset?.decimals != null) metadata.set(address, { asset })
      else {
        metadata.set(address, { offset: calls.length })
        for (const data of ['0x06fdde03', '0x95d89b41', '0x313ce567']) calls.push({ to: abiAddress(address), data })
      }
    }
  }
  const groups = pools.map(p => {
    const i = calls.length, pool = abiAddress(p.pool)
    calls.push(lookup(p))
    if (p.kind === 'v1') {
      calls.push({ to: abiAddress(p.token0), data: '0x70a08231' + word(pool) },
        { to: abiAddress(MULTICALL), data: '0x4d2301cc' + word(pool) })
    } else calls.push(...poolStateCalls({ ...p, pool, token0: abiAddress(p.token0), token1: abiAddress(p.token1) }))
    return [i, calls.length]
  })
  const { values, at } = await client.aggregate(calls)
  for (const [address, m] of metadata) {
    if (m.asset) continue
    const [name, symbol, d] = values.slice(m.offset, m.offset + 3)
    m.asset = { ...labels({ name: abiLabel(name), symbol: abiLabel(symbol) }, address), decimals: abiDecimals(d) }
  }
  return pools.map((p, i) => {
    const [from, end] = groups[i]
    const info = { token0: metadata.get(p.token0).asset, token1: metadata.get(p.token1).asset }
    const places = [info.token0.decimals, info.token1.decimals]
    if (!values[from] || lookupAddress(values[from]) !== p.pool) return { at, info }
    let valuesForPool = values.slice(from + 1, end)
    if (p.kind === 'v1') {
      if (valuesForPool.some(v => field(v, 0) == null)) return { at, info }
      valuesForPool = ['0x' + valuesForPool.map(v => word(field(v, 0))).join('')]
    }
    const state = poolStateValue(p.kind === 'v1' ? { kind: 'v2' } : p, valuesForPool, places)
    return { at, info, state }
  })
}
