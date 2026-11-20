import { address, multiRead, word, ZERO } from '../src/sources/evm-abi.js'

// Read a signed Uniswap V3 native/USDC market so an isolated history reader has a current USD conversion.
export async function nativeRate(engine, source) {
  const chain = source.chain, native = engine.registry.assets.get(chain.id + ':native')
  const quotes = [...source.quotes.values()]
  const w = quotes.find(q => q.symbol === 'W' + native.symbol), usd = quotes.find(q => q.symbol === 'USDC')
  const factory = chain.deployments.find(d => d.name === 'uniswap-v3')
  const [a,b] = [w.address, usd.address].sort()
  const values = await multiRead(engine.rpc, chain, [100,500,3000,10000].map(fee =>
    ({ to: factory.address, data: '0x1698ee82' + word(a) + word(b) + word(fee) })))
  const pools = values.map(address).filter(p => p && p !== ZERO).map(pool => ({ pool, kind: 'v3', token0: a, token1: b }))
  const states = await source.snapshots(pools, calls => multiRead(engine.rpc, chain, calls))
  const deepest = states.filter(s => s?.liquidity > 1000).sort((a,b) => b.liquidity - a.liquidity)[0]
  if (!deepest) throw new Error('No funded native/USDC conversion')
  const price = a === w.address ? deepest.price : 1 / deepest.price
  engine.store.writer.prepare('INSERT OR REPLACE INTO prices(asset,price,at,trust) VALUES (?,?,?,?)')
    .run(native.id, String(price), Date.now(), 'yellow')
  return { type: 'native', chain: chain.id, price, liquidity: deepest.liquidity }
}
