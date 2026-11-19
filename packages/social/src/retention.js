// Count UTF-8 payloads plus a fixed allowance for each SQLite row. fitBudget measures actual live pages.
export const LANE_LIMITS = {
  small:  { laneRows: 12_000, laneBytes: 8 * 1024 ** 2, laneRate: 120 },
  normal: { laneRows: 48_000, laneBytes: 32 * 1024 ** 2, laneRate: 360 },
  large:  { laneRows: 192_000, laneBytes: 128 * 1024 ** 2, laneRate: 900 }
};

const tables = [
  { name: 'posts', at: 'received_at', fields: 'key id channel t text envelope parent_key parent_id target_key target_id' },
  { name: 'likes', at: 'received_at', fields: 'key target_key target_id' },
  { name: 'social_seen', at: 'first_at', fields: 'key id bucket fingerprint post_id' },
  { name: 'directory', at: 'last_seen', fields: 'key topics id' },
  { name: 'profiles', at: 'received_at', fields: 'key handle card card_id' }
];
const laneOf = (name, p) => name === 'directory' ? "'directory'" : p + 'inbound_lane';
const localKey = "(SELECT json_extract(value,'$') FROM social_state WHERE name='quotaOwner')";
function cost({ name, fields }, prefix = '') {
  const payload = fields.split(' ').map(f => `coalesce(octet_length(${prefix}${f}),0)`).join('+');
  if (name !== 'posts') return { rows: '1', bytes: '128+' + payload };
  // Mention children follow their post on deletion. Include all three columns of their composite key.
  return { rows: '1+' + prefix + 'mention_count',
    bytes: `128+${payload}+${prefix}mention_count*(256+octet_length(${prefix}id))` };
}

export function migrateRetention(db) {
  db.exec(`
    CREATE TABLE social_lane_usage (lane TEXT PRIMARY KEY, n INTEGER NOT NULL, bytes INTEGER NOT NULL);
    CREATE TABLE social_inbound (lane TEXT NOT NULL, at INTEGER NOT NULL, key TEXT, bucket TEXT);
    CREATE INDEX social_inbound_window ON social_inbound(lane,at);
    CREATE INDEX social_inbound_author ON social_inbound(key,bucket,at) WHERE bucket IS NOT NULL;
    ALTER TABLE posts ADD COLUMN inbound_lane TEXT NOT NULL DEFAULT 'owner';
    ALTER TABLE likes ADD COLUMN inbound_lane TEXT NOT NULL DEFAULT 'reply';
    ALTER TABLE social_seen ADD COLUMN inbound_lane TEXT NOT NULL DEFAULT 'reply';
    ALTER TABLE profiles ADD COLUMN inbound_lane TEXT NOT NULL DEFAULT 'directory';
    ALTER TABLE posts ADD COLUMN received_at INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE profiles ADD COLUMN received_at INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE likes ADD COLUMN received_at INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE posts ADD COLUMN mention_count INTEGER NOT NULL DEFAULT 0;
    UPDATE posts SET received_at=coalesce((SELECT min(first_at) FROM social_seen WHERE key=posts.key AND post_id=posts.id),0),
      inbound_lane=CASE WHEN channel='soc/official' THEN 'official' WHEN channel LIKE 'soc/p/%' THEN 'product'
        WHEN channel LIKE 'soc/u/%' THEN 'owner' ELSE 'reply' END,
      mention_count=(SELECT count(*) FROM social_mentions WHERE author=posts.key AND id=posts.id);
    UPDATE profiles SET received_at=coalesce((SELECT last_seen FROM directory WHERE key=profiles.key),0),
      inbound_lane=CASE WHEN key IN (SELECT key FROM directory) THEN 'directory' ELSE 'owner' END;
    UPDATE social_seen SET inbound_lane=coalesce(
      (SELECT inbound_lane FROM posts WHERE key=social_seen.key AND id=social_seen.post_id),
      CASE bucket WHEN 'cards' THEN 'directory' WHEN 'follows' THEN 'owner' ELSE 'reply' END);
    CREATE TRIGGER social_refresh_card AFTER UPDATE OF last_seen ON directory BEGIN
      UPDATE profiles SET received_at=max(received_at,NEW.last_seen) WHERE key=NEW.key;
    END;
    CREATE TRIGGER social_discover_card AFTER INSERT ON directory BEGIN
      UPDATE profiles SET received_at=max(received_at,NEW.last_seen) WHERE key=NEW.key;
    END;
    CREATE TRIGGER social_count_mention AFTER INSERT ON social_mentions BEGIN
      UPDATE posts SET mention_count=mention_count+1 WHERE key=NEW.author AND id=NEW.id;
    END;
    CREATE TRIGGER social_forget_mention AFTER DELETE ON social_mentions BEGIN
      UPDATE posts SET mention_count=mention_count-1 WHERE key=OLD.author AND id=OLD.id;
    END;
  `);
  for (const table of tables) {
    const { name, at, fields } = table;
    // A fixed allowance includes bounded numeric fields and the profile's two proof flags.
    const columns = fields.split(' ');
    if (name !== 'directory') columns.push('inbound_lane');
    if (name === 'posts') columns.push('mention_count');
    const add = cost(table, 'NEW.'), sub = cost(table, 'OLD.');
    const subtract = `UPDATE social_lane_usage SET n=n-(${sub.rows}),bytes=bytes-(${sub.bytes})
      WHERE lane=${laneOf(name, 'OLD.')} AND OLD.key<>${localKey};`;
    const insert = `INSERT INTO social_lane_usage SELECT ${laneOf(name, 'NEW.')},${add.rows},${add.bytes}
      WHERE NEW.key<>${localKey} ON CONFLICT(lane) DO UPDATE SET n=n+excluded.n,bytes=bytes+excluded.bytes;`;
    db.exec(`
      ${['posts', 'likes', 'profiles'].includes(name) ? `CREATE INDEX social_pressure_${name} ON ${name}(${at});` : ''}
      CREATE INDEX social_quota_${name} ON ${name}(${name === 'directory' ? '' : 'inbound_lane,'}${at});
      CREATE TRIGGER social_charge_${name} AFTER INSERT ON ${name} BEGIN ${insert} END;
      CREATE TRIGGER social_refund_${name} AFTER DELETE ON ${name} BEGIN ${subtract} END;
      CREATE TRIGGER social_adjust_${name} AFTER UPDATE OF ${columns.join(',')} ON ${name}
        BEGIN ${subtract} ${insert} END;
    `);
  }
}

/** Owns row accounting, admission and eviction for all social lanes on one writer. */
export class SocialRetention {
  constructor(store) { this.store = store; }
  initialize() {
    const s = this.store;
    if (s.state('quotaOwner') !== s.key) {
      const now = s.now();
      for (const name of ['posts', 'profiles', 'likes', 'directory']) {
        s.sql(`UPDATE ${name} SET ts=? WHERE ts>?`).run(now, now);
      }
      s.sql('DELETE FROM social_lane_usage').run();
      for (const table of tables) {
        const { rows, bytes } = cost(table);
        s.sql(`INSERT INTO social_lane_usage SELECT ${laneOf(table.name, '')},sum(${rows}),sum(${bytes})
          FROM ${table.name} WHERE key<>? GROUP BY 1 ON CONFLICT(lane) DO UPDATE
          SET n=n+excluded.n, bytes=bytes+excluded.bytes`).run(s.key);
      }
      s.setState('quotaOwner', s.key);
    }
    // A profile downgrade may leave more protected history than the new limit.
    this.enforce();
  }
  admit(lane, now) {
    const s = this.store;
    s.sql('DELETE FROM social_inbound WHERE lane=? AND at<=?').run(lane, now - s.limits.windowMs);
    if (s.sql('SELECT count(*) AS n FROM social_inbound WHERE lane=?').get(lane).n >= s.limits.laneRate) return false;
    return s.sql('INSERT INTO social_inbound(lane,at) VALUES(?,?)').run(lane, now).lastInsertRowid;
  }
  evict({ lane, followed, limit }) {
    const s = this.store;
    const candidates = [];
    for (const { name, at } of tables) {
      if (name === 'directory' && lane && lane !== 'directory') continue;
      const filters = ['key<>?'];
      const args = [s.key];
      if (lane && name !== 'directory') { filters.push('inbound_lane=?'); args.push(lane); }
      if (followed !== undefined) {
        filters.push(followed ? '(key IN follows OR key=?)' : '(key NOT IN follows AND key<>?)');
        args.push(s.rootKey);
      }
      if (name === 'profiles') {
        filters.push('key<>? AND key NOT IN follows AND key NOT IN social_contacts');
        args.push(s.rootKey);
      }
      const rows = s.sql(`SELECT rowid AS rid,${at} AS at FROM ${name} WHERE ${filters.join(' AND ')}
        ORDER BY ${at},rowid LIMIT ?`).all(...args, limit);
      for (const row of rows) candidates.push({ ...row, name });
    }
    candidates.sort((a, b) => a.at - b.at || a.rid - b.rid);
    let removed = 0;
    for (const { name, rid } of candidates.slice(0, limit)) {
      if (name === 'profiles') {
        removed += s.sql('DELETE FROM directory WHERE key=(SELECT key FROM profiles WHERE rowid=?)').run(rid).changes;
      }
      removed += s.sql(`DELETE FROM ${name} WHERE rowid=?`).run(rid).changes;
    }
    return removed;
  }
  pressure({ targetBytes, liveBytes }) {
    const limit = Math.min(64, Math.max(1, Math.ceil((liveBytes - targetBytes) / 4096)));
    return this.evict({ followed: false, limit }) || this.evict({ followed: true, limit });
  }
  enforce(lane) {
    const s = this.store;
    const { laneRows, laneBytes } = s.limits;
    const over = s.sql('SELECT lane,n,bytes FROM social_lane_usage WHERE n>? OR bytes>?').all(laneRows, laneBytes);
    let fits = true;
    for (const row of over) {
      if (lane && row.lane !== lane) continue;
      let usage = row;
      while (usage.n > laneRows || usage.bytes > laneBytes) {
        const limit = Math.min(64, Math.max(1, usage.n - laneRows, Math.ceil((usage.bytes - laneBytes) / 4096)));
        if (!this.evict({ lane: row.lane, limit })) { fits = false; break; }
        usage = s.sql('SELECT n,bytes FROM social_lane_usage WHERE lane=?').get(row.lane);
      }
    }
    return fits;
  }
}
