const receiptColumns = `ALTER TABLE obs ADD COLUMN lastTs INTEGER;
  ALTER TABLE obs ADD COLUMN seq INTEGER;
  ALTER TABLE obs ADD COLUMN ticks BLOB;
  ALTER TABLE obs ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0;`;

// All four additions have constant defaults and leave old SQLite records and indexes
// byte-for-byte compatible. On a populated STRICT table, ordinary ADD COLUMN runs a
// whole-table check for each addition. Have SQLite generate the identical DDL on an
// empty copy, then install its parsed definition in the existing migration transaction.
// https://sqlite.org/lang_altertable.html#making_other_kinds_of_table_schema_changes
function addReceiptColumns(db) {
  if (!db.prepare('SELECT id FROM obs LIMIT 1').get()) { db.exec(receiptColumns); return false; }
  const definition = "SELECT sql FROM sqlite_schema WHERE type='table' AND name='obs'";
  const original = db.prepare(definition).get().sql;
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const template = new DatabaseSync(':memory:');
  let sql;
  try {
    template.exec(original);
    template.exec(receiptColumns);
    sql = template.prepare(definition).get().sql;
  } finally { template.close(); }
  const { schema_version } = db.prepare('PRAGMA main.schema_version').get();
  let changed = false;
  try {
    db.exec('PRAGMA writable_schema=ON');
    changed = db.prepare("UPDATE main.sqlite_schema SET sql=? WHERE type='table' AND name='obs' AND sql=?")
      .run(sql, original).changes === 1;
    if (!changed) throw new Error('Observation schema changed during migration');
    db.exec(`PRAGMA main.schema_version=${schema_version + 1}`);
    if (db.prepare('PRAGMA main.schema_version').get().schema_version !== schema_version + 1) {
      throw new Error('Unable to advance the observation schema version');
    }
  } catch (error) {
    // SQLite defensive mode can disallow metadata edits. The normal DDL remains compatible.
    if (changed || !/may not be modified|not authorized/i.test(error.message)) throw error;
  } finally { db.exec('PRAGMA writable_schema=RESET'); }
  if (!changed) db.exec(receiptColumns);
  const row = db.prepare('SELECT lastTs,seq,ticks,ordinal FROM obs ORDER BY id DESC LIMIT 1').get();
  if (row.lastTs !== null || row.seq !== null || row.ticks !== null || row.ordinal !== 0) {
    throw new Error('Unexpected defaults for a migrated observation');
  }
  return true;
}

/** Store-owned schema. Other packages pass their migrations to openStore. */
export const migrations = [{
  id: 'store:001-market',
  up(db) {
    db.exec(`
      CREATE TABLE assets (
        id TEXT PRIMARY KEY, chain TEXT NOT NULL, address TEXT NOT NULL,
        symbol TEXT NOT NULL, name TEXT NOT NULL, category TEXT, rank INTEGER CHECK(rank > 0),
        views INTEGER NOT NULL DEFAULT 0 CHECK(views >= 0), UNIQUE(chain, address)
      ) STRICT;
      CREATE INDEX assets_symbol ON assets(symbol COLLATE NOCASE);
      CREATE INDEX assets_name ON assets(name COLLATE NOCASE);
      CREATE INDEX assets_address ON assets(address COLLATE NOCASE);
      CREATE INDEX assets_rank ON assets(rank, id);
      CREATE INDEX assets_category ON assets(category, rank, id);
      CREATE INDEX assets_views ON assets(views DESC, rank, id);

      CREATE TABLE markets (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, exchange TEXT, chain TEXT,
        base TEXT NOT NULL, quote TEXT NOT NULL
      ) STRICT;
      CREATE INDEX markets_exchange ON markets(exchange, kind);
      CREATE TABLE asset_markets (
        asset TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        market TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
        PRIMARY KEY(asset, market)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX asset_markets_market ON asset_markets(market, asset);

      CREATE TABLE obs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        market TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
        reporter TEXT NOT NULL, srcTs INTEGER NOT NULL, at INTEGER NOT NULL,
        price TEXT NOT NULL, priceReal REAL GENERATED ALWAYS AS (CAST(price AS REAL)) VIRTUAL,
        priceUsd TEXT, baseVol24h TEXT, quoteVol24hUsd TEXT, bid TEXT, ask TEXT,
        UNIQUE(market, reporter, srcTs)
      ) STRICT;
      CREATE INDEX obs_market_time ON obs(market, srcTs, id);
      CREATE INDEX obs_time ON obs(srcTs);

      CREATE TABLE prices (
        asset TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
        price TEXT NOT NULL, priceReal REAL GENERATED ALWAYS AS (CAST(price AS REAL)) STORED,
        at INTEGER NOT NULL, change1h REAL, change24h REAL, change7d REAL,
        volume24h REAL, marketCap REAL, fdv REAL, trust TEXT,
        agents INTEGER, exchanges INTEGER, trending REAL
      ) STRICT;
      CREATE INDEX prices_price ON prices(priceReal, asset);
      CREATE INDEX prices_movers ON prices(change24h, asset);
      CREATE INDEX prices_cap ON prices(marketCap, asset);
      CREATE INDEX prices_volume ON prices(volume24h, asset);
      CREATE INDEX prices_trending ON prices(trending, asset);
      CREATE TABLE candles (
        asset TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        tf TEXT NOT NULL CHECK(tf IN ('1m','5m','1h','1d')), ts INTEGER NOT NULL,
        open TEXT NOT NULL, high TEXT NOT NULL, low TEXT NOT NULL, close TEXT NOT NULL,
        samples INTEGER NOT NULL CHECK(samples > 0),
        firstTs INTEGER NOT NULL, firstId INTEGER NOT NULL,
        lastTs INTEGER NOT NULL, lastId INTEGER NOT NULL,
        PRIMARY KEY(asset, tf, ts)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX candles_expiry ON candles(tf, ts);

      CREATE TABLE pools (
        chain TEXT NOT NULL, pool TEXT NOT NULL, dex TEXT NOT NULL, kind TEXT,
        token0 TEXT NOT NULL, token1 TEXT NOT NULL, block INTEGER, tx TEXT,
        firstSeen INTEGER NOT NULL, liquidity REAL, PRIMARY KEY(chain, pool)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX pools_time ON pools(firstSeen DESC, chain, pool);
      CREATE INDEX pools_chain_time ON pools(chain, firstSeen DESC, pool);
      CREATE TABLE listings (
        exchange TEXT NOT NULL, symbol TEXT NOT NULL, firstSeen INTEGER NOT NULL,
        PRIMARY KEY(exchange, symbol)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX listings_time ON listings(firstSeen DESC, exchange, symbol);
      CREATE TABLE risk (
        asset TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
        at INTEGER NOT NULL, method TEXT NOT NULL, flags TEXT NOT NULL
      ) STRICT;
      CREATE TABLE claims (
        asset TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, reporter TEXT NOT NULL, value TEXT NOT NULL, proof TEXT, at INTEGER NOT NULL,
        PRIMARY KEY(asset, kind, reporter)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE reporters (
        key TEXT PRIMARY KEY, strikes INTEGER NOT NULL DEFAULT 0 CHECK(strikes >= 0),
        mutedUntil INTEGER NOT NULL DEFAULT 0, weight REAL NOT NULL DEFAULT 1 CHECK(weight >= 0)
      ) STRICT;

      CREATE TABLE watchlist (
        asset TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE, addedAt INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE portfolio (
        asset TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        account TEXT NOT NULL DEFAULT '', amount TEXT NOT NULL,
        PRIMARY KEY(asset, account)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE alerts (
        id INTEGER PRIMARY KEY, asset TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        direction TEXT NOT NULL CHECK(direction IN ('above','below')), threshold TEXT NOT NULL,
        createdAt INTEGER NOT NULL, hitAt INTEGER
      ) STRICT;
      CREATE INDEX alerts_asset ON alerts(asset, hitAt);
      CREATE TABLE fear_greed (
        at INTEGER PRIMARY KEY, value REAL NOT NULL CHECK(value BETWEEN 0 AND 100),
        label TEXT NOT NULL, inputs TEXT NOT NULL
      ) STRICT;
      CREATE TABLE extras (
        slotType TEXT NOT NULL, slot INTEGER NOT NULL CHECK(slot >= 0),
        contentHash TEXT NOT NULL, expiresAt INTEGER NOT NULL, PRIMARY KEY(slotType, slot)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE endpoint_health (
        id TEXT PRIMARY KEY, failures INTEGER NOT NULL CHECK(failures >= 0),
        retryAt INTEGER NOT NULL, lastSuccess INTEGER
      ) STRICT;
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    `);
  },
}, {
  id: 'store:002-retention',
  up(db) {
    db.exec(`
      CREATE TABLE store_retention (
        id INTEGER PRIMARY KEY CHECK(id = 1), obsFrom INTEGER NOT NULL
      ) STRICT;
      INSERT INTO store_retention VALUES (1, 0);
    `);
  },
}, {
  id: 'store:003-market-tabs',
  up(db) {
    db.exec(`
      ALTER TABLE assets ADD COLUMN kind TEXT NOT NULL DEFAULT 'token' CHECK(kind IN ('token','nft'));
      ALTER TABLE prices ADD COLUMN floor TEXT;
      ALTER TABLE prices ADD COLUMN floorCurrency TEXT;
      ALTER TABLE markets ADD COLUMN instrument TEXT NOT NULL DEFAULT 'spot'
        CHECK(instrument IN ('spot','perpetual','future','option'));
      ALTER TABLE markets ADD COLUMN volume24h REAL;
      ALTER TABLE markets ADD COLUMN funding REAL;
      ALTER TABLE markets ADD COLUMN openInterest REAL;
      ALTER TABLE markets ADD COLUMN oiChange24h REAL;
      CREATE INDEX markets_derivatives ON markets(openInterest DESC, id) WHERE instrument <> 'spot';
      CREATE INDEX assets_kind ON assets(kind, rank, id);
    `);
  },
}, {
  id: 'store:004-address-search',
  up(db) {
    db.exec('DROP INDEX assets_address; CREATE INDEX assets_address ON assets(address)');
  },
}, {
  // Earlier asset candles were drawn from every raw quote, so stale or thin pairs left false wicks.
  // They are a local cache: exchange history refills the chart and new bars use the aggregated price.
  id: 'store:005-aggregate-candles',
  up(db) {
    db.exec('DELETE FROM candles');
  },
}, {
  id: 'store:006-quote-history',
  up(db) {
    const populated = addReceiptColumns(db);
    db.exec(`
      CREATE TABLE store_obs_clock (id INTEGER PRIMARY KEY CHECK(id=1), seq INTEGER NOT NULL) STRICT;
      CREATE TABLE store_activity_upgrade (done INTEGER NOT NULL, lastId INTEGER NOT NULL) STRICT;
      INSERT INTO store_activity_upgrade SELECT 0,id FROM obs ORDER BY id DESC LIMIT 1;
      INSERT INTO store_obs_clock SELECT 1, coalesce(max(id),0) FROM obs;
      CREATE TABLE store_report_activity (
        at INTEGER NOT NULL, reporter TEXT NOT NULL, reports INTEGER NOT NULL,
        PRIMARY KEY(at, reporter)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE store_reporters_seen (reporter TEXT PRIMARY KEY, at INTEGER NOT NULL) STRICT, WITHOUT ROWID;
    `);
    if (!populated) db.exec('DROP INDEX obs_market_time');
  },
}, {
  id: 'store:007-receipt-archives',
  up(db) {
    db.exec(`
      ALTER TABLE store_report_activity ADD COLUMN marks BLOB NOT NULL DEFAULT x'';
      CREATE TABLE store_obs_archive (
        id INTEGER PRIMARY KEY, data BLOB NOT NULL, live INTEGER NOT NULL, total INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE store_obs_slice (
        obsId INTEGER PRIMARY KEY REFERENCES obs(id) ON DELETE CASCADE,
        archive INTEGER NOT NULL REFERENCES store_obs_archive(id), archiveOffset INTEGER NOT NULL, archiveLength INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX store_obs_slice_archive ON store_obs_slice(archive);
      CREATE TABLE store_obs_pending (obsId INTEGER PRIMARY KEY REFERENCES obs(id) ON DELETE CASCADE) STRICT;
      CREATE TRIGGER obs_ready AFTER UPDATE OF ticks ON obs
        WHEN length(NEW.ticks)>=192 AND coalesce(length(OLD.ticks),0)<192 BEGIN
        INSERT OR IGNORE INTO store_obs_pending VALUES (NEW.id);
      END;
      CREATE TRIGGER obs_archive_move AFTER UPDATE OF archive ON store_obs_slice BEGIN
        UPDATE store_obs_archive SET live=live-OLD.archiveLength WHERE id=OLD.archive;
        DELETE FROM store_obs_archive WHERE id=OLD.archive AND live=0;
      END;
      CREATE TRIGGER obs_archive_remove AFTER DELETE ON store_obs_slice BEGIN
        UPDATE store_obs_archive SET live=live-OLD.archiveLength WHERE id=OLD.archive;
        DELETE FROM store_obs_archive WHERE id=OLD.archive AND live=0;
      END;
    `);
  },
}, {
  id: 'store:008-sparse-archives',
  up(db) {
    db.exec('CREATE INDEX store_obs_sparse ON store_obs_archive(id) WHERE live*2<total');
  },
}, {
  id: 'store:009-comparison-history',
  up(db) {
    db.exec(`
      ALTER TABLE store_obs_clock ADD COLUMN archivedThrough INTEGER NOT NULL DEFAULT -1;
      CREATE TABLE store_obs_comparisons (
        id INTEGER PRIMARY KEY, firstTs INTEGER NOT NULL, lastTs INTEGER NOT NULL, data BLOB NOT NULL
      ) STRICT;
      CREATE INDEX store_obs_comparison_expiry ON store_obs_comparisons(lastTs);
      CREATE TABLE store_obs_comparison_keys (
        pair BLOB NOT NULL, batch INTEGER NOT NULL REFERENCES store_obs_comparisons(id) ON DELETE CASCADE,
        PRIMARY KEY(batch,pair)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX store_obs_comparison_pair ON store_obs_comparison_keys(pair);
    `);
  },
}, {
  id: 'store:010-candle-expiry-primary-key',
  up(db) {
    db.exec('DROP INDEX IF EXISTS candles_expiry');
  },
}];
