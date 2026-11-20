import { keyPattern } from '../obs/index.js'

const CURSOR = 'dex-coverage/announcements'
const MINUTE = 60_000

/** Revisit persisted announcements that outlived the bounded live verification queue. Only the original verifier
 * can install a market. A price waiting for its identity takes precedence over ordinary local assignments. */
export class StoredDiscoveries {
  constructor(engine) {
    this.engine = engine
    const db = engine.store.reader
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='intel_discoveries'").get()) {
      this.read = db.prepare(`SELECT market,message,reporters FROM intel_discoveries
        WHERE market>? AND market<'dex;' ORDER BY market LIMIT 32`)
      this.any = db.prepare("SELECT 1 FROM intel_discoveries WHERE market>'dex:' AND market<'dex;' LIMIT 1")
    }
    this.next = engine.store.getSetting(CURSOR)?.next ?? 0
  }

  preference(id) {
    const { dexCoverage, pendingDexQuotes, clock } = this.engine
    if (pendingDexQuotes.rows.get(id)?.expires > clock()) return 2
    const roster = dexCoverage.members()
    return Number(roster.split && roster.priority(id) !== null)
  }

  due() {
    const now = this.engine.clock()
    if (!this.read || now < this.next) return false
    if (this.any.get()) return true
    this.next = now + MINUTE
    return false
  }

  enqueue() {
    if (!this.due()) return
    const { store, hints, book, registry, clock, transport, dexCoverage } = this.engine
    const last = store.getSetting(CURSOR)?.market ?? 'dex:'
    const page = this.read.all(last)
    let market = last
    for (const row of page) {
      market = row.market
      if (registry.markets.has(market) || (dexCoverage.members().split && !this.preference(market))) continue
      let signer, best = -Infinity
      for (const k of JSON.parse(row.reporters)) {
        if (!keyPattern.test(k) || k === transport.publicKey || !book.isProven(k)) continue
        const rank = hints.rank(k)
        if (rank >= 0 && rank > best) { signer = k; best = rank }
      }
      if (!signer) continue
      hints.receive(JSON.parse(row.message), signer)
      if (hints.size) break
    }
    const end = page.length < 32 && market === (page.at(-1)?.market ?? last)
    this.next = clock() + (end ? 60 * MINUTE : MINUTE)
    store.setSetting(CURSOR, { market: end ? 'dex:' : market, next: this.next })
  }
}
