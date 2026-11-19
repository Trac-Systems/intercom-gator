import { keccak256 } from './keccak.js';
import { UNKNOWN } from './evm.js';
import { addressWord, DAY, isAddress, isTime, readAddress, readUint, ZERO } from './values.js';

const DEAD = '0x' + '0'.repeat(36) + 'dead';
const addresses = list => (list ?? []).filter(isAddress).map(a => a.toLowerCase());
const positive = value => Number.isFinite(value) && value > 0;

const transferTopic = keccak256('Transfer(address,address,uint256)');
const quantity = n => '0x' + n.toString(16);
function creationBlock(pool, head) {
  const n = pool.block;
  return Number.isSafeInteger(n) && n >= 0 && BigInt(n) <= head ? BigInt(n) : null;
}

// ERC-20 has no holder iterator. Use observed LP transfers only as candidate addresses,
// then measure balances and account code at the pinned block. Unseen supply stays unknown.
async function holderCandidates(reader, pool) {
  if (Array.isArray(pool.holders)) return addresses(pool.holders).slice(0, 32);
  if (!reader.block) return [];
  const head = BigInt(reader.block), start = head > 95n ? head - 95n : 0n;
  const ranges = [[start, head]], created = creationBlock(pool, head);
  if (created !== null && created < start) ranges.unshift([created, created]);
  const candidates = new Set();
  for (const [from, to] of ranges) {
    const logs = await reader.read('eth_getLogs', [{ address: pool.address, topics: [transferTopic],
      fromBlock: quantity(from), toBlock: quantity(to) }]);
    if (!Array.isArray(logs)) continue;
    for (const log of logs.slice(-256)) {
      if (log?.removed || log?.address?.toLowerCase() !== pool.address.toLowerCase() ||
          log.topics?.[0] !== transferTopic) continue;
      const recipient = readAddress(log.topics[2]);
      if (recipient) candidates.add(recipient);
      if (candidates.size >= 32) return [...candidates];
    }
  }
  return [...candidates];
}

const createdTopics = new Map([
  [keccak256('PairCreated(address,address,address,uint256)'), 0],
  [keccak256('PoolCreated(address,address,uint24,int24,address)'), 1],
]);

// The engine can first see a pair in a swap. Count its block as the birth block only
// when the recorded transaction contains the matching factory creation event.
async function findCreationBlock(reader, pool) {
  if (!isAddress(pool.factory) || !/^0x[\da-f]{64}$/i.test(pool.discoveryTx ?? '')) return null;
  const receipt = await reader.read('eth_getTransactionReceipt', [pool.discoveryTx]);
  if (!Array.isArray(receipt?.logs) || receipt.logs.length > 1024 || !/^0x[\da-f]{1,14}$/i.test(receipt.blockNumber)) return null;
  for (const log of receipt.logs) {
    const i = createdTopics.get(log?.topics?.[0]);
    if (i === undefined || log?.address?.toLowerCase() !== pool.factory.toLowerCase() ||
        typeof log.data !== 'string' || !/^0x(?:[\da-f]{64}){2}$/i.test(log.data)) continue;
    const pair = readAddress('0x' + log.data.slice(2 + i * 64, 66 + i * 64));
    if (pair === pool.address.toLowerCase()) return Number(BigInt(receipt.blockNumber));
  }
  return null;
}

async function poolAge(reader, pool, at) {
  let createdAt = pool.createdAt;
  if (!isTime(createdAt) && reader.block) {
    const block = creationBlock(pool, BigInt(reader.block));
    if (block !== null) {
      const header = await reader.read('eth_getBlockByNumber', [quantity(block), false]);
      if (/^0x[\da-f]{1,14}$/i.test(header?.timestamp)) createdAt = Number(BigInt(header.timestamp)) * 1000;
    }
  }
  return isTime(createdAt) && createdAt <= at ? at - createdAt : null;
}

// When a creation event is missing, historical code can establish an age bound.
// The timestamp of the block actually returned determines what the observation proves.
async function ageBound(reader, pool, at, threshold, seconds) {
  if (!reader.block || !Number.isFinite(seconds) || seconds <= 0) return null;
  const header = async block => {
    const h = await reader.read('eth_getBlockByNumber', [quantity(block), false]);
    return /^0x[\da-f]{1,12}$/i.test(h?.timestamp) ? Number(BigInt(h.timestamp)) * 1000 : null;
  };
  const head = BigInt(reader.block), target = at - threshold;
  const headAt = await header(head);
  if (headAt === null || headAt < target || headAt > at + 60_000) return null;
  let block = head - BigInt(Math.ceil((headAt - target) / (1000 * seconds)));
  if (block < 0n) block = 0n;
  for (let attempt = 0; attempt < 2; attempt++) {
    const time = await header(block);
    if (time === null || time > at) return null;
    const code = await reader.read('eth_getCode', [pool.address, quantity(block)]);
    const evidence = { method: 'pool code at historical block', block: quantity(block), at: time };
    if (typeof code !== 'string' || !/^0x(?:[\da-f]{2})*$/i.test(code)) return null;
    if (code !== '0x' && time <= target) return { flag: false, ...evidence, minAgeMs: at - time };
    if (code === '0x' && time >= target) return { flag: true, ...evidence, maxAgeMs: at - time };
    // Move to the other side of the cutoff using the observed time difference.
    const steps = BigInt(Math.max(1, Math.ceil(Math.abs(time - target) / (1000 * seconds)) + 1));
    block += time < target ? steps : -steps;
    if (block < 0n || block > head) break;
  }
  return null;
}

async function lockStatus(reader, pool, lockers) {
  const supply = readUint(await reader.call(pool.address, 'totalSupply()'));
  if (!supply) return { flag: UNKNOWN };
  const lockedAccounts = new Set([ZERO, DEAD, ...addresses(lockers)]);
  const holders = new Set([...lockedAccounts, ...await holderCandidates(reader, pool)]);
  let locked = 0n, eoa = 0n;
  for (const holder of holders) {
    const balance = readUint(await reader.call(pool.address, 'balanceOf(address)', addressWord(holder)));
    if (!balance) continue;
    if (lockedAccounts.has(holder)) locked += balance;
    else if (await reader.code(holder) === '0x') eoa += balance;
  }
  let flag = UNKNOWN;
  if (locked + eoa <= supply) {
    if (eoa > 0n) flag = true;
    else if (locked === supply) flag = false;
  }
  return { flag, supply: String(supply), locked: String(locked), eoa: String(eoa), method: 'V2 LP balances' };
}

async function usdReserves(reader, pool, a, b, v2, prices) {
  let balances;
  if (v2) {
    const data = await reader.call(pool.address, 'getReserves()');
    if (typeof data !== 'string' || !/^0x[\da-f]{192}$/i.test(data)) return null;
    balances = data.slice(2).match(/.{64}/g).slice(0, 2).map(s => BigInt('0x' + s));
  } else {
    balances = await Promise.all([a, b].map(async token =>
      readUint(await reader.call(token, 'balanceOf(address)', addressWord(pool.address)))));
  }
  const sides = await Promise.all([a, b].map(async (token, i) => {
    const price = Number(prices[token]);
    if (!positive(price) || balances[i] === null) return null;
    const decimals = readUint(await reader.call(token, 'decimals()'));
    if (decimals === null || decimals > 255n) return null;
    const usd = Number(balances[i]) / 10 ** Number(decimals) * price;
    return Number.isFinite(usd) ? usd : null;
  }));
  const priced = sides.filter(s => s !== null);
  if (priced.length === 2) return { usd: priced[0] + priced[1], method: v2 ? 'priced reserves' : 'priced pool balances' };
  if (priced.length === 1 && v2) return { usd: 2 * priced[0], method: 'V2 estimate from one priced reserve' };
  return null;
}

export async function poolRisk(reader, token, pool, { at, prices, lockers, lowLiquidityUsd, veryNewMs = DAY, blockTimeSeconds }) {
  const flags = { lpUnlocked: UNKNOWN, veryNew: UNKNOWN, lowLiquidity: UNKNOWN };
  const evidence = {};
  if (!isAddress(pool?.address)) return { flags, evidence };
  const [a, b] = await Promise.all(['token0()', 'token1()'].map(async f => readAddress(await reader.call(pool.address, f))));
  if (!a || !b || a === b || ![a, b].includes(token)) return { flags, evidence };
  evidence.pool = pool.address;
  if (pool.block == null && pool.discoveryTx && reader.block) pool = { ...pool, block: await findCreationBlock(reader, pool) };
  evidence.ageMs = await poolAge(reader, pool, at);
  if (evidence.ageMs !== null) {
    flags.veryNew = evidence.ageMs < veryNewMs;
  } else if (['v2', 'uniswap-v2', 'v3', 'uniswap-v3'].includes(pool.kind)) {
    evidence.ageBound = await ageBound(reader, pool, at, veryNewMs, blockTimeSeconds);
    if (evidence.ageBound) flags.veryNew = evidence.ageBound.flag;
  }
  const v2 = ['v2', 'uniswap-v2'].includes(pool.kind);
  if (v2) {
    evidence.lp = await lockStatus(reader, pool, lockers);
    flags.lpUnlocked = evidence.lp.flag;
  }
  evidence.liquidity = await usdReserves(reader, pool, a, b, v2, prices ?? {});
  if (Number.isFinite(evidence.liquidity?.usd)) flags.lowLiquidity = evidence.liquidity.usd < (lowLiquidityUsd ?? 100_000);
  return { flags, evidence };
}
