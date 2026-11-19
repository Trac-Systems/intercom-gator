import test from 'node:test';
import assert from 'node:assert/strict';
import { httpClient } from '../src/client.js';
import { fixture } from './fixtures.js';

test('exchange and derivative HTTP rows carry engine evidence, chain names and asset IDs through pagination', async t => {
  let now = Date.now();
  const app = await fixture(t).start('exchange-queries', { clock: () => now });
  const { engine } = app;
  const api = httpClient(app.dataDir);
  const pairs = [['BTC', 'USD', '100'], ['ETH', 'USD', '10'], ['ETH', 'BTC', '0.1']];
  function ingest(volume) {
    const rows = pairs.map(([base, quote, price]) => [
      engine.registry.cex('bitstamp', base, quote).id, price, '1', volume, price, price, now,
    ]);
    engine.book.ingest(engine.book.ownKey, rows, true);
  }
  engine.registry.register({ id: 'dex:ethereum:pool', exchange: 'swap', kind: 'dex',
    chain: 'ethereum', base: 'ethereum:native', quote: 'bitcoin:native' });
  ingest(100);
  const first = (await api('GET', '/exchanges', { kind: 'cex' })).items[0];
  assert.equal(first.reporters, 1);
  assert.equal(first.trustScore, 8);
  assert.deepEqual(first.trustWhy, { agreement: 5, freshness: 2, confirmation: 0, book: 1, comparedMarkets: 3 });
  assert.equal(first.change24h, null);
  const venues = await api('GET', '/exchanges');
  assert.deepEqual(venues.items.map(row => row.id), ['bitstamp']);
  assert.deepEqual(venues.hidden, { stale: 1, unconfirmed: 0, dust: 0 });
  const dex = (await api('GET', '/exchanges', { offset: 1, limit: 1, include: 'hidden' })).items[0];
  assert.equal(dex.chain, engine.registry.chains.get('ethereum').name);
  assert.equal(dex.trustScore, null);
  now += 86_400_000;
  ingest(200);
  assert.equal((await api('GET', '/exchanges', { kind: 'CEX' })).items[0].change24h, 100);
  engine.saveDerivative('bitstamp', 'btcusd-perp', 0.01, 17, now);
  engine.saveDerivative('bitstamp', 'unlistedusd-perp', 0.02, 18, now);
  const expected = engine.derivatives();
  assert.deepEqual(expected.map(d => d.asset), ['bitcoin:native', null]);
  for (const [offset, row] of expected.entries()) {
    assert.deepEqual((await api('GET', '/derivatives', { offset, limit: 1 })).items, [row]);
  }
});
