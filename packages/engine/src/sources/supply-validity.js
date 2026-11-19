import { DAY } from './supply-api.js'

const age = { 'chain-circulating': 4 * DAY, 'issuer-circulating': 4 * DAY, 'net-issuance': 7 * DAY }
export const expires = row => row.expiresAt ?? row.at + (age[row.method] ?? 2 * DAY)

/** Retire a local circulating measurement from every persisted valuation input. Keep independently
 * measured totals and quantities supplied by another source. Only local-supply owns these claims. */
export function supplyValidity(engine, local) {
  const { store, registry, book, clock } = engine
  const del = store.writer.prepare("DELETE FROM claims WHERE asset=? AND kind='supply' AND reporter='local-supply'")
  const clear = store.writer.prepare('UPDATE engine_asset_data SET supply=NULL WHERE asset=? AND supply=?')
  const clearPrice = store.writer.prepare('UPDATE prices SET marketCap=NULL WHERE asset=?')
  let deadline = Infinity, timer, signal

  function invalidate(id, matches) {
    const row = local.get(id)?.circulating
    if (!row || !matches(row)) return
    const asset = registry.assets.get(id), value = Number(row.value)
    store.transaction(() => {
      del.run(id)
      if (asset?.supply === value) {
        clear.run(id, value)
        clearPrice.run(id)
      }
    })
    if (asset?.supply === value) asset.supply = null
    delete local.get(id).circulating
    book.dirty = true
  }

  function disarm() {
    clearTimeout(timer)
    timer = null
  }
  function arm() {
    if (timer || !Number.isFinite(deadline) || !engine.active || engine.abort?.signal.aborted) return
    if (signal !== engine.abort.signal) {
      signal = engine.abort.signal
      signal.addEventListener('abort', disarm, { once: true })
    }
    // A monthly issuer report can have more than 2^31-1 ms left to live.
    timer = setTimeout(() => { timer = null; expire() }, Math.min(2 ** 31 - 1, Math.max(1, deadline - clock())))
    timer.unref()
  }
  function expire() {
    const now = clock()
    if (deadline <= now) {
      disarm()
      deadline = Infinity
      for (const [id, records] of local) {
        const row = records.circulating
        if (!row) continue
        if (!(expires(row) > now)) invalidate(id, () => true)
        else deadline = Math.min(deadline, expires(row))
      }
    }
    arm()
  }
  function watch(row) {
    if (row && expires(row) < deadline) {
      deadline = expires(row)
      disarm()
    }
    expire()
  }
  // Every valuation entry point calls book.refresh(), including its one-second cache hit. Expire
  // the inputs before that call: timers can run late after sleep or during a synchronous request.
  const refresh = book.refresh.bind(book)
  book.refresh = () => {
    expire()
    return refresh()
  }
  // Sweep restored evidence before the first book refresh, even when background fetching is disabled.
  deadline = -Infinity
  expire()
  return { watch, expire, invalidate }
}
