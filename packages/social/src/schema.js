import { migrateRetention } from './retention.js';

/** Migrations for openStore({ migrations }). Run once per peer database. */
export const migrations = [{
  id: 'social-001',
  up(db) {
    db.exec(`
      CREATE TABLE social_state (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE profiles (
        key TEXT PRIMARY KEY, handle TEXT NOT NULL, card TEXT NOT NULL,
        ts INTEGER NOT NULL, card_id TEXT NOT NULL, verified TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX social_handle ON profiles(handle);
      CREATE TABLE follows (key TEXT PRIMARY KEY);
      CREATE TABLE mutes (key TEXT PRIMARY KEY);
      CREATE TABLE social_root_mutes (key TEXT PRIMARY KEY, seq INTEGER NOT NULL, muted INTEGER NOT NULL);
      CREATE VIEW social_hidden AS
        SELECT key FROM mutes UNION SELECT key FROM social_root_mutes
        WHERE muted = 1 AND COALESCE((SELECT value FROM social_state WHERE name = 'useRootMutes'), 'true') = 'true';

      CREATE TABLE directory (
        key TEXT PRIMARY KEY REFERENCES profiles(key), topics TEXT NOT NULL, ts INTEGER NOT NULL,
        id TEXT NOT NULL, arrival INTEGER NOT NULL, last_seen INTEGER NOT NULL
      );
      CREATE INDEX social_directory_time ON directory(ts DESC, key);
      CREATE TABLE posts (
        key TEXT NOT NULL, id TEXT NOT NULL, channel TEXT NOT NULL, t TEXT NOT NULL, ts INTEGER NOT NULL,
        text TEXT NOT NULL, envelope TEXT NOT NULL, arrival INTEGER NOT NULL, copies INTEGER NOT NULL DEFAULT 1,
        parent_key TEXT, parent_id TEXT, target_key TEXT, target_id TEXT, PRIMARY KEY(key, id)
      );
      CREATE INDEX social_posts_id ON posts(id);
      CREATE INDEX social_posts_time ON posts(ts DESC, id DESC, key DESC);
      CREATE INDEX social_posts_parent ON posts(parent_key, parent_id);
      CREATE INDEX social_posts_target ON posts(target_key, target_id, t);
      CREATE UNIQUE INDEX social_repost_once ON posts(key, target_key, target_id) WHERE t = 'repost';
      CREATE TABLE social_mentions (
        author TEXT NOT NULL, id TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(author, id, key),
        FOREIGN KEY(author, id) REFERENCES posts(key, id) ON DELETE CASCADE
      );
      CREATE INDEX social_mentions_inbox ON social_mentions(key);
      CREATE VIEW social_visible_posts AS SELECT p.* FROM posts p
        WHERE NOT EXISTS (SELECT 1 FROM social_hidden h WHERE h.key IN (p.key, p.target_key, p.parent_key));
      CREATE TABLE likes (
        key TEXT NOT NULL, target_key TEXT NOT NULL, target_id TEXT NOT NULL, ts INTEGER NOT NULL,
        PRIMARY KEY(key, target_key, target_id)
      );
      CREATE INDEX social_likes_target ON likes(target_key, target_id);
      CREATE INDEX social_likes_time ON likes(ts);
      CREATE TABLE social_seen (
        key TEXT NOT NULL, id TEXT NOT NULL, first_at INTEGER NOT NULL, copies INTEGER NOT NULL DEFAULT 1,
        bucket TEXT, fingerprint TEXT, post_id TEXT, PRIMARY KEY(key, id)
      );
      CREATE INDEX social_seen_time ON social_seen(first_at);
      CREATE INDEX social_rate ON social_seen(key, bucket, first_at);
      CREATE TABLE social_outbox (
        slot TEXT PRIMARY KEY, envelope TEXT NOT NULL, last_sent INTEGER NOT NULL, ts INTEGER NOT NULL
      );
    `);
  }
}, {
  id: 'social-002',
  up(db) {
    db.exec(`
      ALTER TABLE profiles ADD COLUMN proof_checked INTEGER;
      CREATE INDEX social_seen_post ON social_seen(key,post_id);
    `);
  }
}, {
  id: 'social-003',
  up(db) {
    db.exec(`
      CREATE TABLE social_contacts (key TEXT PRIMARY KEY);
      CREATE INDEX social_directory_seen ON directory(last_seen,arrival);
      UPDATE directory SET ts=min(ts,last_seen);
      UPDATE profiles SET ts=min(ts,coalesce(
        (SELECT first_at FROM social_seen WHERE key=profiles.key AND id=profiles.card_id),
        (SELECT last_seen FROM directory WHERE key=profiles.key),ts));
      UPDATE posts SET ts=min(ts,coalesce(
        (SELECT min(first_at) FROM social_seen WHERE key=posts.key AND post_id=posts.id),ts));
    `);
  }
}, {
  id: 'social-004',
  up(db) {
    db.exec(`
      CREATE TABLE social_revocations (root TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(root,id));
      ALTER TABLE posts ADD COLUMN notice_expires INTEGER;
      CREATE INDEX social_notice_expiry ON posts(notice_expires) WHERE notice_expires IS NOT NULL;
      DROP VIEW social_visible_posts;
      CREATE VIEW social_unmuted_posts AS SELECT p.* FROM posts p
        WHERE NOT EXISTS (SELECT 1 FROM social_hidden h WHERE h.key IN (p.key, p.target_key, p.parent_key));
      CREATE VIEW social_visible_posts AS SELECT * FROM social_unmuted_posts
        WHERE notice_expires IS NULL OR notice_expires > unixepoch('subsec') * 1000;
    `);
  }
}, { id: 'social-005', up: migrateRetention }, {
  id: 'social-006',
  up(db) {
    // The image stays inside the stored signed card (so lane byte budgets count it); this column addresses it by SHA-256.
    db.exec(`
      ALTER TABLE profiles ADD COLUMN avatar TEXT;
      CREATE INDEX social_avatar ON profiles(avatar) WHERE avatar IS NOT NULL;
    `);
  }
}];
