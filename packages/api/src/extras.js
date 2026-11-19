import { contentHash, purchasedLogs, readExtrasTerms, unsignedPurchase } from '../../engine/src/intel/extras.js';
import { isAddress, isAsset, ZERO } from '../../engine/src/intel/values.js';
import { check, HttpError } from './local.js';

const slots = ['promoted-token', 'pinned-news', 'spotlight'];
const txPattern = /^0x[0-9a-f]{64}$/i;

/** A node can prepare transactions and read receipts using only the signed bundle's public RPCs. */
export function extrasRoutes({ engine, clock, store }, market) {
  const cache = new Map(), rpc = engine.rpc.publicOnly, bundle = engine.bundle;
  // Receipts only contain hashes. Keep recent preimages across a wallet handoff or daemon restart,
  // including quotes for tokens and posts that the node has not encountered yet.
  const quoteKey = 'api:extras:recent-quotes';
  const quoted = new Map((store.getSetting(quoteKey) ?? []).map(candidate => [contentHash(candidate.slot, candidate), candidate]));
  function deployments() {
    return bundle.chains.filter(c => c.family === 'evm').flatMap(chain => {
      const contract = bundle.paidExtras?.[chain.id];
      return isAddress(contract) && contract.toLowerCase() !== ZERO ? [{ chain, contract }] : [];
    });
  }
  function terms({ chain, contract }) {
    const key = chain.id + ':' + contract;
    const cached = cache.get(key), at = clock();
    if (cached && (cached.at == null || (at >= cached.at && at - cached.at < 60_000))) return cached.read;
    const entry = { at: null };
    // Public RPCs fail now and then: try up to three reads (the client rotates endpoints after a failure) and keep a
    // failed result for no more than this request, so the next quote reads again instead of failing for a minute.
    const attempt = (left) => readExtrasTerms(rpc, chain, contract).catch(error => (left > 1 ? attempt(left - 1) : Promise.reject(error)));
    entry.read = attempt(3).then(fields => {
      entry.at = clock();
      return { ...fields, checkedAt: entry.at };
    }, () => {
      if (cache.get(key) === entry) cache.delete(key);
      return { paymentToken: null, paused: null, slots: slots.map(slot => ({ slot, price: null, nextStart: null })), checkedAt: clock() };
    });
    cache.set(key, entry);
    return entry.read;
  }
  async function list(slot) {
    check(slot === undefined || slots.includes(slot), 'unknown slot');
    const prices = await Promise.all(deployments().map(async d => {
      const { slots: rows, ...meta } = await terms(d);
      return rows.filter(r => !slot || r.slot === slot).map(row => ({
        chain: d.chain.id, chainId: d.chain.chainId, contract: d.contract, ...meta, ...row,
      }));
    }));
    return { ...market.extras(slot), slots: prices.flat() };
  }
  async function quote({ slot, asset, post }) {
    check(slots.includes(slot), 'unknown slot');
    const news = slot === 'pinned-news';
    check(news ? post && asset === undefined : typeof asset === 'string' && post === undefined,
      news ? 'provide a post key and id' : 'provide an asset');
    const candidate = news ? { slot, authorKey: post.key, envelopeId: post.id } :
      { slot, assetId: isAsset(asset) ? asset : market.resolve(asset, false) };
    let hash;
    try { hash = contentHash(slot, candidate); }
    catch { throw new HttpError(400, 'invalid content identity'); }
    const all = deployments(), d = all.find(d => d.chain.id === 'ethereum') ?? all[0];
    check(d, 'no paid extras deployment', 503);
    const { slots: rows, paymentToken, paused, checkedAt } = await terms(d);
    check(paymentToken, 'live slot terms unavailable', 503);
    check(!paused, 'new purchases are paused', 409);
    const { price, nextStart } = rows.find(row => row.slot === slot);
    const chainId = d.chain.chainId, contract = d.contract;
    const txs = unsignedPurchase({ chainId, contract, paymentToken, slot, price, nextStart, hash });
    quoted.delete(hash);
    if (quoted.size >= 128) quoted.delete(quoted.keys().next().value);
    quoted.set(hash, candidate);
    store.setSetting(quoteKey, [...quoted.values()]);
    const target = news ? post.key + '/' + post.id : candidate.assetId;
    return { ...candidate, chain: d.chain.id, chainId, contract, paymentToken, price, nextStart, checkedAt, contentHash: hash, ...txs,
      summary: 'Approve ' + price + ' TAP base units, then buy ' + slot + ' for ' + target + ' on ' + d.chain.name +
        '. Latest accepted start ' + new Date(txs.maxStart).toISOString() + '. Both transactions are unsigned.' };
  }
  async function receipt({ txHash }) {
    check(typeof txHash === 'string' && txPattern.test(txHash), 'invalid transaction hash');
    txHash = txHash.toLowerCase();
    const all = deployments();
    check(all.length, 'no paid extras deployment', 503);
    let unavailable = false, mismatch;
    for (const { chain, contract } of all) {
      let receipt;
      try { receipt = await rpc.call(chain.id, 'eth_getTransactionReceipt', [txHash]); }
      catch { unavailable = true; continue; }
      if (!receipt) continue;
      if (typeof receipt.transactionHash !== 'string' || receipt.transactionHash.toLowerCase() !== txHash ||
          !['0x0','0x1'].includes(receipt.status)) { unavailable = true; continue; }
      if (receipt.status === '0x0') { mismatch = 'transaction reverted'; continue; }
      const purchases = purchasedLogs(receipt, txHash, contract);
      if (!purchases.length) { mismatch = 'no Purchased event from the configured contract'; continue; }
      const results = purchases.map(purchase => {
        let candidate = quoted.get(purchase.contentHash);
        if (!candidate) {
          for (const item of market.extraCandidates(purchase.slot)) {
            if (item.assetId && !isAsset(item.assetId)) continue;
            if (contentHash(item.slot, item) === purchase.contentHash) { candidate = item; break; }
          }
        }
        const shown = market.extras(purchase.slot).items.some(row => row.purchaseId === purchase.purchaseId &&
          row.chain === chain.id && row.contract.toLowerCase() === contract.toLowerCase() && row.contentHash === purchase.contentHash);
        return { ...purchase, contentHashMatch: !!candidate, content: candidate ?? null, shown,
          ...(purchase.slot !== 'pinned-news' && { next: 'Call announce_placement with the assetId, slot and purchaseId when the purchase is live.' }) };
      });
      return { txHash, chain: chain.id, contract, ...results[0], ...(results.length > 1 && { purchases: results }) };
    }
    if (unavailable) throw new HttpError(503, 'receipt verification unavailable');
    if (mismatch) throw new HttpError(422, mismatch);
    throw new HttpError(404, 'receipt not found or still pending');
  }
  return { list, quote, receipt };
}
