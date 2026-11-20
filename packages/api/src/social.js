import { extractText } from '@gator/social';
import { isRef } from '../../social/src/validate.js';
import { isKey } from '../../dashboard/public/js/lib/text.js';
import { check } from './local.js';

/** Read only locally visible rows. Ids are scoped to the signed author. */
export function socialViews(app) {
  const { store: { reader, writer }, social, engine } = app;
  const own = app.transport.publicKey, root = app.release.rootKey;
  const rowFor = reader.prepare('SELECT * FROM social_visible_posts WHERE key=? AND id=?');
  const has = (query, ...params) => !!reader.prepare(query).get(...params);
  const muted = key => has('SELECT 1 FROM social_hidden WHERE key=?', key);
  const followed = key => key === root || has('SELECT 1 FROM follows WHERE key=?', key);
  function resolveKey(input) {
    if (input === 'me') return own;
    if (isKey(input)) return input;
    const rows = reader.prepare('SELECT key FROM profiles WHERE handle=? AND key NOT IN social_hidden LIMIT 2')
      .all(String(input).replace(/^@/, ''));
    check(rows.length < 2, 'ambiguous handle', 409);
    check(rows.length, 'unknown key', 404);
    return rows[0].key;
  }
  function profile(key) {
    const card = social.profile(key);
    const dir = reader.prepare('SELECT topics,last_seen FROM directory WHERE key=?').get(key);
    const counts = reader.prepare('SELECT count(*) AS n,min(ts) AS joined,max(ts) AS seen FROM social_visible_posts WHERE key=?').get(key);
    const official = key === root;
    return { key, name: card?.name || card?.handle || (official ? 'Official' : key.slice(0, 12)),
      handle: card?.handle ? '@' + card.handle : null, bio: card?.bio || '', avatar: card?.avatar ?? null,
      agent: !!card?.harnesses?.length || key === own,
      official, product: null, me: key === own, verified: official || !!card?.verified,
      harnesses: card?.harnesses ?? [], links: card?.links ?? [], proofs: Object.fromEntries(Object.entries(card?.proofs ?? {}).map(([kind, value]) =>
        [kind, { value, ok: !!card.proofStatus?.[kind] }])),
      topics: dir ? JSON.parse(dir.topics) : [], followed: followed(key), muted: muted(key),
      posts: counts.n, followers: key !== own && followed(key) && !official ? 1 : 0,
      following: key === own ? reader.prepare('SELECT count(*) AS n FROM follows').get().n : 0,
      joined: counts.joined ?? card?.ts ?? null, lastSeen: Math.max(counts.seen ?? 0, card?.ts ?? 0, dir?.last_seen ?? 0) || null,
      unknown: !card && !official && key !== own, ...(key === own && elsewhere()) };
  }
  // The own key signed something this process did not send: the identity also runs elsewhere (gator key export).
  function elsewhere() {
    const seen = social.identityElsewhere?.(86_400_000);
    return seen ? { elsewhere: { lastSeen: seen.lastSeen, channel: seen.channel } } : {};
  }
  function decorate(p) {
    const { key, id, ts, channel } = p, card = social.profile(key);
    const product = channel?.startsWith('soc/p/') ? channel.slice(6) : null, official = channel === 'soc/official';
    const text = p.text ?? p.original?.message?.text ?? '';
    const parsed = extractText(text);
    const tickers = new Map(parsed.tickers.map(t => [t.sym, t]));
    for (const t of p.tickers ?? []) tickers.set(t.sym, t);
    return { id, key, ts, text, channel, kind: official ? 'official' : p.t, official, product,
      author: card?.name || card?.handle || (official ? 'Official' : key.slice(0, 12)),
      handle: card?.handle ? '@' + card.handle : null, avatar: card?.avatar ?? null, verified: !!(official || product || card?.verified),
      agent: key === own || !!card?.harnesses?.length, parent: p.parent, quote: p.quote, target: p.target, severity: p.severity,
      tickers: [...tickers.values()].map(t => {
        const ids = engine.registry.symbols.get(t.sym);
        return { sym: t.sym, asset: t.asset ?? (ids?.size === 1 ? [...ids][0] : null) };
      }), tags: p.tags ?? parsed.tags, ...social.counts({ key, id }),
      liked: has('SELECT 1 FROM likes WHERE key=? AND target_key=? AND target_id=?', own, key, id),
      reposted: has("SELECT 1 FROM social_visible_posts WHERE key=? AND target_key=? AND target_id=? AND t='repost'", own, key, id) };
  }
  function fromRow(row) {
    return decorate({ ...JSON.parse(row.envelope).message, key: row.key, id: row.id, channel: row.channel, ts: row.ts });
  }
  function directory(q = {}) {
    const query = (q.q ?? '').replace(/^@/, '');
    const rows = social.directory({ q: query, limit: 100 }).map(r => profile(r.key)).filter(p => !p.me && !p.official);
    if ('official'.includes(query.toLowerCase()) || root.startsWith(query)) rows.unshift(profile(root));
    return { topics: [...new Set(rows.flatMap(p => p.topics))], items: rows.filter(p => !q.topic || p.topics.includes(q.topic)) };
  }
  function thread(ref) {
    check(isRef(ref), 'post not found or expired', 404);
    const rows = social.thread(ref);
    const same = (a, b) => a?.key === b.key && a?.id === b.id;
    const p = rows.find(r => same(r, ref));
    check(p, 'post not found or expired', 404);
    const parents = [], visited = new Set([p]);
    let ancestor = p;
    while (ancestor.parent) {
      ancestor = rows.find(r => same(r, ancestor.parent));
      if (!ancestor || visited.has(ancestor)) break;
      visited.add(ancestor);
      parents.unshift(decorate(ancestor));
    }
    return { post: decorate(p), parents, replies: rows.filter(r => same(r.parent, ref)).map(decorate) };
  }
  function searchPosts(query) {
    return reader.prepare('SELECT * FROM social_visible_posts WHERE instr(lower(text),lower(?))>0 ORDER BY ts DESC LIMIT 5')
      .all(query).map(fromRow);
  }
  function assetPosts(asset, limit) {
    const token = app.store.getAsset(asset);
    if (!token) return [];
    // Explicit asset references outrank ticker labels, which can be ambiguous.
    const rows = reader.prepare(`SELECT * FROM social_visible_posts WHERE instr(upper(text),?)>0 OR EXISTS (
      SELECT 1 FROM json_each(envelope,'$.message.tickers') WHERE json_extract(value,'$.asset')=?
        OR json_extract(value,'$.sym')=?) ORDER BY ts DESC`).iterate('$' + token.symbol.toUpperCase(), asset, token.symbol);
    const result = [];
    for (const row of rows) {
      const post = fromRow(row);
      if (post.tickers.some(t => t.asset === asset)) result.push(post);
      if (result.length === limit) break;
    }
    return result;
  }
  function trending() {
    const counts = new Map();
    const rows = reader.prepare("SELECT text,envelope FROM social_visible_posts WHERE ts>=? AND t IN ('post','reply')")
      .iterate(app.clock() - 86_400_000);
    for (const r of rows) {
      const m = JSON.parse(r.envelope).message, parsed = extractText(r.text);
      const tags = [...(m.tags ?? []), ...parsed.tags].map(t => '#' + t.toLowerCase());
      for (const t of [...(m.tickers ?? []), ...parsed.tickers]) tags.push('$' + t.sym);
      for (const label of new Set(tags)) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0,100).map(([tag,posts]) => ({ tag, posts }));
  }
  function feed(q, limit) {
    if (q.asset) return { items: assetPosts(q.asset, limit) };
    const scope = q.author ? 'profile' : q.lane ?? 'following';
    check(['profile','following','latest','official','mentions'].includes(scope), 'unknown lane');
    if (scope === 'official') {
      const before = Number(q.before ?? Number.MAX_SAFE_INTEGER);
      check(Number.isSafeInteger(before), 'bad range');
      return { items: reader.prepare(`SELECT * FROM social_visible_posts WHERE key=? AND ts<? AND
        ((channel='soc/official' AND t='notice') OR (channel LIKE 'soc/p/%' AND t='post'))
        ORDER BY ts DESC,id DESC LIMIT ?`).all(root,before,limit).map(fromRow) };
    }
    const key = q.author ? resolveKey(q.author) : own;
    return { items: social.timeline({ scope, key, limit, ...(q.before && { before: Number(q.before) }) }).map(decorate) };
  }
  async function write(name, b) {
    if (['posts','replies'].includes(name)) {
      check(typeof b.text === 'string' && b.text.trim(), 'empty');
      check([...b.text].length <= 500, 'too long');
      if (name === 'replies') check(isRef(b.parent), 'parent required');
      const sent = name === 'posts' ? await social.post(b.text) : await social.reply(b.parent, b.text);
      check(sent, 'post refused or rate limited', 429);
      const row = reader.prepare('SELECT * FROM social_visible_posts WHERE key=? AND text=? ORDER BY arrival DESC LIMIT 1').get(own,b.text);
      check(row, 'signed post unavailable', 503);
      return fromRow(row);
    }
    if (['likes','reposts'].includes(name)) {
      check(isRef(b.target), 'target required');
      const { key, id } = b.target, row = rowFor.get(key,id);
      check(row, 'post not found or expired', 404);
      const before = fromRow(row), like = name === 'likes';
      if (b.undo) {
        // Intercom v1 has no retraction message. Remove only the local action and its rebroadcast copy.
        if (like) writer.prepare('DELETE FROM likes WHERE key=? AND target_key=? AND target_id=?').run(own,key,id);
        else app.store.transaction(db => {
          const repost = db.prepare("SELECT id FROM posts WHERE key=? AND t='repost' AND target_key=? AND target_id=?").get(own,key,id);
          if (!repost) return;
          db.prepare('DELETE FROM social_outbox WHERE slot=?').run('post/' + repost.id);
          db.prepare('DELETE FROM posts WHERE key=? AND id=?').run(own,repost.id);
        });
      } else if (!(like ? before.liked : before.reposted)) {
        check(await (like ? social.like(b.target) : social.repost(b.target)), 'action refused or rate limited', 429);
      }
      return fromRow(row);
    }
    if (['follow','unfollow'].includes(name)) {
      const key = resolveKey(b.key);
      check(key !== root || name === 'follow', 'the official channel cannot be unfollowed');
      if (key !== root) await social[name](key);
      return profile(key);
    }
    check(isKey(b.key), 'bad key');
    check(b.key !== root, 'the official channel cannot be muted');
    social[name](b.key);
    return { key: b.key, muted: muted(b.key) };
  }
  return { decorate, directory, feed, fromRow, profile, resolveKey, searchPosts, thread, trending, write,
    follows: () => [profile(root), ...reader.prepare('SELECT key FROM follows WHERE key<>?').all(root).map(r => profile(r.key))],
    mutes: () => reader.prepare("SELECT key, CASE WHEN key IN mutes THEN 'you' ELSE 'official' END AS by FROM social_hidden").all()
      .map(r => ({ ...profile(r.key), by: r.by, ts: null })) };
}
