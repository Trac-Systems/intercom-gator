// Paging for list endpoints. Pure: the fetch function is injected, so it runs in Node for tests.
//
// The API pages lists with ?limit=&offset= (max 500) and answers { items, total? }. The feed pages
// with a cursor instead (?before=<ts>); fetchPage gets the last loaded item for that.
// Rows can move between pages while the node updates prices, so a later page may repeat a row
// already shown: those repeats are dropped (first position wins).

/**
 * @template T
 * @typedef {{ items: T[], total: number|null, done: boolean, loading: boolean, error: Error|null, pages: number }} PagerState
 */

/**
 * @template T
 * @param {(offset: number, limit: number, last: T|undefined) => Promise<{ items?: T[], total?: number }>} fetchPage
 * @param {{ limit?: number, idOf?: (x: T) => unknown }} [opts]
 */
export function createPager(fetchPage, opts = {}) {
  const limit = opts.limit ?? 100;
  const idOf = opts.idOf ?? ((x) => /** @type {any} */ (x)?.id);
  /** @type {PagerState<T>} */
  const state = { items: [], total: null, done: false, loading: false, error: null, pages: 0 };
  const seen = new Set();
  let offset = 0;
  /** @type {Promise<PagerState<T>>|null} */
  let inflight = null;

  /** Load the next page (no-op when done; concurrent calls share one request). */
  function more() {
    if (state.done) return Promise.resolve(state);
    if (inflight) return inflight;
    state.loading = true;
    inflight = (async () => {
      try {
        const r = await fetchPage(offset, limit, state.items[state.items.length - 1]);
        const got = Array.isArray(r?.items) ? r.items : [];
        offset += got.length;
        for (const x of got) {
          const id = idOf(x);
          if (id != null && id !== '') { if (seen.has(id)) continue; seen.add(id); }
          state.items.push(x); // in place: views keep a reference to this array
        }
        if (Number.isFinite(r?.total)) state.total = /** @type {number} */ (r.total);
        state.pages++;
        state.done = got.length < limit || (state.total != null && offset >= state.total);
        state.error = null;
      } catch (e) {
        state.error = /** @type {Error} */ (e);
        throw e;
      } finally {
        state.loading = false;
        inflight = null;
      }
      return state;
    })();
    return inflight;
  }

  return { state, more, limit };
}

/** @typedef {ReturnType<typeof createPager>} Pager */

/**
 * Keeps pagers by key for a short while, so going back to a list keeps the pages you loaded.
 * @param {number} [ttl] ms
 * @param {() => number} [now]
 */
export function pagerCache(ttl = 60000, now = Date.now) {
  /** @type {Map<string, { at: number, pager: Pager }>} */
  const map = new Map();
  return {
    /**
     * @param {string} key
     * @param {() => Pager} make
     * @returns {Pager}
     */
    get(key, make) {
      const hit = map.get(key);
      if (hit && !hit.pager.state.error && now() - hit.at < ttl) { hit.at = now(); return hit.pager; }
      const pager = make();
      map.set(key, { at: now(), pager });
      return pager;
    },
    clear(prefix = '') { for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k); },
  };
}

/**
 * The visible count under a paged list: "100 of 1,435", "240" (more may exist), "All 37".
 * @param {{ items: unknown[], total: number|null, done: boolean }} s
 * @param {(n: number) => string} fmt
 */
export function countText(s, fmt) {
  const n = s.items.length;
  if (s.done) return n ? 'All ' + fmt(n) : '';
  if (s.total != null && s.total > n) return fmt(n) + ' of ' + fmt(s.total);
  return fmt(n) + ' shown';
}
