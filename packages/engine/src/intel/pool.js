import { keccak256 } from './keccak.js';
import { UNKNOWN } from './evm.js';
import { V3_KINDS } from './routes.js';
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
    // The creating transaction's sender usually added the first liquidity: an LP holder candidate.
    if (pair === pool.address.toLowerCase()) return { block: Number(BigInt(receipt.blockNumber)),
      from: isAddress(receipt.from) ? receipt.from.toLowerCase() : null };
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

// Readers without Multicall3 support (tests, minimal adapters) fall back to individual calls.
const callsOf = reader => reader.calls ?? (list => Promise.all(list.map(c => reader.call(...c))));
const pct = (part, whole) => whole > 0n ? Number(part * 10_000n / whole) / 100 : null;

/** V2 LP tokens: measured shares of the LP supply at the pinned block. Burned (zero, 0x…dead) and known lockers count as
 * locked; an externally owned account can withdraw at will. true: EOAs hold >= 5%; false: >= 95% burned or locked;
 * otherwise the seen balances cannot decide (LP in other contracts, or holders not among the candidates). */
async function lockStatus(reader, pool, lockers, extra) {
  const lockedAccounts = new Set([ZERO, DEAD, ...addresses(lockers)]);
  const holders = [...new Set([...lockedAccounts, ...addresses(extra), ...await holderCandidates(reader, pool)])].slice(0, 40);
  const [supplyData, ...balanceData] = await callsOf(reader)([[pool.address, 'totalSupply()'],
    ...holders.map(h => [pool.address, 'balanceOf(address)', addressWord(h)])]);
  const supply = readUint(supplyData);
  if (!supply) return { flag: UNKNOWN, reason: supply === 0n ? 'no LP supply (empty pool)' : 'LP supply unavailable' };
  let locked = 0n, eoa = 0n, contracts = 0n, unread = 0n;
  const others = [];
  holders.forEach((holder, i) => {
    const balance = readUint(balanceData[i]);
    if (!balance) return;
    if (lockedAccounts.has(holder)) locked += balance;
    else others.push([holder, balance]);
  });
  others.sort((x, y) => (y[1] > x[1]) - (y[1] < x[1]));
  for (const [i, [holder, balance]] of others.entries()) {
    const code = i < 4 ? await reader.code(holder) : null;
    if (code === '0x') eoa += balance;
    else if (typeof code === 'string') contracts += balance;
    else unread += balance;
  }
  const seen = locked + eoa + contracts + unread;
  const evidence = { supply: String(supply), locked: String(locked), eoa: String(eoa), contracts: String(contracts),
    lockedPct: pct(locked, supply), eoaPct: pct(eoa, supply), unseenPct: seen <= supply ? pct(supply - seen, supply) : null,
    method: 'V2 LP balances of burn, locker, owner, token and recent LP recipients' };
  if (seen > supply) return { flag: UNKNOWN, ...evidence, reason: 'inconsistent LP balances' };
  if (eoa * 20n >= supply) return { flag: true, ...evidence };
  if (locked * 20n >= supply * 19n) return { flag: false, ...evidence };
  return { flag: UNKNOWN, ...evidence, reason: 'under 95% of LP burned or locked and under 5% seen with EOAs' +
    (contracts > 0n ? ' (LP held by other contracts)' : '') };
}

/** USD value of the pool from priced balances. Both sides priced: their sum. One side priced: a V2 pool holds equal
 * value on both sides (2x); a concentrated-liquidity pool only gives a lower bound (the priced side). */
async function usdReserves(reader, pool, a, b, v2, prices, reserves) {
  const [decimalsA, decimalsB, balanceA, balanceB] = await callsOf(reader)([[a, 'decimals()'], [b, 'decimals()'],
    ...(v2 ? [] : [[a, 'balanceOf(address)', addressWord(pool.address)], [b, 'balanceOf(address)', addressWord(pool.address)]])]);
  const balances = v2 ? reserves : [readUint(balanceA), readUint(balanceB)];
  if (!balances) return null;
  // An empty pool is worth $0 whatever the prices (launchpad pairs created before liquidity is added).
  if (balances[0] === 0n && balances[1] === 0n) return { usd: 0, method: 'empty pool (no reserves)' };
  const sides = [a, b].map((token, i) => {
    const price = Number(prices[token]), decimals = readUint([decimalsA, decimalsB][i]);
    if (!positive(price) || balances[i] === null || decimals === null || decimals > 255n) return null;
    const usd = Number(balances[i]) / 10 ** Number(decimals) * price;
    return Number.isFinite(usd) ? usd : null;
  });
  const priced = sides.filter(s => s !== null);
  if (priced.length === 2) return { usd: priced[0] + priced[1], method: v2 ? 'priced reserves' : 'priced pool balances' };
  if (priced.length === 1 && v2) return { usd: 2 * priced[0], method: 'V2 estimate from one priced reserve' };
  if (priced.length === 1) return { atLeastUsd: priced[0], method: 'lower bound from one priced pool balance' };
  return null;
}

/** Flags: lpUnlocked, veryNew, lowLiquidity. `why` explains every flag left unknown. */
export async function poolRisk(reader, token, pool, { at, prices, lockers, lowLiquidityUsd, veryNewMs = DAY, blockTimeSeconds,
  liquidityUsd, holders } = {}) {
  const flags = { lpUnlocked: UNKNOWN, veryNew: UNKNOWN, lowLiquidity: UNKNOWN };
  const evidence = {}, why = {};
  const all = reason => { for (const k of Object.keys(flags)) if (flags[k] === UNKNOWN) why[k] ??= reason; return { flags, evidence, why }; };
  if (!isAddress(pool?.address)) return all(reader.stats?.refused ? 'pool lookup refused (' + reader.stats.reasons.at(-1) + ')' : 'no pool found');
  const v2 = ['v2', 'uniswap-v2'].includes(pool.kind);
  // V2: the token's owner (Ownable or BEP-20 getOwner) is a likely LP holder; read with the pool state.
  const [t0, t1, reservesData, ownerData, getOwnerData] = await callsOf(reader)([[pool.address, 'token0()'],
    [pool.address, 'token1()'], ...(v2 ? [[pool.address, 'getReserves()'], [token, 'owner()'], [token, 'getOwner()']] : [])]);
  const [a, b] = [readAddress(t0), readAddress(t1)];
  if (!a || !b || a === b || ![a, b].includes(token)) {
    return all(t0 === null ? 'pool state unavailable (' + (reader.stats?.reasons.at(-1) ?? 'rpc') + ')' : 'pool does not hold this token');
  }
  evidence.pool = pool.address;
  evidence.kind = pool.kind;
  const threshold = lowLiquidityUsd ?? 100_000;
  const reserves = typeof reservesData === 'string' && /^0x[\da-f]{192}$/i.test(reservesData)
    ? reservesData.slice(2).match(/.{64}/g).slice(0, 2).map(s => BigInt('0x' + s)) : null;
  evidence.liquidity = await usdReserves(reader, pool, a, b, v2, prices ?? {}, reserves);
  if (Number.isFinite(evidence.liquidity?.usd)) flags.lowLiquidity = evidence.liquidity.usd < threshold;
  else if (evidence.liquidity?.atLeastUsd >= threshold) flags.lowLiquidity = false;
  else if (Number.isFinite(liquidityUsd) && liquidityUsd >= 0) {
    evidence.liquidity = { usd: liquidityUsd, method: 'engine-measured pool depth' };
    flags.lowLiquidity = liquidityUsd < threshold;
  } else why.lowLiquidity = evidence.liquidity ? 'only one side priced; lower bound below the threshold' : 'no USD price for either pool token';

  const creators = [];
  if (pool.block == null && pool.discoveryTx && reader.block) {
    const created = await findCreationBlock(reader, pool);
    pool = { ...pool, block: created?.block ?? null };
    if (created?.from) creators.push(created.from);
  }
  evidence.ageMs = await poolAge(reader, pool, at);
  if (evidence.ageMs !== null) {
    flags.veryNew = evidence.ageMs < veryNewMs;
  } else if (v2 || V3_KINDS.has(pool.kind)) {
    evidence.ageBound = await ageBound(reader, pool, at, veryNewMs, blockTimeSeconds);
    if (evidence.ageBound) flags.veryNew = evidence.ageBound.flag;
    else why.veryNew = 'creation not observed; historical state unavailable';
  } else why.veryNew = 'creation not observed for a ' + pool.kind + ' pool';

  if (v2) {
    const owners = [readAddress(ownerData), readAddress(getOwnerData)].filter(a => a && a !== ZERO);
    evidence.lp = await lockStatus(reader, pool, lockers, [...(holders ?? []), ...owners, ...creators]);
    flags.lpUnlocked = evidence.lp.flag;
    if (evidence.lp.flag === UNKNOWN) why.lpUnlocked = evidence.lp.reason;
  } else why.lpUnlocked = 'liquidity positions of ' + pool.kind + ' pools are not fungible LP tokens (not inspected)';
  return { flags, evidence, why };
}
