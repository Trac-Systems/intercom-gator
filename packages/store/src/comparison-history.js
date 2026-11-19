import { createHash } from 'node:crypto';
import { archiveReader, packHistory, unpackHistory } from './observation-archive.js';
import { previousTick, receipts } from './observation-codec.js';

// Under byte pressure a superseded full quote can retire. Preserve the exact price, order
// and timestamps needed to match late peer claims for the rest of the two-hour window.
const pairKey = (market, reporter) => createHash('sha256').update(JSON.stringify([market, reporter])).digest().subarray(0, 8);
const historyByDb = new WeakMap();

export function comparisonHistory(db) {
  if (historyByDb.has(db)) return historyByDb.get(db);
  const archived = db.prepare('SELECT archivedThrough FROM store_obs_clock');
  const mark = db.prepare('UPDATE store_obs_clock SET archivedThrough=max(archivedThrough,?)');
  const insert = db.prepare('INSERT INTO store_obs_comparisons(firstTs,lastTs,data) VALUES (?,?,?)');
  const link = db.prepare('INSERT OR IGNORE INTO store_obs_comparison_keys VALUES (?,?)');
  const candidates = db.prepare(`SELECT b.data FROM store_obs_comparison_keys k JOIN store_obs_comparisons b ON b.id=k.batch
    WHERE k.pair=? AND b.firstTs<=? AND b.lastTs>=?`);
  const span = db.prepare(`SELECT o.id,market,reporter,coalesce(lastTs,srcTs) AS srcTs,at,
    coalesce(seq,id) AS seq,price,bid,ask,ordinal,ticks,archive,archiveOffset,archiveLength
    FROM obs o LEFT JOIN store_obs_slice s ON s.obsId=o.id WHERE o.id=?`);
  const read = archiveReader(db);
  const expire = db.prepare('DELETE FROM store_obs_comparisons WHERE lastTs<?');

  function save(headers, parts, length, first, last) {
    const meta = Buffer.from(JSON.stringify(headers));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(meta.length);
    const packed = packHistory(Buffer.concat([prefix, meta, ...parts], 4 + meta.length + length), true);
    const id = insert.run(first, last, packed).lastInsertRowid;
    for (const [market, reporter] of headers) link.run(pairKey(market, reporter), id);
    mark.run(last);
  }

  const history = {
    // This bound is transactional. A caller can roll back an entire prune.
    overlaps(at) { return at <= archived.get().archivedThrough; },
    expire(cutoff) { expire.run(cutoff); },
    preserve(rows, cutoff) {
      let headers = [], parts = [], length = 0, first = Infinity, last = 0;
      const cache = new Map();
      for (const { id, until } of rows) {
        if (until < cutoff) continue;
        const { ticks, ...head } = span.get(id);
        let newer, start = head.srcTs;
        const offset = length;
        for (const r of receipts(head, ticks, read, cache)) {
          if (r.srcTs < cutoff) break;
          if (newer) {
            const delta = previousTick(r, newer, ['price']);
            parts.push(delta);
            length += delta.length;
          }
          newer = r;
          start = r.srcTs;
        }
        headers.push([head.market, head.reporter, head.srcTs, head.at, head.seq, head.price, start, offset, length - offset]);
        first = Math.min(first, start);
        last = Math.max(last, head.srcTs);
        if (length >= 96 * 1024 || headers.length === 256) {
          save(headers, parts, length, first, last);
          headers = [];
          parts = [];
          length = 0;
          first = Infinity;
          last = 0;
        }
      }
      if (headers.length) save(headers, parts, length, first, last);
    },
    *matches(market, reporter, ts, tolerance) {
      const lo = ts - tolerance, hi = ts + tolerance;
      for (const { data } of candidates.iterate(pairKey(market, reporter), hi, lo)) {
        const bytes = unpackHistory(data);
        const end = 4 + bytes.readUInt32LE(0);
        for (const [storedMarket, storedReporter, srcTs, at, seq, price, start, offset, length] of JSON.parse(bytes.toString('utf8', 4, end))) {
          if (storedMarket !== market || storedReporter !== reporter || start > hi || srcTs < lo) continue;
          const head = { market, reporter, srcTs, at, seq, price, ordinal: 0, bid: null, ask: null,
            baseVol24h: null, quoteVol24hUsd: null, priceUsd: null };
          for (const r of receipts(head, bytes.subarray(end + offset, end + offset + length))) {
            if (r.srcTs < lo) break;
            // If this receipt is checked, it will get a new single-receipt row with ordinal zero.
            if (r.srcTs <= hi) yield { ...r, ordinal: 0 };
            if (r.srcTs <= ts) break;
          }
        }
      }
    },
  };
  historyByDb.set(db, history);
  return history;
}
