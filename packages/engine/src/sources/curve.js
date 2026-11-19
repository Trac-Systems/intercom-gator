import { address, curveCoins, word, ZERO } from './evm-abi.js'

const count = (data) => /^0x[0-9a-f]{64}$/i.test(data) && Number.isSafeInteger(Number(data)) ? Number(data) : null
const coinCall = (factory, pool) => ({ to: factory, data: '0x9ac90d3d' + word(pool) }) // get_coins(address)
const currency = (coin) => coin === '0x' + 'e'.repeat(40) ? 'native' : coin

/** PlainPoolDeployed omits the pool address. Match its ordered coin list to a unique new factory entry. */
export async function resolveCurveCreations(events, block, read) {
  const creations = events.filter(e => e.swap.type === 'curve-deployment')
  for (const [factory, logs] of Map.groupBy(creations, e => e.swap.emitter)) {
    const query = [{ to: factory, data: '0x956aae3a' }] // pool_count()
    if (block < 1) continue
    const before = count((await read(query, block - 1))[0])
    const after = count((await read(query, block))[0])
    if (before == null || after == null || after <= before || after - before > 64) continue
    const list = Array.from({ length: after - before }, (_, i) =>
      ({ to: factory, data: '0x3a1d5d8e' + word(before + i) })) // pool_list(uint256)
    const pools = (await read(list, block)).map(address)
    if (pools.some(pool => !pool || pool === ZERO)) continue
    const coins = (await read(pools.map(pool => coinCall(factory, pool)), block)).map(curveCoins)
    if (coins.some(tokens => !tokens)) continue
    for (const [pair, matches] of Map.groupBy(logs, e => e.swap.coins.join(','))) {
      const i = coins.findIndex(tokens => tokens?.join(',') === pair)
      if (i < 0 || matches.length !== 1 || coins.some((tokens, j) => j !== i && tokens?.join(',') === pair)) continue
      matches[0].swap = { type: 'pool', emitter: factory, pool: pools[i],
        token0: currency(coins[i][0]), token1: currency(coins[i][1]) }
    }
  }
}

/** Existing pools are authenticated by the configured factory's coin registry at the swap block. */
export async function identifyCurvePools(pools, deployments, block, read) {
  const queries = deployments.filter(d => d.kind === 'curve-plain').flatMap(deployment =>
    pools.map(pool => ({ pool, deployment, call: coinCall(deployment.address, pool) })))
  const coins = (await read(queries.map(q => q.call), block)).map(curveCoins)
  return queries.flatMap(({ pool, deployment }, i) => coins[i] ? [{
    pool, token0: currency(coins[i][0]), token1: currency(coins[i][1]),
    dex: deployment.name, kind: deployment.kind,
  }] : [])
}
