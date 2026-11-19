import { createHash } from 'node:crypto';
import { evmNames } from '../sources/names/evm.js';
import { solanaNames } from '../sources/names/solana.js';
import { contractName } from '../sources/names/contracts.js';
import { offchainReader } from '../sources/names/ton.js';
import { labels, validDecimals } from '../sources/names/text.js';
import { fetchImageBytes, inspectImage } from '../logos/index.js';
import { RateLimited } from '../scheduler/index.js';

const HOUR = 3_600_000;

/** One-off reads use the same source decoders, endpoint buckets and storage conventions as routine collection. */
export function focusCollectors(engine) {
  const { store, clock, registry, logos } = engine;
  const rotation = new Map(), cooldown = new Map(), offchain = offchainReader(engine);
  const bar = store.writer.prepare(`INSERT INTO candles(asset,tf,ts,open,high,low,close,samples,firstTs,firstId,lastTs,lastId)
    VALUES (?,'1h',?,?,?,?,?,1,?,0,?,0) ON CONFLICT DO NOTHING`);
  const setNames = store.writer.prepare(`UPDATE engine_names SET name=?,symbol=?,method=?,block=?,decimals=coalesce(?,decimals),
    failures=0,lastAttempt=?,nextRetry=CASE WHEN coalesce(?,decimals) IS NULL THEN nextRetry ELSE NULL END,publishAt=?
    WHERE asset=? AND coalesce(lastAttempt,0)<=? AND (? IS NULL OR block IS NULL OR block<=?)`);
  const label = store.writer.prepare('UPDATE assets SET name=?,symbol=? WHERE id=?');
  const units = store.writer.prepare(`UPDATE engine_asset_data SET decimals=coalesce(?,decimals),
    totalSupply=coalesce(?,totalSupply) WHERE asset=?`);
  return {
    async history(asset, active) {
      const to = clock() - clock() % HOUR, limit = 8 * 24;
      const rows = await engine.candles(asset.id, { tf: '1h', from: Math.max(0, to - limit * HOUR), to, limit });
      let imported = 0;
      if (active()) store.transaction(() => {
        for (const r of rows) if (r.source) imported += bar.run(asset.id, r.ts, r.open, r.high, r.low, r.close, r.ts, r.ts + HOUR - 1).changes;
      });
      if (imported) engine.book.dirty = true;
      return { imported };
    },
    async metadata(asset, active, reads) {
      if (asset.address === 'native') return { source: 'registry' };
      const chain = registry.chains.get(asset.chain), rpc = engine.rpc.publicOnly, start = clock();
      if (!chain) return { available: false };
      let row;
      if (chain.family === 'evm') [row] = await evmNames(chain, [asset], rpc, reads, cooldown, start);
      else if (chain.family === 'solana') [row] = await solanaNames(chain, [asset], rpc);
      else row = await contractName(engine.bundle.chains.find(c => c.id === chain.id), asset, engine.http, reads, rotation, offchain);
      if (!row || !active()) return { available: false };
      const fields = labels(row, asset.address);
      const decimals = validDecimals(row.decimals) ? row.decimals : null;
      const patch = {};
      store.transaction(() => {
        if (fields && row.method) {
          const block = row.block ?? null;
          if (setNames.run(fields.name, fields.symbol, row.method, block, decimals, clock(), decimals, clock(), asset.id, start, block, block).changes)
            Object.assign(patch, fields);
        }
        if (decimals !== null && decimals <= 77) patch.decimals = decimals;
        // The ERC-20 names read already includes totalSupply. Circulating supply stays with its ordinary evidence rules.
        if (Number.isFinite(row.totalSupply) && row.totalSupply >= 0) patch.totalSupply = row.totalSupply;
        if (patch.name) label.run(patch.name, patch.symbol, asset.id);
        if (patch.decimals != null || patch.totalSupply != null) units.run(patch.decimals ?? null, patch.totalSupply ?? null, asset.id);
      });
      Object.assign(asset, patch);
      if (Object.keys(patch).length) engine.book.dirty = true;
      return { nameResolved: !!fields, totalSupplyKnown: asset.totalSupply != null };
    },
    async supply(asset, active) {
      if (asset.address === 'native') {
        const job = engine.scheduler.jobs.get('supply:' + asset.chain);
        if (!job) return { available: false };
        if (job.next === Infinity) throw new RateLimited(clock() + 5_000);
        if (job.next > clock()) throw new RateLimited(job.next);
        await engine.scheduler.execute(job, job.run);
      } else if (registry.chains.get(asset.chain)?.family === 'solana') {
        const data = await engine.rpc.publicOnly.call(asset.chain, 'getTokenSupply', [asset.address, { commitment: 'finalized' }]);
        const { amount, decimals } = data?.value ?? {};
        if (!Number.isSafeInteger(data?.context?.slot) || data.context.slot < 0 || typeof amount !== 'string' ||
            !/^\d{1,20}$/.test(amount) || BigInt(amount) >= 2n ** 64n || !validDecimals(decimals) || decimals > 77)
          throw new Error('Invalid mint supply');
        if (active()) engine.setSupply(asset.id, { totalSupply: Number(amount) / 10 ** decimals });
      }
      return { totalSupplyKnown: asset.totalSupply != null, circulatingSupplyKnown: asset.supply != null };
    },
    async logo(asset, active) {
      const ref = 'asset:' + asset.id, url = logos.resolve(ref);
      if (!url) return { available: false };
      logos.take(url);
      const bytes = await fetchImageBytes(logos.fetch, url, { signal: engine.http.signal, timeout: logos.timeout });
      const info = inspectImage(bytes);
      if (active()) logos.keep(ref, url, { ...info, bytes, sha: createHash('sha256').update(bytes).digest('hex') }, clock());
      return { available: true };
    },
  };
}
