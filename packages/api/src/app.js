import { EventEmitter } from 'node:events';
import { lstatSync, rmSync, rmdirSync, statSync, statfsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SwarmTransport, loadOrCreateKey } from '@gator/net';
import { windowsDirectory } from '@gator/net/src/private-file.js';
import { RELAYS } from '@gator/bundle/src/relays.js';
import { Social, lockIdentity, migrations as socialMigrations } from '@gator/social';
import { openStore } from '@gator/store';
import { fitBudget } from '../../store/src/prune.js';
import { Engine, migrations as engineMigrations } from '@gator/engine';
import { createIntel, migrations as intelMigrations } from '../../engine/src/intel/index.js';
import { configureMirrors } from './sources.js';
import { verifyRelease } from './bundle.js';
import { loadConfig, rpcEndpoints, saveConfig, storageCapBytes } from './config.js';
import { createAccount, migrations as accountMigrations } from './account.js';
import { CREDENTIALS, defaultDir, ensureToken, lockDirectory, readJson, writePrivate } from './local.js';

const HOUR = 3_600_000, MINUTE = 60_000;

function seenLockRecord(dataDir, platform) {
  const seen = join(dataDir, 'seen'), lock = join(seen, '.writer.lock');
  if (platform === 'win32') {
    windowsDirectory(seen);
    const stat = windowsDirectory(lock);
    return { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
  }
  const stat = lstatSync(lock);
  if (!stat.isDirectory()) return null;
  return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

/** An unclean exit leaves Intercom's seen-list directory lock. Reclaim only the exact inode this daemon
 * acquired before (recorded in seen-writer.json), under the OS data-directory lock the caller holds. The lock
 * directory holds an `owner` record, so a killed daemon leaves it non-empty. */
export function reclaimSeenLock(dataDir, platform = process.platform) {
  const prior = readJson(join(dataDir, 'seen-writer.json'), null);
  if (!prior) return false;
  try {
    const record = seenLockRecord(dataDir, platform);
    if (!record || !Object.entries(record).every(([key, value]) => prior[key] === value)) return false;
    const seenLock = join(dataDir, 'seen', '.writer.lock');
    rmSync(join(seenLock, 'owner'), { force: true });
    rmdirSync(seenLock);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

const named = (label, fn) => Object.assign(fn, { label });

/** Start one peer, its signed sources, agent files and loopback API.
 * @param {{dataDir?:string, config?:object, bootstrap?:Array, transport?:object|Function, clock?:(()=>number)|{now:()=>number},
 * port?:number, release?:{dir:string,rootKey:string}, fetch?:Function, signals?:boolean}} options */
export async function createGator(options = {}) {
  const dataDir = resolve(options.dataDir ?? defaultDir());
  const sourceClock = options.clock ?? Date.now;
  const clock = typeof sourceClock === 'function' ? sourceClock : sourceClock.now.bind(sourceClock);
  const release = await verifyRelease(options.release);
  const unlock = lockDirectory(dataDir);
  const app = { dataDir, clock, release, events: new EventEmitter() };
  const cleanups = [unlock];
  let closing;
  app.close = () => closing ??= (async () => {
    const errors = [];
    app.engine?.abort?.abort();
    // Each step gets a deadline: one hung step (a network read in flight) once left a daemon with its HTTP
    // server closed and its process alive. Later steps (store, locks) still run.
    for (const cleanup of cleanups.reverse()) {
      let timer;
      const label = cleanup.label ?? 'cleanup', started = Date.now();
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Shutdown step timed out: ' + label)), options.cleanupTimeoutMs ?? 10_000);
      });
      try { await Promise.race([cleanup(), deadline]); } catch (error) { errors.push(error); } finally { clearTimeout(timer); }
      // Name slow steps so a slow or failed stop can be traced from the daemon log.
      const seconds = (Date.now() - started) / 1000;
      if (seconds >= 2) process.emitWarning(`Shutdown step ${label} took ${seconds.toFixed(1)} s`);
    }
    if (options.signals !== false) {
      // A daemon process must end once it is closed, even if a library left a socket or timer behind.
      setTimeout(() => process.exit(process.exitCode ?? (errors.length ? 1 : 0)), 2_000).unref();
    }
    if (errors.length) throw new AggregateError(errors, 'Daemon shutdown failed');
  })();
  try {
    Object.assign(app, loadConfig(dataDir, options.config));
    const { config } = app;
    const store = app.store = openStore({ file: join(dataDir, 'gator.db'), profile: config.profile,
      migrations: [...socialMigrations, ...engineMigrations, ...intelMigrations, ...accountMigrations] });
    cleanups.push(named('store', () => store.close()));
    const wallet = await loadOrCreateKey(dataDir);
    // One identity runs in one process per machine (gator or a gator-social add-on with the imported key).
    if (!options.transport) cleanups.push(named('identity-lock',
      lockIdentity(wallet.publicKey.toString('hex'), { harness: 'gator', dataDir })));
    // Blind relay: the release's relays (replaceable by root network settings), local extras, and serving on request.
    const blindRelay = { serve: options.blindRelayServe === true, relays: options.blindRelays ?? [], defaults: RELAYS };
    const transportOptions = { dataDir, wallet, rootKey: release.rootKey, bootstrap: options.bootstrap, blindRelay };
    const seenOwner = join(dataDir, 'seen-writer.json');
    if (!options.transport) reclaimSeenLock(dataDir);
    const transport = app.transport = typeof options.transport === 'function' ? options.transport(transportOptions)
      : options.transport ?? new SwarmTransport(transportOptions);
    cleanups.push(named('transport', async () => {
      await transport.close();
      if (!options.transport) rmSync(seenOwner, { force: true });
    }));
    const social = app.social = new Social({ transport, db: store, rootKey: release.rootKey, clock, dataDir,
      product: ['gator','dex','reset','dmw'], useRootMutes: config.officialMutes,
      proofs: { fetch: options.fetch ?? globalThis.fetch } });
    cleanups.push(named('social', () => social.close()));
    await social.ready;
    if (!options.transport) {
      writePrivate(seenOwner, JSON.stringify(seenLockRecord(dataDir, process.platform)));
    }
    if (!social.profile(transport.publicKey)) {
      const handle = 'peer_' + transport.publicKey.slice(0, 12);
      await social.setCard({ handle, harnesses: ['gator'] });
    }
    const isFollowed = key => !!store.reader.prepare('SELECT 1 FROM follows WHERE key=?').get(key);
    const posts = store.reader.prepare(`SELECT key,id,t,ts,text,json_extract(envelope,'$.message.tickers') AS tickers
      FROM social_visible_posts WHERE ts>=? AND ts<? AND t IN ('post','reply') ORDER BY ts DESC`);
    // options.nfts: NFT sale collection, off until the NFTs tab ships (tests and harness builds may turn it on).
    const engine = app.engine = new Engine({ bundle: release.bundle, transport, store, clock, profile: config.profile, nfts: options.nfts === true,
      readStaleMs: options.readStaleMs ?? 4000,
      extensions: release.extensions,
      patches: { snapshot: release.snapshot, ...(typeof config.patchFeed === 'boolean' && { patchFeed: config.patchFeed }) },
      rpcConfig: { endpoints: rpcEndpoints(release, config), requestsPerMinute: config.budgetPerMin, fetch: options.fetch,
        bundleDigest: release.digest, isFollowed } });
    configureMirrors(app);
    const account = app.account = createAccount(store, clock, (type, data) => app.events.emit(type, data));
    engine.on('price', p => {
      account.onPrice(p);
      app.events.emit('price', { id: p.asset, price: p.price, change24h: p.change24h, trust: p.trust });
    });
    cleanups.push(named('engine', () => engine.stop()));
    await engine.start();
    const lastReadKey = 'intel:briefing:lastRead';
    const briefingFile = join(dataDir, 'agent', 'market', 'briefing.md');
    app.lastBriefingRead = (saved = store.getSetting(lastReadKey) ?? 0) => {
      const file = statSync(briefingFile, { throwIfNoEntry: false });
      if (!file || file.atimeMs <= file.mtimeMs) return saved;
      return Math.max(saved, Math.min(clock(), Math.floor(file.atimeMs)));
    };
    const intelStore = {
      ...store, listAlerts: account.listAlerts,
      getSetting(key) {
        const saved = store.getSetting(key);
        if (key !== lastReadKey) return saved;
        // Persist file reads before the hourly writer replaces the file.
        const read = app.lastBriefingRead(saved ?? 0);
        if (read > (saved ?? 0)) store.setSetting(key, read);
        return read;
      },
    };
    const intel = app.intel = createIntel({ engine, dataDir, isFollowed,
      store: intelStore,
      isReputable: key => { const r = store.getReporter(key); return r && r.weight > 1 && !r.strikes && r.mutedUntil <= clock(); },
      postsSince: ({ from, to }) => posts.all(from, to).map(row => ({ ...row, tickers: JSON.parse(row.tickers) ?? [] })) });
    cleanups.push(named('intel', () => intel.stop()));
    await intel.start();
    await social.writeAgentFiles();
    const liveSize = store.reader.prepare(`SELECT (page_count - freelist_count) * page_size AS bytes
      FROM pragma_page_count, pragma_freelist_count, pragma_page_size`);
    // The cap may never take more than half of the disk space that is still free (a 10 GiB large cap on a nearly
    // full disk): live pages plus half of the free space.
    app.storageCapBytes = () => {
      let free = NaN;
      try { const disk = statfsSync(dataDir); free = disk.bavail * disk.bsize; } catch {}
      return storageCapBytes(app.config.storageCapMB, liveSize.get().bytes, free);
    };
    app.prune = () => {
      const cap = app.storageCapBytes();
      const result = store.prune({ now: clock(), profile: app.config.profile });
      // Leave 10% headroom so a busy network does not trigger a prune every minute.
      if (result.liveBytes > cap * 0.9) store.transaction(db => fitBudget(db, cap * 0.9, clock()));
    };
    const timer = setInterval(() => { try { app.prune(); } catch { process.emitWarning('Scheduled prune failed'); } }, HOUR);
    timer.unref();
    cleanups.push(() => clearInterval(timer));
    // Raw observations can arrive at ~10 MB/min on a busy network, so the hourly prune alone would overshoot a small
    // cap by hundreds of MB. Check the live size every minute and prune early.
    app.checkBudget = () => {
      if (liveSize.get().bytes > app.storageCapBytes() * 0.95) app.prune();
    };
    const budgetTimer = setInterval(() => { try { app.checkBudget(); } catch { process.emitWarning('Storage check failed'); } }, MINUTE);
    budgetTimer.unref();
    cleanups.push(() => clearInterval(budgetTimer));
    saveConfig(dataDir, config);
    const token = ensureToken(dataDir, CREDENTIALS.agent), login = ensureToken(dataDir, CREDENTIALS.owner);
    const stop = ensureToken(dataDir, CREDENTIALS.stop);
    const { serve } = await import('./server.js');
    const http = await serve(app, { port: options.port, token, login, stop });
    app.port = http.port;
    cleanups.push(named('http', http.close));
    writePrivate(join(dataDir, 'daemon.json'), JSON.stringify({ port: app.port, publicKey: transport.publicKey }));
    cleanups.push(() => rmSync(join(dataDir, 'daemon.json'), { force: true }));
    if (options.signals !== false) {
      const stop = () => { app.close().catch(() => { process.exitCode = 1; }); };
      for (const name of ['SIGINT','SIGTERM']) process.once(name, stop);
      cleanups.push(() => { for (const name of ['SIGINT','SIGTERM']) process.off(name, stop); });
    }
    return app;
  } catch (error) { await app.close(); throw error; }
}
