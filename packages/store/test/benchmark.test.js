import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './fixture.js';

test('100k observations and 100k aggregate price samples commit to WAL with all four candle resolutions', t => {
  const store = fixture(t);
  const markets = Array.from({ length: 20 }, (_, i) => 'cex:fixture:S' + i + '-USD');
  store.transaction(() => {
    for (const [i, id] of markets.entries()) {
      const asset = 'test:' + i, base = 'S' + i;
      store.upsertAsset({ id: asset, symbol: base, name: base });
      store.upsertMarket({ id, base, quote: 'USD', exchange: 'fixture', kind: 'cex' });
      store.linkAssetMarket(asset, id);
    }
  });
  const rows = Array.from({ length: 100_000 }, (_, i) => {
    const tick = Math.floor(i / markets.length);
    const srcTs = 1_728_000_000_000 + tick * 15_000;
    return { market: markets[i % markets.length], reporter: 'fixture-' + tick % 5,
      srcTs, at: srcTs, price: String(10 + i % 1000) + '.123456789', baseVol24h: '12000' };
  });

  const start = performance.now();
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    inserted += store.insertObservations(batch);
    store.recordPrices(batch.map(r => ({ asset: 'test:' + markets.indexOf(r.market), price: r.price, at: r.srcTs })));
  }
  const elapsed = performance.now() - start;
  t.diagnostic('100,000 source receipts + 100,000 price samples, 1,000 commits: ' + elapsed.toFixed(1) + ' ms (' +
    Math.round(inserted * 1000 / elapsed).toLocaleString('en-US') + ' observations/s)');
  assert.equal(inserted, 100_000);
  assert.ok(store.reader.prepare('SELECT count(*) AS n FROM obs').get().n < inserted / 8);
  assert.equal(store.reader.prepare('SELECT sum(reports) AS n FROM store_report_activity').get().n, inserted);
  const frames = store.reader.prepare('SELECT tf,sum(samples) AS n FROM candles GROUP BY tf').all();
  assert.equal(frames.length, 4);
  for (const frame of frames) assert.equal(frame.n, inserted, frame.tf);
  assert.equal(store.reader.prepare('PRAGMA quick_check').get().quick_check, 'ok');
});
