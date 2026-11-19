import { multiRead } from '../sources/evm-abi.js';
import { solanaNames } from '../sources/names/solana.js';
import { PeerQuota } from '../obs/index.js';
import { keccak256 } from './keccak.js';
import { DAY, isAddress, isAsset, isKey, readAddress, readUint, selector, word, ZERO } from './values.js';

export const EXTRAS_INTERVAL_MS = 300_000;
const slots = ['promoted-token', 'pinned-news', 'spotlight'];
const capacity = [3, 2, 1];
const current = selector('current(uint8)');
const purchased = keccak256('Purchased(bytes32,uint8,uint8,address,bytes32,uint256,uint256,uint256)');

/** Read prices and lane availability together at one block via the bundle's Multicall3. */
export async function readExtrasTerms(rpc, chain, contract) {
  const data = [selector('token()'), selector('paused()')];
  for (const i of slots.keys()) data.push(selector('price(uint8)') + word(i), selector('nextStart(uint8)') + word(i));
  const calls = data.map(data => ({ to: contract, data }));
  const [token, paused, ...terms] = await multiRead(rpc, { id: chain.id, multicall: chain.multicall3 }, calls);
  const paymentToken = readAddress(token), pausedFlag = readUint(paused);
  if (!paymentToken || paymentToken === ZERO || ![0n, 1n].includes(pausedFlag)) throw new Error('Invalid contract terms');
  return { paymentToken, paused: pausedFlag === 1n, slots: slots.map((slot, i) => {
    const price = readUint(terms[2*i]), start = readUint(terms[2*i+1]);
    if (!price || start == null || start * 1000n + 600_000n > 8_640_000_000_000_000n) throw new Error('Invalid slot terms');
    return { slot, price: price.toString(), nextStart: Number(start * 1000n) };
  }) };
}

/** ABI calldata only. Price is in TAP base units, the API's millisecond times become contract seconds. */
export function unsignedPurchase({ chainId, contract, paymentToken, slot, price, nextStart, hash }) {
  const maxStart = nextStart + 600_000;
  const approve = selector('approve(address,uint256)') + word(contract) + word(price);
  const buy = selector('buy(uint8,bytes32,uint256,uint256)') + word(slots.indexOf(slot)) + word(hash) + word(price) + word(maxStart / 1000);
  return { maxPrice: price, maxStart, transactions: [
    { chainId, to: paymentToken, data: approve, value: '0' }, { chainId, to: contract, data: buy, value: '0' },
  ] };
}

/** Accept only a complete Purchased log from the configured deployment in the requested successful receipt. */
export function purchasedLogs(receipt, txHash, contract) {
  if (typeof receipt?.transactionHash !== 'string' || receipt.transactionHash.toLowerCase() !== txHash ||
      receipt.status !== '0x1' || !Array.isArray(receipt.logs)) return [];
  return receipt.logs.flatMap(log => {
    const { topics, data } = log ?? {};
    if (log?.removed || !isAddress(log?.address) || log.address.toLowerCase() !== contract.toLowerCase() ||
        (log.transactionHash !== undefined && (typeof log.transactionHash !== 'string' || log.transactionHash.toLowerCase() !== txHash)) ||
        !Array.isArray(topics) || topics.length !== 4 || !topics.every(t => readUint(t) !== null) ||
        topics[0].toLowerCase() !== purchased || typeof data !== 'string' || !/^0x(?:[a-f\d]{64}){5}$/i.test(data)) return [];
    const [lane, hash, start, end, price] = data.slice(2).match(/.{64}/g).map(w => BigInt('0x' + w));
    const slotType = Number(readUint(topics[2])), buyer = readAddress(topics[3]);
    if (!slots[slotType] || lane >= capacity[slotType] || !buyer || buyer === ZERO || !readUint(topics[1]) ||
        !hash || !price || start >= end || !Number.isSafeInteger(Number(end * 1000n))) return [];
    return [{ purchaseId: topics[1].toLowerCase(), slot: slots[slotType], lane: Number(lane), buyer,
      contentHash: '0x' + word(hash), start: Number(start * 1000n), end: Number(end * 1000n), price: String(price) }];
  });
}

/** Hash a local content identity in its slot-specific namespace. */
export function contentHash(slot, { assetId, authorKey, envelopeId }) {
  if (slot === 'pinned-news') {
    if (!isKey(authorKey) || typeof envelopeId !== 'string' || !/^[a-zA-Z0-9_.:@-]{1,192}$/.test(envelopeId)) {
      throw new TypeError('Invalid post identity');
    }
    return keccak256('gator:pinned-news:' + authorKey + ':' + envelopeId);
  }
  if (!slots.includes(slot) || !isAsset(assetId)) throw new TypeError('Invalid placement identity');
  return keccak256('gator:' + slot + ':' + assetId);
}

/** Decode current(uint8) -> (bytes32,address,bytes32,uint256,uint256,uint256)[].
 * Time fields use epoch milliseconds and TAP base units stay decimal strings. */
export function decodeCurrent(hex, slotType) {
  if (!Number.isInteger(slotType) || !slots[slotType] || typeof hex !== 'string' ||
      hex.length > 2 + 64 * (2 + 6 * capacity[slotType]) || !/^0x(?:[\da-f]{64}){2,}$/i.test(hex)) {
    throw new TypeError('Invalid current result');
  }
  const words = hex.slice(2).toLowerCase().match(/.{64}/g);
  const uint = i => BigInt('0x' + words[i]);
  const count = Number(uint(1));
  if (uint(0) !== 32n || count > capacity[slotType] || words.length !== 2 + 6 * count) {
    throw new TypeError('Invalid purchase array');
  }
  const rows = [];
  for (let i = 2; i < words.length; i += 6) {
    const buyer = readAddress('0x' + words[i + 1]);
    const start = Number(uint(i + 3) * 1000n), end = Number(uint(i + 4) * 1000n);
    if (!buyer || buyer === ZERO || uint(i) === 0n || uint(i + 2) === 0n ||
        !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end) {
      throw new TypeError('Invalid purchase');
    }
    rows.push({ id: '0x' + words[i], buyer, contentHash: '0x' + words[i + 2], start, end,
      price: String(uint(i + 5)), slot: slots[slotType] });
  }
  return rows;
}

function deployments(bundle) {
  const entries = Object.entries(bundle.paidExtras ?? {});
  return entries.filter(([, address]) => isAddress(address) && address.toLowerCase() !== ZERO);
}

/** rpc.call(chainId, method, params) returns the unwrapped JSON-RPC result.
 * bundle.paidExtras maps chain IDs to contract addresses. start() polls immediately. */
export function createExtrasVerifier({ rpc, bundle, candidatesFor = () => [], now = Date.now }) {
  let verified = [], checked = new Map(), running, timer, nextLookup = 0;

  async function readAll() {
    const checkedAt = now();
    const rows = [], successes = new Map();
    for (const [chain, address] of deployments(bundle)) {
      for (const index of slots.keys()) {
        try {
          const data = current + word(index);
          const result = await rpc.call(chain, 'eth_call', [{ to: address, data }, 'latest']);
          for (const purchase of decodeCurrent(result, index)) rows.push({ ...purchase, chain, address, checkedAt });
          successes.set(chain + ':' + slots[index], { address, checkedAt });
        } catch {
          // A failed slot has no verified purchases for this poll.
          continue;
        }
      }
    }
    verified = rows;
    checked = successes;
  }

  function refresh() {
    running ??= readAll().finally(() => { running = undefined; });
    return running;
  }

  function live() {
    const time = now(), deployed = new Map(deployments(bundle));
    return verified.filter(p => deployed.get(p.chain) === p.address && p.start <= time && time < p.end &&
      p.checkedAt <= time && time - p.checkedAt < EXTRAS_INTERVAL_MS);
  }

  function match({ chain, slot, purchaseId, assetId }) {
    return live().find(p => (!chain || p.chain === chain) && p.slot === slot && p.id === purchaseId &&
      p.contentHash === contentHash(slot, { assetId }));
  }

  return {
    refresh, match,
    /** A fresh purchase may postdate the periodic poll. Coalesce misses across senders.
     * Undefined means the relevant deployment could not be checked; null is a checked miss. */
    async lookup(message) {
      const deployed = deployments(bundle).filter(([chain]) => !message.chain || chain === message.chain);
      if (!deployed.length) return null;
      const cached = match(message);
      if (cached) return cached;
      if (running || now() >= nextLookup) {
        nextLookup = now() + 30_000;
        await refresh();
      }
      const purchase = match(message);
      if (purchase) return purchase;
      const time = now();
      const complete = deployed.every(([chain, address]) => {
        const poll = checked.get(chain + ':' + message.slot);
        return poll?.address === address && poll.checkedAt <= time && time - poll.checkedAt < EXTRAS_INTERVAL_MS;
      });
      return complete ? null : undefined;
    },
    start() {
      if (!timer) {
        timer = setInterval(refresh, EXTRAS_INTERVAL_MS);
        timer.unref?.();
      }
      return refresh();
    },
    stop() { clearInterval(timer); timer = undefined; return running; },
    /** Match local candidates ({slot, assetId} or {slot, authorKey, envelopeId}). */
    active(candidates, limit = Infinity) {
      const matches = new Map(live().map(p => [p.slot + ':' + p.contentHash, p]));
      const items = [];
      if (!matches.size) return items;
      for (const candidate of candidates ?? candidatesFor()) {
        let key;
        try { key = candidate.slot + ':' + contentHash(candidate.slot, candidate); } catch { continue; }
        const purchase = matches.get(key);
        if (purchase) {
          items.push({ ...candidate, purchase: { ...purchase }, label: 'Promoted' });
          matches.delete(key);
          if (!matches.size || items.length >= limit) break;
        }
      }
      return items;
    },
  };
}

function tokenPlacement({ slot, assetId, purchaseId }) {
  return ['promoted-token', 'spotlight'].includes(slot) && isAsset(assetId) && !assetId.endsWith(':native') &&
    typeof purchaseId === 'string' && /^0x[0-9a-f]{64}$/.test(purchaseId);
}

/** Public, budgeted token identity check shared by paid announcements and local focus requests. */
export async function readTokenIdentity(publicRpc, chain, address) {
  // A one-item batch waits for the shared endpoint budget. A single slow public endpoint
  // can therefore finish code and interface checks without restarting from the first read.
  const batch = (chain, calls) => publicRpc.batch ? publicRpc.batch(chain, calls)
    : Promise.all(calls.map(({ method, params }) => publicRpc.call(chain, method, params)));
  const tokenRpc = { batch, call: async (chain, method, params) => (await batch(chain, [{ method, params }]))[0] };
  if (chain.family === 'solana') {
    const [mint] = await solanaNames(chain, [{ address }], tokenRpc);
    return mint;
  }
  const code = await tokenRpc.call(chain.id, 'eth_getCode', [address, 'latest']);
  if (code === '0x') return null;
  if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(code)) throw new Error('Invalid bytecode response');
  // Enumerable NFTs also implement totalSupply. ERC-20 allowance distinguishes the fungible interface.
  const account = word(address);
  const calls = [{ to: address, data: '0x18160ddd' }, { to: address, data: '0xdd62ed3e' + account + account }];
  const results = await multiRead(tokenRpc, chain, calls);
  return results.length === calls.length && results.every(value => readUint(value) !== null) ? {} : null;
}

/** Verified announcements are preimages, never observations. Retries share token validation and
 * only a live, locally verified purchase can create or extend the paid retention window. */
export function createPlacements({ engine, verifier, publicRpc, now }) {
  const { registry, store, transport } = engine;
  const quota = new PeerQuota(now, 8), tokenChecks = new Map();
  const leases = store.writer.prepare(`INSERT INTO engine_placement_assets(asset,keepUntil) VALUES (?,?)
    ON CONFLICT(asset) DO UPDATE SET keepUntil=max(keepUntil,excluded.keepUntil)`);
  const retained = store.reader.prepare(`SELECT coalesce(f.paidUntil,p.keepUntil) AS keepUntil
    FROM engine_placement_assets p LEFT JOIN engine_focus f ON f.asset=p.asset AND f.poolDiscovery=1
    WHERE p.asset=? AND coalesce(f.paidUntil,p.keepUntil)>?`);
  const revive = store.writer.prepare('UPDATE store_market_list SET forgotten=0 WHERE asset=? AND forgotten=1');
  const hold = store.writer.prepare(`UPDATE store_market_list SET forgotten=0 WHERE forgotten=1 AND asset IN
    (SELECT asset FROM engine_placement_assets WHERE keepUntil>?)`);
  const expired = store.writer.prepare('DELETE FROM engine_placement_assets WHERE keepUntil<=?');
  let pending = 0;
  function chainFor(assetId) {
    const [slug, address] = assetId.split(':');
    const chain = registry.chains.get(slug);
    return chain?.family === (isAddress(address) ? 'evm' : 'solana') ? chain : null;
  }

  function checkToken(assetId, chain) {
    const cached = tokenChecks.get(assetId);
    if (cached && cached.expires > now()) return cached.promise;
    if (tokenChecks.size >= 128) tokenChecks.delete(tokenChecks.keys().next().value);
    const entry = { expires: now() + EXTRAS_INTERVAL_MS, promise: readTokenIdentity(publicRpc, chain, assetId.split(':')[1]).catch(error => {
      if (tokenChecks.get(assetId) === entry) tokenChecks.delete(assetId);
      throw error;
    }) };
    tokenChecks.set(assetId, entry);
    return entry.promise;
  }

  async function adopt(message) {
    const chain = chainFor(message.assetId);
    if (!chain) return false;
    const purchase = await verifier.lookup(message);
    if (!purchase) return purchase === null ? false : null;
    const { assetId } = message;
    const until = purchase.end + 7 * DAY;

    const info = await checkToken(assetId, chain);
    if (!info) return false;
    const live = verifier.match(message);
    if (!live || live.chain !== purchase.chain || live.address !== purchase.address || live.end !== purchase.end) return false;
    if (retained.get(assetId, now())?.keepUntil >= until) return purchase;
    const previous = registry.assets.get(assetId);
    try {
      store.transaction(() => {
        registry.registerToken(chain.id, assetId.split(':')[1], info);
        leases.run(assetId, until);
        revive.run(assetId);
        engine.scheduleMeta(assetId, true);
      });
    } catch (error) {
      // SQLite rolled back registration. Revert the corresponding in-memory identity as well.
      if (previous) registry.assets.set(assetId, previous);
      else registry.assets.delete(assetId);
      throw error;
    }
    return purchase;
  }

  return {
    async receive(message, reporter) {
      if (pending >= 128 || !quota.take(reporter, 1)) return false;
      if (!tokenPlacement(message) || typeof message.chain !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(message.chain)) {
        engine.hints.penalize(reporter);
        return false;
      }
      pending++;
      try {
        const result = await adopt(message);
        if (result === false) engine.hints.penalize(reporter);
        return !!result;
      } catch {
        // A failed endpoint read is inconclusive and costs the reporter no standing.
        return false;
      } finally { pending--; }
    },
    async announcePlacement({ slot, assetId, purchaseId }) {
      const candidate = { slot, assetId, purchaseId };
      if (!tokenPlacement(candidate)) throw new TypeError('Invalid token placement');
      if (pending >= 128) throw new Error('Placement verification busy');
      pending++;
      const purchase = await adopt(candidate).catch(() => null).finally(() => { pending--; });
      if (purchase === null) throw new Error('Placement verification unavailable');
      if (!purchase) throw new RangeError('No verified live placement for this token and purchase');
      const message = { t: 'placement', v: 1, ...candidate, chain: purchase.chain };
      return { ...candidate, chain: purchase.chain, announced: transport.send('gator/new', message) };
    },
    state(assetId) {
      if (!registry.assets.has(assetId)) return null;
      const lease = retained.get(assetId, now());
      const [active] = verifier.active(['promoted-token', 'spotlight'].map(slot => ({ slot, assetId })));
      if (!lease && !active) return null;
      return { keepUntil: lease?.keepUntil ?? null, active: active ? { slot: active.slot, label: active.label,
        purchaseId: active.purchase.id, chain: active.purchase.chain, until: active.purchase.end } : null };
    },
    prune(db, { now: at }) { expired.run(at); hold.run(at); },
  };
}
