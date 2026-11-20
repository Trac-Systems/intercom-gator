// One row and one page per coin. A signed coin group (`coin` on the bundle token records) or a set of bundle records
// joined by reciprocal `links` (bridged copies of one token) is shown as one asset: lists collapse its members into one
// row, and every member's page lists all members as contracts.

/**
 * @typedef {{ id: string, symbol?: string, coin?: string, coinSupply?: string, links?: string[], explorer?: string }} TokenRecord
 * @typedef {{ key: string, kind: 'coin'|'linked', coin?: string, members: TokenRecord[], collapse: boolean, stable?: boolean }} Group
 */

/**
 * Bundle records without a signed coin, joined by their `links`. A set that links into a signed coin group holds
 * independent third-party pegs (Binance-Peg USDC, bridged USDC.e): those keep separate list rows and valuations
 * and only share the Contracts list.
 * @param {TokenRecord[]} tokens
 * @returns {Group[]}
 */
export function linkGroups(tokens) {
  const byId = new Map(tokens.map(t => [t.id, t]))
  const parent = new Map(tokens.filter(t => !t.coin).map(t => [t.id, t.id]))
  const find = (/** @type {string} */ id) => {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)))
      id = parent.get(id)
    }
    return id
  }
  for (const t of tokens) {
    if (!parent.has(t.id)) continue
    for (const link of t.links ?? []) {
      if (!parent.has(link)) continue
      const a = find(t.id), b = find(link)
      if (a !== b) parent.set(a < b ? b : a, a < b ? a : b)
    }
  }
  const sets = Map.groupBy(tokens.filter(t => parent.has(t.id)), t => find(t.id))
  return [...sets].filter(([, members]) => members.length > 1).map(([root, members]) => ({
    key: 'linked:' + root, kind: 'linked', members,
    collapse: !members.some(t => (t.links ?? []).some(id => byId.get(id)?.coin)),
  }))
}

/** "Ethereum Mainnet" → "Ethereum"; the bundle chain name otherwise, the id when unknown. */
export function chainLabel(chain, id) {
  return String(chain?.name ?? id ?? '').replace(/\s+Mainnet$/i, '') || id
}

/**
 * The record's own explorer page when the bundle names one, otherwise the chain explorer's token page.
 * @param {TokenRecord|undefined} token
 * @param {{ explorer?: string, family?: string }|undefined} chain
 * @param {string} id asset id
 */
export function explorerUrl(token, chain, id) {
  if (token?.explorer && /^https:\/\//.test(token.explorer)) return token.explorer
  const base = chain?.explorer?.replace(/\/$/, '')
  if (!base || !/^https:\/\//.test(base)) return null
  const address = id.slice(id.indexOf(':') + 1)
  if (address === 'native') return base
  const path = encodeURI(address)
  switch (chain.family) {
    case 'evm': return base + '/token/' + path
    case 'tron': return base + '/#/token20/' + path
    case 'solana': return base + '/address/' + path
    case 'ton': return base + '/' + path
    case 'near': return base + '/token/' + path
    case 'sui': return base + '/coin/' + path
    case 'aptos': return base + '/fungible_asset/' + path + '?network=mainnet'
    default: return base
  }
}

/**
 * A member's role inside its group: issuer-native, bridged (lock-and-mint, with its own ticker when it differs) or
 * linked (a bundle link without a signed group).
 * @param {TokenRecord|undefined} token
 * @param {Group|undefined} group
 * @param {string} [symbol] the group's main ticker
 */
export function contractRole(token, group, symbol) {
  if (!group || !token) return null
  if (group.kind === 'linked') return 'linked'
  if (token.coinSupply === 'escrow-backed') return token.symbol && symbol && token.symbol !== symbol ? `bridged (${token.symbol})` : 'bridged'
  return 'native'
}

/**
 * Representative order: most live markets, then Ethereum, then the issuer-native member with the largest verified
 * supply, then asset id.
 * @param {(id: string) => number} liveMarkets
 * @param {(id: string) => TokenRecord|undefined} record
 * @param {(id: string) => number|null|undefined} supply
 */
export function representativeOrder(liveMarkets, record, supply) {
  return (/** @type {string} */ a, /** @type {string} */ b) =>
    liveMarkets(b) - liveMarkets(a) ||
    Number(b.startsWith('ethereum:')) - Number(a.startsWith('ethereum:')) ||
    Number(record(b)?.coinSupply === 'issuance') - Number(record(a)?.coinSupply === 'issuance') ||
    (supply(b) ?? -1) - (supply(a) ?? -1) ||
    (a < b ? -1 : a > b ? 1 : 0)
}

const STATES = ['live', 'stale', 'unconfirmed', 'dust']
/** The most visible of several list states (live before stale before unconfirmed before dust). */
export function bestState(states) {
  let best = null
  for (const s of states) if (STATES.includes(s) && (best == null || STATES.indexOf(s) < STATES.indexOf(best))) best = s
  return best
}

const TEXT = new Set(['symbol', 'name'])
/**
 * The store's list order on finished rows: the sort column, NULLS LAST, then asset id. Text compares without case.
 * @param {string} sort
 * @param {'asc'|'desc'} order
 */
export function rowOrder(sort, order) {
  const sign = order === 'asc' ? 1 : -1
  const key = (/** @type {any} */ row) => {
    const v = sort === 'price' ? row.priceReal ?? row.price : row[sort]
    if (v == null) return null
    return TEXT.has(sort) ? String(v).toLowerCase() : Number(v)
  }
  return (/** @type {any} */ a, /** @type {any} */ b) => {
    const x = key(a), y = key(b)
    if (x == null || y == null) {
      if (x != null) return -1
      if (y != null) return 1
    } else if (x !== y) return (x < y ? -1 : 1) * sign
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  }
}

const isStable = (/** @type {any} */ t) => /^stablecoin$/i.test(t?.category ?? '')
/**
 * Signed price siblings: deployment id → the ids whose price it may borrow as its USD rate when it has none of its own
 * (book: a chain's USD quote must not rest on one third-party reference). Members of one signed coin group lend to each
 * other (the same coin). A stablecoin record without a coin whose reciprocal signed `links` reach stablecoin members of
 * exactly one coin group (a third-party peg: Binance-Peg USDT on BSC, bridged USDT on Base) borrows from that group.
 * Never by symbol.
 * @param {(TokenRecord & { category?: string })[]} tokens
 * @returns {Map<string, string[]>}
 */
export function priceSiblings(tokens) {
  const byId = new Map(tokens.map(t => [t.id, t]))
  const coins = Map.groupBy(tokens.filter(t => t.coin), t => /** @type {string} */ (t.coin))
  /** @type {Map<string, string[]>} */
  const out = new Map()
  for (const t of tokens) {
    if (t.coin) {
      const members = (coins.get(t.coin) ?? []).filter(m => m.id !== t.id).map(m => m.id)
      if (members.length) out.set(t.id, members)
      continue
    }
    if (!isStable(t)) continue
    const linked = new Set()
    for (const id of t.links ?? []) {
      const other = byId.get(id)
      if (other?.coin && isStable(other) && other.links?.includes(t.id)) linked.add(other.coin)
    }
    if (linked.size === 1) out.set(t.id, (coins.get([...linked][0]) ?? []).map(m => m.id))
  }
  return out
}
