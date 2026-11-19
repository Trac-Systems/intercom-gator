import { randomUUID } from 'node:crypto';
import { readTokenIdentity } from '../intel/extras.js';
import { isAddress, isAsset } from '../intel/values.js';
import { RateLimited } from '../scheduler/index.js';
import { focusCollectors } from './collect.js';
import { coverageReader } from './coverage.js';

const HOUR = 3_600_000;
const capacities = { small: 5, normal: 10, large: 20 };

export class FocusError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function registerFocus(engine) {
  const { store, registry, clock, scheduler } = engine, db = store.writer;
  const limit = () => capacities[engine.profile] ?? capacities.normal;
  const coverage = coverageReader(engine), collect = focusCollectors(engine);
  const pending = new Map(), leases = new Map(), partial = new Map();
  const all = db.prepare('SELECT * FROM engine_focus WHERE expiresAt>? ORDER BY addedAt DESC,asset');
  const expired = db.prepare('SELECT asset FROM engine_focus WHERE expiresAt<=?');
  const remove = db.prepare('DELETE FROM engine_focus WHERE asset=?');
  const add = db.prepare(`INSERT INTO engine_focus(asset,generation,addedAt,expiresAt,poolDiscovery,paidUntil,requests)
    VALUES(?,?,?,?,?,coalesce((SELECT keepUntil FROM engine_placement_assets WHERE asset=?),0),?)`);
  const renew = db.prepare('UPDATE engine_focus SET expiresAt=? WHERE asset=?');
  const task = db.prepare('INSERT INTO engine_focus_tasks(asset,task,dueAt) VALUES(?,?,?)');
  const tasks = db.prepare('SELECT task,dueAt,attempts,result FROM engine_focus_tasks WHERE asset=? ORDER BY task');
  const due = db.prepare(`SELECT t.*,f.generation FROM engine_focus_tasks t JOIN engine_focus f USING(asset)
    WHERE f.expiresAt>? AND t.dueAt<=? ORDER BY t.dueAt,t.asset,t.task LIMIT 1`);
  const finish = db.prepare('UPDATE engine_focus_tasks SET dueAt=?,attempts=attempts+?,result=? WHERE asset=? AND task=?');
  const charge = db.prepare('UPDATE engine_focus SET requests=requests+? WHERE asset=?');
  const chains = db.prepare(`SELECT DISTINCT m.chain FROM engine_focus f JOIN asset_markets a ON a.asset=f.asset
    JOIN markets m ON m.id=a.market WHERE m.kind='dex' AND f.expiresAt>$now
    UNION SELECT m.chain FROM engine_focus f JOIN markets m ON m.quote=f.asset WHERE m.kind='dex' AND f.expiresAt>$now`);
  let chainCache, running;

  function invalidate() {
    chainCache = null;
    for (const job of scheduler.jobs.values()) delete job.scored;
  }
  function forget(id) {
    leases.delete(id);
    partial.delete(id);
  }
  // Preserve the newest entries when a machine is switched to a smaller profile.
  function resize(now = clock()) {
    const overflow = [...expired.all(now), ...all.all(now).slice(limit())];
    if (!overflow.length) return;
    store.transaction(() => { for (const { asset } of overflow) remove.run(asset); });
    for (const { asset } of overflow) forget(asset);
    invalidate();
  }
  resize();
  for (const row of all.all(clock())) leases.set(row.asset, row);
  function active(id, now = clock()) { return (leases.get(id)?.expiresAt ?? 0) > now; }
  function any() {
    const now = clock();
    for (const row of leases.values()) if (row.expiresAt > now) return true;
    return false;
  }
  scheduler.focus = { active: any,
    market(id, now) {
      if (!leases.size) return false;
      const m = registry.markets.get(id);
      return m && (active(m.base, now) || active(m.quote, now));
    },
    chain(id, now) {
      if (!any()) return false;
      if (!chainCache || now >= chainCache.until) chainCache = { until: now + 5000, ids: new Set(chains.all({ now }).map(r => r.chain)) };
      return chainCache.ids.has(id);
    },
  };
  function entry(row) {
    const { asset, addedAt, expiresAt, requests, poolDiscovery } = row;
    return { asset, addedAt, expiresAt, requests, poolDiscovery: !!poolDiscovery, gathered: coverage(asset),
      tasks: tasks.all(asset).map(t => ({ ...t, result: t.result && JSON.parse(t.result) })) };
  }
  function list() { return { limit: limit(), items: all.all(clock()).map(entry) }; }
  function tokenChain(id) {
    if (!isAsset(id) || id.endsWith(':native')) return null;
    const [slug, address] = id.split(':'), chain = registry.chains.get(slug);
    return chain?.family === (isAddress(address) ? 'evm' : 'solana') ? chain : null;
  }
  function extend(id, hours) {
    const expiresAt = clock() + hours * HOUR;
    renew.run(expiresAt, id);
    leases.get(id).expiresAt = expiresAt;
    invalidate();
    return list();
  }
  async function set(id, { hours = 168, remove: drop = false } = {}) {
    if (!Number.isInteger(hours) || hours < 1 || hours > 720 || typeof drop !== 'boolean')
      throw new FocusError(400, 'hours must be an integer from 1 to 720 and remove must be boolean');
    resize();
    if (drop) {
      const request = pending.get(id);
      if (request) request.cancelled = true;
      remove.run(id);
      forget(id);
      invalidate();
      return list();
    }
    if (active(id)) return extend(id, hours);
    if (pending.has(id)) {
      if (pending.get(id).cancelled) throw new FocusError(409, 'verification is finishing a cancelled request');
      await pending.get(id).promise;
      if (!active(id)) throw new FocusError(409, 'focus request cancelled');
      return extend(id, hours);
    }
    if (leases.size + pending.size >= limit()) throw new FocusError(409, 'focus list is full for this profile');
    const known = registry.assets.get(id), chain = tokenChain(id);
    if ((!known && !chain) || known?.kind === 'nft') throw new FocusError(400, 'expected a known token or an EVM contract / Solana mint');
    const request = { requests: 0 };
    pending.set(id, request);
    async function enroll() {
      let info;
      if (!known) {
        try { info = await readTokenIdentity(engine.rpc.publicOnly, chain, id.split(':')[1]); }
        catch { throw new FocusError(503, 'public token verification unavailable'); }
        if (!info) throw new FocusError(422, 'address did not pass token verification');
      }
      if (request.cancelled) throw new FocusError(409, 'focus request cancelled');
      if (leases.size >= limit()) throw new FocusError(409, 'focus list is full for this profile');
      const now = clock(), generation = randomUUID(), expiresAt = now + hours * HOUR;
      const pools = chain && (chain.family === 'solana' || engine.evm.has(chain.id));
      const previous = registry.assets.get(id);
      try {
        store.transaction(() => {
          if (!previous) registry.registerToken(chain.id, id.split(':')[1], info);
          add.run(id, generation, now, expiresAt, Number(!!pools), id, request.requests);
          for (const name of Object.keys(collect)) task.run(id, name, now);
          engine.scheduleMeta(id, true);
        });
      } catch (error) {
        if (!previous) registry.assets.delete(id);
        throw error;
      }
      leases.set(id, { generation, expiresAt });
      invalidate();
    }
    request.promise = engine.budget.trackRequests(request, enroll);
    try { await request.promise; }
    finally { if (pending.get(id) === request) pending.delete(id); }
    return list();
  }

  async function collectOne() {
    const now = clock(), row = due.get(now, now);
    if (!row) return;
    const { asset, generation } = row, account = { requests: 0 };
    const current = () => active(asset) && leases.get(asset)?.generation === generation;
    let next = null, result, attempt = 1;
    const state = partial.get(asset) ?? {};
    partial.set(asset, state);
    try {
      result = await engine.budget.trackRequests(account, () => collect[row.task](registry.assets.get(asset), current, state[row.task] ??= {}));
    } catch (error) {
      if (error instanceof RateLimited) { next = Math.max(clock() + 1000, error.retryAt); attempt = 0; result = { state: 'rate-limited' }; }
      else {
        if (row.attempts < 2) next = clock() + 60_000 * 2 ** row.attempts;
        result = { state: 'unavailable' };
      }
    }
    if (!current()) return;
    if (attempt) delete state[row.task];
    store.transaction(() => {
      finish.run(next, attempt, JSON.stringify(result), asset, row.task);
      charge.run(account.requests, asset);
    });
  }
  engine.registerJob({ id: 'focus:collect', interval: 1000, ready: () => any() && !!due.get(clock(), clock()),
    run: () => running ??= collectOne().finally(() => { running = null; }) });
  return { set, list, coverage, resize, tokenChain };
}
