import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { loadBundle } from '@gator/bundle'
import { openStore } from '@gator/store'
import { migrations as socialMigrations } from '@gator/social'
import { Engine, migrations } from '../src/index.js'
import { RateLimited } from '../src/scheduler/index.js'
import { readSubnets, storageKey, storagePrefix, twox128 } from '../src/sources/subtensor.js'

const le = (v, width) => '0x' + Array.from({ length: width }, (_, k) => Number((BigInt(v) >> BigInt(8 * k)) & 255n)
  .toString(16).padStart(2, '0')).join('')
const vec = (text) => { const b = Buffer.from(text); return '0x' + (b.length << 2).toString(16).padStart(2, '0') + b.toString('hex') }
const rao = (n) => BigInt(Math.round(n * 1e9))
// sn110 on 2026-11-19: 11,764 TAO and 535,120 alpha in the pool, 3,553,821 alpha outside, 24 h earlier 0.029482 TAO.
function chain(subnets) {
  const now = new Map(), then = new Map()
  for (const s of subnets) {
    now.set(storageKey('NetworksAdded', s.n), '0x01')
    now.set(storageKey('SubnetTAO', s.n), le(rao(s.tao), 8))
    now.set(storageKey('SubnetAlphaIn', s.n), le(rao(s.alphaIn), 8))
    now.set(storageKey('SubnetAlphaOut', s.n), le(rao(s.alphaOut), 8))
    now.set(storageKey('SubnetVolume', s.n), le(rao(s.volume), 16))
    if (s.before) {
      then.set(storageKey('SubnetTAO', s.n), le(rao(s.before.tao), 8))
      then.set(storageKey('SubnetAlphaIn', s.n), le(rao(s.before.alphaIn), 8))
      then.set(storageKey('SubnetVolume', s.n), le(rao(s.before.volume), 16))
    }
  }
  return { now, then }
}
const sn110 = { n: 110, tao: 11764.355416515, alphaIn: 535119.573844141, alphaOut: 3553820.826758453, volume: 650933.262265322,
  before: { tao: 14716.0, alphaIn: 499146.0, volume: 639222.863542916 } }

test('twox128 storage prefixes match the Substrate constants', () => {
  assert.equal(twox128('System'), '26aa394eea5630e07c48ae0c9558cef7')
  assert.equal(storagePrefix('NetworksAdded').length, 66)
  assert.equal(storageKey('SubnetTAO', 110).slice(-4), '6e00')
})

test('subnet pools give price in TAO, the 24 h move, alpha volume and supply; root and empty pools are skipped', () => {
  const { now, then } = chain([sn110, { n: 7, tao: 0, alphaIn: 1, alphaOut: 1, volume: 0 },
    { n: 9, tao: 100, alphaIn: 1000, alphaOut: 50, volume: 3 }])
  now.set(storageKey('NetworksAdded', 0), '0x01')
  const identities = new Map([[110, vec('Green Compute') + '00']])
  const subnets = readSubnets([0, 7, 9, 110], now, then, identities)
  assert.deepEqual(subnets.map(s => s.netuid), [9, 110])
  const s = subnets[1]
  assert.equal(s.symbol, 'SN110')
  assert.equal(s.name, 'Green Compute')
  assert.ok(Math.abs(Number(s.priceTao) - 0.0219845) < 1e-6)
  assert.ok(Math.abs((s.ratio - 1) * 100 - -25.43) < 0.05)
  assert.ok(Math.abs(Number(s.volume24h) - 11710.4 / Number(s.priceTao)) < 1)
  assert.equal(Math.round(Number(s.circulating)), 3553821)
  assert.equal(Math.round(Number(s.total)), Math.round(535119.573844141 + 3553820.826758453))
  // A subnet younger than a day has no 24 h move or volume yet; it is named by its number.
  assert.equal(subnets[0].ratio, null)
  assert.equal(subnets[0].volume24h, null)
  assert.equal(subnets[0].name, 'Subnet 9')
})

test('the subnet job lists each subnet as a TAO-quoted pool with a USD price, 24 h change, liquidity and supply', async t => {
  const bundle = structuredClone(loadBundle())
  bundle.exchanges = bundle.exchanges.filter(s => s.id === 'bitstamp')
  bundle.tokens.tokens = bundle.tokens.tokens.filter(t => t.id === 'bittensor:native')
  const { now: nowValues, then: thenValues } = chain([sn110])
  const keys = (prefix, values) => [...values.keys()].filter(k => k.startsWith(prefix))
  const transport = Object.assign(new EventEmitter(), { publicKey: 'a'.repeat(64), sent: [], channels: () => [],
    join: async () => true, leave: async () => true, send(channel, message) { this.sent.push({ channel, message }); return true } })
  const store = openStore({ file: ':memory:', profile: 'small', migrations: [...migrations, ...socialMigrations] })
  let now = Date.UTC(2026, 10, 19, 18)
  const engine = new Engine({ bundle, transport, store, clock: () => now, backgroundJobs: ['subnets:bittensor'], random: () => 0.5,
    rpcConfig: { bundleDigest: '0'.repeat(64), timeout: 500, retries: 0, requestsPerMinute: 600,
      fetch: async (url, init) => {
        assert.ok(url.startsWith('https://archive.chain.opentensor.ai'))
        const { method, params } = JSON.parse(init.body)
        const reply = result => Response.json({ jsonrpc: '2.0', id: 1, result })
        if (method === 'chain_getFinalizedHead') return reply('0xhead')
        if (method === 'chain_getHeader') return reply({ number: '0x' + (9542412).toString(16) })
        if (method === 'chain_getBlockHash') return reply('0xbefore')
        if (method === 'state_getKeysPaged') return reply(params[0] === storagePrefix('NetworksAdded') ? keys(params[0], nowValues) : [])
        if (method === 'state_queryStorageAt') {
          const values = params[1] === '0xhead' ? nowValues : thenValues
          return reply([{ block: params[1], changes: params[0].map(k => [k, values.get(k) ?? null]) }])
        }
        assert.fail('Unexpected ' + method)
      } } })
  t.after(async () => { await engine.stop(); store.close() })
  await engine.start()
  clearTimeout(engine.timer)
  // TAO's own price: $194 and +2% on the day.
  const taoMarket = engine.registry.cex('bitstamp', 'TAO', 'USD')
  engine.registry.venues.get('bitstamp').lastTickers = new Map([[taoMarket.id, { at: now, dayRatio: 1.02 }]])
  engine.publish([[taoMarket.id, '194', '1000', '194000', null, null, now]])
  assert.ok(Math.abs(engine.book.refresh().get('bittensor:native').change24h - 2) < 1e-9)
  now += 31_000
  assert.ok(engine.subnets, 'subnet job registered')
  // Six reads at one request per bucket slot: the job resumes after each deferral.
  for (let i = 0; i < 30 && !engine.registry.assets.has('bittensor:sn110'); i++) {
    try { await engine.step() } catch (error) { if (!(error instanceof RateLimited)) throw error }
    now += 5_000
  }
  const asset = engine.registry.assets.get('bittensor:sn110')
  assert.equal(asset.symbol, 'SN110')
  assert.equal(asset.category, 'ai')
  engine.publish([[taoMarket.id, '194', '1000', '194000', null, null, now]])
  const price = engine.book.refresh().get('bittensor:sn110')
  assert.ok(Math.abs(price.price - 0.0219845 * 194) < 0.01)
  // The pool's −25.4% in TAO times TAO's +2%: about −23.9% in USD, from the first read.
  assert.ok(Math.abs(price.change24h - ((1 - 0.2543) * 1.02 - 1) * 100) < 0.2)
  assert.ok(price.volume24h > 2_000_000)
  assert.equal(engine.supply.display('bittensor:sn110').circulating.method, 'subtensor-alpha')
  assert.ok(Math.abs(price.marketCap - 3553821 * price.price) < 1)
  const pool = store.reader.prepare("SELECT liquidity FROM pools WHERE chain='bittensor' AND pool='sn110'").get()
  assert.ok(Math.abs(pool.liquidity - 2 * 11764.355 * 194) < 10)
  assert.equal(engine.subnets.status().subnets, 1)
})
