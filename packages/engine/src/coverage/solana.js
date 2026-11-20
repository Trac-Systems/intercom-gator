import { fetchSolana, recordSolanaPools, solanaPools } from '../sources/solana.js'
import { RateLimited } from '../scheduler/index.js'

const BATCH = { small: 8, normal: 16, large: 32 }
const mint = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/** Exact reads use the venue's own pool endpoint on its signed directory origin. No third-party price feed. */
export async function readSolanaPools(options, pools) {
  const { source, http } = options
  const wanted = new Map(pools.filter(p => mint.test(p.pool)).map(p => [p.pool, p]))
  if (!wanted.size) return
  const raydium = source.id === 'raydium'
  const url = new URL(source.url)
  url.search = ''
  if (raydium) {
    url.pathname = url.pathname.replace(/\/list$/, '/ids')
    url.searchParams.set('ids', [...wanted.keys()].join(','))
  } else url.pathname = url.pathname.replace(/\/$/, '') + '/' + wanted.keys().next().value
  const json = await http.getPublic(url.href, source.rpm)
  const data = raydium ? { data: { data: json?.data } } :
    { data: [source.id === 'orca' ? json?.data : json] }
  const matching = solanaPools(source, data).filter(p => {
    const stored = wanted.get(p.address)
    return stored && ((p.a.address === stored.token0 && p.b.address === stored.token1) ||
      (p.a.address === stored.token1 && p.b.address === stored.token0))
  })
  recordSolanaPools({ ...options, fromHint: true }, matching)
}

export class SolanaCoverage {
  constructor(engine, options) {
    this.engine = engine
    this.options = options
    this.key = 'dex-directory/' + options.source.id
    this.pool = engine.store.reader.prepare('SELECT * FROM pools WHERE chain=? AND pool=? AND dex=?')
  }

  spotCheck(id) {
    const { source, chain } = this.options
    const p = this.pool.get(chain, id.split(':')[2], source.id)
    if (p) return readSolanaPools(this.options, [p])
  }

  async run() {
    const { source } = this.options, { store, dexCoverage } = this.engine
    const roster = dexCoverage.members()
    if (!roster.split) return fetchSolana(this.options)
    const saved = store.getSetting(this.key) ?? {}
    const turn = saved.turn ?? 0
    try {
      await this.collect(roster, saved, turn)
    } catch (error) {
      if (error instanceof RateLimited) throw error
      // A retired pool or cursor cannot hold the directory on a failing turn.
      if (source.id === 'orca' && turn % 4 === 1) saved.cursor = null
      store.setSetting(this.key, { ...saved, turn: turn + 1 })
      throw error
    }
    store.setSetting(this.key, { ...saved, turn: turn + 1 })
  }

  async collect(roster, saved, turn) {
    const { source, chain } = this.options, { profile, dexCoverage } = this.engine
    const discover = turn % 4 === 1
    if (discover && source.url.includes('{page}')) {
      // A short page establishes an upper bound. Let nodes without a page inside it spend
      // their next discovery turn on known pools. Recheck the bound as the directory grows.
      let page = saved.page ?? 2
      const ceiling = saved.until > this.engine.clock() ? saved.last : Infinity
      const end = Math.min(ceiling, page + 63)
      while (page <= end && roster.priority('directory:' + source.id + ':' + page) === null) page++
      if (page <= end) {
        const { count } = await fetchSolana(this.options, page)
        if (count < 100) {
          saved.last = count ? page : page - 1
          saved.until = this.engine.clock() + 30 * 60_000
        }
        saved.page = count === 100 ? page + 1 : 2
        return
      }
      saved.page = page > ceiling ? 2 : page
    }
    // Only the owners of the Orca cursor stream walk its opaque cursor chain. Other signers
    // use that turn for their pool IDs. Everyone still reads the shared first page.
    const walkCursor = discover && source.id === 'orca' && roster.priority('directory:orca:cursor') !== null
    if (turn % 4 !== 0 && !walkCursor) {
      const limit = source.id === 'raydium' ? BATCH[profile] : 1
      const read = await dexCoverage.readPage(chain, source.id, p => p.dex === source.id, limit,
        rows => readSolanaPools(this.options, rows))
      if (read) return
    }
    const result = await fetchSolana(this.options, 1, walkCursor ? saved.cursor : null)
    if (walkCursor || !saved.cursor) saved.cursor = result.cursor
  }
}
