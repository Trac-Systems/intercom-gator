/** Accepted root-signed bundle patches, in chain order from the signed release digest (at most MAX_CHAIN rows).
 * `message` is the canonical `patch` ctl message and stays the source of truth; the other columns are copies. */
export const migrations = [
  {
    id: 'engine-patches-001',
    up(db) {
      db.exec(`CREATE TABLE engine_patches (
      pos INTEGER PRIMARY KEY, seq INTEGER NOT NULL, baseDigest TEXT NOT NULL, newDigest TEXT NOT NULL,
      message TEXT NOT NULL, appliedAt INTEGER NOT NULL
    ) STRICT;`)
    },
  },
  {
    id: 'engine-patches-002',
    up(db) {
      db.exec('ALTER TABLE engine_patches ADD COLUMN envelope TEXT')
    },
  },
]
