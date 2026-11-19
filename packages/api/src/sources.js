import { createHash } from 'node:crypto';
import { RateLimited } from '../../engine/src/scheduler/index.js';

/** Allow compatible HTTP mirrors for a signed exchange or API. The engine still
 * accounts for every attempt against its shared budget and actual endpoint bucket. */
export function configureMirrors(app) {
  const { engine, clock, store } = app;
  let rules = mirrorRules(engine);
  // A live root patch can change source URLs; rebuild the mirror rules from the patched catalog.
  engine.on('bundlePatch', () => { rules = mirrorRules(engine); });
  const direct = engine.http.get.bind(engine.http);
  engine.http.get = async (url, ...args) => {
    const configured = app.config.endpoints.filter(e => e.kind !== 'rpc' && /^https?:/.test(e.url));
    if (!configured.length) return direct(url, ...args);
    const upstream = new URL(url);
    const matches = rules.filter(r => r.origin === upstream.origin &&
      (r.template ? upstream.pathname.startsWith(r.path) : r.path === upstream.pathname));
    for (const e of configured) {
      if (!matches.some(s => s.kind === e.kind && [s.name.toLowerCase(),s.id].includes((e.source || e.label || e.chain).toLowerCase()))) continue;
      const mirror = new URL(e.url);
      mirror.pathname = mirror.pathname.replace(/\/$/, '') + upstream.pathname;
      for (const [k,v] of upstream.searchParams) mirror.searchParams.append(k,v);
      if (mirror.href === upstream.href) continue;
      const id = createHash('sha256').update(e.url).digest('hex').slice(0,16);
      const health = store.getEndpointHealth(id);
      if (health?.retryAt > clock()) continue;
      try {
        const result = await direct(mirror.href,...args);
        store.setEndpointHealth({ id, lastSuccess: clock() });
        return result;
      } catch (error) {
        if (engine.http.signal?.aborted) throw error;
        if (!(error instanceof RateLimited)) {
          const failures = Math.min(8, (health?.failures ?? 0) + 1);
          store.setEndpointHealth({ id, failures, retryAt: clock() + 1000 * 2 ** failures, lastSuccess: health?.lastSuccess });
        }
      }
    }
    return direct(url,...args);
  };
}

function mirrorRules(engine) {
  const sources = [
    ...engine.catalog.exchanges.map(e => ({ kind: 'cex', id: e.id, name: e.name, urls: [
      e.ticker?.url, e.format.catalog?.url, e.candles?.url, ...e.derivatives.map(d => d.url),
    ] })),
    ...engine.catalog.apis.map(a => ({ kind: 'api', id: a.id, name: a.name, urls: [a.url] })),
  ];
  const rules = [];
  for (const source of sources) {
    for (const url of source.urls.filter(Boolean)) {
      const [prefix] = url.split('{');
      const part = new URL(prefix);
      rules.push({ ...source, origin: part.origin, path: part.pathname, template: prefix !== url && !prefix.includes('?') });
    }
  }
  return rules;
}
