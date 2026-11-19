import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateRawSync } from 'node:zlib';
import { packHistory, unpackHistory } from '../src/observation-archive.js';
import { openStore } from '../src/index.js';
import { openDatabase } from '../src/database.js';
import { migrations } from '../src/schema.js';
import { storeOpener } from './fixture.js';

const market = 'cex:test:ONE-USD';
const feed = (srcTs, price, extra = {}) => ({ market, reporter: 'self', srcTs, at: srcTs + 20, price, ...extra });
const register = s => s.upsertMarket({ id: market, kind: 'cex', base: 'ONE', quote: 'USD' });

test('refreshes an unchanged quote across reopen, preserves decimal changes and ignores replays inside the span', t => {
  const open = storeOpener(t);
  let s = open();
  register(s);
  const a = feed(100, '1.000000000000000001', { bid: '0.9' });
  const b = { ...a, srcTs: 110, at: 104, baseVol24h: '777' };
  assert.equal(s.insertObservations([a,b]), 2);
  const head = s.observations({ market });
  assert.equal(head.length, 1);
  assert.deepEqual([head[0].srcTs,head[0].at,head[0].baseVol24h], [110,104,'777']);
  s.close();
  s = open();
  const c = { ...b, srcTs: 130, at: 135, ask: '1.01' };
  const d = feed(140, '1.000000000000000002');
  assert.equal(s.insertObservations([c,d,{ ...b, price: '99' }]), 2);
  assert.equal(s.reader.prepare('SELECT count(*) n FROM obs').get().n, 1);
  const quotes = s.observations({ market });
  assert.deepEqual(quotes.map(r => [r.srcTs,r.price,r.bid,r.ask]), [
    [110,a.price,'0.9',null], [130,a.price,'0.9','1.01'], [140,d.price,null,null],
  ]);
  assert.equal(s.nearestObservation(market, 'self', 120, 5), undefined);
  assert.equal(s.nearestObservation(market, 'self', 120, 10).srcTs, 130);
  assert.equal(s.nearestObservation(market, 'self', 100, 0).at, 120);
  assert.equal(s.insertObservations([feed(120,'2'), feed(150,'3')]), 2);
  assert.equal(s.nearestObservation(market, 'self', 120, 0).price, '2');
  assert.equal(s.nearestObservation(market, 'self', 150, 0).price, '3');
  assert.equal(s.reader.prepare('SELECT sum(reports) n FROM store_report_activity').get().n, 6);
  assert.throws(() => s.transaction(() => { s.insertObservations([feed(160,'4')]); throw Error('rollback'); }));
  assert.equal(s.nearestObservation(market, 'self', 160, 0), undefined);
  assert.equal(s.insertObservations([feed(160,'4')]), 1);
});

test('freshness markers, price changes and pagination stay exact across packed block boundaries', t => {
  const s = storeOpener(t)();
  register(s);
  const count = 1400;
  const batch = Array.from({ length: count }, (_, i) => feed(i, String(i), { ask: String(i + 1) }));
  assert.equal(s.insertObservations(batch), count);
  const spans = s.reader.prepare('SELECT count(*) n,max(length(ticks)) bytes FROM obs').get();
  assert.ok(spans.n > 1 && spans.n < count / 20);
  assert.ok(spans.bytes <= 2048);
  assert.deepEqual(s.observations({ market, from: 500, to: 600, offset: 20, limit: 3 })
    .map(r => [r.srcTs,r.price,r.ask]), [[520,'520','521'],[521,'521','522'],[522,'522','523']]);
  assert.equal(s.insertObservations(batch), 0);
});

test('legacy receipt totals migrate once and a large old database shrinks in bounded committed steps', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gator-upgrade-'));
  let s;
  t.after(() => { try { s?.close(); } finally { rmSync(dir, { recursive: true, force: true }); } });
  const file = join(dir,'gator.db'), now = Date.now();
  const old = openDatabase({ file, profile: 'large' }, migrations.slice(0,5));
  try {
    old.writer.prepare("INSERT INTO markets(id,kind,base,quote) VALUES (?,'cex','ONE','USD')").run(market);
    const add = old.writer.prepare('INSERT INTO obs(market,reporter,srcTs,at,price,baseVol24h) VALUES (?,?,?,?,?,?)');
    old.transaction(() => {
      for (let i = 0; i < 9000; i++) add.run(market, 'self', now - 4 * 3_600_000 + i, now, '5', '1'.repeat(1500));
    });
    // A failure later in the migration must restore the old schema as well as the data.
    assert.throws(() => old.transaction(db => {
      migrations[5].up(db);
      assert.equal(db.prepare('PRAGMA writable_schema').get().writable_schema, 0);
      assert.equal(db.prepare('SELECT ordinal FROM obs LIMIT 1').get().ordinal, 0);
      throw new Error('interrupted migration');
    }), /interrupted migration/);
    assert.equal(old.writer.prepare("SELECT 1 FROM pragma_table_xinfo('obs') WHERE name='ordinal'").get(), undefined);
    assert.equal(old.writer.prepare('SELECT max(id) id FROM obs').get().id, 9000);
  } finally { old.close(); }
  const original = statSync(file).size;
  assert.ok(original > 12 * 1024 ** 2);
  s = openStore({ file, profile: 'large' });
  s.close();
  s = openStore({ file, profile: 'large' });
  assert.equal(s.reader.prepare('SELECT reports FROM store_report_activity').get().reports, 9000);
  assert.equal(s.reader.prepare('SELECT at FROM store_reporters_seen').get().at, now);
  const migrated = s.reader.prepare('SELECT id,price,priceReal,ordinal,seq FROM obs ORDER BY id DESC LIMIT 1').get();
  assert.deepEqual({ ...migrated }, { id: 9000, price: '5', priceReal: 5, ordinal: 0, seq: null });
  assert.throws(() => s.writer.prepare(`INSERT INTO obs(market,reporter,srcTs,at,price)
    SELECT market,reporter,srcTs,at,price FROM obs LIMIT 1`).run(), /UNIQUE/);
  const oldIndex = s.reader.prepare("SELECT 1 FROM sqlite_schema WHERE name='obs_market_time'");
  assert.ok(oldIndex.get());
  const size = () => s.reader.prepare('PRAGMA page_count').get().page_count;
  const before = size();
  const first = s.prune({ now });
  assert.ok(first.obs > 0 && first.obs <= 64, 'the cold legacy index starts with a small deletion batch');
  // Incremental vacuum can also remove a pointer-map page per ~819 data pages.
  assert.ok(before - size() <= 1026);
  const remaining = s.reader.prepare('SELECT count(*) n FROM obs').get().n;
  assert.equal(remaining, 9000 - first.obs);
  for (let i = 0; i < 12; i++) {
    const previous = size();
    s.prune({ now });
    assert.ok(previous - size() <= 1026);
  }
  s.writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.equal(oldIndex.get(), undefined);
  assert.equal(s.fileBytes(), statSync(file).size);
  assert.ok(s.fileBytes() < original / 4);
  assert.equal(s.reader.prepare('PRAGMA quick_check').get().quick_check, 'ok');
});

test('hourly counters include the exact millisecond boundary across compact report batches', t => {
  const s = storeOpener(t)();
  register(s);
  const samples = [[1, 1000], [2, 1000], [3, 1007], [4, 1999], [5, 2000]];
  s.insertObservations(samples.map(([ts,at]) => feed(ts,'1',{ at })));
  s.insertObservations([feed(6,'1',{ at: 1007 }),feed(7,'1',{ at: 2000, reporter: 'peer' })]);
  assert.deepEqual([999,1000,1001,1007,1008,1999,2000,2001].map(cut => s.reportsSince('self',cut)),
    [6,6,4,4,2,2,1,0]);
  assert.equal(s.reportsSince('peer',2000),1);
});

test('shared archives retain exact evidence across reopen and release space after the final reference', t => {
  const open = storeOpener(t);
  let s = open();
  register(s);
  const src = (ts, r) => feed(ts, String(ts), { reporter: String(r), ask: String(ts+1) });
  for (let ts = 1; ts <= 150; ts++) {
    s.insertObservations(Array.from({length:32}, (_,r) => src(ts,r)));
  }
  const archived = s.reader.prepare('SELECT count(*) n FROM store_obs_slice').get().n;
  assert.ok(archived >= 30);
  s.close();
  s = open();
  for (const ts of [1,40,90,150]) {
    const found = s.nearestObservation(market,'15',ts,0);
    assert.deepEqual([found.srcTs,found.price,found.ask],[ts,String(ts),String(ts+1)]);
  }
  assert.equal(s.insertObservations([src(40,15)]),0);
  assert.equal(s.prune({now: 4*3_600_000}).obs,32);
  for (const table of ['store_obs_archive','store_obs_slice','store_obs_pending']) {
    assert.equal(s.reader.prepare('SELECT count(*) n FROM '+table).get().n,0);
  }
});

test('quote archives read earlier DEFLATE pages alongside dense pressure pages', () => {
  const bytes = Buffer.from('1.003 1.004 1.003 '.repeat(40));
  for (const packed of [deflateRawSync(bytes, { level: 6 }), packHistory(bytes, false), packHistory(bytes, true)]) {
    assert.deepEqual(unpackHistory(packed), bytes);
  }
});
