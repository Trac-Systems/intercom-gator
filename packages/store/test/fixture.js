import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/index.js';

/** Reopens share a test-local file. Close every handle before removing its directory on Windows. */
export function storeOpener(t) {
  const dir = mkdtempSync(fileURLToPath(new URL('./.store-test-', import.meta.url)));
  const stores = [];
  t.after(() => {
    try { for (const store of stores) store.close(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  return (options = {}) => {
    const store = openStore({ file: join(dir, 'gator.db'), profile: 'small', ...options });
    stores.push(store);
    return store;
  };
}

export function fixture(t, options) {
  return storeOpener(t)(options);
}
