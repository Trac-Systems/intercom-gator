import { rateLimit } from './bundle-adapter.js'
import { communityAtom, unlockedAtom } from './supply-cosmos.js'
import { RateLimited } from '../scheduler/index.js'
import { emissionAtHeight, units } from './supply-emission.js'

const integer = value => typeof value === 'string' && /^\d{1,78}$/.test(value)
const uint = value => Number.isSafeInteger(value) && value >= 0
const height = value => uint(value) ? value : integer(value) && uint(Number(value)) ? Number(value) : null
const amount = (raw, places) => integer(raw) ? units(BigInt(raw), places) : null

function issuance(chain, rawHeight) {
  const block = height(rawHeight)
  const value = block === null ? null : emissionAtHeight(chain, block)
  return value === null ? null : { value, total: value, method: 'scheduled-emission', block, estimate: true }
}

// Strictly decode QuerySupplyOfResponse.amount (Coin{denom, amount}). Both field lengths fit a byte.
function atomSupply(result) {
  const reply = result?.response
  if (reply?.code !== 0 || typeof reply.value !== 'string' || reply.value.length > 128) return null
  const coin = Buffer.from(reply.value, 'base64')
  if (coin.toString('base64') !== reply.value || coin[0] !== 10 || coin[1] !== coin.length - 2 ||
      coin[2] !== 10 || coin[3] !== 5 || coin.toString('latin1', 4, 9) !== 'uatom' ||
      coin[9] !== 18 || coin[10] !== coin.length - 11) return null
  const total = amount(coin.toString('latin1', 11), 6), block = height(reply.height)
  return total !== null && block !== null ? { total, block, method: 'cosmos-bank-supply' } : null
}

const rpcBody = (method, params) => ({ jsonrpc: '2.0', id: 1, method, params })

function route(chain, protocol) {
  if (['bitcoin', 'litecoin', 'dogecoin', 'bitcoin-cash'].includes(chain)) {
    const symbol = { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE', 'bitcoin-cash': 'BCH' }[chain]
    switch (protocol) {
      case 'esplora': return { path: '/blocks/tip/height', read: n => issuance(chain, n) }
      case 'blockcypher': return { path: '', read: r => r?.name === symbol + '.main' && issuance(chain, r.height) }
      case 'blockchair': return { path: '/stats', read: r => issuance(chain, r?.data?.best_block_height) }
    }
  }
  if (chain === 'near' && protocol === 'near-jsonrpc') return {
    path: '', body: rpcBody('block', { finality: 'final' }), read(r) {
      const header = r?.result?.header, total = amount(header?.total_supply, 24), block = height(header?.height)
      return r?.id === 1 && !r.error && total !== null && block !== null && { total, block, method: 'near-block-total' }
    },
  }
  if (chain === 'cosmos' && protocol === 'cometbft') return {
    path: '/abci_query?path=%22%2Fcosmos.bank.v1beta1.Query%2FSupplyOf%22&data=0x0a057561746f6d',
    read: r => !r?.error && atomSupply(r?.result),
    async complete(row, get) {
      const reply = await get('/abci_query?path=%22%2Fcosmos.distribution.v1beta1.Query%2FCommunityPool%22&height=' + row.block)
      return { ...row, value: unlockedAtom(row.total, communityAtom(reply, row.block)),
        method: 'cosmos-minus-community-pool', estimate: true }
    },
  }
  if (chain === 'xrpl' && protocol === 'xrpl-jsonrpc') return {
    path: '', body: { method: 'ledger', params: [{ ledger_index: 'validated', transactions: false }] }, read(r) {
      const result = r?.result, total = amount(result?.ledger?.total_coins, 6), block = height(result?.ledger_index)
      return result?.validated === true && result.status === 'success' && total !== null && block !== null &&
        { total, block, method: 'xrpl-ledger-total' }
    },
  }
  if (chain === 'cardano' && protocol === 'koios') return {
    path: '/totals?limit=1&order=epoch_no.desc', read(r) {
      const row = Array.isArray(r) && r.length === 1 && r[0]
      const value = amount(row?.circulation, 6), total = amount(row?.supply, 6)
      return value !== null && total !== null && BigInt(row.circulation) <= BigInt(row.supply) &&
        uint(row.epoch_no) && { value, total, method: 'koios-epoch-circulation', epoch: row.epoch_no }
    },
  }
  if (chain === 'aptos' && protocol === 'aptos-rest') return {
    path: '/view', body: { function: '0x1::coin::supply', type_arguments: ['0x1::aptos_coin::AptosCoin'], arguments: [] },
    read(r) {
      const total = Array.isArray(r) && r.length === 1 && r[0]?.vec?.length === 1 ? amount(r[0].vec[0], 8) : null
      return total !== null && { total, method: 'aptos-coin-supply' }
    },
  }
}

/** One reader per supported signed-bundle chain. Rotate on failure and share HTTP/RPC buckets with prices. */
export function nativeReader(chain, http, rpc, clock = Date.now) {
  if (chain.id === 'solana' && chain.endpoints.some(e => e.protocol === 'solana-jsonrpc')) return async () => {
    const result = await rpc.call(chain.id, 'getSupply', [{ commitment: 'finalized', excludeNonCirculatingAccountsList: true }])
    const { circulating, total } = result?.value ?? {}
    // Solana returns JSON u64 numbers. Above 2^53, keep the precision of the shared RPC decoder.
    if (![circulating, total].every(n => Number.isInteger(n) && n >= 0 && n < 2 ** 64) ||
        circulating > total || !uint(result?.context?.slot)) throw new Error('Invalid Solana supply')
    return { value: String(circulating / 1e9), total: String(total / 1e9), method: 'solana-get-supply',
      source: 'solana-jsonrpc', block: result.context.slot }
  }
  const routes = chain.endpoints.map(e => ({ e, spec: route(chain.id, e.protocol) })).filter(r => r.spec)
    .sort((a, b) => Number(!!b.e.verified?.ok) - Number(!!a.e.verified?.ok) ||
      Number(b.e.protocol === 'esplora') - Number(a.e.protocol === 'esplora'))
  if (!routes.length) return null
  let cursor = 0, pending
  return async () => {
    const { e, spec } = routes[cursor]
    try {
      const get = (path, body) => http.get(e.url.replace(/\/$/, '') + path, rateLimit(e.limits), 1, body)
      if (pending && clock() - pending.at > 300_000) pending = null
      let data = pending?.data ?? spec.read(await get(spec.path, spec.body))
      if (!data) throw new Error('Invalid native supply response')
      if (spec.complete) {
        pending ??= { data, at: clock() }
        data = { ...await spec.complete(data, get), at: pending.at }
        pending = null
      }
      return { ...data, source: chain.id + '/' + e.protocol + '/' + new URL(e.url).hostname }
    } catch (error) {
      // Let the scheduler back off before trying a different bundle endpoint.
      if (!(error instanceof RateLimited)) {
        pending = null
        cursor = (cursor + 1) % routes.length
      }
      throw error
    }
  }
}
