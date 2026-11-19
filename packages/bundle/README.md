# Source bundle

This package supplies offline market-source discovery for intercom-gator. It runs on Node 22.13+ with no runtime dependencies. Run `npm test` in this directory.

```js
import { loadBundle, bundleDigest, selectEndpoints } from '@gator/bundle'

const bundle = loadBundle()
const digest = bundleDigest(bundle)
const urls = selectEndpoints(bundle, 1, {
  endpoints: { ethereum: ['http://127.0.0.1:8545'] },
  health: { 'https://ethereum-rpc.publicnode.com': 4 },
})
```

`loadBundle({ dir })` reads, validates and freezes the source files. The default directory is `data/`. Select endpoints by slug or numeric EVM ID. Configured URLs come first. If both the slug and numeric ID have configured URLs, the requested form takes precedence and both lists are included. Bundle URLs follow by descending health score. Missing scores default to zero, ties keep file order, and each URL appears once. Use the endpoint’s `protocol` to construct the request.

## Data format

| File | Contents |
| --- | --- |
| `exchanges.json` | REST ticker and candle requests, symbol splitting, WebSocket subscriptions, derivative metrics, rate limits, terms and dated probe receipts. |
| `chains.json` | Network identity, approximate block time in seconds, explorer, Multicall3 deployment and public endpoint records. Each HTTPS record has a probe and its observed result. WebSocket URLs are companion addresses. |
| `dex.json` | EVM deployments reference pool kinds, which reference named event layouts. The emitter identifies where to collect each log. Indexed field positions are zero-based. Fee tiers are common settings in parts per million. Dynamic or unconfirmed tiers are null. Solana venues reference pool directory IDs in `apis.json`. |
| `tokens.json` | Asset facts, list URLs and licenses. Split `chain:address` at the first colon. EVM addresses are lowercase. Solana mints and Move type identifiers preserve case. Native assets use `chain:native`. Reciprocal links come from explicit bridge metadata or a shared native currency. |
| `apis.json` | Secondary routes for token prices, pool directories, NFT collection statistics, fee estimates and historical block lookup. |
| `paidExtras.json` | Maps each chain slug to its paid-extras contract. An empty string keeps that chain dormant. Active entries require a nonzero EVM contract address. |

Supported factory records carry `router`, `routerKind` and `routerSource`. The intel verifier understands the V2 Router02 (`v2`), V3 SwapRouter (`v3`) and V3 SwapRouter02 (`v3-router02`) ABIs. Its simulation checks the router's factory against the exact pool. The Ethereum `dex.evm[].lockers` list includes the UNCX Uniswap V2 LP locker. The risk check reads LP token balances held by the listed address. [Ethereum locker contract and source](https://etherscan.io/address/0x663a5c229c09b049e36dcc11f9b0d4a8eb9db214#code)

Token records can supply explicit HTTPS `website`, `x`, `github`, `docs` and `logo` fields to the intel verifier. The `links` array is reserved for cross-chain asset identities.

## Logos

Tokens and chains carry `logo` (an HTTPS image URL) with `logoSource` (an id in `tokens.sources`). Exchange marks live in `tokens.exchangeLogos` as `{ id, logo, logoSource }`. An EVM or Solana chain can also carry `tokenLogo`, a URL template with one `{address}` (EIP-55 for EVM) for tokens the node discovers outside the bundle. Trust Wallet references are pinned to one commit of `trustwallet/assets` (MIT), so a URL always names the same bytes. Bridged L2 tokens without their own entry use the Ethereum entry that the Uniswap default list names as their bridge source. Exchange marks (`venue-site-icon`) are the touch icon or PNG favicon that the venue serves on its own domain, or that its homepage declares, and only where its `robots.txt` allows the path. `node scripts/logos.js [--commit SHA] [--dry-run]` rebuilds every reference. It downloads each candidate once and keeps only images that pass the node's checks (PNG, WebP or JPEG, at most 64 KB and 512 px, square). The release signature must then be renewed. The node fetches, checks and stores the images itself (`packages/engine/src/logos`).

A ticker list path starts at the response root (`.`). Dots traverse members or array indices. Apply the row filter first. `$key` reads an object key and `$join.name` reads the same index from `joinByIndex`. Expand dynamic fields such as `vol_{base}` after resolving the market. Null means unavailable or unconfirmed. `changeUnit` distinguishes percent, percent-suffixed strings, ratios and absolute changes. A `referencePrice` can be a mark or oracle.

Use the venue’s instrument IDs and interval names. Encode URL substitutions and substitute numeric timestamps as numbers in JSON messages. `Sec` and `Ms` indicate units. The `catalog` splitter joins IDs to a market catalog, and `pair-field` splits a separate pair field. The `index-pairs` splitter reads pair rows (`name`, `tokens: [base, quote]`) and token rows (`index`, `name`) from the same reply and resolves each token by its `index` field, not its array position (Hyperliquid spot: `@107` is HYPE/USDC). For `bitfinex`, strip the leading `t`, then split at `:` or divide a six-character symbol into two three-character codes. Venue notes cover pagination and WebSocket bootstrap.

## Exchange redistribution

The engine uses an exchange with `terms.redistribution: "restricted"` for local prices, spot checks and candles. Its observations stay off `gator/px/*` and its listing discoveries stay local. The engine publishes observations from `"allowed"` and `"unclear"` exchanges. An `"unclear"` entry records that a redistribution grant has yet to be established.

The USD turnover field on the wire carries venue-reported USD amounts or turnover directly quoted in USD. Each node converts other quote currencies locally, so a shareable row cannot expose a restricted exchange's FX price.

## Adding a source

Seed selection prioritizes native currencies, quote tokens and assets matched by contract address to a public top-500 snapshot. Curated assets with explicit bridge links fill out the seed. The source record identifies the registry supplying the name, symbol and decimals. Trust Wallet entries use the asset directory's `info.json`.

Add its record and provenance, check a cheap keyless read, and record the actual UTC date and result. Leave unconfirmed limits and log ranges null. The terms record distinguishes access from redistribution. Only mark redistribution as allowed when the terms explicitly grant it. EVM events need their canonical Solidity signature, emitter, field names, indexed positions and Keccak-256 topic. Run the offline tests after editing.

## Release signatures and patches

`canonical(value)` emits compact JSON with object keys sorted by UTF-16 code unit, ordinary JSON number formatting and array order preserved. `bundleDigest()` returns lowercase hex SHA-256 over the UTF-8 canonical array of `[filename, parsedData]` pairs in this order — exchanges, chains, dex, tokens, apis, paidExtras, each with the `.json` extension. Archived five-file bundles omit the last pair and retain their original digest. An authenticated patch can add the entire map to an older release or replace an individual chain's address.

`signBundle(digest, seed)` signs the 32 decoded digest bytes using Ed25519. Supply 32 seed bytes or 64 hex characters. Signatures are 128 hex characters. Obtain the 64-character root public key independently.

```js
import {
  loadBundle, bundleDigest, verifyBundleSignature, applyPatch,
} from '@gator/bundle'

const current = loadBundle({ dir, rootPubKeyHex })
if (!verifyBundleSignature(bundleDigest(current), releaseSignature, rootPubKeyHex)) {
  throw new Error('Invalid release signature')
}
const next = applyPatch(current, signedPatch)
```

A patch has `{ baseDigest, ops, newDigest, signature }`. The signer computes the proposed result, validates it, then signs `patchDigest({ baseDigest, ops, newDigest })` with `signBundle`. The patch digest hashes canonical JSON of `["intercom-gator/source-bundle/patch/v1", baseDigest, ops, newDigest]`. Paths are JSON Pointers rooted at dataset names, for example `/chains/0/endpoints/-`. Operations follow JSON Patch add, replace and remove semantics. The receiver checks the base, signature, resulting schema and new digest and returns a frozen snapshot. A failure leaves the original snapshot available. File persistence and release key custody belong to the integrating harness.
