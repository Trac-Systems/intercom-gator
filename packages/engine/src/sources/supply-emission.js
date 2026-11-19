// Express protocol quantities in base units until the registry's REAL valuation boundary.
export function units(amount, places) {
  const digits = amount.toString().padStart(places + 1, '0')
  if (!places) return digits
  const fraction = digits.slice(-places).replace(/0+$/, '')
  return digits.slice(0, -places) + (fraction ? '.' + fraction : '')
}

const COIN = 100_000_000n
// Main-chain coinbase generation, net of fees, excluding the unspendable genesis.
// https://api.blockchair.com/dogecoin/blocks?q=id(1..144999),is_aux(false)&a=count(),sum(generation)
// count() = 144999, sum(generation) = 6117540627100000000 koinu.
const DOGE_RANDOM_END = 144_999
const DOGE_RANDOM_COINS = 61_175_406_271n

/** Mainnet scheduled issuance through the indicated tip (inclusive), in whole-coin decimal units.
 * This circulation proxy excludes genesis and cannot detect unclaimed subsidies, burns or lost keys.
 * DOGE mainnet rewards before 145000 depend on the previous block hash, not just height.
 * @param {string} chain @param {number} height @returns {string|null} */
export function emissionAtHeight(chain, height) {
  if (!Number.isSafeInteger(height) || height < 0) throw new RangeError('Invalid block height')
  if (chain === 'dogecoin') {
    if (!height) return '0'
    if (height < DOGE_RANDOM_END) return null
    let coins = DOGE_RANDOM_COINS
    for (const [first, next, reward] of [
      [145000, 200000, 250000], [200000, 300000, 125000], [300000, 400000, 62500],
      [400000, 500000, 31250], [500000, 600000, 15625],
    ]) {
      coins += BigInt(Math.max(0, Math.min(height + 1, next) - first)) * BigInt(reward)
    }
    coins += BigInt(Math.max(0, height - 599999)) * 10000n
    return coins.toString()
  }
  const period = chain === 'litecoin' ? 840000 : ['bitcoin', 'bitcoin-cash'].includes(chain) ? 210000 : 0
  if (!period) return null
  let amount = 0n
  for (let first = 0, subsidy = 50n * COIN; first <= height && subsidy; first += period, subsidy >>= 1n) {
    const count = Math.min(height - first + 1, period) - Number(first === 0)
    amount += BigInt(count) * subsidy
  }
  return units(amount, 8)
}
