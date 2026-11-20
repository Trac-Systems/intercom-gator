/** Install with openStore({ file, migrations }). The shared tables belong to @gator/store. */
export const migrations = [
  {
    id: 'engine-001',
    up(db) {
      db.exec(`
      CREATE TABLE engine_asset_data (
        asset TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
        decimals INTEGER, supply REAL, totalSupply REAL, stable INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE engine_market_data (
        market TEXT PRIMARY KEY REFERENCES markets(id) ON DELETE CASCADE,
        symbol TEXT, inverse INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE engine_latest (
        market TEXT NOT NULL, reporter TEXT NOT NULL, srcTs INTEGER NOT NULL,
        obsId INTEGER NOT NULL REFERENCES obs(id) ON DELETE CASCADE,
        PRIMARY KEY(market, reporter)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX engine_latest_obs ON engine_latest(obsId);
      CREATE TABLE engine_checks (
        obsId INTEGER PRIMARY KEY REFERENCES obs(id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE engine_heads (chain TEXT PRIMARY KEY, block INTEGER NOT NULL) STRICT;
      CREATE TABLE engine_logs (
        chain TEXT NOT NULL, block INTEGER NOT NULL, idx INTEGER NOT NULL, log TEXT NOT NULL,
        PRIMARY KEY(chain,block,idx)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE engine_trades (
        market TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE, block INTEGER NOT NULL,
        idx INTEGER NOT NULL, at INTEGER NOT NULL, baseVolume REAL NOT NULL,
        PRIMARY KEY(market,block,idx)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX engine_trades_time ON engine_trades(at);
      CREATE INDEX engine_trades_market_time ON engine_trades(market,at);
      CREATE TABLE engine_references (
        asset TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        provider TEXT NOT NULL, price REAL NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(asset,provider)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE engine_derivatives (
        exchange TEXT NOT NULL, symbol TEXT NOT NULL, funding REAL, openInterest REAL, at INTEGER NOT NULL,
        PRIMARY KEY(exchange,symbol)
      ) STRICT, WITHOUT ROWID;
    `)
    },
  },
  {
    id: 'engine-002',
    up(db) {
      db.exec(`
      CREATE INDEX engine_quote_markets ON markets(quote);
      CREATE INDEX engine_pending_usd ON obs(market,srcTs) WHERE priceUsd IS NULL;
      CREATE TABLE engine_interest_history (
        exchange TEXT NOT NULL,symbol TEXT NOT NULL,hour INTEGER NOT NULL,value REAL NOT NULL,
        PRIMARY KEY(exchange,symbol,hour)
      ) STRICT, WITHOUT ROWID;
    `)
    },
  },
  {
    id: 'engine-003',
    up(db) {
      db.exec(`CREATE TABLE engine_v4_lookup (
      chain TEXT NOT NULL,pool TEXT NOT NULL,manager TEXT NOT NULL,nextBlock INTEGER NOT NULL,
      lastSeen INTEGER NOT NULL,log TEXT NOT NULL,PRIMARY KEY(chain,pool)
    ) STRICT, WITHOUT ROWID;`)
    },
  },
  {
    id: 'engine-004',
    up(db) {
      db.exec(`CREATE TABLE engine_cex_symbols (
      exchange TEXT NOT NULL,symbol TEXT NOT NULL,firstSeen INTEGER NOT NULL,PRIMARY KEY(exchange,symbol)
    ) STRICT, WITHOUT ROWID;
    INSERT INTO engine_cex_symbols SELECT exchange,symbol,firstSeen FROM listings;`)
    },
  },
  {
    id: 'engine-005',
    up(db) {
      db.exec(`CREATE TABLE engine_spot_checks (
      localId INTEGER NOT NULL REFERENCES obs(id) ON DELETE CASCADE,reporter TEXT NOT NULL,
      PRIMARY KEY(localId,reporter)
    ) STRICT, WITHOUT ROWID;`)
    },
  },
  {
    id: 'engine-006',
    up(db) {
      db.exec(`ALTER TABLE engine_spot_checks ADD COLUMN struck INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE engine_standing (
        reporter TEXT PRIMARY KEY, agreements INTEGER NOT NULL, checkedAt INTEGER NOT NULL, lastObs INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX engine_standing_eviction ON engine_standing(agreements,checkedAt,reporter);
      CREATE TRIGGER engine_standing_cap AFTER INSERT ON engine_standing
      WHEN (SELECT count(*) FROM engine_standing)>4096 BEGIN
        DELETE FROM engine_standing WHERE reporter=(
          SELECT reporter FROM engine_standing WHERE reporter<>NEW.reporter
          ORDER BY agreements,checkedAt,reporter LIMIT 1
        );
      END;`)
    },
  },
  {
    id: 'engine-007',
    up(db) {
      // Older databases did not record discovery origin. Restore ordinary enrichment
      // once the local chain scan or pool directory independently sees the pool again.
      db.exec(`ALTER TABLE engine_market_data ADD COLUMN fromHint INTEGER NOT NULL DEFAULT 0;
        UPDATE engine_market_data SET fromHint=1 WHERE market LIKE 'dex:%'`)
    },
  },
  {
    id: 'engine-008-venue-volume',
    up(db) {
      db.exec(`CREATE TABLE engine_venue_volume (
        hour INTEGER NOT NULL, venue TEXT NOT NULL, volume REAL,
        PRIMARY KEY(hour,venue)
      ) STRICT, WITHOUT ROWID;`)
    },
  },
  {
    id: 'engine-009-token-names',
    up(db) {
      db.exec(`CREATE TABLE engine_names (
        asset TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
        chain TEXT NOT NULL, publicOnly INTEGER NOT NULL, priority INTEGER NOT NULL,
        lastAttempt INTEGER, failures INTEGER NOT NULL DEFAULT 0, nextRetry INTEGER DEFAULT 0,
        name TEXT, symbol TEXT, decimals INTEGER, method TEXT, block INTEGER, publishAt INTEGER
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX engine_names_batch ON engine_names(chain,publicOnly,priority,nextRetry,asset) WHERE nextRetry IS NOT NULL;
      CREATE INDEX engine_names_publish ON engine_names(publishAt,asset) WHERE publishAt IS NOT NULL;`)
    },
  },
  {
    id: 'engine-010-evm-scans',
    up(db) {
      db.exec(`ALTER TABLE engine_logs ADD COLUMN creation INTEGER NOT NULL DEFAULT 0;
        UPDATE engine_logs SET creation=-1;
        CREATE INDEX engine_logs_lane ON engine_logs(chain,creation,block,idx);
        CREATE TABLE engine_pool_scans (
          chain TEXT NOT NULL, pool TEXT NOT NULL, block INTEGER NOT NULL, polled INTEGER NOT NULL,
          PRIMARY KEY(chain,pool), FOREIGN KEY(chain,pool) REFERENCES pools(chain,pool) ON DELETE CASCADE
        ) STRICT, WITHOUT ROWID;`)
    },
  },
  {
    id: 'engine-011-evm-seed',
    up(db) {
      db.exec(`CREATE TABLE engine_seed_attempts (
        chain TEXT NOT NULL, probe TEXT NOT NULL, retryAt INTEGER NOT NULL,
        PRIMARY KEY(chain,probe)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX engine_seed_expiry ON engine_seed_attempts(chain,retryAt);`)
    },
  },
  {
    id: 'engine-012-evm-pool-parameters',
    up(db) {
      db.exec(`CREATE TABLE engine_pool_parameters (
        chain TEXT NOT NULL, pool TEXT NOT NULL, stable INTEGER, spacing INTEGER,
        PRIMARY KEY(chain,pool), FOREIGN KEY(chain,pool) REFERENCES pools(chain,pool) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;`)
    },
  },
  {
    // Imported hourly history from markets nobody traded (flat bars at an old price) drew week-long steps and,
    // counting as covered, was never replaced. Drop it for non-stable assets so the import refetches from the
    // main market. Imported bars span exactly one hour with one sample; local bars do not.
    id: 'engine-013-dead-seed-candles',
    up(db) {
      db.exec(`WITH seeded AS (
          SELECT asset, count(*) AS n, sum(open=high AND high=low AND low=close) AS flat FROM candles
          WHERE tf='1h' AND samples=1 AND firstTs=ts AND lastTs=ts+3599999 GROUP BY asset),
        dead AS (SELECT s.asset FROM seeded s LEFT JOIN engine_asset_data d ON d.asset=s.asset
          WHERE s.n >= 12 AND s.flat >= s.n * 0.8 AND coalesce(d.stable,0)=0)
        DELETE FROM candles WHERE tf='1h' AND samples=1 AND firstTs=ts AND lastTs=ts+3599999
          AND asset IN (SELECT asset FROM dead)`)
    },
  },
  {
    id: 'engine-014-logos',
    up(db) {
      // Logo images by SHA-256 (served as /img/<sha>.<ext>) and per-reference fetch state with negative caching.
      db.exec(`CREATE TABLE engine_logo_images (
        sha TEXT PRIMARY KEY, ext TEXT NOT NULL CHECK(ext IN ('png','webp','jpg')), width INTEGER NOT NULL,
        height INTEGER NOT NULL, bytes BLOB NOT NULL, at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE engine_logos (
        ref TEXT PRIMARY KEY, url TEXT NOT NULL, sha TEXT, failures INTEGER NOT NULL DEFAULT 0,
        nextRetry INTEGER NOT NULL DEFAULT 0, lastAttempt INTEGER, reason TEXT
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX engine_logos_sha ON engine_logos(sha) WHERE sha IS NOT NULL;`)
    },
  },
  {
    // Inverted wrapped-SOL pools (SOL at $0.0134) won the collision vote and durably detached every SOL exchange
    // market. Native coins are never pool-anchored now; release splits saved against a native coin and rebind their
    // markets to it.
    id: 'engine-015-release-native-splits',
    up(db) {
      const splits = db.prepare(`SELECT key, json_extract(value,'$.venue') AS venue, json_extract(value,'$.label') AS label,
        json_extract(value,'$.asset') AS asset FROM settings WHERE key LIKE 'engine-split/%'
        AND json_extract(value,'$.asset') LIKE '%:native'`).all()
      const rebind = db.prepare('UPDATE markets SET base=? WHERE base=?')
      const link = db.prepare(`INSERT OR IGNORE INTO asset_markets(asset,market)
        SELECT ?, id FROM markets WHERE base=? AND EXISTS (SELECT 1 FROM assets WHERE id=?)`)
      const drop = db.prepare('DELETE FROM settings WHERE key=?')
      for (const { key, venue, label, asset } of splits) {
        const unresolved = 'unresolved:' + venue + ':' + label
        rebind.run(asset, unresolved)
        link.run(asset, asset, asset)
        drop.run(key)
      }
    },
  },
  {
    id: 'engine-016-placement-assets',
    up(db) {
      db.exec(`CREATE TABLE engine_placement_assets (
        asset TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
        keepUntil INTEGER NOT NULL, seedAt INTEGER NOT NULL DEFAULT 0, seedCursor INTEGER NOT NULL DEFAULT 0
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX engine_placements_due ON engine_placement_assets(seedAt,asset);`)
    },
  },
  {
    id: 'engine-017-pool-reannouncements',
    up(db) {
      db.exec(`CREATE TABLE engine_pool_announcements (
        chain TEXT NOT NULL, pool TEXT NOT NULL, tx TEXT NOT NULL, attemptedAt INTEGER NOT NULL, retryAt INTEGER NOT NULL,
        PRIMARY KEY(chain,pool), FOREIGN KEY(chain,pool) REFERENCES pools(chain,pool) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;`)
    },
  },
  {
    id: 'engine-018-placement-checks',
    up(db) {
      db.exec(`ALTER TABLE engine_placement_assets ADD COLUMN checkAt INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE engine_placement_assets ADD COLUMN lastMarket TEXT NOT NULL DEFAULT '';`)
    },
  },
  {
    id: 'engine-019-nft-sales',
    up(db) {
      // NFT collections stay out of assets/prices: the price book treats every priced asset as a token.
      db.exec(`CREATE TABLE engine_nft_collections (
        chain TEXT NOT NULL, address TEXT NOT NULL, name TEXT, symbol TEXT, seeded INTEGER NOT NULL DEFAULT 0,
        source TEXT, firstSeen INTEGER NOT NULL, nameAt INTEGER, nameFailures INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(chain,address)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE engine_nft_sales (
        chain TEXT NOT NULL, tx TEXT NOT NULL, collection TEXT NOT NULL, tokenId TEXT NOT NULL,
        idx INTEGER NOT NULL, block INTEGER NOT NULL, at INTEGER NOT NULL, qty INTEGER NOT NULL,
        standard TEXT NOT NULL, marketplace TEXT NOT NULL, currency TEXT NOT NULL,
        priceEth REAL, priceUsd REAL, unitEth REAL, seller TEXT, buyer TEXT, fees INTEGER, bundle INTEGER NOT NULL,
        flag TEXT CHECK(flag IN ('self','loop')),
        PRIMARY KEY(chain,tx,collection,tokenId)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX engine_nft_sales_time ON engine_nft_sales(at);
      CREATE INDEX engine_nft_sales_collection ON engine_nft_sales(chain,collection,at);
      CREATE INDEX engine_nft_sales_token ON engine_nft_sales(chain,collection,tokenId,at);
      CREATE TABLE engine_nft_scans (chain TEXT PRIMARY KEY, block INTEGER NOT NULL) STRICT;`)
    },
  },
  {
    id: 'engine-020-quote-history',
    up(db) {
      if (!db.prepare('SELECT id FROM obs LIMIT 1').get()) db.exec('DROP INDEX IF EXISTS engine_pending_usd')
      db.exec(`ALTER TABLE engine_checks RENAME TO engine_old_checks;
        CREATE TABLE engine_checks (
          obsId INTEGER PRIMARY KEY REFERENCES obs(id) ON DELETE CASCADE, hits BLOB NOT NULL
        ) STRICT;
        INSERT INTO engine_checks SELECT obsId,x'01' FROM engine_old_checks;
        DROP TABLE engine_old_checks;
        ALTER TABLE engine_spot_checks RENAME TO engine_old_spots;
        CREATE TABLE engine_spot_checks (
          localId INTEGER NOT NULL REFERENCES obs(id) ON DELETE CASCADE, reporter TEXT NOT NULL,
          hits BLOB NOT NULL, struck BLOB, srcTs INTEGER NOT NULL, price TEXT NOT NULL,
          PRIMARY KEY(localId,reporter)
        ) STRICT, WITHOUT ROWID;
        INSERT INTO engine_spot_checks SELECT o.id,c.reporter,x'01',CASE WHEN c.struck THEN x'01' END,o.srcTs,o.price
          FROM engine_old_spots c JOIN obs o ON o.id=c.localId;
        DROP TABLE engine_old_spots;
        CREATE TABLE engine_last_spot (
          market TEXT PRIMARY KEY, localId INTEGER NOT NULL, reporter TEXT NOT NULL, srcTs INTEGER NOT NULL, seq INTEGER NOT NULL
        ) STRICT, WITHOUT ROWID;
        INSERT INTO engine_last_spot
          SELECT market,localId,reporter,srcTs,localId FROM (
            SELECT o.market,c.*,row_number() OVER (PARTITION BY o.market ORDER BY c.srcTs DESC,c.localId DESC,c.reporter) n
            FROM engine_spot_checks c JOIN obs o ON o.id=c.localId) WHERE n=1;`)
    },
  },
  {
    id: 'engine-021-focus',
    up(db) {
      db.exec(`CREATE TABLE engine_focus (
        asset TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
        generation TEXT NOT NULL, addedAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, poolDiscovery INTEGER NOT NULL,
        paidUntil INTEGER NOT NULL, requests INTEGER NOT NULL DEFAULT 0
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE engine_focus_tasks (
        asset TEXT NOT NULL REFERENCES engine_focus(asset) ON DELETE CASCADE, task TEXT NOT NULL,
        dueAt INTEGER, attempts INTEGER NOT NULL DEFAULT 0, result TEXT,
        PRIMARY KEY(asset,task)
      ) STRICT, WITHOUT ROWID;
      -- The existing seeder, tracker and re-announcer share one cursor per asset. During
      -- focus, keep the independently purchased deadline, including purchases made later.
      CREATE TRIGGER engine_focus_paid BEFORE INSERT ON engine_placement_assets
        WHEN NEW.keepUntil>0 BEGIN
        UPDATE engine_focus SET paidUntil=max(paidUntil,NEW.keepUntil) WHERE asset=NEW.asset AND poolDiscovery=1;
      END;
      CREATE TRIGGER engine_focus_seed AFTER INSERT ON engine_focus WHEN NEW.poolDiscovery=1 BEGIN
        INSERT INTO engine_placement_assets(asset,keepUntil) VALUES(NEW.asset,0) ON CONFLICT DO NOTHING;
        UPDATE engine_placement_assets SET keepUntil=max(NEW.expiresAt,NEW.paidUntil) WHERE asset=NEW.asset;
      END;
      CREATE TRIGGER engine_focus_renew AFTER UPDATE OF expiresAt ON engine_focus WHEN NEW.poolDiscovery=1 BEGIN
        UPDATE engine_placement_assets SET keepUntil=max(NEW.expiresAt,NEW.paidUntil) WHERE asset=NEW.asset;
      END;
      CREATE TRIGGER engine_focus_release AFTER DELETE ON engine_focus WHEN OLD.poolDiscovery=1 BEGIN
        DELETE FROM engine_placement_assets WHERE asset=OLD.asset AND OLD.paidUntil=0;
        UPDATE engine_placement_assets SET keepUntil=OLD.paidUntil WHERE asset=OLD.asset;
      END;`)
    },
  },
  {
    id: 'engine-pool-catchup-v1',
    up(db) {
      db.exec(`CREATE TABLE engine_pool_history (
        chain TEXT NOT NULL, pool TEXT NOT NULL, at INTEGER NOT NULL, verified INTEGER NOT NULL,
        PRIMARY KEY(chain,pool), FOREIGN KEY(chain,pool) REFERENCES pools(chain,pool) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX engine_pool_history_page ON engine_pool_history(verified,at,chain,pool);
      CREATE TRIGGER engine_pool_history_change AFTER UPDATE OF tx,block,dex,kind,token0,token1 ON pools
        WHEN OLD.tx IS NOT NEW.tx OR OLD.block IS NOT NEW.block OR OLD.dex IS NOT NEW.dex
          OR OLD.kind IS NOT NEW.kind OR OLD.token0 IS NOT NEW.token0 OR OLD.token1 IS NOT NEW.token1 BEGIN
        DELETE FROM engine_pool_history WHERE chain=NEW.chain AND pool=NEW.pool;
      END;
      -- Legacy rows can describe a swap. Check a bounded selection with spare budget on upgrade.
      INSERT INTO engine_pool_history
        SELECT chain,pool,firstSeen,0 FROM pools WHERE firstSeen >= (unixepoch()-604800)*1000
          AND block IS NOT NULL AND length(tx)=66 AND EXISTS (
            SELECT 1 FROM markets WHERE id='dex:'||pools.chain||':'||pools.pool)
        ORDER BY firstSeen DESC,chain,pool LIMIT 5000;`)
    },
  },
  {
    id: 'engine-023-announced-pools',
    up(db) {
      // Pools registered from a peer's gator/new record or catch-up row (intel/announced-pools.js): measured once,
      // kept priced while at least the added-token floor deep (bounded per chain), then forgotten after 24 h below it.
      db.exec(`CREATE TABLE engine_announced_pools (
        chain TEXT NOT NULL, pool TEXT NOT NULL, since INTEGER NOT NULL, checkAt INTEGER NOT NULL,
        checks INTEGER NOT NULL DEFAULT 0, depth REAL, belowSince INTEGER, PRIMARY KEY(chain,pool)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX engine_announced_pools_due ON engine_announced_pools(checkAt,chain);`)
    },
  },
  {
    id: 'engine-factory-history-v1',
    up(db) {
      db.exec(`CREATE TABLE engine_history_ranges (
        chain TEXT NOT NULL, factory TEXT NOT NULL, mode TEXT NOT NULL, start INTEGER NOT NULL,
        next INTEGER NOT NULL, afterIdx INTEGER NOT NULL, span INTEGER NOT NULL, checkedAt INTEGER NOT NULL,
        PRIMARY KEY(chain,factory,mode,start)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE engine_history_pools (
        chain TEXT NOT NULL, pool TEXT NOT NULL, factory TEXT NOT NULL, idx INTEGER,
        lo INTEGER NOT NULL, hi INTEGER NOT NULL, bisect INTEGER NOT NULL, span INTEGER NOT NULL,
        nextShare INTEGER NOT NULL, PRIMARY KEY(chain,pool),
        FOREIGN KEY(chain,pool) REFERENCES pools(chain,pool) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX engine_history_outbox ON engine_history_pools(nextShare,chain,pool);`)
    },
  },
]
