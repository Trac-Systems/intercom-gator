import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryTransport } from '@gator/net'
import { openStore } from '@gator/store'
import { Engine, migrations } from '../src/index.js'
import { RateLimited } from '../src/scheduler/index.js'

const address = '0x42::coin::FISH', id = 'sui:' + address
const start = 1770000000000, day = 86_400_000
const bundle = {
  chains: [{ id: 'sui', family: 'sui', endpoints: [{ url: 'https://sui.invalid', protocol: 'sui-jsonrpc', limits: 60000 }] }],
  tokens: { tokens: [] }, dex: { evm: [], solana: [], events: [], kinds: [] }, exchanges: [], apis: [],
}

async function fixture(t, { seeds = [], legacy, respond }) {
  const dir = mkdtempSync(join(tmpdir(), 'engine-names-')), file = join(dir, 'test.db')
  let now = start, engine, store
  const sent = [], visited = [], transport = new MemoryTransport({ skipPow: true })
  transport.on('message', (topic, envelope) => { if (envelope.from === transport.publicKey) sent.push(envelope) })
  if (legacy) {
    const before = openStore({ file, migrations: migrations.filter(m => m.id !== 'engine-009-token-names') })
    try { legacy(before) } finally { before.close() }
  }
  const open = async () => {
    if (engine) { await engine.stop(); store.close() }
    store = openStore({ file, migrations })
    engine = new Engine({ store, bundle: { ...bundle, tokens: { tokens: seeds } }, transport,
      clock: () => now, backgroundJobs: ['names'], random: () => 0.5,
      rpcConfig: { bundleDigest: '0'.repeat(64), retries: 0, fetch: async (url, init) => {
        assert.equal(url, 'https://sui.invalid')
        const request = JSON.parse(init.body)
        visited.push(request.params[0])
        return Response.json({ jsonrpc: '2.0', id: request.id, result: respond(request.params[0]) })
      } } })
    await engine.start()
    clearTimeout(engine.timer)
    return engine
  }
  t.after(async () => { await engine?.stop(); await transport.close(); store?.close(); rmSync(dir, { recursive: true, force: true }) })
  return { e: await open(), open, sent, visited, transport, tick: ms => { now += ms }, clock: () => now,
    row: asset => store.reader.prepare('SELECT * FROM engine_names WHERE asset=?').get(asset) }
}

test('legacy address labels resolve without rediscovery, retry across database reopen and cap at one day', async t => {
  let answer = null
  const f = await fixture(t, { legacy: store => store.upsertAsset({ id, name: address, symbol: '' }), respond: () => answer })
  // A never-priced token is unconfirmed and hidden from ranked lists, so the list view asks for hidden entries.
  const shape = e => [e.asset(id), ...e.markets({ include: 'hidden' }), ...e.search(id)].map(a => [a.name, a.symbol, a.nameStatus])
  let e = f.e
  assert.deepEqual(shape(e), Array(3).fill([null, null, 'pending']))
  assert.equal(e.scheduler.jobs.get('names').markets, undefined)
  await e.step()
  assert.equal(f.row(id).lastAttempt, start)
  assert.equal(f.row(id).nextRetry, start + 60_000)
  assert.equal(e.names.display(id).nameStatus, 'unresolvable')
  e.scheduleMeta(id)
  e = await f.open()
  await e.step() // Reattach to the channel without spending the retry.
  assert.equal(f.visited.length, 1)
  for (let i = 1; i <= 12; i++) {
    const due = f.row(id).nextRetry
    f.tick(due - f.clock() - 1)
    assert.equal(await e.step(), null)
    f.tick(1)
    assert.equal(await e.step(), 'names')
    assert.equal(f.row(id).nextRetry - due, Math.min(day, 60_000 * 2 ** i))
  }
  assert.equal(f.row(id).failures, 13)
  answer = { name: '  Ｓilly\u200b Dragon ', symbol: 'ＳＩＬＬＹ', decimals: 9 }
  f.tick(day)
  await e.step()
  assert.deepEqual(shape(e), Array(3).fill(['Silly Dragon', 'SILLY', 'resolved']))
  assert.equal(e.registry.assets.get(id).decimals, 9)
  assert.equal(e.store.getAsset(id).symbol, 'SILLY')
  assert.equal(e.store.reader.prepare('SELECT decimals FROM engine_asset_data WHERE asset=?').get(id).decimals, 9)
  assert.equal(e.search('silly')[0].id, id)
  const [claim] = f.sent.filter(r => r.message.kind === 'name')
  assert.equal(claim.channel, 'gator/meta')
  assert.ok(claim.sig)
  assert.deepEqual(claim.message, { t: 'claim', v: 1, asset: id, kind: 'name',
    value: { name: 'Silly Dragon', symbol: 'SILLY', decimals: 9, method: 'sui-coin' } })
  assert.equal(f.row(id).nextRetry, null)
  const before = f.visited.length
  e = await f.open()
  assert.deepEqual(e.names.display(id), { name: 'Silly Dragon', symbol: 'SILLY', decimals: 9, nameStatus: 'resolved',
    nameSource: 'on-chain', nameFlags: [] })
  await e.step()
  assert.equal(f.visited.length, before)
})

test('two currently proven reporters must agree exactly after local failure, and a subsequent local result wins', async t => {
  let answer = null
  const f = await fixture(t, { respond: () => answer }), e = f.e
  await e.step() // Join the signed metadata channel before discovery.
  const a = e.registry.token('sui', address)
  e.scheduleMeta(a.id)
  const keys = ['1', '2', '3', '4'].map(c => c.repeat(64))
  const prove = (key, agreements) => e.store.writer.prepare('INSERT OR REPLACE INTO engine_standing VALUES(?,?,?,?)')
    .run(key, agreements, f.clock(), 1)
  const value = { name: 'Fish', symbol: 'USDC', decimals: 6, method: 'sui-coin' }
  const hint = (from, fields = {}, ts = f.clock()) => f.transport.emit('message', 'gator/meta',
    { channel: 'gator/meta', from, ts, message: { t: 'claim', v: 1, kind: 'name', asset: id, value: { ...value, ...fields } } })
  for (const k of keys.slice(0, 2)) prove(k, 3)
  hint(keys[0])
  hint(keys[0])
  hint(keys[2])
  hint(keys[1], { symbol: 'usdc' })
  assert.equal(e.names.display(id).nameSource, null)
  f.tick(1000)
  await e.step()
  assert.equal(e.names.display(id).nameStatus, 'unresolvable')
  hint(keys[1], { decimals: 9 })
  assert.equal(e.names.display(id).nameSource, null)
  f.tick(1)
  hint(keys[1], { symbol: 'USDC\u200b' })
  assert.equal(e.names.display(id).nameSource, null)
  hint(keys[1], {}, f.clock() - day - 1)
  assert.equal(e.names.display(id).nameSource, null)
  hint(keys[1], { block: 124, method: 'suix_getCoinMetadata' })
  assert.deepEqual(e.names.display(id), { name: 'Fish', symbol: 'USDC', decimals: 6, nameStatus: 'resolved',
    nameSource: 'reported', nameFlags: ['imitates:USDC'] })
  assert.equal(e.store.getAsset(id).symbol, address)
  assert.equal(a.decimals, null)
  assert.equal(e.registry.symbols.has('USDC'), false)
  prove(keys[0], 0)
  assert.equal(e.asset(id).nameSource, null)
  prove(keys[0], 3)
  for (const k of keys.slice(2)) { prove(k, 3); hint(k, { name: 'Different' }) }
  assert.equal(e.asset(id).nameSource, null) // Two conflicting quorums.
  prove(keys[3], 0)
  assert.equal(e.asset(id).nameSource, 'reported')
  assert.equal(f.sent.filter(r => r.message.kind === 'name').length, 0)
  f.tick(day + 1)
  assert.equal(e.asset(id).nameSource, null)
  answer = { name: 'Local Fish', symbol: 'FISH', decimals: 0 }
  await e.step()
  hint(keys[0])
  hint(keys[1])
  assert.deepEqual(e.names.display(id), { name: 'Local Fish', symbol: 'FISH', decimals: 0, nameStatus: 'resolved',
    nameSource: 'on-chain', nameFlags: [] })
  assert.equal(a.decimals, 0)
})

test('signed bundle labels survive while waiting, and ranked-symbol lookalikes stay visible and flagged', async t => {
  const seed = { id: 'sui:0x3::gem::GEM', name: 'Gem', symbol: 'GEM', decimals: 3, rank: 15 }
  const usdc = { id: 'sui:0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    name: 'USD Coin', symbol: 'USDC', decimals: 6 }
  const f = await fixture(t, { seeds: [seed, usdc], respond: () => ({ name: 'Other Gem', symbol: 'ＧＥＭ', decimals: 7 }) })
  const e = f.e
  assert.equal(e.names.display(seed.id).nameSource, 'bundle')
  assert.deepEqual(e.names.display(usdc.id).nameFlags, [])
  e.registry.token('sui', address, { name: 'Directory Guess', symbol: 'GEM' })
  e.scheduleMeta(id)
  assert.equal(e.names.display(id).symbol, null)
  await e.step()
  assert.equal(f.visited[0], address)
  assert.deepEqual(e.names.display(id).nameFlags, ['imitates:GEM'])
  assert.equal(e.search('Other Gem')[0].id, id)
  assert.equal(e.registry.symbols.get('GEM').has(id), false)
})

test('budget deferrals survive reopen without counting a failure or blocking another ready route', async t => {
  const f = await fixture(t, { respond: () => ({ name: 'Fish', symbol: 'FISH', decimals: 4 }) })
  let e = f.e
  e.registry.token('sui', address)
  e.scheduleMeta(id, true)
  const localAddress = '0xff::gem::GEM', localId = 'sui:' + localAddress
  e.registry.token('sui', localAddress)
  e.scheduleMeta(localId)
  let limited = 0
  const getPublic = e.http.getPublic.bind(e.http)
  e.http.getPublic = (url, rpm, cost, body) => {
    if (body.params[0] === address) { limited++; throw new RateLimited(start + 60_000) }
    return getPublic(url, rpm, cost, body)
  }
  await e.step()
  assert.equal(limited, 1)
  assert.equal(f.row(id).failures, 0)
  assert.equal(f.row(id).lastAttempt, start)
  assert.equal(f.row(id).nextRetry, start + 60_000)
  f.tick(1000)
  await e.step()
  assert.equal(f.row(localId).symbol, 'FISH')
  assert.deepEqual(f.visited, [localAddress])
  e = await f.open()
  await e.step()
  assert.equal(e.asset(id).nameStatus, 'pending')
  assert.deepEqual(f.visited, [localAddress])
  f.tick(59_000)
  await e.step()
  assert.deepEqual(f.visited, [localAddress, address])
  assert.equal(e.asset(id).nameSource, 'on-chain')
})

test('a refused signed send is retried from the outbox after restart without another chain read', async t => {
  const f = await fixture(t, { respond: () => ({ name: 'Fish', symbol: 'FISH', decimals: 9 }) })
  let e = f.e
  e.registry.token('sui', address)
  e.scheduleMeta(id)
  const send = f.transport.send.bind(f.transport)
  f.transport.send = (topic, msg) => msg.kind === 'name' ? false : send(topic, msg)
  await e.step()
  assert.equal(e.asset(id).nameSource, 'on-chain')
  assert.ok(f.row(id).publishAt > f.clock())
  e = await f.open()
  f.transport.send = send
  f.tick(f.row(id).publishAt - f.clock())
  await e.step()
  assert.equal(f.row(id).publishAt, null)
  assert.equal(f.sent.filter(r => r.message.kind === 'name').length, 1)
  assert.equal(f.visited.length, 1)
})

test('local labels remain available while decimals are missing, then a later read completes the signed claim', async t => {
  let decimals = null
  const f = await fixture(t, { respond: () => ({ name: 'Measured Fish', symbol: 'FISH', decimals }) })
  const e = f.e
  e.registry.token('sui', address)
  e.scheduleMeta(id)
  await e.step()
  assert.equal(e.names.display(id).nameSource, 'on-chain')
  assert.equal(e.names.display(id).decimals, null)
  assert.equal(f.sent.filter(r => r.message.kind === 'name').length, 0)
  f.tick(f.row(id).nextRetry - f.clock())
  decimals = 255
  await e.step()
  assert.equal(e.names.display(id).decimals, 255)
  assert.equal(e.registry.assets.get(id).decimals, null) // Valuation code supports up to 77.
  assert.equal(f.row(id).nextRetry, null)
  assert.equal(f.sent.filter(r => r.message.kind === 'name').length, 1)
})

test('existing registry names for assets outside contract discovery remain available without network work', async t => {
  const f = await fixture(t, { legacy: store => store.upsertAsset({ id: 'local:native', name: 'Local Coin', symbol: 'LOC' }),
    respond: () => assert.fail('native asset requested contract metadata') })
  await f.e.step()
  assert.equal(f.e.asset('local:native').symbol, 'LOC')
  assert.equal(f.e.asset('local:native').nameSource, 'registry')
  assert.equal(f.row('local:native'), undefined)
  assert.deepEqual(f.visited, [])
})

test('a release display name replaces a misleading on-chain name; the symbol stays the chain\'s', async t => {
  // Binance-Peg USDT reads "Tether USD" on chain (release-extensions.json `names`, applied as displayName).
  const seed = { id: 'sui:0x5::peg::USDT', name: 'Tether USD', symbol: 'USDT', decimals: 6, displayName: 'Binance-Peg USDT' }
  const f = await fixture(t, { seeds: [seed], respond: () => ({ name: 'Tether USD', symbol: 'USDT', decimals: 6 }) })
  const e = f.e
  assert.deepEqual([e.names.display(seed.id).name, e.names.display(seed.id).nameSource], ['Binance-Peg USDT', 'release'])
  e.scheduleMeta(seed.id)
  await e.step()
  assert.equal(f.row(seed.id).name, 'Tether USD', 'the chain read is still recorded')
  assert.deepEqual([e.asset(seed.id).name, e.asset(seed.id).symbol, e.asset(seed.id).nameSource],
    ['Binance-Peg USDT', 'USDT', 'release'])
})
