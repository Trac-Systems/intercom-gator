import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { contractName } from '../src/sources/names/contracts.js'
import { jettonContent, jettonName, offchainReader } from '../src/sources/names/ton.js'
import { RateLimited } from '../src/scheduler/index.js'

function reader(family, protocol, respond) {
  const visits = [], rotation = new Map(), reads = {}
  const chain = { id: family, family, endpoints: [{ url: 'https://bundle.invalid', protocol }] }
  const http = { async getPublic(url, rpm, cost, body) {
    const path = new URL(url).pathname + new URL(url).search
    visits.push({ path, body })
    return respond(path, body)
  } }
  return { visits, run: (address, offchain) => contractName(chain, { address }, http, reads, rotation, offchain) }
}

test('TRC-20 uses visible addresses and resumes after a rate limit without repeating selectors', async () => {
  const address = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
  let deferred = false
  const r = reader('tron', 'tron-http', (path, body) => {
    assert.equal(path, '/wallet/triggerconstantcontract')
    assert.equal(body.contract_address, address)
    assert.equal(body.visible, true)
    if (body.function_selector === 'symbol()' && !deferred) { deferred = true; throw new RateLimited(1) }
    const raw = { 'name()': 'Tether USD', 'symbol()': 'USDT' }[body.function_selector]
    return { result: { result: true }, constant_result: [raw ? Buffer.from(raw).toString('hex').padEnd(64, '0') : '6'.padStart(64, '0')] }
  })
  await assert.rejects(r.run(address), RateLimited)
  assert.deepEqual(await r.run(address), { name: 'Tether USD', symbol: 'USDT', decimals: 6, method: 'trc20' })
  assert.deepEqual(r.visits.map(v => v.body.function_selector), ['name()', 'symbol()', 'symbol()', 'decimals()'])
})

test('Sui RPC receives the complete Move coin type, Aptos handles coin resources and FA metadata objects', async () => {
  const type = '0x42::test::COIN', data = { symbol: 'C', name: 'Coin', decimals: 0 }
  const sui = reader('sui', 'sui-jsonrpc', (path, body) => {
    assert.equal(body.method, 'suix_getCoinMetadata')
    assert.deepEqual(body.params, [type])
    return { jsonrpc: '2.0', id: 1, result: data }
  })
  assert.deepEqual(await sui.run(type), { ...data, method: 'sui-coin' })
  const aptos = reader('aptos', 'aptos-rest', path => ({ type: decodeURIComponent(path.split('/').at(-1)), data }))
  assert.deepEqual(await aptos.run(type), { ...data, method: 'aptos-coin' })
  assert.deepEqual(await aptos.run('0xabc'), { ...data, method: 'aptos-fa' })
  assert.equal(decodeURIComponent(aptos.visits[0].path), '/accounts/0x42/resource/0x1::coin::CoinInfo<' + type + '>')
  assert.equal(decodeURIComponent(aptos.visits[1].path), '/accounts/0xabc/resource/0x1::fungible_asset::Metadata')
  assert.equal(await sui.run(type + '?junk'), null)
})

const bitString = bytes => Array.from(bytes, n => n.toString(2).padStart(8, '0')).join('')
function cell(bits, refs = []) {
  const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0')
  const b = Buffer.from((padded.match(/.{8}/g) ?? []).map(n => parseInt(n, 2)))
  return { data: { b64: b.toString('base64'), len: bits.length }, refs, special: false }
}
const stack = root => ({ ok: true, result: { exit_code: 0, stack: [null, null, null, ['cell', { object: root }]] } })
const snake = (s, refs) => cell(bitString(Buffer.from(s)), refs)
function metadataTree(values) {
  function trie(rows, bits) {
    let common = 0
    while (common < bits && rows.every(([k]) => k[common] === rows[0][0][common])) common++
    const label = '10' + common.toString(2).padStart(Math.ceil(Math.log2(bits + 1)), '0') + rows[0][0].slice(0, common)
    if (common === bits) return cell(label, [snake('\0' + rows[0][1])])
    const branch = bit => trie(rows.filter(([k]) => k[common] === bit).map(([k, v]) => [k.slice(common + 1), v]), bits - common - 1)
    return cell(label, [branch('0'), branch('1')])
  }
  const rows = Object.entries(values).map(([field, value]) => [bitString(createHash('sha256').update(field).digest()), value])
  return cell('000000001', [trie(rows, 256)])
}

test('TON jetton on-chain TEP-64 dictionary is read at the content position of get_jetton_data', async () => {
  const r = reader('ton', 'toncenter-v2', (path, body) => {
    assert.equal(path, '/runGetMethod')
    assert.equal(body.method, 'get_jetton_data')
    return stack(metadataTree({ name: 'Jetton', symbol: 'JET', decimals: '7' }))
  })
  assert.deepEqual(await r.run('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'),
    { name: 'Jetton', symbol: 'JET', decimals: 7, method: 'jetton-tep64' })
  assert.throws(() => jettonContent(stack(cell('000000001'))), /dictionary/)
})

test('TON off-chain and semi-chain metadata only follow public HTTPS, and on-chain fields win', async () => {
  const uri = 'https://example.org/asset.json'
  const fields = jettonContent(stack(snake('\x01https://example.org', [snake('/asset.json')])))
  assert.equal(fields.uri, uri)
  const remote = async target => { assert.equal(target, uri); return { name: 'Token', symbol: 'JET', decimals: '5' } }
  assert.deepEqual(await jettonName({ ...fields, decimals: '6' }, remote),
    { name: 'Token', symbol: 'JET', decimals: 6, method: 'jetton-https' })
  for (const unsafe of ['http://example.org', 'https://127.0.0.1/a', 'https://user:pass@example.org/', 'ipfs://abc'])
    assert.equal((await jettonName({ uri: unsafe }, () => assert.fail('unsafe fetch'))).symbol, undefined)
})

test('Cosmos bank denom metadata verifies the base denom and finds the display exponent in denom units', async () => {
  const field = (key, raw) => {
    const bytes = Buffer.from(raw)
    return Buffer.concat([Buffer.from([8 * key + 2, bytes.length]), bytes])
  }
  const denom = 'ugem', unit = Buffer.concat([field(1, 'gem'), Buffer.from([16, 6])])
  const metadata = Buffer.concat([field(2, unit), field(3, denom), field(4, 'gem'), field(5, 'Gem'), field(6, 'GEM')])
  const r = reader('cosmos', 'cometbft', () => ({ result: { response: { code: 0, value: field(1, metadata).toString('base64') } } }))
  assert.deepEqual(await r.run(denom), { name: 'Gem', symbol: 'GEM', decimals: 6, method: 'cosmos-bank' })
  assert.match(decodeURIComponent(r.visits[0].path), /DenomMetadata.*0x0a047567656d$/)
  assert.equal(await r.run('uother'), null)
})

test('the bundled TON USDT jetton returns a semi-chain URI and decimal override in separate dictionary leaves', () => {
  const root = JSON.parse(readFileSync(new URL('./fixtures/names-ton-usdt.json', import.meta.url), 'utf8'))
  assert.deepEqual(jettonContent(stack(root)), { decimals: '6', uri: 'https://tether.to/usdt-ton.json' })
})

test('off-chain jetton documents enforce the 32 KiB limit on the actual stream and reject redirects', async () => {
  let at = 0, status = 200, chunks = [], size, charges = 0
  const fetchDocument = offchainReader({ clock: () => at, budget: { take() { charges++ } }, http: {} },
    (uri, options, respond) => {
      const res = Readable.from(chunks)
      res.statusCode = status
      res.headers = size == null ? {} : { 'content-length': size }
      respond(res)
      return new EventEmitter()
    })
  const uri = 'https://example.org/asset.json'
  chunks = [Buffer.from('{"name":"Jetton"}')]
  assert.deepEqual(await fetchDocument(uri), { name: 'Jetton' })
  await assert.rejects(fetchDocument(uri), RateLimited)
  at += 60_000
  chunks = [Buffer.alloc(20_000), Buffer.alloc(20_000)]
  await assert.rejects(fetchDocument(uri), /too large/)
  at += 60_000
  size = 33_000
  await assert.rejects(fetchDocument(uri), /unavailable/)
  at += 60_000
  status = 302
  size = 0
  await assert.rejects(fetchDocument(uri), /unavailable/)
  assert.equal(charges, 4)
  const partial = await jettonName({ uri, name: 'Local', symbol: 'LOC' }, async () => { throw new Error('unavailable') })
  assert.deepEqual(partial, { name: 'Local', symbol: 'LOC', decimals: null, method: 'jetton-tep64' })
})

test('Sui GraphQL reads the requested coin type on mainnet and rejects partial responses', async () => {
  const usdc = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
  const coinMetadata = { name: 'USDC', symbol: 'USDC', decimals: 6 }
  const data = { chainIdentifier: '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S', coinMetadata }
  let reply = { data }
  const sui = reader('sui', 'sui-graphql', (_, body) => {
    assert.deepEqual(body.variables, { coin: usdc })
    return reply
  })
  assert.deepEqual(await sui.run(usdc), { ...coinMetadata, method: 'sui-coin' })
  reply = { data, errors: [{ message: 'partial' }] }
  assert.equal(await sui.run(usdc), null)
  reply = { data: { ...data, chainIdentifier: 'testnet' } }
  assert.equal(await sui.run(usdc), null)
})
