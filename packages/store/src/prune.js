import { comparisonHistory } from './comparison-history.js';
import { archiveWriter } from './observation-archive.js';
import { DAY, MINUTE } from './candles.js';
import { MARKET_POLICY } from './markets.js';
import { limitsFor } from './profile.js';
import { integer } from './values.js';

// fitBudget is also called directly by harnesses enforcing a lower local cap.
const evictors = new WeakMap();

function registerEvictor(writer, fn) {
  if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') throw new TypeError('Expected a synchronous evictor');
  let hooks = evictors.get(writer);
  if (!hooks) evictors.set(writer, hooks = new Set());
  hooks.add(fn);
  return () => hooks.delete(fn);
}

const lifetime = [['1m', DAY, MINUTE], ['5m', 7 * DAY, 5 * MINUTE], ['1h', 90 * DAY, 60 * MINUTE]];

function liveBytes(db) {
  const { bytes } = db.prepare(`SELECT (page_count - freelist_count) * page_size AS bytes
    FROM pragma_page_count, pragma_freelist_count, pragma_page_size`).get();
  return bytes;
}

export const RAW_AGE = 2 * 60 * MINUTE;
const BATCH = 2048;
const PRESSURE_BATCH = 256;
const VACUUM_PAGES = 1024;
// Leave room for the next sampling/maintenance interval below the 300 MB node target.
// This limit applies exclusively to dispensable raw evidence.
const RAW_WATERMARK = 285_000_000;
const STEADY_BYTES = 295_000_000;
const rawStatements = new WeakMap();

function rawQueries(db) {
  if (rawStatements.has(db)) return rawStatements.get(db);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(r => r.name));
  const references = [['engine_latest','obsId'], ['engine_checks','obsId'], ['engine_spot_checks','localId']]
    .filter(([name]) => tables.has(name));
  const guards = refs => refs.map(([name,key]) => `AND NOT EXISTS (SELECT 1 FROM ${name} WHERE ${key}=o.id)`).join(' ');
  const candidates = db.prepare(`SELECT o.id,coalesce(o.lastTs,o.srcTs) AS until FROM obs o
    WHERE o.srcTs<?1 AND coalesce(o.lastTs,o.srcTs)<?1 ${guards(references)} ORDER BY o.srcTs LIMIT ?2`);
  const erase = db.prepare('DELETE FROM obs WHERE id=?');
  const floor = db.prepare('UPDATE store_retention SET obsFrom=?1 WHERE obsFrom<?1');
  const tails = db.prepare(`SELECT o.id,o.lastTs AS until FROM obs o WHERE o.lastTs<? AND o.ordinal>0
    ${guards(references.filter(([name]) => name !== 'engine_latest'))} ORDER BY o.srcTs LIMIT ?`);
  const cut = db.prepare('UPDATE obs SET srcTs=lastTs,lastTs=NULL,ticks=NULL,ordinal=0 WHERE id=?');
  const unlink = db.prepare('DELETE FROM store_obs_slice WHERE obsId=?');
  const dequeue = db.prepare('DELETE FROM store_obs_pending WHERE obsId=?');
  const queries = { candidates, erase, floor, tails, cut, unlink, dequeue };
  rawStatements.set(db, queries);
  return queries;
}

function removeRaw(db, before, limit, preserveFrom) {
  const { candidates, erase } = rawQueries(db);
  const rows = candidates.all(before, limit);
  if (preserveFrom !== undefined) comparisonHistory(db).preserve(rows, preserveFrom);
  for (const { id } of rows) erase.run(id);
  return rows.length;
}

// Once wholly unreferenced spans are exhausted, a latest pointer still needs its current
// receipt. Its unchecked tail can make room without changing the row ID, price or freshness.
function relieveRaw(db, target, now, limit) {
  const cutoff = Math.max(0, now - RAW_AGE - 30_000);
  const removed = removeRaw(db, now + 1, limit, cutoff);
  let count = removed;
  const q = rawQueries(db);
  if (count < limit && liveBytes(db) > target) {
    const tails = q.tails.all(now - 30_000, limit - count);
    comparisonHistory(db).preserve(tails, cutoff);
    for (const { id } of tails) {
      q.unlink.run(id);
      q.dequeue.run(id);
      q.cut.run(id);
      count++;
    }
  }
  return { removed, worked: count, full: count === limit };
}

function expireObservations(db, now, limit) {
  const cutoff = Math.max(0, now - RAW_AGE);
  rawQueries(db).floor.run(cutoff);
  comparisonHistory(db).expire(Math.max(0, cutoff - 30_000));
  return removeRaw(db, Math.max(0, cutoff - 30_000), limit);
}

// Protect both persisted visibility and its one-hour freshness limit at the time of pruning.
const liveAssets = `SELECT p.asset FROM prices p JOIN store_market_list s ON s.asset=p.asset
  WHERE s.visibility='live' AND p.at>=?`;

/** Each call releases at most one batch of raw quotes. Other eviction tiers wait until raw is exhausted. */
export function fitBudget(db, targetBytes, now, limit = PRESSURE_BATCH) {
  let bytes = liveBytes(db), obs = 0, candles = 0;
  if (bytes > targetBytes) {
    const batch = relieveRaw(db, targetBytes, now, limit);
    obs = batch.removed;
    bytes = liveBytes(db);
    const archive = archiveWriter(db);
    if (!batch.full && bytes > targetBytes && archive.hasSparse()) {
      archive.pack(true);
      bytes = liveBytes(db);
    }
    if (bytes > targetBytes && (batch.full || archive.hasSparse())) {
      return { obs, candles, liveBytes: bytes, overBudgetBytes: bytes - targetBytes, moreRaw: true };
    }
  }
  for (const evict of evictors.get(db) ?? []) {
    while (bytes > targetBytes) {
      const removed = evict(db, { now, targetBytes, liveBytes: bytes });
      if (!Number.isSafeInteger(removed) || removed < 0) throw new TypeError('Expected number of evicted rows');
      if (!removed) break;
      bytes = liveBytes(db);
    }
  }
  if (bytes > targetBytes) {
    const candidates = db.prepare(`SELECT id FROM assets a
      WHERE NOT EXISTS (SELECT 1 FROM watchlist WHERE asset=a.id)
      AND NOT EXISTS (SELECT 1 FROM portfolio WHERE asset=a.id)
      AND a.id NOT IN (${liveAssets})
      AND EXISTS (SELECT 1 FROM candles WHERE asset=a.id)
      ORDER BY a.views, a.rank DESC NULLS FIRST, a.id DESC`).all(now - MARKET_POLICY.maxPriceAge);
    const evict = db.prepare('DELETE FROM candles WHERE asset=?');
    for (const { id } of candidates) {
      candles += evict.run(id).changes;
      bytes = liveBytes(db);
      if (bytes <= targetBytes) break;
    }
  }
  return { obs, candles, liveBytes: bytes, overBudgetBytes: Math.max(0, bytes - targetBytes) };
}

/** @param {import('./database.js').StoreDatabase} db */
export function pruneAccessors({ writer, transaction, profile: defaultProfile, close }) {
  const hooks = new Set();
  const archive = archiveWriter(writer);
  // The (asset,tf,ts) primary key can expire each asset's time range directly. A second
  // time index would also store the full asset ID alongside every candle at every resolution.
  const expire = writer.prepare('DELETE FROM candles WHERE asset IN (SELECT id FROM assets) AND tf=? AND ts<?');
  const cap = writer.prepare(`WITH kept(asset) AS (
    SELECT id FROM (SELECT id FROM assets ORDER BY views DESC, rank NULLS LAST, id LIMIT ?)
    UNION SELECT asset FROM watchlist UNION SELECT asset FROM portfolio UNION ${liveAssets}
  ) DELETE FROM candles WHERE asset NOT IN (SELECT asset FROM kept)`);
  const hasPosts = writer.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='posts'");

  let nextRawPass = null, continuation, backlog = false;
  const free = writer.prepare('PRAGMA freelist_count');
  // Evicting most of a time range can leave the market/reporter index half empty
  // even after every completely free page has been vacuumed. Inspect only a small
  // index and rebuild it only when the rebuild can recover several MiB.
  const hasPageStats = writer.prepare('PRAGMA module_list').all().some(row => row.name === 'dbstat');
  const indexSpace = hasPageStats &&
    writer.prepare(`SELECT count(*) AS pages,sum(ncell) AS entries,sum(unused) AS unused,sum(pgsize) AS bytes
      FROM (SELECT ncell,unused,pgsize FROM dbstat WHERE name='sqlite_autoindex_obs_1' LIMIT 6145)`);
  let nextIndexCheck = -Infinity;
  function compactQuoteIndex(now, bytes) {
    if (!indexSpace || now < nextIndexCheck || bytes <= RAW_WATERMARK || bytes > 350_000_000) return;
    nextIndexCheck = now + 60 * MINUTE;
    const index = indexSpace.get();
    if (index.pages <= 6144 && index.bytes <= 24 * 1024 ** 2 && index.entries <= 125_000 && index.unused > 2 * 1024 ** 2 &&
        index.unused > index.bytes * 0.35) writer.exec('REINDEX sqlite_autoindex_obs_1');
  }
  // Let bounded row eviction shrink old indexes before releasing their B-trees. Dropping a
  // populated legacy index during startup can otherwise touch hundreds of MiB in one commit.
  const obsolete = writer.prepare(`SELECT name FROM sqlite_schema WHERE type='index'
    AND name IN ('obs_market_time','engine_pending_usd')`);
  const smallIndex = hasPageStats && writer.prepare(`SELECT count(*) AS pages,coalesce(sum(pgsize),0) AS bytes FROM
    (SELECT pgsize FROM dbstat WHERE name=? LIMIT 2049)`);
  const pastSmallTable = writer.prepare('SELECT id FROM obs LIMIT 1 OFFSET 1024');
  const upgrading = !!obsolete.get();
  let slice = upgrading ? 16 : BATCH;
  function retireOldIndexes() {
    for (const { name } of obsolete.all()) {
      const stat = smallIndex && smallIndex.get(name);
      if (stat ? stat.pages > 2048 || stat.bytes > 8 * 1024 ** 2 : pastSmallTable.get()) continue;
      writer.exec(`DROP INDEX ${name}`);
    }
  }
  const expiredCounts = writer.prepare('DELETE FROM store_report_activity WHERE at<?');
  const expiredReporters = writer.prepare('DELETE FROM store_reporters_seen WHERE at<?');
  function vacuum() {
    writer.exec(`PRAGMA incremental_vacuum(${VACUUM_PAGES})`);
  }
  function rawPass(now) {
    const started = performance.now(), limit = slice;
    let removed = expireObservations(writer, now, limit), worked = removed;
    // First recover holes left in shared compressed groups. Deleting newer usable
    // history before this space becomes reusable would needlessly shorten the window.
    backlog = removed === limit;
    const sparse = archive.hasSparse();
    if (sparse) archive.pack(true);
    if (removed < limit && !archive.hasSparse() && liveBytes(writer) > RAW_WATERMARK) {
      const batch = relieveRaw(writer, RAW_WATERMARK, now, Math.min(PRESSURE_BATCH, limit - removed));
      removed += batch.removed;
      worked += batch.worked;
      backlog ||= batch.full;
    }
    if (worked && !sparse) archive.pack();
    if (!worked && !sparse) {
      retireOldIndexes();
      compactQuoteIndex(now, liveBytes(writer));
    }
    // A cold legacy B-tree can make the first random deletes much slower than later ones.
    if (upgrading && worked) {
      const elapsed = performance.now() - started;
      if (elapsed > 150) slice = Math.max(16, Math.floor(limit / 2));
      else if (elapsed < 60) slice = Math.min(BATCH, limit * 2);
    }
    nextRawPass = now + (backlog || archive.hasSparse() ? backlogGap() : MINUTE);
    return removed;
  }
  // Reclaim at most ~25% of the main thread: the next backlog pass waits three times as long as the last one took
  // (a 4 GB upgrade on the owner's node otherwise kept the thread 93% busy and dashboard reads timed out).
  let lastPassMs = 0;
  const backlogGap = () => Math.max(250, Math.round(lastPassMs * 3));
  const timed = (fn) => {
    const started = performance.now();
    try { return fn(); } finally { lastPassMs = performance.now() - started; }
  };
  // Yield the writer between slices. Large upgrades continue to reclaim space even while the feed is quiet.
  function reclaimLater(now, targetBytes) {
    if (continuation) return;
    continuation = setTimeout(() => {
      continuation = undefined;
      try {
        const more = timed(() => transaction(() => {
          rawPass(now);
          if (!backlog) backlog = !!fitBudget(writer, targetBytes, now, Math.min(slice, PRESSURE_BATCH)).moreRaw;
          vacuum();
          return backlog;
        }));
        if (more || archive.hasSparse() || free.get().freelist_count > 0) reclaimLater(now, targetBytes);
      } catch { process.emitWarning('Store reclamation deferred until the next prune'); }
    }, backlogGap());
    continuation.unref();
  }
  return {
    close() { clearTimeout(continuation); close(); },
    maintainObservations(now) {
      if (nextRawPass === null) { nextRawPass = now + MINUTE; return; }
      if (now < nextRawPass) return;
      timed(() => transaction(() => {
        rawPass(now);
        if (!backlog && !archive.hasSparse() && liveBytes(writer) > STEADY_BYTES) {
          fitBudget(writer, STEADY_BYTES, now, Math.min(slice, PRESSURE_BATCH));
        }
        vacuum();
      }));
      // rawPass planned its next run before the pass finished; apply the measured duty cycle.
      if (backlog || archive.hasSparse()) nextRawPass = Math.max(nextRawPass, now + backlogGap());
    },
    /** Remove a bounded batch under byte pressure. Return the number removed or zero at the protected floor. */
    onEvict(fn) { return registerEvictor(writer, fn); },
    /** Register a package-owned synchronous pruning hook. Returns an unregister function. */
    onPrune(fn) {
      if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') {
        throw new TypeError('Expected a synchronous pruning hook');
      }
      hooks.add(fn);
      return () => hooks.delete(fn);
    },
    prune({ now = Date.now(), profile = defaultProfile } = {}) {
      integer(now, 'now');
      const limits = limitsFor(profile);
      const targetBytes = limits.storeBudgetMB * 1024 ** 2;
      const steadyTarget = Math.min(targetBytes, STEADY_BYTES);
      const result = transaction(() => {
        const obs = rawPass(now);
        expiredCounts.run(Math.floor((now - 60 * MINUTE) / 1000) * 1000);
        expiredReporters.run(now - DAY);
        let candles = 0;
        for (const [tf, age, width] of lifetime) {
          const cutoff = Math.max(0, now - age);
          candles += expire.run(tf, cutoff - cutoff % width).changes;
        }
        candles += cap.run(limits.keptAssets, now - MARKET_POLICY.maxPriceAge).changes;
        const postsBefore = Math.max(0, now - 30 * DAY);
        const posts = hasPosts.get() ? writer.prepare(
          "DELETE FROM posts WHERE ts < ? AND channel <> 'soc/official'").run(postsBefore).changes : 0;
        for (const hook of hooks) {
          if (typeof hook(writer, { now, profile, limits, postsBefore })?.then === 'function') {
            throw new TypeError('Pruning hook returned a promise');
          }
        }

        const pressure = backlog ? { obs: 0, candles: 0 } :
          fitBudget(writer, steadyTarget, now, Math.min(slice, PRESSURE_BATCH));
        backlog ||= !!pressure.moreRaw;
        vacuum();
        const bytes = liveBytes(writer);
        return { obs: obs + pressure.obs, candles: candles + pressure.candles, posts,
          liveBytes: bytes, overBudgetBytes: Math.max(0, bytes - targetBytes) };
      });
      if (backlog || archive.hasSparse() || free.get().freelist_count > 0) reclaimLater(now, steadyTarget);
      return result;
    },
  };
}
