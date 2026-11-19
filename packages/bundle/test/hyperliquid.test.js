import assert from 'node:assert/strict';
import test from 'node:test';
import { loadBundle, validateBundle } from '../src/index.js';

const bundle = loadBundle();
const copy = () => structuredClone(bundle);

test('Hyperliquid records validate and the index-pairs splitter names both of its paths', () => {
  const spot = bundle.exchanges.find(e => e.id === 'hyperliquid-spot');
  assert.deepEqual(spot.symbols, { mode: 'index-pairs', universe: '0.universe', tokens: '0.tokens' });
  assert.equal(spot.kind, 'spot');
  assert.equal(bundle.exchanges.find(e => e.id === 'hyperliquid').kind, 'derivatives');
  for (const broken of [{ mode: 'index-pairs', universe: '0.universe' }, { mode: 'index-pairs', universe: '0.universe',
    tokens: '0.tokens', quote: 'USDC' }, { mode: 'index-pairs', universe: '0 universe', tokens: '0.tokens' }]) {
    const b = copy();
    b.exchanges.find(e => e.id === 'hyperliquid-spot').symbols = broken;
    assert.throws(() => validateBundle(b), /hyperliquid-spot|symbols/);
  }
});

test('HyperEVM needs its paid-extras entry, its DEX coverage and chain ID 999 receipts', () => {
  const noPaid = copy();
  delete noPaid.paidExtras.hyperevm;
  assert.throws(() => validateBundle(noPaid), /paidExtras/);
  const noDex = copy();
  noDex.dex.evm = noDex.dex.evm.filter(d => d.chain !== 'hyperevm');
  assert.throws(() => validateBundle(noDex), /EVM coverage/);
  const wrongId = copy();
  wrongId.chains.find(c => c.id === 'hyperevm').endpoints[0].verified.result = '0x1';
  assert.throws(() => validateBundle(wrongId), /chain ID/);
  const nativeDecimals = copy();
  nativeDecimals.tokens.tokens.find(t => t.id === 'hyperliquid:native').decimals = 18;
  assert.throws(() => validateBundle(nativeDecimals), /native identity/);
});
