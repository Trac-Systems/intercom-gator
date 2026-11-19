// A validator either accepts its input or throws at the offending data path.
function requireValue(ok, path, message) {
  if (!ok) throw new TypeError(path + ': ' + message);
}
const rule = (predicate, message) => (value, path) => requireValue(predicate(value), path, message);
const nullable = check => (value, path) => { if (value !== null) check(value, path); };
const choice = (...options) => rule(v => options.includes(v), 'expected one of ' + options.join(', '));
const pattern = (regex, message) => rule(v => typeof v === 'string' && regex.test(v), message);
const string = rule(v => typeof v === 'string', 'expected string');
const text = rule(v => typeof v === 'string' && v.trim().length > 0, 'expected nonempty text');
const id = pattern(/^[a-z][a-z0-9-]*$/, 'invalid source ID');
const bool = rule(v => typeof v === 'boolean', 'expected boolean');
const uint = rule(v => Number.isSafeInteger(v) && v >= 0, 'expected nonnegative integer');
const positive = rule(v => Number.isSafeInteger(v) && v > 0, 'expected positive integer');
const decimals = rule(v => Number.isInteger(v) && v >= 0 && v <= 255, 'invalid asset decimals');
const address = pattern(/^0x[0-9a-f]{40}$/, 'expected lowercase EVM address');
const contract = (v, p) => {
  address(v, p);
  requireValue(v !== '0x' + '0'.repeat(40), p, 'zero contract address');
};
// Move coin types include module and type identifiers. Aptos fungible assets
// can instead use the address of the metadata object.
const moveCoin = /^0x[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/;
const aptosAsset = /^0x[0-9a-fA-F]{1,64}$/;
const tronAddress = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const tonAddress = /^(?:[A-Za-z0-9_-]{48}|-?\d+:[0-9a-fA-F]{64})$/;
const solAddress = rule(value => {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let bits = 0n;
  for (const char of value) bits = bits * 58n + BigInt(alphabet.indexOf(char));
  const leading = value.match(/^1*/)[0].length;
  const bytes = bits === 0n ? 0 : Math.ceil(bits.toString(16).length / 2);
  return bytes + leading === 32;
}, 'expected a base58-encoded 32-byte address');
const date = rule(v => {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(v)) return false;
  const t = new Date(v + 'T00:00:00Z');
  return Number.isFinite(t.valueOf()) && t.toISOString().slice(0, 10) === v;
}, 'expected ISO calendar date');

function url(scheme, templates = false) {
  return rule(s => {
    if (typeof s !== 'string' || /[\s\\]/.test(s)) return false;
    const resolved = templates ? s.replace(/\{[a-zA-Z][a-zA-Z0-9]*\}/g, 'example') : s;
    if (/[{}]/.test(resolved) || !resolved.startsWith(scheme + '://')) return false;
    try {
      const u = new URL(resolved);
      return u.protocol === scheme + ':' && Boolean(u.hostname) && !u.username && !u.password;
    } catch { return false; }
  }, 'expected ' + scheme + ' URL');
}
const https = url('https');
const templateUrl = url('https', true);
const route = (v, p) => {
  if (typeof v === 'string' && v.startsWith('/')) {
    requireValue(!v.startsWith('//') && !/[#\\\s]/.test(v), p, 'invalid relative route');
    templateUrl('https://source.invalid' + v, p);
  } else templateUrl(v, p);
};

function list(check, min = 0) {
  return (value, path) => {
    requireValue(Array.isArray(value) && value.length >= min, path, 'expected array of length >= ' + min);
    for (let i = 0; i < value.length; i++) check(value[i], path + '[' + i + ']');
  };
}
function unique(values, path) {
  requireValue(new Set(values).size === values.length, path, 'duplicate entry');
}
function uniqueList(check, min = 0) {
  return (v, p) => { list(check, min)(v, p); unique(v, p); };
}
function records(check, key = 'id', min = 1) {
  return (v, p) => { list(check, min)(v, p); unique(v.map(item => item[key]), p + '.' + key); };
}
function object(fields, optional = {}) {
  return (value, path) => {
    requireValue(value !== null && typeof value === 'object' &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)), path, 'expected plain object');
    for (const [name, check] of Object.entries(fields)) {
      requireValue(Object.hasOwn(value, name), path, 'missing ' + name);
      check(value[name], path + '.' + name);
    }
    for (const name of Object.keys(value)) {
      if (Object.hasOwn(fields, name)) continue;
      requireValue(Object.hasOwn(optional, name), path, 'unknown field ' + name);
      optional[name](value[name], path + '.' + name);
    }
  };
}

function jsonBody(v, p) {
  if (v === null || ['string', 'boolean'].includes(typeof v) || Number.isFinite(v)) return;
  if (Array.isArray(v)) return list(jsonBody)(v, p);
  requireValue(typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v)),
    p, 'expected JSON message');
  for (const [key, child] of Object.entries(v)) jsonBody(child, p + '.' + key);
}
const terms = object({ url: https, redistribution: choice('allowed', 'restricted', 'unclear'), note: text });
const receipt = (v, p) => {
  if (v && Object.hasOwn(v, 'address')) {
    // Some explorers name their public contract-address query parameter "token".
    object({ method: choice('GET'), url: templateUrl, date, address: pattern(tronAddress, 'expected TRON contract') })(v, p);
    requireValue(v.url.includes('{address}'), p, 'missing contract address parameter');
    https(v.url.replaceAll('{address}', v.address), p + '.url');
  } else object({ method: choice('GET', 'POST'), url: https, date })(v, p);
};
const verified = (v, p) => {
  object({ date, successful: list(receipt) })(v, p);
  for (const item of v.successful) requireValue(item.date <= v.date, p, 'receipt after verification date');
  unique(v.successful.map(item => item.method + ' ' + item.url.replaceAll('{address}', item.address ?? '')), p);
};
const httpMethod = choice('GET', 'POST');
function httpRequest(v, p, schema) {
  schema(v, p);
  requireValue(v.method === 'GET' ? v.body === null : v.body !== null && typeof v.body === 'object',
    p + '.body', 'body inconsistent with HTTP method');
}
const attr = pattern(/^(?:\$key|\$join\.[a-zA-Z_]\w*|[a-zA-Z_0-9{}-]+(?:\.[a-zA-Z_0-9{}-]+)*)$/, 'invalid response field');
const listPath = (v, p) => { if (v !== '.') attr(v, p); };
const fields = object({
  symbol: attr, last: nullable(attr), baseVolume: nullable(attr), quoteVolume: nullable(attr),
  bid: nullable(attr), ask: nullable(attr), change24h: nullable(attr),
  changeUnit: nullable(choice('percent', 'ratio', 'absolute', 'percent-string')), open24h: nullable(attr),
}, { referencePrice: attr, usdVolume: attr });
const rowFilter = (v, p) => {
  const match = Object.hasOwn(v ?? {}, 'startsWith') ? 'startsWith' : 'exceptValue';
  object({ field: attr, [match]: text })(v, p);
};
const mapping = object({
  list: listPath, rows: choice('object', 'array'), fields, filter: nullable(rowFilter),
  joinByIndex: nullable(listPath),
});
const tickerSchema = object({ method: httpMethod, path: route, body: jsonBody, mapping });
function tickers(v, p) {
  httpRequest(v, p, tickerSchema);
  const f = v.mapping.fields;
  requireValue(f.last !== null || Boolean(f.referencePrice), p, 'missing price mapping');
  requireValue((f.change24h === null) === (f.changeUnit === null), p, 'change field and units must agree');
  requireValue(!f.symbol.startsWith('$join.') || v.mapping.joinByIndex !== null, p, 'missing symbol join');
}
const symbolSchemas = {
  catalog: { url: templateUrl, list: listPath, symbol: attr, base: attr, quote: attr },
  delimiter: { separator: text, order: choice('base-quote', 'quote-base') },
  fields: { base: attr, quote: attr },
  'fixed-quote': { quote: text },
  'pair-field': { field: attr, separator: text },
  // Pair rows ({ name, tokens: [baseIndex, quoteIndex] }) and token rows ({ index, name }) in the same reply.
  'index-pairs': { universe: attr, tokens: attr },
  bitfinex: {},
};
function symbols(v, p) {
  requireValue(v && Object.hasOwn(symbolSchemas, v.mode), p, 'unknown symbol splitter');
  object({ mode: choice(v.mode), ...symbolSchemas[v.mode] })(v, p);
}
const candles = object({
  method: httpMethod, path: route, body: jsonBody, intervals: uniqueList(text, 1), maxLimit: nullable(positive),
});
const metric = object({ method: httpMethod, url: templateUrl, body: jsonBody, field: attr });
const derivative = nullable((v, p) => httpRequest(v, p, metric));
// Explicit venue labels: the venue's own ticker for a signed identity (it differs from the symbol or collides with
// another project). Labels use the engine's market-label form; validateBundle checks every target asset exists.
const venueLabel = pattern(/^[A-Z0-9][A-Z0-9._]{0,31}$/, 'invalid venue label');
function symbolMap(v, p) {
  requireValue(v !== null && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v)) &&
    Object.keys(v).length > 0, p, 'expected a nonempty label-to-asset map');
  for (const [label, asset] of Object.entries(v)) {
    venueLabel(label, p + '.' + label);
    text(asset, p + '.' + label);
  }
}
const exchange = object({
  id, name: text, kind: choice('both', 'spot', 'derivatives'), restBase: https, docs: https,
  tickers, symbols, candles: (v, p) => httpRequest(v, p, candles),
  websocket: nullable(object({
    url: url('wss', true), subscribe: jsonBody,
    bootstrap: nullable(object({ method: httpMethod, url: https, endpointField: nullable(attr), tokenField: attr })),
  })),
  rateLimit: object({ requestsPerMinute: nullable(positive), weightPerMinute: nullable(positive),
    tickerWeight: nullable(positive), note: text }),
  derivatives: nullable(object({ fundingRate: derivative, openInterest: derivative })),
  terms, verified, note: nullable(text),
}, { symbolMap });
const endpoint = object({
  url: https, wss: nullable(url('wss')), protocol: id, limits: nullable(text), probe: string,
  getLogs: object({ allowed: nullable(bool), maxRange: nullable(positive) }),
  verified: object({ date, ok: bool, result: text }),
});
const chain = object({
  id, name: text, family: id,
  chainId: nullable((v, p) => typeof v === 'number' ? uint(v, p) : text(v, p)),
  native: object({ symbol: text, decimals }),
  blockTimeSeconds: nullable(rule(v => Number.isFinite(v) && v > 0, 'expected positive seconds')),
  explorer: https, multicall3: nullable(contract), endpoints: records(endpoint, 'url', 0),
}, { logo: https, logoSource: id, tokenLogo: templateUrl });
// Signed IDs stay separate from display labels and the engine's historical USD-peg flag.
export const categoryLabels = Object.freeze({
  'layer-1': 'Layer 1', 'layer-2': 'Layer 2', stablecoin: 'Stablecoin', 'liquid-staking': 'Liquid staking',
  'wrapped-bridged': 'Wrapped / bridged', defi: 'DeFi', 'exchange-token': 'Exchange token', meme: 'Meme',
  ai: 'AI', gaming: 'Gaming', 'real-world-assets': 'Real-world assets', 'oracle-data': 'Oracle / data',
  infrastructure: 'Infrastructure', privacy: 'Privacy', 'media-collectibles': 'Media / collectibles',
});
const reason = rule(v => typeof v === 'string' && v.trim().length > 0 && v.length <= 240 &&
  !/[\u0000-\u001f\u007f]/u.test(v), 'expected a short category reason');
const category = choice(...Object.keys(categoryLabels));
const deploymentId = pattern(/^[a-z][a-z0-9-]*:[a-zA-Z0-9_:.-]{1,220}$/, 'invalid category deployment ID');
const categoryEntry = object({ id: deploymentId, category, categorySource: id }, { categoryReason: reason });
const tokenSource = object({ id, url: nullable(https), license: nullable(text), licenseUrl: nullable(https), version: nullable(text) },
  { assetCategories: records(categoryEntry), notice: text });
const token = object({ id: text, symbol: text, name: text, decimals, source: id, links: uniqueList(text) },
  { website: https, x: https, github: https, docs: https, logo: https, logoSource: id,
    category, categorySource: id, categoryReason: reason, explorer: https,
    coin: id, coinSupply: choice('issuance', 'escrow-backed') });
// Exchange marks live next to the token marks so one source table licenses every logo reference.
const exchangeLogo = object({ id, logo: https, logoSource: id });
const coinGroup = object({ id, source: https });
const tokens = object({ sources: records(tokenSource), tokens: records(token) },
  { exchangeLogos: records(exchangeLogo, 'id', 0), coinGroups: records(coinGroup, 'id', 0) });
const fee = rule(v => Number.isSafeInteger(v) && v >= 0 && v <= 1_000_000, 'invalid fee in ppm');
const signature = pattern(/^[A-Za-z][A-Za-z0-9]*\((?:(?:address|bool|bytes32|u?int(?:8|16|24|32|64|112|128|160|256))(?:\[\d+\])?(?:,(?:address|bool|bytes32|u?int(?:8|16|24|32|64|112|128|160|256))(?:\[\d+\])?)*)?\)$/, 'invalid event signature');
const event = object({
  id, emitter: choice('pool', 'factory', 'vault', 'manager'), signature,
  topic0: pattern(/^0x[0-9a-f]{64}$/, 'invalid event topic'), fields: uniqueList(attr, 1), indexed: uniqueList(uint),
});
const dex = object({
  events: records(event), kinds: records(object({ id, events: uniqueList(id, 1) })),
  evm: records(object({ chain: id, deployments: records(object({
    name: text, kind: id, address: contract, feeTiersPpm: nullable(uniqueList(fee, 1)), source: https,
  }, { router: contract, routerKind: choice('v2', 'v3', 'v3-router02'), routerSource: https }), 'address'),
    quoteTokens: records(object({ symbol: text, address: contract, decimals }), 'address'),
  }, { lockers: uniqueList(contract) }), 'chain'),
  solana: records(object({ name: text, api: id, programs: records(object({ kind: text, address: solAddress }), 'address') }), 'name'),
}, { nft: (v, p) => nftSchema(v, p) });
// NFT sales are decoded per protocol in engine code; the bundle names the contracts, currencies and seed list.
const nftSource = object({ id, note: text, date, url: nullable(https) });
const nftSchema = object({
  marketplaces: list(object({ chain: id, name: text, protocol: choice('seaport', 'blur-v2', 'payment-processor-v2'),
    address: contract, source: https })),
  currencies: list(object({ chain: id, symbol: text, address: contract, decimals, unit: choice('ETH', 'USD') })),
  collections: list(object({ chain: id, address: contract, name: text, source: id })),
  sources: records(nftSource),
});
const api = object({
  id, name: text, base: https, path: route, requestsPerMinute: nullable(positive),
  limitNote: text, terms, verified,
});
const schema = object({ exchanges: records(exchange), chains: records(chain), dex, tokens, apis: records(api) },
  { paidExtras: (v, p) => requireValue(v !== null && typeof v === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(v)), p, 'expected a chain-to-contract map') });

function categoryProvenance(t, sources, p) {
  requireValue(Object.hasOwn(t, 'category') === Object.hasOwn(t, 'categorySource'), p,
    'category and categorySource must be supplied together');
  if (t.categorySource !== undefined) requireValue(sources.has(t.categorySource), p, 'unknown category source');
  requireValue((t.categorySource === 'gator-curated') === Object.hasOwn(t, 'categoryReason'), p,
    'provide a categoryReason for each gator-curated classification only');
}

function tokenLocation(id, chains, p) {
  const separator = id.indexOf(':'), chainId = id.slice(0, separator), location = id.slice(separator + 1);
  const c = chains.get(chainId);
  requireValue(separator > 0 && c && location, p, 'unrecognized token identity');
  if (location !== 'native') {
    requireValue(c.family !== 'cex-only', p, 'CEX-only chain supports native identity only');
    if (c.family === 'evm') contract(location, p);
    else if (c.family === 'solana') solAddress(location, p);
    else if (c.family === 'sui') requireValue(moveCoin.test(location), p, 'invalid Sui coin type');
    else if (c.family === 'aptos') requireValue(moveCoin.test(location) || aptosAsset.test(location), p, 'invalid Aptos asset');
    else if (c.family === 'tron') requireValue(tronAddress.test(location), p, 'invalid TRON contract');
    else if (c.family === 'ton') requireValue(tonAddress.test(location), p, 'invalid TON account');
  }
  return { chainId, location, c };
}

/** Validate schemas, identities and cross-file references. Throws a path-bearing TypeError. */
export function validateBundle(bundle) {
  schema(bundle, 'bundle');
  const chains = new Map(bundle.chains.map(c => [c.id, c]));
  if (Object.hasOwn(bundle, 'paidExtras')) {
    object(Object.fromEntries(bundle.chains.filter(c => c.family !== 'cex-only').map(c => [c.id, (value, path) => {
      if (value === '') return;
      requireValue(c.family === 'evm', path, 'paid contract requires EVM');
      contract(value, path);
    }])), Object.fromEntries(bundle.chains.filter(c => c.family === 'cex-only').map(c => [c.id, choice('')])))(bundle.paidExtras, 'paidExtras');
  }
  const nativeSymbols = bundle.chains.map(c => c.native.symbol.toUpperCase());
  for (const c of bundle.chains.filter(c => c.family === 'cex-only')) {
    requireValue(nativeSymbols.filter(s => s === c.native.symbol.toUpperCase()).length === 1,
      'chains.' + c.id, 'ambiguous CEX-only native symbol');
  }
  const evm = bundle.chains.filter(c => c.family === 'evm');
  unique(evm.map(c => c.chainId), 'chains.chainId');
  for (const c of bundle.chains) {
    const p = 'chains.' + c.id;
    if (c.family === 'cex-only') {
      requireValue(c.endpoints.length === 0 && c.chainId === null, p, 'CEX-only chain cannot have RPC endpoints');
    } else {
      requireValue(c.endpoints.length >= 3 && c.endpoints.length <= 8 && c.blockTimeSeconds !== null,
        p, 'expected block time and 3 to 8 endpoints');
    }
    if (c.family === 'evm') positive(c.chainId, p + '.chainId');
    else requireValue(c.multicall3 === null, p, 'multicall3 requires EVM');
    for (const e of c.endpoints) {
      requireValue((e.protocol === 'evm-jsonrpc') === (c.family === 'evm'), p, 'RPC protocol and family disagree');
      requireValue(c.family === 'evm' || e.getLogs.allowed === false, p, 'eth_getLogs requires EVM');
      requireValue(e.getLogs.maxRange === null || e.getLogs.allowed === true, p, 'range needs eth_getLogs support');
      if (c.family === 'evm' && e.verified.ok) {
        requireValue(/^0x[0-9a-f]+$/i.test(e.verified.result) && Number(e.verified.result) === c.chainId,
          p, 'verified chain ID mismatch');
      }
    }
  }
  const sources = new Set(bundle.tokens.sources.map(s => s.id));
  for (const s of bundle.tokens.sources) {
    const external = s.url !== null;
    requireValue((s.license !== null) === external && (s.licenseUrl !== null) === external,
      'tokens.sources.' + s.id, 'registry URL and license references must be supplied together');
  }
  const assets = new Map(bundle.tokens.tokens.map(t => [t.id, t]));
  const classified = new Set(assets.keys());
  for (const source of bundle.tokens.sources) {
    for (const row of source.assetCategories ?? []) {
      const p = 'tokens.sources.' + source.id + '.assetCategories.' + row.id;
      requireValue(!classified.has(row.id), p, 'duplicate classified asset');
      classified.add(row.id);
      requireValue(row.categorySource === source.id, p, 'categorySource must match its source record');
      categoryProvenance(row, sources, p);
      requireValue(!row.id.endsWith(':native'), p, 'expected a token deployment');
      // A retained source can also describe a chain removed by a patch or a reduced catalog.
      // Such an annotation stays inert until that chain is configured and its address validates.
      if (chains.has(row.id.split(':', 1)[0])) tokenLocation(row.id, chains, p);
    }
  }
  const coins = new Set((bundle.tokens.coinGroups ?? []).map(g => g.id));
  const issuanceGroups = new Set();
  for (const t of assets.values()) {
    const p = 'tokens.' + t.id;
    const { chainId, location, c } = tokenLocation(t.id, chains, p);
    requireValue(sources.has(t.source), p, 'unrecognized token source');
    requireValue(Object.hasOwn(t, 'coin') === Object.hasOwn(t, 'coinSupply') && (!t.coin || coins.has(t.coin)),
      p, 'coin membership needs a known group and a supply role');
    if (t.coinSupply === 'issuance') issuanceGroups.add(t.coin);
    categoryProvenance(t, sources, p);
    if (location === 'native')
      requireValue(t.symbol === c.native.symbol && t.decimals === c.native.decimals, p, 'native identity mismatch');
    for (const link of t.links) {
      requireValue(link !== t.id && link.split(':')[0] !== chainId && assets.get(link)?.links.includes(t.id),
        p, 'invalid or asymmetric cross-chain link ' + link);
    }
  }
  for (const t of assets.values()) {
    if (t.coinSupply === 'escrow-backed')
      requireValue(issuanceGroups.has(t.coin), 'tokens.' + t.id, 'coin group needs an issuance member');
  }
  for (const c of chains.keys()) requireValue(assets.has(c + ':native'), 'tokens', 'missing native identity for ' + c);
  // Logo references: every image URL names the registry it came from; a chain's token template substitutes {address}.
  const logoRef = (record, path) => {
    requireValue(Object.hasOwn(record, 'logo') === Object.hasOwn(record, 'logoSource'), path, 'logo and logoSource must be supplied together');
    if (record.logoSource !== undefined) requireValue(sources.has(record.logoSource), path, 'unknown logo source');
  };
  for (const t of assets.values()) logoRef(t, 'tokens.' + t.id);
  for (const c of bundle.chains) {
    logoRef(c, 'chains.' + c.id);
    if (c.tokenLogo !== undefined) {
      requireValue(c.logoSource !== undefined && /^[^{}]*\{address\}[^{}]*$/.test(c.tokenLogo), 'chains.' + c.id,
        'token logo template needs one {address} and a logo source');
    }
  }
  // An exchange mark for a venue this bundle does not list is inert (fixtures and patches may drop venues).
  for (const e of bundle.tokens.exchangeLogos ?? []) logoRef(e, 'tokens.exchangeLogos.' + e.id);
  const eventIds = new Set(bundle.dex.events.map(e => e.id));
  for (const e of bundle.dex.events) {
    const n = e.signature.slice(e.signature.indexOf('(') + 1, -1).split(',').length;
    requireValue(n === e.fields.length && e.indexed.length <= 3 && e.indexed.every(i => i < n),
      'dex.events.' + e.id, 'event fields disagree with signature');
  }
  for (const kind of bundle.dex.kinds) {
    requireValue(kind.events.every(key => eventIds.has(key)), 'dex.kinds.' + kind.id, 'unknown event');
  }
  const kinds = new Set(bundle.dex.kinds.map(k => k.id));
  const covered = new Set(bundle.dex.evm.map(d => d.chain));
  requireValue(covered.size === evm.length && evm.every(c => covered.has(c.id)), 'dex.evm', 'EVM coverage mismatch');
  for (const entry of bundle.dex.evm) {
    requireValue(entry.deployments.every(d => kinds.has(d.kind)), 'dex.' + entry.chain, 'unknown pool kind');
    for (const d of entry.deployments) {
      const path = 'dex.' + entry.chain + '.' + d.name;
      requireValue(Boolean(d.router) === Boolean(d.routerKind), path, 'router and routerKind must be supplied together');
      requireValue(!d.routerSource || d.router, path, 'routerSource needs a router');
      if (d.router) requireValue(d.kind === (d.routerKind === 'v2' ? 'v2' : 'v3'),
        path, 'router ABI disagrees with factory kind');
    }
    for (const q of entry.quoteTokens) {
      const known = assets.get(entry.chain + ':' + q.address);
      requireValue(!known || q.decimals === known.decimals, 'dex.' + entry.chain, 'quote token decimals mismatch');
    }
  }
  if (bundle.dex.nft) {
    const nft = bundle.dex.nft, sourceIds = new Set(nft.sources.map(x => x.id));
    for (const [field, key] of [['marketplaces', m => m.chain + ':' + m.address], ['currencies', c => c.chain + ':' + c.address],
      ['collections', c => c.chain + ':' + c.address]]) {
      unique(nft[field].map(key), 'dex.nft.' + field);
      // Entries for a chain this bundle leaves out stay dormant (trimmed test bundles keep the section).
      for (const item of nft[field]) requireValue(!chains.has(item.chain) || chains.get(item.chain).family === 'evm',
        'dex.nft.' + field, 'NFT entry on a non-EVM chain ' + item.chain);
    }
    for (const c of nft.collections) requireValue(sourceIds.has(c.source), 'dex.nft.collections', 'unknown source ' + c.source);
  }
  const apiIds = new Set(bundle.apis.map(a => a.id));
  for (const s of bundle.dex.solana) requireValue(apiIds.has(s.api), 'dex.solana.' + s.name, 'unknown pool API');
  for (const e of bundle.exchanges) {
    requireValue((e.kind === 'spot') === (e.derivatives === null), 'exchanges.' + e.id, 'derivatives and kind disagree');
    for (const [label, asset] of Object.entries(e.symbolMap ?? {}))
      requireValue(assets.has(asset), 'exchanges.' + e.id + '.symbolMap.' + label, 'unknown asset ' + asset);
  }
  return bundle;
}
