import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createMemoryHub, keyFromSeed, MemoryTransport } from '@gator/net';
import { startAddon } from '../src/addon.js';

export const ROOT_SEED = '11'.repeat(32);
export const root = keyFromSeed(ROOT_SEED);
export const ROOT = root.publicKey.toString('hex');

export async function until(check, { timeout = 8000, step = 10 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('Timed out waiting');
    await delay(step);
  }
}

/** Addons on one in-memory Intercom network (real framing, signatures and admission; PoW skipped). */
export async function network(t) {
  const hub = createMemoryHub();
  const dir = await mkdtemp(join(import.meta.dirname, 'scratch-'));
  const running = [];
  t.after(async () => {
    for (const item of running.reverse()) await item.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  let n = 0;
  return {
    hub, dir,
    beforeRemove(close) { running.push({ close }); },
    transport(wallet) {
      const transport = new MemoryTransport({ hub, skipPow: true, rootKey: ROOT, ...(wallet ? { wallet } : {}) });
      running.push({ close: () => transport.close() });
      return transport;
    },
    async addon(options = {}) {
      const transport = options.transport ?? this.transport();
      const addon = await startAddon({ dataDir: join(dir, 'peer' + n++), rootKey: ROOT, proofs: false,
        profile: 'small', product: 'dex', ...options, transport });
      running.push(addon);
      return addon;
    },
  };
}

export const tool = (addon, name) => addon.tools.find(t => t.name === name);
export const call = (addon, name, args) => tool(addon, name).call(args);
