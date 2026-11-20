import { avatarHash, parseAvatar } from './avatar.js';
import { DAY, isKey } from './policy.js';
import { SocialRetention } from './retention.js';
import { extractText, isHandle, isId, isRef, reservedHandle } from './validate.js';

// SQL consumers of social_visible_posts use wall time. Social uses its harness clock for the same predicate.
const visiblePosts = '(SELECT * FROM social_unmuted_posts WHERE notice_expires IS NULL OR notice_expires > social_now_ms())';
const pageSize = n => Number.isSafeInteger(n) ? Math.max(0, Math.min(n, 100)) : 50;
function cursor(before) {
  if (Number.isSafeInteger(before)) return [before, '', ''];
  if (before && Number.isSafeInteger(before.ts) && isId(before.id) && isKey(before.key)) {
    return [before.ts, before.id, before.key];
  }
  throw new TypeError('Expected a timestamp or the previous page’s last row');
}
const normalized = text => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function near(a, b) {
  if (a === b) return true;
  if (a.length < 16 || b.length < 16 || Math.min(a.length, b.length) / Math.max(a.length, b.length) < 0.85) return false;
  const grams = s => new Set(Array.from({ length: s.length - 2 }, (_, i) => s.slice(i, i + 3)));
  const left = grams(a);
  const right = grams(b);
  let matches = 0;
  for (const gram of left) if (right.has(gram)) matches++;
  return 2 * matches >= 0.88 * (left.size + right.size);
}

const buckets = { card: 'cards', announce: 'cards', post: 'posts', reply: 'posts', repost: 'posts',
  like: 'likes', follow: 'follows' };
const postTypes = new Set(['post', 'reply', 'repost', 'notice']);

function budgetFor(message) {
  const bucket = buckets[message.t] ?? null;
  const fingerprint = bucket === 'posts' && message.text ? normalized(message.text) || message.text : null;
  return { bucket, fingerprint };
}

/** Synchronous SQLite operations on the node's single social identity. */
export class FeedStore {
  constructor(db, key, limits, rootKey, now) {
    this.runTransaction = db.transaction?.bind(db);
    this.reader = db.reader ?? db;
    this.writer = db.writer ?? db;
    this.now = now;
    for (const conn of new Set([this.reader, this.writer])) conn.function('social_now_ms', now);
    this.key = key;
    this.rootKey = rootKey;
    this.limits = limits;
    this.retention = new SocialRetention(this);
    this.statements = new Map();
  }
  sql(query, conn = this.writer) {
    let map = this.statements.get(conn);
    if (!map) this.statements.set(conn, map = new Map());
    if (!map.has(query)) map.set(query, conn.prepare(query));
    return map.get(query);
  }
  transaction(fn) {
    if (this.runTransaction) return this.runTransaction(fn);
    // A savepoint also works when a harness already has a transaction on its writer.
    this.writer.exec('SAVEPOINT social_event');
    try {
      const result = fn();
      this.writer.exec('RELEASE social_event');
      return result;
    } catch (err) {
      this.writer.exec('ROLLBACK TO social_event');
      this.writer.exec('RELEASE social_event');
      throw err;
    }
  }
  state(name) {
    const row = this.sql('SELECT value FROM social_state WHERE name = ?').get(name);
    return row && JSON.parse(row.value);
  }
  setState(name, value) {
    this.sql('INSERT OR REPLACE INTO social_state (name,value) VALUES (?,?)').run(name, JSON.stringify(value));
  }
  arrival() {
    const next = (this.state('arrival') ?? 0) + 1;
    this.setState('arrival', next);
    return next;
  }
  removeReservedCards() {
    if (this.state('reservedHandlesRoot') === this.rootKey) return;
    for (const { key, handle } of this.sql('SELECT key,handle FROM profiles WHERE key<>?').all(this.rootKey)) {
      if (!reservedHandle(handle)) continue;
      this.sql('DELETE FROM directory WHERE key=?').run(key);
      this.sql('DELETE FROM profiles WHERE key=?').run(key);
    }
    if (this.key !== this.rootKey) {
      for (const { slot, envelope } of this.sql("SELECT slot,envelope FROM social_outbox WHERE slot IN ('card','announce')").all()) {
        const m = JSON.parse(envelope).message;
        if (reservedHandle((m.card ?? m).handle)) this.sql('DELETE FROM social_outbox WHERE slot=?').run(slot);
      }
    }
    this.setState('reservedHandlesRoot', this.rootKey);
  }
  activeFollows() {
    return this.sql('SELECT key FROM follows ORDER BY rowid LIMIT ?').all(this.limits.followCap);
  }
  hidden(key) {
    return Boolean(this.sql('SELECT 1 FROM social_hidden WHERE key = ?').get(key));
  }
  followed(key) {
    return !!this.sql('SELECT 1 FROM follows WHERE key=?').get(key);
  }
  mayMention(key, now) {
    return key === this.key || key === this.rootKey || this.followed(key) ||
      !!this.sql('SELECT 1 FROM directory WHERE key=? AND last_seen>=?').get(key, now - 7 * DAY);
  }
  ownHandle() {
    return this.sql('SELECT handle FROM profiles WHERE key=?').get(this.key)?.handle;
  }
  mentionsMe(text) {
    const own = this.ownHandle();
    return !!own && extractText(text).handles.includes(own);
  }
  resolveHandle(input, own = this.ownHandle()) {
    if (typeof input !== 'string') return null;
    const handle = input.replace(/^@/, '').toLowerCase();
    if (!isHandle(handle)) return null;
    if (handle === own) return this.key;
    const rows = this.sql(`SELECT p.key, EXISTS(SELECT 1 FROM follows f WHERE f.key=p.key) AS followed,
      EXISTS(SELECT 1 FROM json_each(p.verified) WHERE value=1) AS verified FROM profiles p
      WHERE p.handle=? AND p.key NOT IN social_hidden
      ORDER BY followed DESC, verified DESC, p.key LIMIT 2`).all(handle);
    if (!rows.length || (rows[1] && rows[0].followed === rows[1].followed && rows[0].verified === rows[1].verified)) return null;
    return rows[0].key;
  }
  handles(text) {
    const own = this.ownHandle() ?? null;
    return extractText(text).handles.map(h => this.resolveHandle(h, own)).filter(Boolean);
  }
  initializeContacts(now) {
    if (this.state('contactsInitialized')) return;
    this.sql(`INSERT OR IGNORE INTO social_contacts SELECT author FROM social_mentions WHERE key=? AND (author IN (SELECT key FROM profiles) OR author IN follows)
      UNION SELECT key FROM social_mentions WHERE author=?
      UNION SELECT parent_key FROM posts WHERE key=? AND parent_key IS NOT NULL
      UNION SELECT target_key FROM posts WHERE key=? AND target_key IS NOT NULL
      UNION SELECT target_key FROM likes WHERE key=?`).run(this.key, this.key, this.key, this.key, this.key);
    this.sql(`DELETE FROM social_mentions WHERE key=? AND author NOT IN (?,?)
      AND author NOT IN follows AND author NOT IN (SELECT key FROM directory WHERE last_seen>=?)`)
      .run(this.key, this.key, this.rootKey, now - 7 * DAY);
    this.setState('contactsInitialized', true);
  }
  rememberContact(key) {
    if (key !== this.key) this.sql('INSERT OR IGNORE INTO social_contacts VALUES(?)').run(key);
  }
  upsertCard(key, card, ts, id, lane, now) {
    const previous = this.sql('SELECT ts,card_id,card,verified,proof_checked FROM profiles WHERE key = ?').get(key);
    if (previous && (id === previous.card_id || ts < previous.ts || (ts === previous.ts && id <= previous.card_id))) return;
    const verified = previous ? JSON.parse(previous.verified) : {};
    const old = previous ? JSON.parse(previous.card).proofs : {};
    for (const kind of Object.keys(verified)) if (old?.[kind] !== card.proofs?.[kind]) delete verified[kind];
    const sameProofs = ['dns', 'github'].every(kind => old?.[kind] === card.proofs?.[kind]);
    this.sql(`INSERT INTO profiles(key,handle,card,ts,card_id,verified,proof_checked,inbound_lane,received_at,avatar) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET handle=excluded.handle, card=excluded.card, ts=excluded.ts,
      card_id=excluded.card_id, verified=excluded.verified, proof_checked=excluded.proof_checked,
      inbound_lane=excluded.inbound_lane,received_at=excluded.received_at,avatar=excluded.avatar`)
      .run(key, card.handle, JSON.stringify(card), ts, id, JSON.stringify(verified), sameProofs ? previous?.proof_checked ?? null : null, lane, now,
        card.avatar ? avatarHash(card.avatar) : null);
  }
  announce(e, now) {
    const { card, topics } = e.message;
    const current = this.sql('SELECT ts,id FROM directory WHERE key=?').get(e.from);
    const ts = Math.min(now, e.ts);
    this.upsertCard(e.from, card, ts, e.id, 'directory', now);
    if (current && (current.id === e.id || current.ts > ts || (current.ts === ts && current.id >= e.id))) {
      if (e.id === current.id) this.sql('UPDATE directory SET last_seen=? WHERE key=?').run(now, e.from);
      return;
    }
    this.sql(`INSERT INTO directory(key,topics,ts,id,arrival,last_seen) VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE
      SET topics=excluded.topics, ts=excluded.ts, id=excluded.id, arrival=excluded.arrival, last_seen=excluded.last_seen`)
      .run(e.from, JSON.stringify(topics), ts, e.id, this.arrival(), now);
    this.trimDirectory();
  }
  trimDirectory() {
    const excess = this.sql('SELECT count(*) AS n FROM directory').get().n - this.limits.directoryCap;
    if (excess <= 0) return;
    for (const row of this.sql('SELECT key FROM directory WHERE key<>? ORDER BY last_seen,arrival LIMIT ?').all(this.key, excess)) {
      this.sql('DELETE FROM directory WHERE key=?').run(row.key);
      this.sql('DELETE FROM profiles WHERE key=? AND key NOT IN (?,?) AND key NOT IN follows AND key NOT IN social_contacts').run(row.key, this.key, this.rootKey);
    }
  }
  visibleEnvelope(ref) {
    return this.sql(`SELECT envelope FROM ${visiblePosts} WHERE key=? AND id=?`).get(ref.key, ref.id);
  }
  recentPublicPosts(since) {
    return this.sql(`SELECT key,id,envelope FROM ${visiblePosts} WHERE t='post' AND channel='soc/u/' || key
      AND ts>=? ORDER BY ts DESC,id DESC,key DESC LIMIT 20`).all(since);
  }
  revoked(id) {
    return !!this.sql('SELECT 1 FROM social_revocations WHERE root=? AND id=?').get(this.rootKey, id);
  }
  controls(e) {
    const m = e.message;
    if (m.t === 'revoke') {
      this.sql('INSERT OR IGNORE INTO social_revocations VALUES(?,?)').run(e.from, m.id);
      this.sql(`DELETE FROM social_outbox WHERE slot IN (SELECT 'post/' || id FROM posts
        WHERE key=? AND t='repost' AND target_key=? AND target_id=?)`).run(this.key, e.from, m.id);
      this.sql("DELETE FROM posts WHERE key=? AND id=? AND t='notice'").run(e.from, m.id);
      this.sql("DELETE FROM posts WHERE target_key=? AND target_id=? AND t='repost'").run(e.from, m.id);
      return;
    }
    if (m.t === 'net') {
      if (m.seq <= (this.state('net')?.seq ?? -1)) return;
      this.setState('net', m);
      return { settingsChanged: true };
    }
    for (const [keys, muted] of [[m.add, 1], [m.remove, 0]]) {
      for (const key of keys) this.sql(`INSERT INTO social_root_mutes VALUES(?,?,?) ON CONFLICT(key)
        DO UPDATE SET seq=excluded.seq, muted=excluded.muted WHERE excluded.seq > social_root_mutes.seq`).run(key, m.seq, muted);
    }
  }
  canSend(key, message, now, rates) {
    const { bucket, fingerprint } = budgetFor(message);
    return this.withinLimits(key, bucket, fingerprint, now, rates);
  }
  withinLimits(key, bucket, fingerprint, now, rates) {
    if (bucket) {
      const since = now - this.limits.windowMs;
      // Seen rows can be evicted. Recent admitted actions keep their rate charge for the full window.
      const seen = this.sql('SELECT count(*) n FROM social_seen WHERE key=? AND bucket=? AND first_at>?').get(key, bucket, since);
      const inbound = this.sql('SELECT count(*) n FROM social_inbound WHERE key=? AND bucket=? AND at>?').get(key, bucket, since);
      if (Math.max(seen.n, inbound.n) >= rates[bucket]) return false;
    }
    if (fingerprint && this.sql('SELECT fingerprint FROM social_seen WHERE key=? AND bucket=\'posts\' AND first_at>? AND fingerprint IS NOT NULL')
      .all(key, now - this.limits.nearDuplicateMs).some(row => near(row.fingerprint, fingerprint))) return false;
    return true;
  }
  matchesCopy(prior, e, id, now) {
    const stored = JSON.parse(prior.envelope);
    if (e.id === stored.id && e.channel === stored.channel) return true;
    const a = stored.message;
    const b = e.message;
    const target = a.parent ?? a.target;
    const incoming = b.parent ?? b.target;
    if (!['reply', 'repost'].includes(a.t) || b.t !== a.t || a.text !== b.text ||
        target.key !== incoming?.key || target.id !== incoming.id) return false;
    // Each action can have one canonical author-lane envelope and one signed reply-lane echo.
    // Other newly minted IDs aren't duplicates and must not inherit the original's budget.
    const own = 'soc/u/' + e.from;
    if (e.channel === own) return stored.channel !== own && e.id === id;
    if (stored.channel !== own || b.sourceId !== id) return false;
    return !this.sql('SELECT 1 FROM social_seen WHERE key=? AND post_id=? AND id<>? AND first_at>? LIMIT 1')
      .get(e.from, id, id, now - DAY);
  }
  receive(e, now, rates, lane) {
    // Keep root control traffic independent of notice history. All limits use the wire lane, including mention wrappers.
    if (['revoke', 'mutes', 'net'].includes(e.message.t)) lane = 'control';
    // Anyone can rewrap even our own signed posts. Public receipts share one inbound budget.
    if (e.from === this.key && lane !== 'public') return this.record(e, now, rates, lane);
    const receipt = this.retention.admit(lane, now);
    if (!receipt) return;
    // A protected card may grow when the lane already contains only retained cards.
    // Roll back that update while keeping the inbound rate charge.
    this.writer.exec('SAVEPOINT social_admission');
    try {
      const result = this.record(e, now, rates, lane, receipt);
      if (this.retention.enforce(lane)) return result;
      this.writer.exec('ROLLBACK TO social_admission');
    } finally {
      this.writer.exec('RELEASE social_admission');
    }
  }
  record(e, now, rates, lane, receipt) {
    const ts = Math.min(e.ts, now);
    const m = e.message;
    const control = m.t === 'net' || m.t === 'mutes' || m.t === 'revoke';
    const notice = m.t === 'notice' ? m : m.original?.message;
    const expires = notice?.t === 'notice' ? notice.expires ?? null : null;
    if (expires !== null && expires <= now) return;
    if (m.t === 'notice' && this.revoked(e.id)) return;
    if (m.t === 'repost' && m.target.key === this.rootKey && this.revoked(m.target.id)) return;
    if (!control && (this.hidden(e.from) || [m.target, m.parent, m.quote].some(ref => ref && this.hidden(ref.key)))) return;
    const dup = this.sql('SELECT first_at,post_id FROM social_seen WHERE key=? AND id=?').get(e.from, e.id);
    if (dup && dup.first_at > now - DAY) {
      if (m.t === 'announce') this.sql('UPDATE directory SET last_seen=? WHERE key=? AND id=?').run(now, e.from, e.id);
      this.sql('UPDATE social_seen SET copies=copies+1 WHERE key=? AND id=?').run(e.from, e.id);
      if (dup.post_id) this.sql('UPDATE posts SET copies=copies+1 WHERE key=? AND id=?').run(e.from, dup.post_id);
      return;
    }
    const id = m.sourceId ?? e.id;
    const isPost = postTypes.has(m.t);
    const prior = isPost && this.sql('SELECT channel,envelope FROM posts WHERE key=? AND id=?').get(e.from, id);
    if (prior && !this.matchesCopy(prior, e, id, now)) return;
    const { bucket, fingerprint } = prior ? { bucket: null, fingerprint: null } : budgetFor(m);
    if (!this.withinLimits(e.from, bucket, fingerprint, now, rates)) return;
    if (receipt && bucket) {
      this.sql('UPDATE social_inbound SET key=?,bucket=? WHERE rowid=?').run(e.from, bucket, receipt);
    }
    this.sql(`INSERT INTO social_seen(key,id,first_at,bucket,fingerprint,post_id,inbound_lane) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(key,id) DO UPDATE SET first_at=excluded.first_at,bucket=excluded.bucket,fingerprint=excluded.fingerprint,
      post_id=excluded.post_id,inbound_lane=excluded.inbound_lane,copies=1`)
      .run(e.from, e.id, now, bucket, fingerprint, isPost ? id : null, lane);
    if (control) return this.controls(e);
    if (prior) {
      if (e.channel.startsWith('soc/u/') && !prior.channel.startsWith('soc/u/')) {
        this.sql('UPDATE posts SET channel=?,ts=?,envelope=?,notice_expires=?,inbound_lane=?,copies=copies+1 WHERE key=? AND id=?')
          .run(e.channel, ts, JSON.stringify(e), expires, lane, e.from, id);
      } else this.sql('UPDATE posts SET copies=copies+1 WHERE key=? AND id=?').run(e.from, id);
      return;
    }
    const { t, v, ...card } = m;
    if (t === 'card') this.upsertCard(e.from, card, ts, e.id, lane, now);
    if (t === 'announce') this.announce(e, now);
    if (t === 'like') this.sql('INSERT OR IGNORE INTO likes(key,target_key,target_id,ts,inbound_lane,received_at) VALUES(?,?,?,?,?,?)')
      .run(e.from, m.target.key, m.target.id, ts, lane, now);
    if (e.from === this.key) {
      for (const ref of [m.target, m.quote, m.parent]) if (ref) this.rememberContact(ref.key);
    }
    if (isPost) {
      const target = m.target ?? m.quote;
      const inserted = this.sql(`INSERT OR IGNORE INTO posts(key,id,channel,t,ts,text,envelope,arrival,parent_key,parent_id,target_key,target_id,notice_expires,inbound_lane,received_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(e.from, id, e.channel, t, ts, m.text ?? '', JSON.stringify(e), this.arrival(),
        m.parent?.key ?? null, m.parent?.id ?? null, target?.key ?? null, target?.id ?? null, expires, lane, now);
      if (!inserted.changes) return;
      const mentioned = new Set(m.text ? this.handles(m.text) : []);
      if (m.parent) mentioned.add(m.parent.key);
      if (mentioned.has(this.key)) {
        if (this.mayMention(e.from, now)) this.rememberContact(e.from);
        else mentioned.delete(this.key);
      }
      if (e.from === this.key) for (const key of mentioned) this.rememberContact(key);
      for (const key of mentioned) this.sql('INSERT INTO social_mentions(author,id,key) VALUES(?,?,?)').run(e.from, id, key);
      this.outbox(e, now);
      return { ref: { key: e.from, id }, mention: mentioned.has(this.key), mentioned };
    }
    this.outbox(e, now);
    if (card.proofs || m.card?.proofs) return { proofKey: e.from };
  }
  outbox(e, now) {
    if (e.from !== this.key) return;
    const t = e.message.t;
    let slot;
    if (['card', 'announce'].includes(t)) slot = t;
    else if (['post', 'reply', 'repost'].includes(t) && e.channel === 'soc/u/' + this.key) slot = 'post/' + e.id;
    if (slot) this.sql(`INSERT INTO social_outbox(slot,envelope,last_sent,ts) VALUES(?,?,?,?)
      ON CONFLICT(slot) DO UPDATE SET envelope=excluded.envelope,last_sent=excluded.last_sent,ts=excluded.ts
      WHERE excluded.ts>social_outbox.ts OR (excluded.ts=social_outbox.ts AND
        json_extract(excluded.envelope,'$.id')>=json_extract(social_outbox.envelope,'$.id'))`).run(slot, JSON.stringify(e), now, e.ts);
  }
  saveShare(wrapper, now) {
    const id = wrapper.message.original.id;
    this.sql(`INSERT OR IGNORE INTO social_outbox(slot,envelope,last_sent,ts)
      SELECT ?,?,?,ts FROM social_outbox WHERE slot=?`).run('share/' + id, JSON.stringify(wrapper), now, 'post/' + id);
  }
  ref(input) {
    if (input && typeof input === 'object') {
      const ref = { key: input.key, id: input.id };
      if (isRef(ref)) return ref;
    }
    if (typeof input !== 'string') throw new TypeError('Expected an id or {key,id}');
    const posts = this.sql(`SELECT key,id FROM ${visiblePosts} WHERE id=? LIMIT 2`, this.reader).all(input);
    if (posts.length) return posts.length === 1 ? { ...posts[0] } : null;
    const references = this.sql(`SELECT parent_key AS key FROM ${visiblePosts} WHERE parent_id=?
      UNION SELECT target_key FROM ${visiblePosts} WHERE target_id=?
      UNION SELECT target_key FROM likes WHERE target_id=? AND key NOT IN social_hidden AND target_key NOT IN social_hidden LIMIT 2`, this.reader)
      .all(input, input, input);
    return references.length === 1 ? { key: references[0].key, id: input } : null;
  }
  counts(input) {
    const ref = this.ref(input);
    if (!ref || this.hidden(ref.key)) return { likes: 0, replies: 0, reposts: 0 };
    const params = [ref.key, ref.id];
    return {
      likes: this.sql('SELECT count(*) n FROM likes WHERE target_key=? AND target_id=? AND key NOT IN social_hidden', this.reader).get(...params).n,
      replies: this.sql(`SELECT count(*) n FROM ${visiblePosts} WHERE parent_key=? AND parent_id=?`, this.reader).get(...params).n,
      reposts: this.sql(`SELECT count(*) n FROM ${visiblePosts} WHERE t='repost' AND target_key=? AND target_id=?`, this.reader).get(...params).n,
    };
  }
  /** The stored signed card as published, including an inline avatar. */
  card(key) {
    const row = this.sql('SELECT card FROM profiles WHERE key=?', this.reader).get(key);
    return row ? JSON.parse(row.card) : null;
  }
  /** An avatar by SHA-256 from any stored card that carries it. */
  avatar(hash) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null;
    for (const row of this.sql('SELECT card FROM profiles WHERE avatar=? LIMIT 4', this.reader).all(hash)) {
      const image = parseAvatar(JSON.parse(row.card).avatar);
      if (image?.hash === hash) return image;
    }
    return null;
  }
  profile(key) {
    const p = this.sql('SELECT card,verified,proof_checked,ts,avatar FROM profiles WHERE key=?', this.reader).get(key);
    if (!p) return null;
    const proofStatus = JSON.parse(p.verified);
    // Readers get the avatar's SHA-256; the image itself comes from avatar(hash).
    const { avatar, ...card } = JSON.parse(p.card);
    return { ...card, ...(p.avatar && { avatar: p.avatar }), key, ts: p.ts, proofStatus, proofChecked: p.proof_checked,
      verified: Object.values(proofStatus).some(Boolean),
      following: !!this.sql('SELECT 1 FROM (SELECT key FROM follows ORDER BY rowid LIMIT ?) WHERE key=?', this.reader)
        .get(this.limits.followCap, key), muted: this.hidden(key) };
  }
  present(row) {
    const m = JSON.parse(row.envelope).message;
    const profile = this.profile(row.key);
    const { tags, tickers } = extractText(row.text);
    const symbols = new Map(tickers.map(t => [t.sym, t]));
    for (const t of m.tickers ?? []) symbols.set(t.sym, t);
    return { ...m, kind: m.t === 'notice' ? 'official' : m.t, id: row.id, key: row.key, ts: row.ts, channel: row.channel,
      author: profile?.name ?? profile?.handle ?? row.key, handle: profile?.handle ?? null,
      verified: profile?.verified || row.channel === 'soc/official' || row.channel.startsWith('soc/p/'),
      tags: [...new Set([...tags, ...(m.tags ?? [])])], tickers: [...symbols.values()],
      copies: row.copies, arrival: row.arrival, ...this.counts({ key: row.key, id: row.id }) };
  }
  directory({ q = '', before = Number.MAX_SAFE_INTEGER, limit = 50 } = {}) {
    if (typeof q !== 'string') throw new TypeError('Invalid directory query');
    return this.sql(`SELECT d.*,p.card FROM directory d JOIN profiles p USING(key)
      WHERE d.key NOT IN social_hidden AND (d.ts,d.id,d.key)<(?,?,?) AND instr(lower(p.handle || ' ' ||
        coalesce(json_extract(p.card,'$.name'),'') || ' ' || coalesce(json_extract(p.card,'$.bio'),'') || ' ' || d.topics || ' ' || d.key),lower(?))>0
      ORDER BY d.ts DESC,d.id DESC,d.key DESC LIMIT ?`, this.reader).all(...cursor(before), q, pageSize(limit)).map(row => ({
        ...this.profile(row.key), id: row.id, topics: JSON.parse(row.topics), ts: row.ts, arrival: row.arrival
      }));
  }
  timeline({ scope = 'following', key = this.key, before = Number.MAX_SAFE_INTEGER, limit = 50 } = {}) {
    if (scope === 'directory') return this.directory({ before, limit });
    const filters = {
      latest: ["p.t IN ('post','repost')"],
      following: ["(p.key=? OR p.key IN (SELECT key FROM follows ORDER BY rowid LIMIT ?) OR p.channel='soc/official' OR p.channel LIKE 'soc/p/%')", this.key, this.limits.followCap],
      official: ["p.channel='soc/official' AND p.t='notice'"],
      profile: ['p.key=?', key], mentions: ['EXISTS(SELECT 1 FROM social_mentions m WHERE m.author=p.key AND m.id=p.id AND m.key=?)', key]
    };
    if (!Object.hasOwn(filters, scope)) throw new TypeError('Unknown timeline scope');
    const [where, ...params] = filters[scope];
    return this.sql(`SELECT p.* FROM ${visiblePosts} p WHERE ${where} AND (p.ts,p.id,p.key)<(?,?,?) ORDER BY p.ts DESC,p.id DESC,p.key DESC LIMIT ?`, this.reader)
      .all(...params, ...cursor(before), pageSize(limit)).map(row => this.present(row));
  }
  thread(input) {
    const ref = this.ref(input);
    if (!ref) return [];
    return this.sql(`WITH RECURSIVE ancestors(key,id) AS (
      VALUES(?,?) UNION
      SELECT p.parent_key,p.parent_id FROM ${visiblePosts} p JOIN ancestors a ON p.key=a.key AND p.id=a.id
      WHERE p.parent_id IS NOT NULL LIMIT 500
    ), tree(key,id) AS (
      SELECT key,id FROM ancestors UNION
      SELECT p.key,p.id FROM ${visiblePosts} p JOIN tree t ON p.parent_key=t.key AND p.parent_id=t.id LIMIT 500
    ) SELECT p.* FROM tree JOIN ${visiblePosts} p USING(key,id) ORDER BY p.ts,p.id,p.key`, this.reader)
      .all(ref.key, ref.id).map(row => this.present(row));
  }
  prune(now) {
    this.trimDirectory();
    this.sql('DELETE FROM social_inbound WHERE at<=?').run(now - this.limits.windowMs);
    this.sql("DELETE FROM social_outbox WHERE slot IN (SELECT 'post/' || id FROM posts WHERE key=? AND notice_expires<=?)")
      .run(this.key, now);
    this.sql('DELETE FROM posts WHERE notice_expires<=?').run(now);
    this.sql('DELETE FROM social_seen WHERE first_at<=?').run(now - DAY);
    this.sql("DELETE FROM posts WHERE channel<>'soc/official' AND ts<?").run(now - 30 * DAY);
    this.sql('DELETE FROM likes WHERE ts<?').run(now - 30 * DAY);
    this.sql("DELETE FROM social_outbox WHERE slot LIKE 'post/%' AND (ts<? OR slot NOT IN (SELECT slot FROM social_outbox WHERE slot LIKE 'post/%' ORDER BY ts DESC,slot DESC LIMIT 100))").run(now - 7 * DAY);
    this.sql(`DELETE FROM social_outbox AS share WHERE slot LIKE 'share/%' AND NOT EXISTS
      (SELECT 1 FROM social_outbox WHERE slot='post/' || substr(share.slot,7))`).run();
  }
}
