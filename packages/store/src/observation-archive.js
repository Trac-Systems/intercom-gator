// Ticker batches report many markets at the same times. Deflate bounded groups of their
// history together to share that redundancy, leaving each current quote directly addressable.
import { brotliCompressSync, brotliDecompressSync, constants, deflateRawSync, inflateRawSync } from 'node:zlib';

const MAX_SPANS = 192;
const writers = new WeakMap();
// A raw DEFLATE block can't start with ff (block type 3 is reserved). Existing files
// therefore remain distinguishable from the denser pages produced under byte pressure.
const denseMarker = Buffer.from([0xff]);
const denseOptions = { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } };

export function packHistory(bytes, dense) {
  return dense ? Buffer.concat([denseMarker, brotliCompressSync(bytes, denseOptions)]) :
    deflateRawSync(bytes, { level: 3 });
}

export function unpackHistory(bytes) {
  return bytes[0] === denseMarker[0] ? brotliDecompressSync(bytes.subarray(1)) : inflateRawSync(bytes);
}

export function archiveReader(db) {
  const blob = db.prepare('SELECT data FROM store_obs_archive WHERE id=?');
  return function read(row, cache) {
    if (row.archive == null) return null;
    let bytes = cache.get(row.archive);
    if (!bytes) {
      bytes = unpackHistory(blob.get(row.archive).data);
      if (cache.size >= 8) cache.clear();
      cache.set(row.archive, bytes);
    }
    return bytes.subarray(row.archiveOffset, row.archiveOffset + row.archiveLength);
  };
}

export function archiveWriter(db) {
  if (writers.has(db)) return writers.get(db);
  const read = archiveReader(db);
  const cols = 'id,ticks,archive,archiveOffset,archiveLength';
  const ready = db.prepare(`SELECT ${cols} FROM store_obs_pending q JOIN obs ON obs.id=q.obsId
    LEFT JOIN store_obs_slice s ON s.obsId=obs.id ORDER BY q.obsId LIMIT ?`);
  const sparse = db.prepare('SELECT id FROM store_obs_archive WHERE live*2<total ORDER BY id LIMIT 16');
  const remaining = db.prepare(`SELECT ${cols} FROM store_obs_slice s JOIN obs ON obs.id=s.obsId WHERE archive=?`);
  const save = db.prepare('INSERT INTO store_obs_archive(data,live,total) VALUES (?,?,?)');
  const move = db.prepare(`INSERT INTO store_obs_slice(archive,archiveOffset,archiveLength,obsId) VALUES (?,?,?,?)
    ON CONFLICT(obsId) DO UPDATE SET archive=excluded.archive,archiveOffset=excluded.archiveOffset,
    archiveLength=excluded.archiveLength`);
  const clear = db.prepare('UPDATE obs SET ticks=NULL WHERE id=?');
  const dequeue = db.prepare('DELETE FROM store_obs_pending WHERE obsId=?');
  function pack(dense = false) {
    // Consolidate survivors of pruning so one retained check cannot pin an entire group indefinitely.
    const rows = new Map();
    for (const { id } of sparse.all()) {
      const survivors = remaining.all(id);
      if (rows.size + survivors.length > MAX_SPANS) break;
      for (const row of survivors) rows.set(row.id, row);
    }
    for (const row of ready.all(MAX_SPANS)) {
      if (rows.size >= MAX_SPANS) break;
      rows.set(row.id, row);
    }
    if (!rows.size) return;
    const cache = new Map(), parts = [];
    let total = 0;
    for (const row of rows.values()) {
      const prior = read(row, cache);
      if (row.ticks) parts.push(row.ticks);
      if (prior) parts.push(prior);
      row.offset = total;
      row.size = (row.ticks?.length ?? 0) + (prior?.length ?? 0);
      total += row.size;
    }
    const data = packHistory(Buffer.concat(parts, total), dense);
    const id = save.run(data, total, total).lastInsertRowid;
    for (const row of rows.values()) {
      move.run(id, row.offset, row.size, row.id);
      clear.run(row.id);
      dequeue.run(row.id);
    }
  }
  const writer = { pack, hasSparse: () => !!sparse.get() };
  writers.set(db, writer);
  return writer;
}
