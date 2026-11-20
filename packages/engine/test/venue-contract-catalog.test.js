import assert from 'node:assert/strict'
import test from 'node:test'
import { currencyContracts } from '../src/sources/venue-contracts/catalog.js'

const eth = '0x' + 'ab'.repeat(20), base = '0x' + 'cd'.repeat(20)
const chains = new Map(['ethereum', 'base', 'arbitrum', 'hyperevm'].map(id => [id, { family: 'evm' }]))
const gate = { id: 'gate' }
const row = (name, addr) => ({ name, addr })
const currency = (...chains) => ({ currency: 'mIx', chains })

test('directories use the address of the named chain, preserve label scope and reject conflicting rows', () => {
  const parse = (...rows) => currencyContracts(gate, rows, chains).get('MIX')
  assert.deepEqual(parse(currency(row('ETH', eth.toUpperCase().replace('0X', '0x')), row('BASEEVM', base))),
    ['base:' + base, 'ethereum:' + eth])
  assert.equal(parse(currency(row('ETH', eth), row('ERC20', base))), null)
  assert.equal(parse(currency(row('ETH', eth)), currency(row('ETH', base)), currency(row('ETH', eth))), null)
  assert.equal(parse(currency(row('ETH', eth)), { ...currency(row('ETH', eth)), currency: 'OTHER' }), null)
  assert.equal(parse(currency(row('ARBITRUM NOVA', eth), row('fake ETH', eth))), null)
  assert.deepEqual(parse(currency(row('ETH', '0x' + '0'.repeat(40)))), [])
  assert.deepEqual(parse({ ...currency(row('ETH', eth)), delisted: true }), [])
  assert.throws(() => currencyContracts(gate, { message: 'temporarily unavailable' }, chains))
})

test('bulk venue schemas read contract fields only, including the HyperEVM link and keyed currency objects', () => {
  const cases = [
    ['binance', { code: '000000', data: [{ coin: 'X', networkList: [{ network: 'ETH', contractAddress: eth }] }] }, 'ethereum'],
    ['bitget', { code: '00000', data: [{ coin: 'X', chains: [{ chain: 'ArbitrumOne', contractAddress: eth }] }] }, 'arbitrum'],
    ['kucoin', { code: '200000', data: [{ currency: 'X', chains: [{ chainId: 'eth', contractAddress: eth }] }] }, 'ethereum'],
    ['weex', [{ coin: 'X', networkList: [{ network: 'ETH', contractAddress: eth }] }], 'ethereum'],
    ['htx', { code: 200, data: [{ currency: 'x', chains: [{ baseChain: 'ETH', contractAddress: eth }] }] }, 'ethereum'],
    ['poloniex', [{ coin: 'X', networkList: [{ blockchain: 'ETH', contractAddress: eth }] }], 'ethereum'],
    ['hitbtc', { X: { networks: [{ network: 'ETH', contract_address: eth }] } }, 'ethereum'],
    ['cex-io', { ok: 'ok', data: { X: { blockchains: { ethereum: { contract: eth } } } } }, 'ethereum'],
    ['backpack', [{ symbol: 'X', tokens: [{ blockchain: 'Ethereum', contractAddress: eth }] }], 'ethereum'],
    ['xt', { rc: 0, result: [{ currency: 'x', supportChains: [{ chain: 'Ethereum', contract: eth }] }] }, 'ethereum'],
    ['coinbase', [{ id: 'X', status: 'online', supported_networks: [{ id: 'ethereum', contract_address: eth }] }], 'ethereum'],
    ['hyperliquid-spot', { tokens: [{ name: 'X', tokenId: base, evmContract: { address: eth } }] }, 'hyperevm'],
  ]
  for (const [id, payload, chain] of cases)
    assert.deepEqual(currencyContracts({ id }, payload, chains).get('X'), [chain + ':' + eth], id)
  assert.throws(() => currencyContracts({ id: 'bitget' }, { code: '40000', data: [] }, chains))
})
