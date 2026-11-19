import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { keyFromSeed, MemoryTransport } from '@gator/net';
import { bundleDigest, loadBundle, signBundle } from '@gator/bundle';

export function fixture(t, { paidExtras = {} } = {}) {
  const dir = mkdtempSync(join(import.meta.dirname, 'runtime-'));
  const apps = [];
  t.after(async () => {
    try { for (const app of apps.reverse()) await app.close(); }
    finally { rmSync(dir, { force: true, recursive: true }); }
  });
  const seed = randomBytes(32), root = keyFromSeed(seed.toString('hex'));
  const bundle = structuredClone(loadBundle());
  bundle.exchanges = bundle.exchanges.filter(e => e.id === 'bitstamp');
  bundle.tokens.tokens = bundle.tokens.tokens.filter(t => ['bitcoin:native','ethereum:native'].includes(t.id));
  for (const t of bundle.tokens.tokens) t.links = [];
  bundle.chains = bundle.chains.filter(c => ['bitcoin','ethereum'].includes(c.id));
  // Paid extras stay dormant unless a test passes a contract: the shipped mainnet contract would add RPC reads.
  bundle.paidExtras = Object.fromEntries(bundle.chains.map(c => [c.id, '']));
  Object.assign(bundle.paidExtras, paidExtras);
  bundle.dex.evm = bundle.dex.evm.filter(c => c.chain === 'ethereum');
  const source = join(dir, 'sources');
  mkdirSync(source);
  for (const [name, value] of Object.entries(bundle)) writeFileSync(join(source, name + '.json'), JSON.stringify(value));
  writeFileSync(join(source, 'bundle.sig'), signBundle(bundleDigest(bundle), seed));
  const release = { dir: source, rootKey: root.publicKey.toString('hex') };
  async function start(name, opts = {}) {
    const { createGator } = await import('../src/app.js');
    // readStaleMs 0: tests read a price right after the observation that set it.
    const app = await createGator({ release, dataDir: join(dir, name), config: { profile: 'small' }, port: 0, signals: false, readStaleMs: 0,
      transport: options => new MemoryTransport({ ...options, skipPow: true }),
      fetch: async url => {
        if (!String(url).includes('/api/v2/ticker/')) return new Response('{}', { status: 503 });
        return Response.json([{ market: 'BTC/USD', last: '123.1', volume: '100', bid: '123', ask: '124' }]);
      }, ...opts });
    // Tests dispatch the real source jobs explicitly. A background tick racing
    // the fixture job would consume its rate bucket on slower machines.
    clearTimeout(app.engine.timer);
    apps.push(app);
    return app;
  }
  return { dir, release, root, start };
}
