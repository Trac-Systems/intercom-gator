import { comparisonHistory } from './comparison-history.js';
import { previousTick, receipts } from './observation-codec.js';
import { reportActivity } from './report-activity.js';
import { archiveReader, archiveWriter } from './observation-archive.js';
import { compareDecimal, decimal, integer, page, timeRange } from './values.js';

// Keep searchable spans short. The size limit bounds both a point lookup and SQLite page churn.
export const OBS_SPAN_MS = 30 * 60_000;
const BLOCK_BYTES = 2048;
const fields = ['price', 'bid', 'ask', 'priceUsd', 'baseVol24h', 'quoteVol24hUsd'];
const quoteFields = ['price', 'bid', 'ask'];
const header = 'id,market,reporter,coalesce(lastTs,srcTs) AS srcTs,at,price,bid,ask,priceUsd,baseVol24h,quoteVol24hUsd,coalesce(seq,id) AS seq,obs.srcTs AS firstTs,ordinal,archive,archiveOffset,archiveLength';
const sameQuote = (a, b) => quoteFields.every(k =>
  a[k] === b[k] || (a[k] != null && b[k] != null && compareDecimal(a[k], b[k]) === 0));
const slices = 'LEFT JOIN store_obs_slice a ON a.obsId=obs.id';
/** Spans retain source receipts for exact comparisons. Only the current receipt needs rolling volume and FX. */
export function observationAccessors({ writer, reader, transaction }) {
  const history = comparisonHistory(writer);
  const activity = reportActivity({ writer, reader, transaction });
  // A source receipt has a stable ordinal inside its span. Each comparison needs one bit.
  const wasChecked = (bits, n) => !!(bits?.[Math.floor(n / 8)] & (1 << (n % 8)));
  writer.function('receipt_checked', { deterministic: true }, (bits, n) => Number(wasChecked(bits, n)));
  writer.function('mark_receipt', { deterministic: true }, (bits, n) => {
    const byte = Math.floor(n / 8);
    const marked = Buffer.alloc(Math.max(byte + 1, bits?.length ?? 0));
    if (bits) marked.set(bits);
    marked[byte] |= 1 << (n % 8);
    return marked;
  });
  const { pack } = archiveWriter(writer), read = archiveReader(reader), readPending = archiveReader(writer);
  const latest = writer.prepare(`SELECT ${header},coalesce(length(ticks),0)+coalesce(archiveLength,0) AS bytes FROM obs ${slices}
    WHERE market=?1 AND reporter=?2 AND obs.srcTs >=
      (SELECT max(srcTs) FROM obs WHERE market=?1 AND reporter=?2)-${OBS_SPAN_MS}
    ORDER BY coalesce(lastTs,obs.srcTs) DESC LIMIT 1`);
  const insert = writer.prepare(`INSERT INTO obs(market,reporter,srcTs,at,price,bid,ask,priceUsd,baseVol24h,quoteVol24hUsd,seq)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const extend = writer.prepare(`UPDATE obs SET ordinal=ordinal+1,lastTs=?,at=?,price=?,bid=?,ask=?,
    priceUsd=?,baseVol24h=?,quoteVol24hUsd=?,seq=?,ticks=CAST(? || coalesce(ticks,x'') AS BLOB) WHERE id=?`);
  // Older partial engine schemas also open through the store during a staged upgrade.
  const hasChecks = writer.prepare("SELECT 1 FROM pragma_table_info('engine_checks') WHERE name='hits'").get();
  const checked = hasChecks && reader.prepare(`SELECT hits FROM engine_checks WHERE obsId=?1
    UNION ALL SELECT hits FROM engine_spot_checks WHERE localId=?1`);
  const spans = writer.prepare(`SELECT ${header},ticks FROM obs ${slices} WHERE market=? AND reporter=?
    AND obs.srcTs BETWEEN ? AND ? AND coalesce(lastTs,obs.srcTs)>=?`);
  const checkedSpans = hasChecks && reader.prepare(`SELECT ${header},ticks,c.hits FROM obs ${slices} JOIN engine_checks c ON c.obsId=obs.id
    WHERE market=? AND reporter=? AND obs.srcTs BETWEEN ? AND ? AND coalesce(lastTs,obs.srcTs)>=?`);
  const raw = reader.prepare(`SELECT ${header},ticks FROM obs ${slices} WHERE market=? AND obs.srcTs>=? AND obs.srcTs<?
    AND coalesce(lastTs,obs.srcTs)>=? ORDER BY obs.srcTs,id`);
  const state = writer.prepare('SELECT obsFrom,seq,archivedThrough FROM store_retention,store_obs_clock');
  const saveSeq = writer.prepare('UPDATE store_obs_clock SET seq=?');
  function add(row) {
    return Number(insert.run(row.market, row.reporter, row.srcTs, row.at, ...fields.map(k => row[k]), row.seq).lastInsertRowid);
  }

  function nearestObservation(market, reporter, ts, tolerance, pin = false) {
    let best, distance = Infinity;
    const cache = new Map();
    for (const { ticks, ...head } of spans.iterate(market, reporter, ts - tolerance - OBS_SPAN_MS, ts + tolerance, ts - tolerance)) {
      for (const row of receipts(head, ticks, readPending, cache)) {
        const d = Math.abs(row.srcTs - ts);
        if (d === 0) return row;
        if (d <= tolerance && (d < distance || (d === distance && row.seq > best.seq))) {
          best = row;
          distance = d;
        }
        if (row.srcTs <= ts) break;
      }
    }
    if (history.overlaps(ts - tolerance)) {
      for (const row of history.matches(market, reporter, ts, Math.min(tolerance, distance))) {
        const d = Math.abs(row.srcTs - ts);
        if (d < distance || (d === distance && row.seq > best.seq)) {
          best = row;
          distance = d;
        }
      }
    }
    if (pin && best && best.id == null) best.id = add(best);
    return best;
  }

  return {
    reportsSince: activity.reportsSince,
    nearestObservation,
    checkedPrices(market, reporter, from, to) {
      const prices = [], cache = new Map();
      for (const { ticks, hits, ...head } of checkedSpans.iterate(market, reporter, from - OBS_SPAN_MS, to, from)) {
        for (const r of receipts(head, ticks, read, cache)) {
          if (r.srcTs < from) break;
          if (r.srcTs <= to && wasChecked(hits, r.ordinal)) prices.push(r.price);
          if (prices.length === 2) return prices;
        }
      }
      return prices;
    },
    /** Count distinct accepted source receipts, including freshness updates, and ignore replays.
     * @param {Iterable<{market:string, reporter:string, price:string, srcTs:number, at?:number,
     *   bid?:string|null, ask?:string|null, priceUsd?:string|null, baseVol24h?:string|null, quoteVol24hUsd?:string|null}>} rows
     * @param {(row:object) => void} [onAccepted] Synchronous work on this receipt in its ingestion transaction.
     */
    insertObservations(rows, onAccepted) {
      return transaction(() => {
        const { obsFrom, seq: initial, archivedThrough } = state.get();
        const now = Date.now(), batches = new Map();
        let seq = initial;
        for (const input of rows) {
          const { market, reporter, srcTs } = input;
          if (integer(srcTs, 'srcTs') < obsFrom) continue;
          const row = { market, reporter, srcTs, at: integer(input.at ?? now, 'at'), seq: seq + 1, ordinal: 0 };
          for (const key of fields) row[key] = key !== 'price' && input[key] == null ? null : decimal(input[key], key);
          const old = latest.get(market, reporter);
          if (old?.srcTs === srcTs) continue;
          if ((srcTs < (old?.srcTs ?? 0) || srcTs <= archivedThrough) && nearestObservation(market, reporter, srcTs, 0)) continue;
          let delta;
          if (old && srcTs > old.srcTs && srcTs - old.firstTs < OBS_SPAN_MS &&
              Math.abs(row.at - old.at) < Number.MAX_SAFE_INTEGER / 2 - OBS_SPAN_MS) {
            delta = previousTick(old, row, quoteFields);
          }
          if (delta && (old.bytes ?? 0) + delta.length <= BLOCK_BYTES) {
            extend.run(srcTs, row.at, ...fields.map(k => row[k]), row.seq, delta, old.id);
            row.id = old.id;
            row.ordinal = old.ordinal + 1;
          } else {
            row.id = add(row);
          }
          seq++;
          let times = batches.get(reporter);
          if (!times) batches.set(reporter, times = new Map());
          times.set(row.at, (times.get(row.at) ?? 0) + 1);
          onAccepted?.(row);
        }
        if (seq !== initial) saveSeq.run(seq);
        if (Math.floor(seq / 1024) !== Math.floor(initial / 1024)) pack();
        for (const [reporter, times] of batches) activity.record(reporter, times);
        return seq - initial;
      });
    },
    observations({ market, ...options }) {
      const [from, to] = timeRange(options), [limit, offset] = page(options);
      const found = new Map(), cache = new Map();
      for (const { ticks, ...head } of raw.iterate(market, from - OBS_SPAN_MS, to, from)) {
        const comparisons = checked?.all(head.id) ?? [];
        let newer;
        for (const row of receipts(head, ticks, read, cache)) {
          if (row.srcTs < from) break;
          if (row.srcTs >= to) continue;
          if (!newer || !sameQuote(row, newer) || comparisons.some(c => wasChecked(c.hits, row.ordinal))) {
            found.set(row.seq, row);
          }
          newer = row;
        }
      }
      return [...found.values()].sort((a, b) => a.srcTs - b.srcTs || a.seq - b.seq).slice(offset, offset + limit)
        .map(({ firstTs, seq, ordinal, archive, archiveOffset, archiveLength, ...r }) => ({ ...r, priceReal: Number(r.price) }));
    },
  };
}
