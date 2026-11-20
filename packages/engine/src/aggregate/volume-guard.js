// Venue-reported 24 h volume that independent evidence does not support (DESIGN §5.3 "Volume plausibility").
//
// Live 11-20: Bitget's ticker reported RANTUSDT quoteVolume 102.6B USDT (994M units at ~$91) while its BTCUSDT read 319M;
// its tokenized-stock pairs (catalog `areaSymbol: "yes"`, base coin `rANT`, `rSPY`, …) carry the underlying equity's
// exchange volume (RSPY $50.9B ≈ SPY daily, RNVDA $34B ≈ NVDA). 3,076 such rows summed $944B of USDT's $980B.
//
// The guard never hides or alters a number: a flagged market stays listed with its reported volume. It only leaves volume
// totals, shares, volume sorting, the asset's 24 h volume (and so gainers/losers/trending) and venue volume rankings,
// and its weight in the price median is capped at the largest unflagged market's volume. It is confirmation-based, not
// size-based: a market is flagged only when it is out of line with the venue's own majors, its order book or the base
// asset's value AND no independent source confirms comparable turnover. A real new giant passes as soon as one other
// venue (or the asset's DEX pools together) reports a quarter of its volume, or two others a twentieth each.
// Local computation only: nothing here changes the wire.

/** Thresholds (local; no root-signed engine setting carries them yet). */
export const VOLUME_GUARD = Object.freeze({
  // (b) Out of line with the venue: more than this multiple of the venue's own largest BTC/ETH pair. Stablecoin bases
  // skip it: on-ramp pairs (USDT/TRY, USDT/BRL, USDT/USD) can dwarf a venue's BTC pair; (c) and (d) still apply.
  venueMajorMultiple: 10,
  // (c) Out of line with the book: more than this multiple of the larger top-of-book side (price × size, USD).
  // Live 11-20: Bitget BTCUSDT 1,135× ($281k bid side, $319M/day); RANTUSDT 6.6 million× ($15k ask side, $102B/day).
  bookTurnoverMultiple: 1_000_000,
  // (d) Out of line with the asset: more than this multiple of the base asset's market cap in one day.
  capTurnoverMultiple: 20,
  // (a) Confirmation by independent sources trading the same resolved asset (another exchange; all DEX pools as one).
  confirmOneShare: 0.25,
  confirmTwoShare: 0.05,
})

/** Bases whose pairs define a venue's own scale for (b). */
export const MAJOR_BASES = new Set(['bitcoin:native', 'ethereum:native'])

/** Reason codes and their plain words for the dashboard and API. */
export const SUSPECT_REASONS = Object.freeze({
  'underlying-stock': 'The venue lists this pair as a tokenized stock and reports the underlying stock market\'s volume, not trading on this venue.',
  unconfirmed: 'Reported volume is out of line and no other venue confirms it, so it is left out of totals, shares and volume ranking.',
})

const unresolved = id => typeof id !== 'string' || id.startsWith('unresolved:')

/**
 * @typedef {{ id: string, kind: string, exchange?: string|null, base: string, quote: string, volume: number|null,
 *   stock?: boolean, stable?: boolean, bookUsd?: number|null }} GuardMarket
 * @typedef {{ reason: 'underlying-stock'|'unconfirmed', checks: string[], note: string }} Suspect
 */

/**
 * Markets whose reported 24 h USD volume the node does not count.
 * @param {Iterable<GuardMarket>} markets every observed market with its USD volume (null when unknown)
 * @param {{ capUsd?: (asset: string) => number|null|undefined, settings?: typeof VOLUME_GUARD }} [options]
 * @returns {Map<string, Suspect>}
 */
export function volumeSuspects(markets, { capUsd, settings = VOLUME_GUARD } = {}) {
  const list = [...markets]
  const majors = new Map(), sources = new Map()
  for (const m of list) {
    if (!(m.volume > 0)) continue
    if (m.kind === 'cex' && MAJOR_BASES.has(m.base) && !m.stock)
      majors.set(m.exchange, Math.max(majors.get(m.exchange) ?? 0, m.volume))
    if (unresolved(m.base) || m.stock) continue
    const source = m.kind === 'dex' ? 'dex' : m.exchange ?? m.id
    if (!sources.has(m.base)) sources.set(m.base, new Map())
    const bySource = sources.get(m.base)
    bySource.set(source, (bySource.get(source) ?? 0) + m.volume)
  }
  const result = new Map()
  for (const m of list) {
    if (m.kind !== 'cex' || !(m.volume > 0)) continue
    if (m.stock) {
      result.set(m.id, { reason: 'underlying-stock', checks: ['venue-metadata'], note: SUSPECT_REASONS['underlying-stock'] })
      continue
    }
    const checks = []
    const major = majors.get(m.exchange)
    if (!MAJOR_BASES.has(m.base) && !m.stable && major > 0 && m.volume > settings.venueMajorMultiple * major)
      checks.push('venue-majors')
    if (m.bookUsd > 0 && m.volume > settings.bookTurnoverMultiple * m.bookUsd) checks.push('book-depth')
    const cap = unresolved(m.base) ? null : capUsd?.(m.base)
    if (cap > 0 && m.volume > settings.capTurnoverMultiple * cap) checks.push('market-cap')
    if (!checks.length || confirmed(m, sources.get(m.base), settings)) continue
    result.set(m.id, { reason: 'unconfirmed', checks, note: SUSPECT_REASONS.unconfirmed })
  }
  return result
}

/** Other independent sources of the same resolved asset report comparable turnover. */
function confirmed(m, bySource, settings) {
  if (unresolved(m.base) || !bySource) return false
  let comparable = 0
  for (const [source, volume] of bySource) {
    if (source === m.exchange) continue
    if (volume >= settings.confirmOneShare * m.volume) return true
    if (volume >= settings.confirmTwoShare * m.volume && ++comparable >= 2) return true
  }
  return false
}

/** Market rows by 24 h volume, counted volumes first, flagged ones after them (each by reported volume), then by ID. */
export function volumeOrder(a, b) {
  return (!!a.volumeSuspect - !!b.volumeSuspect) || ((b.volume24h ?? -1) - (a.volume24h ?? -1)) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}
