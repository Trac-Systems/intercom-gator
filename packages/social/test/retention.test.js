import assert from 'node:assert/strict';
import test from 'node:test';
import { openStore } from '@gator/store';
import { fitBudget } from '../../store/src/prune.js';
import { Social, migrations } from '../src/index.js';
import { Hub } from './hub.js';

function environment(t, applied = migrations) {
  const hub = new Hub(), net = hub.peer(), root = hub.peer();
  const store = openStore({ file: ':memory:', profile: 'small', migrations: applied });
  let social;
  t.after(async () => { await social?.close(); store.close(); });
  return { hub, net, root, store, async start(limits) {
    social = new Social({ db: store, transport: net, rootKey: root.publicKey, clock: () => hub.now,
      dataDir: import.meta.dirname, proofs: false, limits });
    await social.ready;
    return social;
  } };
}

test('legacy profiles, mention history, clamped times and lane counters migrate on first open', async t => {
  const { hub, net, store, start } = environment(t, migrations.slice(0, 2));
  const me = net.publicKey, known = hub.peer().publicKey, stranger = hub.peer().publicKey;
  const later = hub.now + 60_000;
  const writer = store.writer;
  const addCard = (key, handle) => {
    const data = { handle, harnesses: [] };
    writer.prepare('INSERT INTO profiles(key,handle,card,ts,card_id) VALUES(?,?,?,?,?)').run(key, handle, JSON.stringify(data), later, key);
    writer.prepare('INSERT INTO directory VALUES(?,?,?,?,?,?)').run(key, '[]', later, key, 1, hub.now);
  };
  addCard(known, 'known');
  addCard(me, 'gator_' + me.slice(0, 12));
  for (const key of [known, stranger]) {
    writer.prepare("INSERT INTO posts(key,id,channel,t,ts,text,envelope,arrival) VALUES(?,?,?,'reply',?,'hello',?,1)")
      .run(key, 'reply', 'soc/r/' + me, later, JSON.stringify({ message: { t: 'reply', text: 'hello' } }));
    writer.prepare('INSERT INTO social_mentions VALUES(?,?,?)').run(key, 'reply', me);
    writer.prepare('INSERT INTO social_seen(key,id,first_at,post_id,bucket) VALUES(?,?,?,?,?)')
      .run(key, 'reply', hub.now, 'reply', 'posts');
  }
  for (const migration of migrations.slice(2)) store.transaction(migration.up);
  const social = await start();
  assert.equal(social.profile(me), null);
  assert.deepEqual(social.timeline({ scope: 'mentions' }).map(r => [r.key, r.ts]), [[known, hub.now]]);
  assert.equal(social.directory()[0].ts, hub.now);
  assert.equal(writer.prepare("SELECT n FROM social_lane_usage WHERE lane='reply'").get().n, 5);
  store.transaction(db => fitBudget(db, 1, hub.now));
  assert.equal(social.profile(known).handle, 'known');
  assert.equal(writer.prepare("SELECT n FROM social_lane_usage WHERE lane='reply'").get().n, 0);
  assert.equal(writer.prepare("SELECT bytes FROM social_lane_usage WHERE lane='reply'").get().bytes, 0);
  assert.equal(writer.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('disk pressure evicts unfollowed rows before followed rows and preserves own rows and contact cards', async t => {
  const { hub, net, store, start } = environment(t);
  const social = await start();
  const me = net.publicKey;
  const followed = hub.peer(), other = hub.peer(), contact = hub.peer();
  await social.follow(followed.publicKey);
  for (const [sender, handle] of [[followed, 'known'], [other, 'other'], [contact, 'contact']]) {
    const channel = 'soc/u/' + sender.publicKey;
    sender.deliver(sender.envelope('soc/dir', { t: 'announce', v: 1, channel, card: { handle, harnesses: [] }, topics: [] }));
    const target = { key: me, id: 'one' };
    sender.deliver(sender.envelope('soc/r/' + me, { t: 'reply', v: 1, text: 'hello', parent: target }));
    sender.deliver(sender.envelope('soc/r/' + me, { t: 'like', v: 1, target }));
    hub.now++;
  }
  // The local user also interacted with a peer whose posts they never received.
  const liked = hub.peer();
  liked.deliver(liked.envelope('soc/dir', { t: 'announce', v: 1, channel: 'soc/u/' + liked.publicKey,
    card: { handle: 'liked', harnesses: [] }, topics: [] }));
  await social.like({ key: liked.publicKey, id: 'saved' });
  await social.setCard({ handle: 'local', harnesses: [] });
  await social.post('local history');
  const db = store.writer;
  db.exec(`CREATE TEMP TABLE removed (key TEXT);
    CREATE TEMP TRIGGER log_order BEFORE DELETE ON posts BEGIN INSERT INTO removed VALUES(OLD.key); END;`);
  store.transaction(writer => fitBudget(writer, 1, hub.now));
  assert.deepEqual(db.prepare('SELECT key FROM removed ORDER BY rowid').all().map(r => r.key),
    [other.publicKey, contact.publicKey, followed.publicKey]);
  for (const [table, expected] of [['posts', 1], ['likes', 1], ['social_seen', 5]]) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE key=?`).get(me).n, expected);
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE key<>?`).get(me).n, 0);
  }
  for (const key of [me, followed.publicKey, other.publicKey, contact.publicKey, liked.publicKey]) assert.ok(social.profile(key));
  assert.equal(social.directory({ q: 'local' })[0].key, me);
});

test('evicting seen rows leaves the current inbound author rate charge intact', async t => {
  const { hub, net, store, start } = environment(t);
  const social = await start({ rates: { posts: 1 }, windowMs: 1000 });
  const sender = hub.peer();
  const reply = text => sender.deliver(sender.envelope('soc/r/' + net.publicKey,
    { t: 'reply', v: 1, text, parent: { key: net.publicKey, id: 'one' } }));
  const rows = () => social.timeline({ scope: 'profile', key: sender.publicKey });
  reply('First reply');
  assert.equal(rows().length, 1);
  store.transaction(db => fitBudget(db, 1, hub.now));
  reply('Second reply');
  assert.equal(rows().length, 0);
  hub.now += 1000;
  reply('Third reply');
  assert.equal(rows()[0].text, 'Third reply');
});

test('a steady target below the profile ceiling leaves social history alone; the ceiling still relieves it', async t => {
  const { hub, net, store, start } = environment(t);
  const social = await start();
  const me = net.publicKey, followed = hub.peer(), other = hub.peer();
  await social.follow(followed.publicKey);
  for (const sender of [followed, other]) {
    sender.deliver(sender.envelope('soc/r/' + me, { t: 'reply', v: 1, text: 'hello', parent: { key: me, id: 'one' } }));
    hub.now++;
  }
  const others = () => store.writer.prepare('SELECT count(*) AS n FROM posts WHERE key<>?').get(me).n;
  assert.equal(others(), 2);
  // v0.1.0 ran this evictor against 295 MB on every maintenance pass and kept only the user's own rows.
  store.transaction(db => fitBudget(db, 1, hub.now, 256, Number.MAX_SAFE_INTEGER));
  assert.equal(others(), 2);
  store.transaction(db => fitBudget(db, 1, hub.now));
  assert.equal(others(), 0);
});
