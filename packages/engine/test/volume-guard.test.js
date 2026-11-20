import test from 'node:test'
import assert from 'node:assert/strict'
import { volumeSuspects, volumeOrder, VOLUME_GUARD } from '../src/aggregate/volume-guard.js'
import { aggregateAssets } from '../src/aggregate/index.js'
import { bookQuote, bookSizes } from '../src/sources/cex.js'

const BTC = 'bitcoin:native', ETH = 'ethereum:native', USDT = 'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7'
const cex = (exchange, base, volume, extra = {}) =>
  ({ id: `cex:${exchange}:${base.split(':').pop()}-USDT`, kind: 'cex', exchange, base, quote: USDT, volume, ...extra })

// Live 11-20 numbers: Bitget BTCUSDT $319M with a $281k bid side; RANTUSDT $102.6B with a $15k ask side.
const venues = {
  binance: [1293e6, 420e6], okx: [515e6, 210e6], coinbase: [813e6, 400e6], bybit: [998e6, 300e6],
  bitget: [319e6, 150e6], kraken: [274e6, 120e6],
}
function liveLike() {
  const rows = []
  for (const [exchange, [btc, eth]] of Object.entries(venues)) {
    rows.push(cex(exchange, BTC, btc, { bookUsd: 281_000 }), cex(exchange, ETH, eth, { bookUsd: 90_000 }))
    rows.push(cex(exchange, 'solana:native', eth / 3), { ...cex(exchange, 'usdc:x', btc * 0.8), id: `cex:${exchange}:USDC-USDT` })
  }
  return rows
}

test('a RANT-like row is flagged and no major pair at the six venues is', () => {
  const rows = [...liveLike(),
    cex('bitget', 'unresolved:bitget:RANT', 102.6e9, { bookUsd: 15_000 }),
    cex('bitget', 'unresolved:bitget:RXYZ', 51e6, { stock: true })]
  const flagged = volumeSuspects(rows)
  assert.equal(flagged.get('cex:bitget:RANT-USDT').reason, 'unconfirmed')
  assert.deepEqual(flagged.get('cex:bitget:RANT-USDT').checks, ['venue-majors', 'book-depth'])
  // Venue metadata labels a tokenized stock whatever its size: the number is the underlying equity's.
  assert.equal(flagged.get('cex:bitget:RXYZ-USDT').reason, 'underlying-stock')
  assert.match(flagged.get('cex:bitget:RXYZ-USDT').note, /underlying stock market's volume/)
  assert.equal(flagged.size, 2)
})

test('book depth alone flags an unresolved pair; one check is enough to need confirmation', () => {
  const rows = [...liveLike(), cex('bitget', 'unresolved:bitget:ZZZ', 2e9, { bookUsd: 1_000 })]
  assert.deepEqual(volumeSuspects(rows).get('cex:bitget:ZZZ-USDT')?.checks, ['book-depth'])
  // The same volume with a book that can carry it is not out of line (2e9 < 10 × 319M at Bitget).
  assert.equal(volumeSuspects([...liveLike(), cex('bitget', 'unresolved:bitget:ZZZ', 2e9, { bookUsd: 50_000 })]).size, 0)
})

test('a legitimate new giant passes once a second independent venue or DEX turnover confirms it', () => {
  const giant = 'base:0xgiant'
  const alone = [...liveLike(), cex('binance', giant, 40e9)]
  assert.equal(volumeSuspects(alone).get('cex:binance:0xgiant-USDT')?.reason, 'unconfirmed')
  // Minutes later a second venue lists it with a quarter of the volume: confirmed.
  assert.equal(volumeSuspects([...alone, cex('okx', giant, 10e9)]).size, 0)
  // Or two venues with a twentieth each.
  assert.equal(volumeSuspects([...alone, cex('okx', giant, 2e9), cex('bybit', giant, 2e9)]).size, 0)
  assert.equal(volumeSuspects([...alone, cex('okx', giant, 2e9)]).size, 1)
  // Or its DEX pools together (one source).
  const pools = [1, 2, 3].map(i => ({ id: `dex:base:0xpool${i}`, kind: 'dex', exchange: 'uniswap-v3', base: giant, quote: USDT, volume: 4e9 }))
  assert.equal(volumeSuspects([...alone, ...pools]).size, 0)
  // The same exchange's other pair is not independent: both stay flagged.
  assert.equal(volumeSuspects([...alone, { ...cex('binance', giant, 30e9), id: 'cex:binance:0xgiant-USDC' }]).size, 2)
})

test('a stablecoin on-ramp pair larger than the venue\'s BTC pair is not out of line with the venue', () => {
  // A one-venue world: USDT/TRY at 25x the venue's BTC pair, nothing to confirm it.
  const rows = [cex('btcturk', BTC, 2e5), { ...cex('btcturk', USDT, 5e6, { stable: true }), id: 'cex:btcturk:USDT-TRY' }]
  assert.equal(volumeSuspects(rows).size, 0)
  assert.deepEqual(volumeSuspects([rows[0], { ...rows[1], stable: false }]).get('cex:btcturk:USDT-TRY').checks, ['venue-majors'])
  // A fake stable with a tiny cap is still caught by the cap check.
  assert.deepEqual(volumeSuspects(rows, { capUsd: () => 1e5 }).get('cex:btcturk:USDT-TRY').checks, ['market-cap'])
})

test('market-cap turnover flags a resolved base the venue cannot confirm', () => {
  const rows = [...liveLike(), cex('bitget', 'ethereum:0xsmall', 3e8)]
  assert.equal(volumeSuspects(rows).size, 0)
  const flagged = volumeSuspects(rows, { capUsd: id => (id === 'ethereum:0xsmall' ? 1e7 : null) })
  assert.deepEqual(flagged.get('cex:bitget:0xsmall-USDT').checks, ['market-cap'])
  assert.equal(VOLUME_GUARD.capTurnoverMultiple, 20)
})

test('flagged rows sort after counted ones, each by reported volume', () => {
  const rows = [{ id: 'a', volume24h: 5 }, { id: 'b', volume24h: 9e10, volumeSuspect: 'unconfirmed' },
    { id: 'c', volume24h: 50 }, { id: 'd', volume24h: 1e9, volumeSuspect: 'underlying-stock' }, { id: 'e', volume24h: null }]
  assert.deepEqual(rows.sort(volumeOrder).map(r => r.id), ['c', 'a', 'e', 'b', 'd'])
})

test('the asset 24 h volume leaves a flagged market out and caps its median weight', () => {
  const assets = new Map([['x:native', { id: 'x:native', address: 'native' }]])
  const market = (id, exchange, price, usdVolume) => ({ id, kind: 'cex', exchange, base: 'x:native', quote: 'fiat:USD',
    price, priceText: String(price), usdVolume, baseVolume: usdVolume / price, at: 1000, window: 60_000, spread: 0,
    agents: ['k'], provenAgents: ['k'], ownFresh: true })
  const rows = [market('cex:a:X-USD', 'a', 10, 1e6), market('cex:b:X-USD', 'b', 10.2, 2e6), market('cex:c:X-USD', 'c', 10.4, 5e10)]
  const plain = aggregateAssets(assets, rows, 1000).get('x:native')
  assert.equal(plain.price, 10.4)
  const guarded = aggregateAssets(assets, rows, 1000, new Map(), { suspects: new Map([['cex:c:X-USD', {}]]) }).get('x:native')
  assert.equal(guarded.volume24h, 3e6)
  assert.equal(guarded.price, 10.2)
  assert.equal(guarded.why.provenVolume24h, 3e6)
  assert.equal(guarded.why.suspectVolume24h, 5e10)
})

test('top-of-book sizes come from the venue row where it carries them', () => {
  assert.deepEqual(bookSizes('bitget', { bidSz: '6', askSz: '165' }), ['6', '165'])
  assert.deepEqual(bookSizes('binance', { bidQty: '1.5', askQty: '2' }), ['1.5', '2'])
  assert.deepEqual(bookSizes('kraken', { b: ['1', '1', '3.5'], a: ['2', '1', '4'] }), ['3.5', '4'])
  assert.equal(bookSizes('gate', { last: '1' }), null)
  assert.equal(Math.round(bookQuote('91.31', '91.41', ['6', '165'])), 15083)
  assert.equal(bookQuote('1', '1', null), null)
})
