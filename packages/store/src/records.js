import { decimal, decoded, encode, integer, page, timeRange } from './values.js';

/** Access the discovery feed, trust records, local user state and engine snapshots.
 * @param {import('./database.js').StoreDatabase} db */
export function recordAccessors({ writer, reader }) {
  const pool = writer.prepare(`INSERT INTO pools(chain,pool,dex,kind,token0,token1,block,tx,firstSeen,liquidity)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chain,pool) DO UPDATE SET
    dex=excluded.dex, kind=coalesce(excluded.kind,kind), token0=excluded.token0, token1=excluded.token1,
    block=coalesce(excluded.block,block), tx=coalesce(excluded.tx,tx),
    firstSeen=min(firstSeen,excluded.firstSeen), liquidity=coalesce(excluded.liquidity,liquidity)`);
  const listing = writer.prepare(`INSERT INTO listings(exchange,symbol,firstSeen) VALUES (?,?,?) ON CONFLICT(exchange,symbol)
    DO UPDATE SET firstSeen=min(firstSeen,excluded.firstSeen)`);
  const listListings = reader.prepare(`SELECT * FROM listings WHERE firstSeen >= ? AND firstSeen < ?
    ORDER BY firstSeen DESC, exchange, symbol LIMIT ? OFFSET ?`);
  const saveRisk = writer.prepare(`INSERT INTO risk(asset,at,method,flags) VALUES (?,?,?,?)
    ON CONFLICT(asset) DO UPDATE SET at=excluded.at, method=excluded.method, flags=excluded.flags
    WHERE excluded.at >= risk.at`);
  const risk = reader.prepare('SELECT * FROM risk WHERE asset=?');
  const claim = writer.prepare(`INSERT INTO claims(asset,kind,reporter,value,proof,at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(asset,kind,reporter) DO UPDATE SET value=excluded.value, proof=excluded.proof, at=excluded.at
    WHERE excluded.at >= claims.at`);
  const claims = reader.prepare('SELECT * FROM claims WHERE asset=? ORDER BY kind,reporter');
  const reporter = writer.prepare(`INSERT INTO reporters(key,strikes,mutedUntil,weight) VALUES (?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET strikes=excluded.strikes, mutedUntil=excluded.mutedUntil, weight=excluded.weight`);
  const getReporter = reader.prepare('SELECT * FROM reporters WHERE key=?');

  const watch = writer.prepare('INSERT INTO watchlist(asset,addedAt) VALUES (?,?) ON CONFLICT DO NOTHING');
  const unwatch = writer.prepare('DELETE FROM watchlist WHERE asset=?');
  const watches = reader.prepare('SELECT * FROM watchlist ORDER BY addedAt DESC, asset');
  const hold = writer.prepare(`INSERT INTO portfolio(asset,account,amount) VALUES (?,?,?) ON CONFLICT(asset,account)
    DO UPDATE SET amount=excluded.amount`);
  const release = writer.prepare('DELETE FROM portfolio WHERE asset=? AND account=?');
  const holdings = reader.prepare('SELECT * FROM portfolio ORDER BY asset,account');
  const alert = writer.prepare('INSERT INTO alerts(asset,direction,threshold,createdAt) VALUES (?,?,?,?)');
  const hit = writer.prepare('UPDATE alerts SET hitAt=? WHERE id=? AND hitAt IS NULL');
  const removeAlert = writer.prepare('DELETE FROM alerts WHERE id=?');
  const alerts = reader.prepare('SELECT * FROM alerts ORDER BY createdAt DESC,id');

  const fear = writer.prepare(`INSERT INTO fear_greed(at,value,label,inputs) VALUES (?,?,?,?)
    ON CONFLICT(at) DO UPDATE SET value=excluded.value,label=excluded.label,inputs=excluded.inputs`);
  const fearHistory = reader.prepare(`SELECT * FROM fear_greed WHERE at >= ? AND at < ?
    ORDER BY at DESC LIMIT ? OFFSET ?`);
  const extra = writer.prepare(`INSERT INTO extras(slotType,slot,contentHash,expiresAt) VALUES (?,?,?,?)
    ON CONFLICT(slotType,slot) DO UPDATE SET contentHash=excluded.contentHash,expiresAt=excluded.expiresAt`);
  const activeExtras = reader.prepare('SELECT * FROM extras WHERE expiresAt > ? ORDER BY slotType,slot');
  const removeExtra = writer.prepare('DELETE FROM extras WHERE slotType=? AND slot=?');
  const health = writer.prepare(`INSERT INTO endpoint_health(id,failures,retryAt,lastSuccess) VALUES (?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET failures=excluded.failures,retryAt=excluded.retryAt,lastSuccess=excluded.lastSuccess`);
  const endpoint = reader.prepare('SELECT * FROM endpoint_health WHERE id=?');
  const setting = writer.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const getSetting = reader.prepare('SELECT value FROM settings WHERE key=?');

  return {
    upsertPool({ chain, pool: address, dex, kind = null, token0, token1, block = null, tx = null, firstSeen, liquidity = null }) {
      pool.run(chain, address, dex, kind, token0, token1, block, tx, integer(firstSeen, 'firstSeen'), liquidity);
    },
    newPools({ chain, ...options } = {}) {
      const where = chain == null ? '' : ' AND chain=?';
      const params = chain == null ? [] : [chain];
      return reader.prepare('SELECT * FROM pools WHERE firstSeen >= ? AND firstSeen < ?' + where +
        ' ORDER BY firstSeen DESC, chain, pool LIMIT ? OFFSET ?').all(...timeRange(options), ...params, ...page(options));
    },
    upsertListing({ exchange, symbol, firstSeen }) {
      listing.run(exchange, symbol, integer(firstSeen, 'firstSeen'));
    },
    newListings: options => listListings.all(...timeRange(options), ...page(options)),
    upsertRisk({ asset, at, method, flags }) { saveRisk.run(asset, integer(at, 'at'), method, encode(flags)); },
    getRisk: asset => decoded(risk.get(asset), 'flags'),
    upsertClaim({ asset, kind, reporter, value, proof = null, at }) {
      claim.run(asset, kind, reporter, value, encode(proof), integer(at, 'at'));
    },
    claimsForAsset: asset => claims.all(asset).map(row => decoded(row, 'proof')),
    upsertReporter({ key, strikes = 0, mutedUntil = 0, weight = 1 }) { reporter.run(key, strikes, mutedUntil, weight); },
    getReporter: key => getReporter.get(key),
    watch: (asset, at = Date.now()) => watch.run(asset, integer(at, 'at')).changes,
    unwatch: asset => unwatch.run(asset).changes,
    listWatchlist: () => watches.all(),
    /** A zero balance removes a holding and releases its retention pin. */
    setHolding({ asset, account = '', amount }) {
      if (/^0+(?:\.0+)?$/u.test(decimal(amount, 'amount'))) return release.run(asset, account).changes;
      return hold.run(asset, account, amount).changes;
    },
    listPortfolio: () => holdings.all(),
    addAlert({ asset, direction, threshold, createdAt = Date.now() }) {
      return alert.run(asset, direction, decimal(threshold, 'threshold'), integer(createdAt, 'createdAt')).lastInsertRowid;
    },
    hitAlert: (id, at = Date.now()) => hit.run(integer(at, 'at'), id).changes,
    removeAlert: id => removeAlert.run(id).changes,
    listAlerts: () => alerts.all(),
    upsertFearGreed({ at, value, label, inputs = [] }) { fear.run(integer(at, 'at'), value, label, encode(inputs)); },
    fearGreedHistory: options => fearHistory.all(...timeRange(options), ...page(options)).map(row => decoded(row, 'inputs')),
    upsertExtra({ slotType, slot, contentHash, expiresAt }) { extra.run(slotType, slot, contentHash, integer(expiresAt, 'expiresAt')); },
    activeExtras: (now = Date.now()) => activeExtras.all(integer(now, 'now')),
    removeExtra: (slotType, slot) => removeExtra.run(slotType, slot).changes,
    setEndpointHealth({ id, failures = 0, retryAt = 0, lastSuccess = null }) { health.run(id, failures, retryAt, lastSuccess); },
    getEndpointHealth: id => endpoint.get(id),
    setSetting: (key, value) => setting.run(key, encode(value)).changes,
    getSetting: key => decoded(getSetting.get(key), 'value')?.value,
  };
}
