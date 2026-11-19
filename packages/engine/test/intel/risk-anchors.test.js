import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadBundle } from '@gator/bundle';
import { createRiskService } from '../../src/intel/risk.js';

// Real reads captured 2026-11-19 through the bundle's public endpoints (one check per asset, final code). Replayed
// offline: any read the fixture does not hold would count as refused, so `rpc.refused === 0` proves full coverage.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/risk-anchors.json', import.meta.url), 'utf8'));
const key = (chain, method, params) => createHash('sha256').update(JSON.stringify([chain, method, params])).digest('hex').slice(0, 32);
const answers = new Map(fixture.calls.map(c => [c.k, c]));
const replay = { async call(chain, method, params) {
  const hit = answers.get(key(chain, method, params));
  if (!hit) throw new Error('not recorded');
  if (hit.error === 'reverted') throw Object.assign(new Error('execution reverted'), { kind: 'reverted' });
  return hit.result;
} };
const bundle = loadBundle();
const unknown = 'unknown';

const expected = {
  // Tether: owner-held issue/pause/addBlackList, plain contract (no proxy).
  'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7': { upgradeable: false, ownerMint: true, ownerPause: true,
    blacklist: true, unsellable: false, veryNew: false, lowLiquidity: false, lpUnlocked: unknown },
  // USDC: ZeppelinOS-slot proxy; mint/pause/blacklist in the implementation, owner set.
  'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { upgradeable: true, ownerMint: true, ownerPause: true,
    blacklist: true, unsellable: false, veryNew: false, lowLiquidity: false, lpUnlocked: unknown },
  // SHIB: plain fixed-supply ERC-20 without owner. Pool vs WETH: no WETH price in a standalone check.
  'ethereum:0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce': { upgradeable: false, ownerMint: false, ownerPause: false,
    blacklist: false, unsellable: false, veryNew: false, lowLiquidity: unknown, lpUnlocked: unknown },
  // Robinhood launchpad token: Solady-style immutable forwarder; no pool on the bundle's V2/V3 factories.
  'robinhood:0x9cb8b697aa93a04cb643e062a802e1cf6bb01e18': { upgradeable: false, ownerMint: false, ownerPause: false,
    blacklist: false, unsellable: unknown, veryNew: unknown, lowLiquidity: unknown, lpUnlocked: unknown },
  // BSC launchpad clone: its PancakeSwap pair exists but is empty (trading on the bonding curve).
  'bsc:0xe7f5985a501f4658d00e9d91a2172ae0f0d17777': { upgradeable: false, ownerMint: false, ownerPause: false,
    blacklist: false, unsellable: unknown, veryNew: true, lowLiquidity: true, lpUnlocked: unknown },
  // Fresh Base Uniswap V2 pool with engine context (creation tx, WETH price): the creator (an EIP-7702 delegated
  // EOA) holds 99.99% of the LP.
  'base:0xb8b52fa74cdbded2f8d16ed207a497b931364382': { upgradeable: false, ownerMint: false, ownerPause: false,
    blacklist: false, unsellable: false, veryNew: true, lowLiquidity: true, lpUnlocked: true },
};

for (const { asset, at, context } of fixture.checks) {
  test('real-read anchor ' + asset, async () => {
    const risk = createRiskService({ rpc: replay, bundle, now: () => at, resolveContext: () => context ?? {} });
    const result = await risk.checkRisk(asset);
    assert.deepEqual(result.flags, expected[asset]);
    assert.equal(result.evidence.rpc.refused, 0);
    assert.ok(result.evidence.rpc.calls <= 40);
    for (const [flag, value] of Object.entries(result.flags)) {
      if (value === unknown) assert.ok(result.evidence.why[flag], flag + ' needs a reason');
    }
  });
}

test('real-read anchors: reasons for the remaining unknowns', async () => {
  const check = async asset => {
    const { at, context } = fixture.checks.find(c => c.asset === asset);
    return createRiskService({ rpc: replay, bundle, now: () => at, resolveContext: () => context ?? {} }).checkRisk(asset);
  };
  const clone = await check('robinhood:0x9cb8b697aa93a04cb643e062a802e1cf6bb01e18');
  assert.equal(clone.evidence.proxy, 'immutable forwarder (minimal proxy)');
  assert.equal(clone.evidence.why.unsellable, 'no pool found');
  const empty = await check('bsc:0xe7f5985a501f4658d00e9d91a2172ae0f0d17777');
  assert.equal(empty.evidence.liquidity.method, 'empty pool (no reserves)');
  assert.equal(empty.evidence.why.lpUnlocked, 'no LP supply (empty pool)');
  const usdc = await check('ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
  assert.equal(usdc.evidence.proxy, 'zeppelinos slot');
  const fresh = await check('base:0xb8b52fa74cdbded2f8d16ed207a497b931364382');
  assert.ok(fresh.evidence.lp.eoaPct > 99);
  assert.ok(fresh.evidence.ageMs > 0 && fresh.evidence.ageMs < 86_400_000);
});
