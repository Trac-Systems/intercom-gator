/** Pass these migrations to the shared market store when enabling persistent intel. */
export const migrations = [{
  id: 'engine:intel-001',
  up(db) {
    db.exec(`
      CREATE TABLE intel_market_days (
        at INTEGER PRIMARY KEY, observedAt INTEGER NOT NULL, volumeUsd REAL NOT NULL, btcDominance REAL NOT NULL
      ) STRICT;
      CREATE TABLE intel_discoveries (
        market TEXT PRIMARY KEY, firstSeen INTEGER NOT NULL, message TEXT NOT NULL, reporters TEXT NOT NULL
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX intel_discoveries_time ON intel_discoveries(firstSeen,market);
      CREATE TABLE intel_graduated (
        asset TEXT PRIMARY KEY, at INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID;
    `);
  },
}];

/** Persist peer observations apart from the engine's locally resolved pool/market registry. */
export function discoveryState(store) {
  const { reader, writer } = store;
  const all = reader.prepare('SELECT * FROM intel_discoveries ORDER BY firstSeen, market');
  const upsert = writer.prepare(`INSERT INTO intel_discoveries(market,firstSeen,message,reporters) VALUES (?,?,?,?)
    ON CONFLICT(market) DO UPDATE SET reporters=excluded.reporters,message=excluded.message,firstSeen=excluded.firstSeen`);
  const remove = writer.prepare('DELETE FROM intel_discoveries WHERE market=?');
  const graduated = reader.prepare('SELECT 1 FROM intel_graduated WHERE asset=?');
  const graduate = writer.prepare('INSERT OR IGNORE INTO intel_graduated(asset,at) VALUES (?,?)');
  return {
    load: () => all.all().map(r => ({ ...r, message: JSON.parse(r.message), reporters: JSON.parse(r.reporters) })),
    save(row, evicted) {
      store.transaction(() => {
        if (evicted) remove.run(evicted);
        upsert.run(row.market, row.firstSeen, JSON.stringify(row.message), JSON.stringify([...row.reporters]));
      });
    },
    graduated: asset => Boolean(graduated.get(asset)),
    graduate: (asset, at) => graduate.run(asset, at),
  };
}
