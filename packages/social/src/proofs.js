import { resolveTxt } from 'node:dns/promises';
import { DAY, HOUR } from './policy.js';

const REQUESTS_PER_HOUR = 60;
class DeferredProof extends Error {}

function rateLimitedUntil(response, now) {
  if (response.status !== 403 && response.status !== 429 && response.headers?.get('x-ratelimit-remaining') !== '0') return 0;
  const reset = Number(response.headers?.get('x-ratelimit-reset')) * 1000;
  const retry = response.headers?.get('retry-after');
  const after = retry && (/^\d+$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry));
  const deadlines = [reset, after].filter(n => Number.isSafeInteger(n) && n > now);
  return deadlines.length ? Math.max(...deadlines) : now + HOUR;
}

const MAX_BYTES = 256 * 1024;
async function githubJson(fetcher, path) {
  const response = await fetcher('https://api.github.com' + path, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'intercom-gator' },
    redirect: 'error', signal: AbortSignal.timeout(5000)
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    return null;
  }
  const chunks = [];
  const reader = response.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  } finally { reader.releaseLock(); }
}

async function hasGist(fetcher, user, key) {
  const gists = await githubJson(fetcher, '/users/' + user + '/gists?per_page=10');
  if (!Array.isArray(gists)) return false;
  const belongs = gist => gist?.owner?.login?.toLowerCase() === user.toLowerCase() && gist.public === true;
  const token = new RegExp('(?:^|[^a-z0-9])' + key + '(?![a-z0-9])', 'i');
  for (const gist of gists.slice(0, 10)) {
    if (!belongs(gist) || typeof gist.id !== 'string' || !/^[a-f0-9]{1,64}$/i.test(gist.id)) continue;
    const detail = await githubJson(fetcher, '/gists/' + gist.id);
    if (detail?.id !== gist.id || !belongs(detail)) continue;
    if (Object.values(detail.files ?? {}).some(file => !file.truncated && typeof file.content === 'string' && token.test(file.content))) return true;
  }
  return false;
}

/** Verify on demand. DNS is available by default; GitHub requires an injected fetch. */
export async function checkProofs(key, proofs = {}, options = {}) {
  const verified = {};
  const dns = options.resolveTxt === undefined ? resolveTxt : options.resolveTxt;
  if (proofs.dns && dns) {
    try {
      const records = await dns(proofs.dns);
      verified.dns = records.some(record => Array.isArray(record) && record.join('') === 'intercom-gator=' + key);
    } catch (err) { if (!(err instanceof DeferredProof)) verified.dns = false; }
  }
  if (proofs.github && options.fetch) {
    try { verified.github = await hasGist(options.fetch, proofs.github, key); }
    catch (err) { if (!(err instanceof DeferredProof)) verified.github = false; }
  }
  return verified;
}

/** Serialize lookups, coalesce repeated announcements and bind results to the current card. */
export class CardProofs {
  #jobs = new Map();
  #tail = Promise.resolve();
  #closed = false;

  constructor(store, options, now) {
    this.store = store;
    this.options = options;
    this.now = now;
  }
  // Reserve each external call, including gist detail requests, across cards and restarts.
  reserve(key, followedOnly) {
    if (this.#closed || (followedOnly && !this.store.followed(key)) || this.store.hidden(key)) throw new DeferredProof();
    const now = this.now();
    const times = (this.store.state('proofRequests') ?? []).filter(t => t > now - HOUR);
    if (times.length >= REQUESTS_PER_HOUR) throw new DeferredProof();
    times.push(now);
    this.store.setState('proofRequests', times);
  }
  providers(key, followedOnly) {
    const dns = this.options.resolveTxt === undefined ? resolveTxt : this.options.resolveTxt;
    return {
      resolveTxt: dns && (domain => {
        this.reserve(key, followedOnly);
        return dns(domain);
      }),
      fetch: this.options.fetch && (async (url, options) => {
        if (this.#closed || this.now() < (this.store.state('githubResumeAt') ?? 0)) throw new DeferredProof();
        this.reserve(key, followedOnly);
        const response = await this.options.fetch(url, options);
        if (this.#closed) {
          await response.body?.cancel();
          throw new DeferredProof();
        }
        const until = rateLimitedUntil(response, this.now());
        if (until) this.store.setState('githubResumeAt', until);
        if (until && !response.ok) {
          await response.body?.cancel();
          throw new DeferredProof();
        }
        return response;
      })
    };
  }
  check(key, { force = false, followedOnly = false } = {}) {
    if (this.#closed || (followedOnly && !this.store.followed(key))) return Promise.resolve({});
    const pending = this.#jobs.get(key);
    if (pending) return pending;
    const p = this.store.profile(key);
    if (!p?.proofs || p.muted || !(p.proofs.dns && this.options.resolveTxt !== null || p.proofs.github && this.options.fetch)) {
      return Promise.resolve({});
    }
    if (this.#jobs.size >= 32 || (!force && p.proofChecked !== null && this.now() - p.proofChecked < DAY)) {
      return Promise.resolve(p.proofStatus);
    }
    const job = this.#tail.then(async () => {
      // A replacement card can arrive while a lookup is in flight.
      for (let attempt = 0; attempt < 2 && !this.#closed; attempt++) {
        const before = this.store.profile(key);
        if (!before?.proofs || before.muted) break;
        const providers = this.providers(key, followedOnly);
        const checked = await checkProofs(key, before.proofs, providers);
        if (this.#closed) break;
        const current = this.store.profile(key);
        if (!current || current.muted) break;
        if (!['dns', 'github'].every(k => before.proofs[k] === current.proofs?.[k])) continue;
        const verified = { ...current.proofStatus, ...checked };
        const complete = (!before.proofs.dns || !providers.resolveTxt || 'dns' in checked) &&
          (!before.proofs.github || !providers.fetch || 'github' in checked);
        if (Object.keys(checked).length) this.store.sql('UPDATE profiles SET verified=?,proof_checked=? WHERE key=?')
          .run(JSON.stringify(verified), complete ? this.now() : null, key);
        return verified;
      }
      return {};
    }).finally(() => this.#jobs.delete(key));
    this.#jobs.set(key, job);
    this.#tail = job.catch(() => {});
    return job;
  }
  close() { this.#closed = true; }
}
