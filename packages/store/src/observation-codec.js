const word = value => value < 0 ? -2 * value - 1 : 2 * value;

function writeInt(bytes, value) {
  while (value >= 128) {
    bytes.push(value % 128 + 128);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
}

// Each record describes the preceding receipt relative to its successor. Decimal fields are
// ASCII by validation. Preserve their spelling and precision, including trailing zeros.
export function previousTick(old, next, quoteFields) {
  const bytes = [];
  writeInt(bytes, next.srcTs - old.srcTs);
  writeInt(bytes, next.seq - old.seq);
  writeInt(bytes, word((next.at - old.at) - (next.srcTs - old.srcTs)));
  let mask = 0;
  quoteFields.forEach((key, i) => { if (old[key] !== next[key]) mask |= 1 << i; });
  bytes.push(mask);
  for (const [i, key] of quoteFields.entries()) {
    if (!(mask & 1 << i)) continue;
    const value = old[key];
    if (value == null) { writeInt(bytes, 0); continue; }
    const newer = next[key] ?? '';
    let prefix = 0;
    while (prefix < value.length && value[prefix] === newer[prefix]) prefix++;
    writeInt(bytes, prefix + 1);
    writeInt(bytes, value.length - prefix);
    for (let j = prefix; j < value.length; j++) bytes.push(value.charCodeAt(j));
  }
  return Buffer.from(bytes);
}

// Records are prepended, so an exact or nearest lookup starts at the newest quote.
export function* receipts(head, blob, readArchive, cache) {
  yield head;
  let row = head;
  function* segments() {
    if (blob?.length) yield Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
    if (head.archive != null) yield readArchive(head, cache);
  }
  for (const bytes of segments()) {
    let pos = 0;
    function readInt() {
      let n = 0, m = 1, byte;
      do {
        byte = bytes[pos++];
        n += (byte & 127) * m;
        m *= 128;
      } while (byte >= 128);
      return n;
    }
    while (pos < bytes.length) {
      const dt = readInt(), ds = readInt(), skew = readInt(), mask = bytes[pos++];
      const prev = { ...row, priceUsd: null, baseVol24h: null, quoteVol24hUsd: null,
        srcTs: row.srcTs - dt, seq: row.seq - ds, ordinal: row.ordinal - 1,
        at: row.at - dt - (skew % 2 ? -(skew + 1) / 2 : skew / 2) };
      for (const [i, key] of ['price', 'bid', 'ask'].entries()) {
        if (!(mask & 1 << i)) continue;
        const prefix = readInt();
        if (!prefix) prev[key] = null;
        else {
          const len = readInt();
          prev[key] = (row[key] ?? '').slice(0, prefix - 1) + bytes.toString('ascii', pos, pos + len);
          pos += len;
        }
      }
      yield prev;
      row = prev;
    }
  }
}
