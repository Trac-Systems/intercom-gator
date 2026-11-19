import { resolveTxt as dnsTxt } from 'node:dns/promises';
import { NEW_POLICY, PeerQuota } from '../obs/index.js';
import { labels, validDecimals } from '../sources/names/text.js';
import { keccak256 } from './keccak.js';
import { isAddress, isAsset, isKey, readAddress, readUint, selector, validMessage, word, ZERO } from './values.js';

const linkKinds = ['website', 'x', 'github', 'docs', 'logo'];
const curveOrder = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const channelName = 'gator/meta';
const isSignature = s => typeof s === 'string' && /^0x[\da-f]{130}$/i.test(s);
const challenge = (asset, value) => 'intercom-gator:' + asset + ':' + value;

function webUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\//i.test(value) || /[\s\\\p{Cc}]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return url.hostname && !url.username && !url.password ? url : null;
  } catch { return null; }
}

function validClaim({ asset, kind, value, proof }) {
  if (!isAsset(asset)) return false;
  if (kind === 'supply') {
    if (typeof value !== 'string' || !/^\d{1,80}(?:\.\d{1,78})?$/.test(value)) return false;
  } else if (!linkKinds.includes(kind) || !webUrl(value)) return false;
  if (proof === undefined) return true;
  return proof?.type === 'deployer' ? isSignature(proof.signature) &&
    (proof.tx === undefined || (typeof proof.tx === 'string' && /^0x[\da-f]{64}$/i.test(proof.tx))) :
    ['wrong', 'dns', 'on-chain', 'token-list'].includes(proof?.type);
}

/** Verify the exact UTF-8 challenge via the standard EVM ecrecover precompile.
 * The deployer address comes from the local creation index. */
export async function verifyDeployer({ rpc, asset, value, signature, deployer }) {
  if (!isAsset(asset) || !isAddress(asset.split(':')[1]) || !isSignature(signature) ||
      !isAddress(deployer) || deployer.toLowerCase() === ZERO) return false;
  const r = signature.slice(2, 66), s = signature.slice(66, 130);
  let v = parseInt(signature.slice(130), 16);
  if (v <= 1) v += 27;
  if (![27, 28].includes(v) || BigInt('0x' + r) === 0n || BigInt('0x' + r) >= curveOrder ||
      BigInt('0x' + s) === 0n || BigInt('0x' + s) > curveOrder / 2n) return false;
  const text = challenge(asset, value);
  const digest = keccak256('\x19Ethereum Signed Message:\n' + Buffer.byteLength(text) + text);
  const data = digest + word(v) + r + s;
  const result = await rpc.call(asset.split(':')[0], 'eth_call', [{ to: '0x' + '0'.repeat(39) + '1', data }, 'latest']);
  return readAddress(result) === deployer.toLowerCase();
}

/** TXT chunks in one record concatenate. Separate records cannot combine into a proof. */
async function dnsProof(asset, value, website, resolveTxt) {
  const host = webUrl(website)?.hostname;
  if (!host || host.length > 253 || !host.includes('.') ||
      !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
      /^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  const records = await resolveTxt(host);
  return records.some(chunks => chunks.join('') === challenge(asset, value));
}

function decodeText(hex) {
  if (typeof hex !== 'string' || hex.length > 8706 || !/^0x(?:[\da-f]{64}){2,}$/i.test(hex) ||
      BigInt('0x' + hex.slice(2, 66)) !== 32n) return null;
  const size = Number(BigInt('0x' + hex.slice(66, 130)));
  if (size > 2048 || hex.length !== 130 + 64 * Math.ceil(size / 32)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(hex.slice(130, 130 + size * 2), 'hex')); }
  catch { return null; }
}

/** Pull directly declared website/logo and ERC-20 total supply at one block. */
export async function onchainMetadata(asset, rpc) {
  if (!isAsset(asset) || !isAddress(asset.split(':')[1])) return {};
  const [chain, to] = asset.split(':');
  let block;
  try { block = await rpc.call(chain, 'eth_blockNumber', []); } catch { return {}; }
  if (!/^0x[\da-f]{1,16}$/i.test(block)) return {};
  const call = async signature => {
    try { return await rpc.call(chain, 'eth_call', [{ to, data: selector(signature) }, block]); } catch { return null; }
  };
  const [site, logo, total, places] = await Promise.all(['website()', 'logoURI()', 'totalSupply()', 'decimals()'].map(call));
  const fields = { website: decodeText(site), logo: decodeText(logo) };
  const units = readUint(total), decimals = readUint(places);
  if (units !== null && decimals !== null && decimals <= 78n) {
    const n = Number(decimals), digits = String(units).padStart(n + 1, '0');
    fields.supply = n ? (digits.slice(0, -n) + '.' + digits.slice(-n)).replace(/\.?0+$/, '') : digits;
  }
  return fields;
}

/** store is the optional market store (upsertClaim/claimsForAsset). getDeployer and websiteFor
 * resolve independent local identities. metadataFor can adapt additional on-chain metadata formats. */
export function createClaimService({ rpc, publicRpc = rpc?.publicOnly, bundle = {}, store, transport, getDeployer, websiteFor,
  resolveTxt = dnsTxt, metadataFor, now = Date.now } = {}) {
  const memory = new Map();
  const rowsFor = asset => store ? store.claimsForAsset(asset) : [...(memory.get(asset)?.values() ?? [])];
  function save(row) {
    const key = row.kind + ':' + row.reporter;
    const previous = rowsFor(row.asset).find(r => r.kind === row.kind && r.reporter === row.reporter);
    if (previous && previous.at >= row.at) return false;
    if (store) store.upsertClaim(row);
    else {
      if (!memory.has(row.asset)) {
        if (memory.size >= 4096) memory.delete(memory.keys().next().value);
        memory.set(row.asset, new Map());
      }
      const rows = memory.get(row.asset);
      if (!previous && rows.size >= 384) return false;
      rows.set(key, row);
    }
    return true;
  }

  async function deployerFor(asset, proof, client) {
    const indexed = await getDeployer?.(asset);
    if (isAddress(indexed)) return indexed;
    if (!proof.tx) return null;
    const [chain, address] = asset.split(':');
    const receipt = await client.call(chain, 'eth_getTransactionReceipt', [proof.tx]);
    if (receipt?.transactionHash?.toLowerCase() !== proof.tx.toLowerCase() || receipt.status !== '0x1' ||
        receipt.to !== null || receipt.contractAddress?.toLowerCase() !== address) return null;
    return receipt.from;
  }
  async function accept(message, reporter, at, client) {
    if (!validClaim(message) || at > now() || (store?.getAsset && !store.getAsset(message.asset))) return false;
    const previous = rowsFor(message.asset).find(r => r.kind === message.kind && r.reporter === reporter);
    if (previous && previous.at >= at) return false;
    const { asset, kind, value, proof } = message;
    let verified = false;
    try {
      if (client && proof?.type === 'deployer') verified = await verifyDeployer({ rpc: client, asset, value,
        signature: proof.signature, deployer: await deployerFor(asset, proof, client) });
      if (proof?.type === 'dns') {
        const site = await websiteFor?.(asset) ?? rowsFor(asset).find(r => r.kind === 'website' && r.proof?.verified)?.value;
        verified = await dnsProof(asset, value, site, resolveTxt);
      }
    } catch { /* An unavailable proof leaves an ordinary reporter assertion. */ }
    return save({ asset, kind, value, reporter, at, proof: { type: proof?.type ?? 'agent', verified } });
  }

  function list(asset) {
    const grouped = new Map();
    for (const { kind, value, reporter, proof } of rowsFor(asset)) {
      const key = kind + ':' + value;
      if (!grouped.has(key)) grouped.set(key, { asset, kind, value, reporters: 0, wrong: 0, verified: false });
      const row = grouped.get(key);
      if (proof?.type === 'wrong') row.wrong++;
      else if (isKey(reporter)) row.reporters++;
      if (proof?.verified) row.verified = true;
    }
    return [...grouped.values()].map(row => ({ ...row,
      trust: row.wrong ? 'red' : row.verified || row.reporters >= 3 ? 'green' : 'yellow' }));
  }
  function recordAutomatic(asset, fields, source) {
    if (!['on-chain', 'token-list'].includes(source)) throw new TypeError('Invalid automatic source');
    for (const [kind, value] of Object.entries(fields)) {
      if (!validClaim({ asset, kind, value })) continue;
      const row = { asset, kind, value, reporter: source, at: now(), proof: { type: source, verified: true } };
      if (save(row)) transport?.send(channelName, { v: 1, t: 'claim', asset, kind, value, proof: { type: source } });
    }
  }
  return {
    list, recordAutomatic,
    async syncAutomatic(asset) {
      const records = bundle.tokens?.tokens ?? bundle.tokens;
      const token = Array.isArray(records) && records.find(t => t.id === asset);
      if (token) recordAutomatic(asset, { ...token, logo: token.logo ?? token.logoURI }, 'token-list');
      if (metadataFor || rpc) recordAutomatic(asset, metadataFor ? await metadataFor(asset) : await onchainMetadata(asset, rpc), 'on-chain');
      return list(asset);
    },
    async consume(channel, envelope) {
      if (!validMessage(channel, envelope, channelName, 'claim')) return false;
      return accept(envelope.message, envelope.from, envelope.ts, publicRpc);
    },
    async publish(claim) {
      if (!isKey(transport?.publicKey) || !validClaim(claim)) return false;
      const { asset, kind, value, proof } = claim;
      const m = { v: 1, t: 'claim', asset, kind, value, ...(proof && { proof }) };
      if (!await accept(m, transport.publicKey, now(), rpc)) return false;
      return transport.send(channelName, m);
    },
  };
}

const nameTtl = 24 * 3600_000;

/** Signed name claims are display evidence. Only the local reader writes trusted asset metadata. */
export class NameClaims {
  constructor(engine) {
    this.engine = engine;
    this.reports = new Map();
    this.quota = new PeerQuota(engine.clock, 60);
    this.receive = this.receive.bind(this);
  }
  async listen() {
    const { transport, joined, abort, active } = this.engine;
    if (this.attached || !active) return;
    if (!transport.channels().includes(channelName)) {
      if (!await transport.join(channelName, NEW_POLICY)) throw new Error('Name claim channel unavailable');
      if (!joined.includes(channelName)) joined.push(channelName);
    }
    abort.signal.throwIfAborted();
    transport.on('message', this.receive);
    this.attached = true;
    abort.signal.addEventListener('abort', () => {
      transport.off('message', this.receive);
      this.attached = false;
      this.reports.clear();
    }, { once: true });
  }
  receive(channel, env) {
    const m = env?.message, { registry, transport, book, clock } = this.engine;
    if (m?.kind !== 'name' || !validMessage(channel, env, channelName, 'claim') || env.from === transport.publicKey ||
        m.proof !== undefined || !this.quota.take(env.from, 1) || !book.isProven(env.from)) return;
    const now = clock(), asset = registry.assets.get(m.asset), v = m.value;
    if (!asset || asset.address === 'native' || asset.kind === 'nft' || !v || typeof v.method !== 'string' ||
        !/^[a-z][a-z0-9._-]{0,47}$/i.test(v.method) || ['reported', 'peer-agreement'].includes(v.method.toLowerCase()) ||
        env.ts < now - nameTtl || env.ts > now + 30_000 || !validDecimals(v.decimals) ||
        (v.block !== undefined && !(Number.isSafeInteger(v.block) && v.block >= 0))) return;
    const fields = labels(v, asset.address);
    if (!fields || fields.name !== v.name || fields.symbol !== v.symbol) return;
    let rows = this.reports.get(asset.id);
    if (!rows) {
      if (this.reports.size >= 512) this.reports.delete(this.reports.keys().next().value);
      this.reports.set(asset.id, rows = new Map());
    }
    for (const [key, r] of rows) if (r.at < now - nameTtl) rows.delete(key);
    if ((!rows.has(env.from) && rows.size >= 16) || (rows.get(env.from)?.at ?? -1) >= env.ts) return;
    rows.set(env.from, { ...fields, decimals: v.decimals, at: env.ts });
  }
  consensus(id) {
    const groups = new Map(), { book, clock } = this.engine;
    for (const [key, r] of this.reports.get(id) ?? []) {
      if (r.at < clock() - nameTtl || !book.isProven(key)) continue;
      // The asserted fields must be identical. Independent readers can observe them at different blocks.
      const identity = JSON.stringify([r.name, r.symbol, r.decimals]);
      const group = groups.get(identity) ?? { count: 0, value: { name: r.name, symbol: r.symbol, decimals: r.decimals } };
      group.count++;
      groups.set(identity, group);
    }
    const agreed = [...groups.values()].filter(g => g.count >= 2);
    return agreed.length === 1 ? agreed[0].value : null;
  }
  send(asset, value) {
    return this.attached && this.engine.active &&
      this.engine.transport.send(channelName, { t: 'claim', v: 1, asset, kind: 'name', value });
  }
}
