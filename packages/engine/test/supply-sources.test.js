import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { nativeReader } from '../src/sources/supply-native.js'
import { circleRows } from '../src/sources/supply-issuer.js'
import { stablecoinRows, ethereumSupply } from '../src/sources/supply-api.js'
import { momentum, momentumTotal, reserveAccounts, tokenSupply } from '../src/sources/supply-token.js'
import { RateLimited } from '../src/scheduler/index.js'
import { word } from '../src/sources/evm-abi.js'

const uint = n => '0x' + word(n)
const host = 'https://chain.invalid/api'
function native(chain, protocol, response, inspect) {
  const config = { id: chain, endpoints: [{ protocol, url: host, limits: '20 requests/minute' }] }
  return nativeReader(config, { get: async (url, rate, cost, body) => {
    assert.equal(rate, 20)
    assert.equal(cost, 1)
    inspect?.(url, body)
    return response
  } })()
}
test('bundled Esplora, BlockCypher and Blockchair select the main-chain tip', async () => {
  assert.equal((await native('bitcoin', 'esplora', 210000, url => assert.equal(url, host + '/blocks/tip/height'))).value, '10499975')
  assert.equal((await native('dogecoin', 'blockcypher', { name: 'DOGE.main', height: 145000 })).value, '61175656271')
  const ltc = await native('litecoin', 'blockchair', { data: { best_block_height: 2, blocks: 99 } })
  assert.equal(ltc.value, '100')
  assert.equal(ltc.source, 'litecoin/blockchair/chain.invalid')
  await assert.rejects(native('dogecoin', 'blockcypher', { name: 'DOGE.test3', height: 160000 }))
  await assert.rejects(native('litecoin', 'blockchair', { data: { blocks: 99 } }))
})
test('NEAR, Aptos and validated XRPL provide total supply only', async () => {
  const near = await native('near', 'near-jsonrpc', { id: 1, result: { header: { total_supply: '123000000000000000000000001', height: 7 } } },
    (_, body) => assert.deepEqual(body.params, { finality: 'final' }))
  const apt = await native('aptos', 'aptos-rest', [{ vec: ['121179398574781331'] }], (_, body) =>
    assert.equal(body.type_arguments[0], '0x1::aptos_coin::AptosCoin'))
  const ledger = { status: 'success', validated: true, ledger_index: 7, ledger: { total_coins: '99123456789123456' } }
  const xrp = await native('xrpl', 'xrpl-jsonrpc', { result: ledger }, (_, body) => assert.equal(body.params[0].ledger_index, 'validated'))
  assert.deepEqual([near, apt, xrp].map(row => row.total),
    ['123.000000000000000000000001', '1211793985.74781331', '99123456789.123456'])
  assert.ok([near, apt, xrp].every(row => row.value === undefined))
  await assert.rejects(native('xrpl', 'xrpl-jsonrpc', { result: { ...ledger, validated: false } }))
  await assert.rejects(native('near', 'near-jsonrpc', { result: { header: { total_supply: 100, height: 7 } } }))
  await assert.rejects(native('aptos', 'aptos-rest', [{ vec: [] }]))
})
test('Solana finalized RPC and Cardano epoch totals separate circulating and total quantities', async () => {
  const result = { context: { slot: 15 }, value: { circulating: 1234567890, total: 2000000000 } }
  const sol = nativeReader({ id: 'solana', endpoints: [{ protocol: 'solana-jsonrpc' }] }, null,
    { call: async (chain, method, params) => {
      assert.equal(chain, 'solana')
      assert.equal(method, 'getSupply')
      assert.deepEqual(params, [{ commitment: 'finalized', excludeNonCirculatingAccountsList: true }])
      return result
    } })
  assert.deepEqual(await sol(), { value: '1.23456789', total: '2', block: 15, method: 'solana-get-supply', source: 'solana-jsonrpc' })
  result.value.total = 0
  await assert.rejects(sol())
  const ada = await native('cardano', 'koios', [{ circulation: '35000000111', supply: '39900000000', epoch_no: 616 }])
  assert.deepEqual([ada.value, ada.total, ada.epoch], ['35000.000111', '39900', 616])
  await assert.rejects(native('cardano', 'koios', [{ circulation: '8', supply: '7', epoch_no: 1 }]))
})
test('failed native request rotates to another signed bundle endpoint on the next attempt', async () => {
  const urls = []
  const read = nativeReader({ id: 'bitcoin', endpoints: ['a', 'b'].map(h => ({ protocol: 'esplora', url: 'https://' + h + '.invalid' })) },
    { get: async url => { urls.push(url); if (urls.length === 1) throw new Error('offline'); return 1 } })
  await assert.rejects(read())
  assert.equal((await read()).block, 1)
  assert.deepEqual(urls, ['https://a.invalid/blocks/tip/height', 'https://b.invalid/blocks/tip/height'])
})
const now = Date.UTC(2026, 10, 19)
test('growthepie matches native-unit on-chain rows to exact chain and contract, once per deployment', () => {
  const address = '0x' + '1'.repeat(40), other = '0x' + '2'.repeat(40)
  const assets = new Map(['ethereum', 'base'].map(chain => [chain + ':' + address, { decimals: 6, stable: true }]))
  const columns = ['address', 'value_usd', 'origin_key', 'method', 'date', 'value', 'decimals']
  const row = [address, 990, 'ethereum', 'rpc', '2026-11-17', 123.45, 6]
  const table = { columns, rows: [row, [other, 100, 'ethereum', 'rpc', '2026-11-17', 1, 6]] }
  const rows = () => stablecoinRows({ data: { table } }, 'ethereum', assets, now)
  assert.deepEqual([...rows()], [['ethereum:' + address, { value: '123.45', at: Date.UTC(2026, 10, 17),
    method: 'chain-circulating', source: 'growthepie-stablecoins' }]])
  table.rows.push(row)
  assert.equal(rows().size, 0)
  table.rows = [[address, 1, 'base', 'rpc', '2026-11-17', 1, 6], [address, 1, 'ethereum', 'vendor', '2026-11-17', 1, 6],
    [address, 1, 'ethereum', 'rpc', '2026-11-11', 1, 6]]
  assert.equal(rows().size, 0)
})
test('ETH net issuance is finalized, mainnet-only, dated and denominated in wei', () => {
  const asOf = now / 1000 - 12, data = { chainId: 1, supply: { finalizedAsOf: { block: 91, timestamp: asOf },
    finalizedTotalWei: { status: 'exact', asOf, value: '122000000000000000000000002' } } }
  assert.equal(ethereumSupply(data, now).value, '122000000.000000000000000002')
  assert.equal(ethereumSupply(data, now).block, 91)
  assert.throws(() => ethereumSupply({ ...data, chainId: 10 }, now))
  assert.throws(() => ethereumSupply(data, now + 8 * 86400000))
})
test('ERC-20 subtracts both burn balances before converting units, at one pinned block', async () => {
  const address = '0x' + '1'.repeat(40), chain = { id: 'ethereum', family: 'evm' }, calls = []
  let amounts = [6, 123000001, 1, 2000000]
  const rpc = { call: async (id, method, args) => {
    if (method === 'eth_blockNumber') return '0x10'
    assert.equal(args[1], '0x10')
    assert.equal(args[0].to, address)
    calls.push(args[0].data)
    return uint(amounts.shift())
  } }
  const run = () => tokenSupply({ address }, chain, rpc, {})
  assert.deepEqual(await run(), { value: '121', total: '123.000001', estimate: true,
    method: 'total-minus-burn', source: 'ethereum/erc20', block: 16 })
  assert.deepEqual(calls, ['0x313ce567', '0x18160ddd', '0x70a08231' + word(0), '0x70a08231' + word(0xdead)])
  amounts = [2, 5, 4, 3]
  await assert.rejects(run(), /Invalid token supply/)
})
test('SPL subtracts all incinerator-owned accounts of this mint and rejects inconsistent accounts', async () => {
  const address = 'A'.repeat(32), chain = { id: 'solana', family: 'solana' }
  const owner = '1nc1nerator11111111111111111111111111111111'
  const accounts = ['1', '2'].map((n, i) => ({ pubkey: (i ? 'B' : 'C').repeat(32), account: { data: { program: 'spl-token',
    parsed: { type: 'account', info: { owner, mint: address, tokenAmount: { amount: n, decimals: 6 } } } } } }))
  const rpc = { call: async (_, method, args) => {
    if (method === 'getTokenSupply') return { context: { slot: 12 }, value: { amount: '1000003', decimals: 6 } }
    assert.deepEqual(args, [owner, { mint: address }, { encoding: 'jsonParsed', commitment: 'finalized', minContextSlot: 12 }])
    return { context: { slot: 13 }, value: accounts }
  } }
  const run = () => tokenSupply({ address }, chain, rpc, {})
  assert.equal((await run()).value, '1')
  accounts.push(accounts[0])
  await assert.rejects(run(), /burn balance/)
  accounts.pop()
  accounts[0].account.data.parsed.info.mint = 'Z'.repeat(32)
  await assert.rejects(run(), /burn balance/)
})

test('ATOM excludes the community pool at the bank supply height and resumes a deferred second read', async () => {
  const block = '33949831', pool = 'CikKBXVhdG9tEiAxMTU3Mzk0NDM5NTU4ODEwOTY1NjIzMjAzMzUwMjAxNw=='
  const bank = 'ChgKBXVhdG9tEg81NDI3NzA0ODgyNjcwMDI='
  const reply = (value, height = block) => ({ result: { response: { code: 0, height, value } } })
  const calls = []
  let fail = true, poolReply = reply(pool)
  const chain = { id: 'cosmos', endpoints: [{ protocol: 'cometbft', url: host }] }
  const reader = nativeReader(chain, { async get(url) {
    const p = new URL(url).searchParams
    calls.push(p.get('path'))
    if (p.get('path').includes('SupplyOf')) {
      assert.equal(p.get('data'), '0x0a057561746f6d')
      return reply(bank)
    }
    assert.equal(p.get('height'), block)
    if (fail) { fail = false; throw new RateLimited(1) }
    return poolReply
  } }, null, () => now)
  await assert.rejects(reader(), RateLimited)
  const row = await reader()
  assert.equal(row.value, '531196543.871413890343767966497983')
  assert.equal(row.total, '542770488.267002')
  assert.equal(row.block, Number(block))
  assert.equal(calls.filter(x => x.includes('SupplyOf')).length, 1)
  poolReply = reply(pool, '33949832')
  await assert.rejects(reader(), /community pool/)
  poolReply = reply('AA==')
  await assert.rejects(reader(), /community pool/)
})

test('mainnet reserve balances are deducted on the same block as issuance', async () => {
  const sample = JSON.parse(readFileSync(new URL('fixtures/supply-reserves-mainnet.json', import.meta.url)))
  const amounts = {
    'ethereum:0xb62132e35a6c13ee1ee0f84dc5d40bad8d815206': '999582322.173657931677705612',
    'ethereum:0xf34960d9d60be18cc1d5afc1a6f012a723a28811': '74665578.937238',
    'ethereum:0x6de037ef9ad2725eb40118bb1702ebb27e4aeb24': '73845069.183352830794404723',
    'arbitrum:0x004b506865409877c9fa29bfb1eba929984b9bbc': '65334677.667835',
    // Ethereum block 26449861 and BSC block 134522973.
    'ethereum:0x925206b8a707096ed26ae47c84747fe0bb734f59': '140227191',
    'ethereum:0x3a63de3572c69a1307ff08394f3ee7702c16d25d': '0',
    'bsc:0x444045b0ee1ee319a660a5e3d604ca0ffa35acaa': '2708142067.040350428716144568',
    'bsc:0x000ae314e2a2172a039b26378814c252734f556a': '2456558477.315088340113204848',
  }
  for (const [id, values] of Object.entries(sample)) {
    const [chain, address] = id.split(':'), requests = []
    let index = 0
    const read = () => tokenSupply({ id, address }, { id: chain, family: 'evm' }, { call: async (_, method, args) => {
      if (method === 'eth_blockNumber') return '0x10'
      assert.equal(args[1], '0x10')
      assert.equal(args[0].to, address)
      requests.push(args[0].data)
      return values[index++]
    } }, {})
    const row = await read()
    assert.equal(row.value, amounts[id])
    assert.equal(row.method, 'erc20-minus-known-reserves')
    assert.deepEqual(requests.slice(2), [0, 0xdead, ...reserveAccounts.get(id)].map(a => '0x70a08231' + word(a)))
    values.pop()
    index = 0
    await assert.rejects(read(), /Incomplete token supply/)
  }
})

test('Momentum native issuance remains total-only even when it exceeds the initial reported float', async () => {
  const data = { chainIdentifier: '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S',
    checkpoint: { sequenceNumber: 346920422, timestamp: '2026-11-19T12:22:00.004Z' },
    coinMetadata: { name: 'MMT', symbol: 'MMT', decimals: 9, supply: '1240943937000000000' } }
  const clock = () => Date.parse('2026-11-19T12:23:00Z')
  const read = () => momentumTotal({ url: 'https://graphql.mainnet.sui.io/graphql' }, { get: async (_, __, cost, body) => {
    assert.equal(body.variables.coin, momentum.slice(4))
    assert.equal(cost, 1)
    return { data }
  } }, clock)
  assert.deepEqual(await read(), { total: '1240943937', method: 'sui-coin-total', block: 346920422,
    at: Date.parse(data.checkpoint.timestamp), source: 'sui/graphql/graphql.mainnet.sui.io' })
  data.checkpoint.timestamp = '2026-11-15T12:00:00Z'
  await assert.rejects(read(), /Invalid Sui/)
  data.checkpoint.timestamp = new Date(clock()).toISOString()
  data.chainIdentifier = 'testnet'
  await assert.rejects(read(), /Invalid Sui/)
})

test('Solana USDG excludes Paxos bridge custody and resumes after a profile deferral', async () => {
  const id = 'solana:2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', address = id.slice(7)
  const sample = JSON.parse(readFileSync(new URL('fixtures/usdg-solana-mainnet.json', import.meta.url)))
  const owner = reserveAccounts.get(id)[0], reads = {}, calls = []
  let defer = true
  const run = () => tokenSupply({ id, address }, { id: 'solana', family: 'solana' }, { call: async (_, method, args) => {
    if (defer && args[0] === owner) { defer = false; throw new RateLimited(1000) }
    calls.push(method)
    return sample[method] ?? sample[args[0]]
  } }, reads)
  await assert.rejects(run(), RateLimited)
  assert.equal((await run()).value, '427590034.385382')
  assert.deepEqual(calls, ['getTokenSupply', 'getTokenAccountsByOwner', 'getTokenAccountsByOwner'])
  sample[owner].value[0].account.data.parsed.info.tokenAmount.amount = '1000000'
  const result = await run()
  assert.equal(result.value, '427590033.385382')
  assert.equal(result.total, '427590034.385382')
  assert.equal(result.method, 'spl-minus-known-reserves')
  assert.equal(result.reserveSlot, 471335186)
})

test('top-cap deployment fixtures measure only their local mint or issuer row', async () => {
  const { tokens, circleEurc, falconTable } = JSON.parse(readFileSync(new URL('fixtures/top-deployment-supply.json', import.meta.url)))
  const expected = new Map([
    ['ethereum:0x2af5d2ad76741191d15dfe7bf6ac92d4bd912ca3', '659999999.999988603742121308'],
    ['ethereum:0x9f6f3991d525015a6f8caf062c83b62fd3ac4436', '122692737.09'],
    ['bsc:0x22b1458e780f8fa71e2f84502cee8b5a3cc731fa', '1154566865.677151218470419793'],
    ['solana:ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB', '121021990.43664'],
    ['solana:5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW', '4337.593563'],
  ])
  for (const [id, value] of expected) {
    const [chain, address] = id.split(':'), fixture = tokens[id]
    let index = 0
    const rpc = { call: async (_, method) => {
      if (method === 'eth_blockNumber') return '0x1'
      if (method === 'eth_call') return fixture[index++]
      return method === 'getTokenSupply' ? fixture.mint : fixture.incinerator
    } }
    const result = await tokenSupply({ id, address }, { id: chain, family: chain === 'solana' ? 'solana' : 'evm' }, rpc, {})
    assert.equal(result.value, value, id)
    assert.equal(result.method, 'total-minus-burn')
  }
  const at = Date.parse('2026-11-19T12:30Z'), eurc = 'solana:HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr'
  assert.equal(circleRows({ data: [{ symbol: 'EURC', chains: [circleEurc] }] }, at).get(eurc).value, '69902423.368748')
  const id = 'ethereum:0xfa2b947eec368f42195f24f36d2af29f7c24cec2', assets = new Map([[id, { id, decimals: 18 }]])
  assert.equal(stablecoinRows({ data: { table: falconTable } }, 'ethereum', assets, at).get(id).value, '1524287103.86')
})
