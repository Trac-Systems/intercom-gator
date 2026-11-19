import { rateLimit } from '../bundle-adapter.js'
import { RateLimited } from '../../scheduler/index.js'
import { abiLabel, abiDecimals } from './evm.js'
import { jettonContent, jettonName } from './ton.js'
import { bankName, denomMetadataPath } from './cosmos.js'

const protocols = { tron: 'tron-http', sui: 'sui-jsonrpc', aptos: 'aptos-rest', ton: 'toncenter-v2', cosmos: 'cometbft' }
const moveType = /^0x[0-9a-f]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/i
const object = /^0x[0-9a-f]{1,64}$/i

async function read(family, address, request, reads, offchain, protocol) {
  switch (family) {
    case 'tron': {
      if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return null
      const values = reads.tron ??= []
      const selectors = ['name()', 'symbol()', 'decimals()']
      while (values.length < selectors.length) {
        const reply = await request('/wallet/triggerconstantcontract', {
          owner_address: address, contract_address: address, function_selector: selectors[values.length], visible: true,
        })
        const raw = reply?.result?.result && reply.constant_result?.[0]
        values.push(typeof raw === 'string' ? '0x' + raw : null)
      }
      return { name: abiLabel(values[0]), symbol: abiLabel(values[1]), decimals: abiDecimals(values[2]), method: 'trc20' }
    }
    case 'sui': {
      if (!moveType.test(address)) return null
      if (protocol === 'sui-graphql') {
        const reply = await request('', {
          query: 'query($coin:String!){chainIdentifier coinMetadata(coinType:$coin){name symbol decimals}}',
          variables: { coin: address },
        })
        const data = reply?.data
        return !reply?.errors && data?.chainIdentifier === '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S' &&
          data.coinMetadata ? { ...data.coinMetadata, method: 'sui-coin' } : null
      }
      const reply = await request('', { jsonrpc: '2.0', id: 1, method: 'suix_getCoinMetadata', params: [address] })
      return reply?.id === 1 && !reply.error && reply.result ? { ...reply.result, method: 'sui-coin' } : null
    }
    case 'aptos': {
      const coin = moveType.test(address)
      if (!coin && !object.test(address)) return null
      const type = coin ? '0x1::coin::CoinInfo<' + address + '>' : '0x1::fungible_asset::Metadata'
      const reply = await request('/accounts/' + address.split('::')[0] + '/resource/' + encodeURIComponent(type))
      return reply?.type === type && reply.data ? { ...reply.data, method: coin ? 'aptos-coin' : 'aptos-fa' } : null
    }
    case 'ton': {
      if (!/^(?:[A-Za-z0-9_-]{48}|-?\d{1,3}:[0-9a-fA-F]{64})$/.test(address)) return null
      reads.content ??= jettonContent(await request('/runGetMethod', { address, method: 'get_jetton_data', stack: [] }))
      return jettonName(reads.content, offchain)
    }
    case 'cosmos': return bankName(await request(denomMetadataPath(address)), address)
  }
}

/** Non-EVM JSON-RPC/REST routes come exclusively from the effective signed bundle. Rotate on source failures. */
export async function contractName(chain, asset, http, reads, rotation, offchain) {
  const routes = chain.endpoints.filter(e => e.protocol === protocols[chain.family] ||
    (chain.family === 'sui' && e.protocol === 'sui-graphql'))
    .sort((a, b) => Number(!!b.verified?.ok) - Number(!!a.verified?.ok))
  if (!routes.length) return null
  const cursor = (rotation.get(chain.id) ?? 0) % routes.length, endpoint = routes[cursor]
  const request = (path, body) => http.getPublic(endpoint.url.replace(/\/$/, '') + path, rateLimit(endpoint.limits), 1, body)
  try {
    const row = await read(chain.family, asset.address, request, reads, offchain, endpoint.protocol)
    if (!row?.name || !row?.symbol) rotation.set(chain.id, cursor + 1)
    return row
  } catch (error) {
    if (!(error instanceof RateLimited)) rotation.set(chain.id, cursor + 1)
    throw error
  }
}
