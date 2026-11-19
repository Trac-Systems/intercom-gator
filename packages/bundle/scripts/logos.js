#!/usr/bin/env node
// Rebuild the logo references in data/tokens.json and data/chains.json.
//
//   node packages/bundle/scripts/logos.js [--commit <trustwallet/assets sha>] [--dry-run]
//
// Sources (recorded per reference as `logoSource`, licensed in tokens.sources):
//   trustwallet-assets  github.com/trustwallet/assets (MIT), raw paths pinned to one commit: chain marks
//                       (blockchains/<chain>/info/logo.png) and tokens (blockchains/<chain>/assets/<address>/logo.png,
//                       EIP-55 address for EVM). A bridged token without its own entry uses its Ethereum entry when the
//                       Uniswap default list names that bridge.
//   venue-site-icon     the exchange's own touch icon / PNG favicon on its official domain, only where the venue's
//                       robots.txt allows the path. The venue publishes it for display next to its name.
// Every candidate is downloaded once and checked with the node's own image rules (PNG/WebP/JPEG, <= 64 KB,
// <= 512 px, square), so the node never spends requests on references it would reject. Release signing is separate.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { inspectImage, checksumAddress, fetchImageBytes } from '../../engine/src/logos/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = join(here, '..', 'data')
const { values } = parseArgs({ options: { commit: { type: 'string' }, 'dry-run': { type: 'boolean' } } })
const TW = 'trustwallet-assets'
const SITE = 'venue-site-icon'
const UA = { 'user-agent': 'intercom-gator-bundle-tool' }

/** Bundle chain id → Trust Wallet folder. Berachain and Unichain have no folder at the pinned commit. */
const TW_CHAINS = {
  ethereum: 'ethereum', bsc: 'smartchain', base: 'base', arbitrum: 'arbitrum', optimism: 'optimism',
  polygon: 'polygon', avalanche: 'avalanchec', linea: 'linea', scroll: 'scroll', zksync: 'zksync', blast: 'blast',
  mantle: 'mantle', sonic: 'sonic', gnosis: 'xdai', celo: 'celo', fantom: 'fantom', robinhood: 'robinhoodchain',
  solana: 'solana', bitcoin: 'bitcoin', tron: 'tron', ton: 'ton', cosmos: 'cosmos', near: 'near', sui: 'sui',
  aptos: 'aptos', xrpl: 'ripple', cardano: 'cardano', dogecoin: 'doge', litecoin: 'litecoin',
}
/** Exchange id → official site origin (the venue's own domain). */
const SITES = {
  aster: 'https://www.asterdex.com', backpack: 'https://backpack.exchange', bigone: 'https://big.one',
  binance: 'https://www.binance.com', 'binance-us': 'https://www.binance.us', bingx: 'https://bingx.com',
  bit2me: 'https://bit2me.com', bitbank: 'https://bitbank.cc', bitfinex: 'https://www.bitfinex.com',
  bitget: 'https://www.bitget.com', bithumb: 'https://www.bithumb.com', bitkub: 'https://www.bitkub.com',
  bitmex: 'https://www.bitmex.com', bitrue: 'https://www.bitrue.com', bitso: 'https://bitso.com',
  bitstamp: 'https://www.bitstamp.net', bittrade: 'https://www.bittrade.co.jp', bitunix: 'https://www.bitunix.com',
  bitvavo: 'https://bitvavo.com', blofin: 'https://blofin.com', btcturk: 'https://www.btcturk.com',
  btse: 'https://www.btse.com', bybit: 'https://www.bybit.com', 'cex-io': 'https://cex.io',
  coinbase: 'https://www.coinbase.com', coinone: 'https://coinone.co.kr', coinsph: 'https://coins.ph',
  coinw: 'https://www.coinw.com', 'crypto-com': 'https://crypto.com', deepcoin: 'https://www.deepcoin.com',
  deribit: 'https://www.deribit.com', digifinex: 'https://www.digifinex.com', dydx: 'https://dydx.trade',
  gate: 'https://www.gate.com', gemini: 'https://www.gemini.com', hashkey: 'https://global.hashkey.com',
  hitbtc: 'https://hitbtc.com', htx: 'https://www.htx.com', hyperliquid: 'https://app.hyperliquid.xyz',
  indodax: 'https://indodax.com', kraken: 'https://www.kraken.com', 'kraken-futures': 'https://futures.kraken.com',
  kucoin: 'https://www.kucoin.com', mexc: 'https://www.mexc.com', okx: 'https://www.okx.com',
  ourbit: 'https://www.ourbit.com', p2b: 'https://p2pb2b.com', paradex: 'https://www.paradex.trade',
  phemex: 'https://phemex.com', pionex: 'https://www.pionex.com', poloniex: 'https://poloniex.com',
  toobit: 'https://www.toobit.com', upbit: 'https://upbit.com', weex: 'https://www.weex.com',
  whitebit: 'https://whitebit.com', xt: 'https://www.xt.com',
}
const ICON_PATHS = ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png', '/favicon-96x96.png',
  '/favicon-32x32.png', '/favicon.png']

async function json(url) {
  const response = await fetch(url, { headers: { accept: 'application/vnd.github+json', ...UA }, redirect: 'error' })
  if (!response.ok) throw new Error(url + ': HTTP ' + response.status)
  return response.json()
}
const rejected = new Map()
async function check(url) {
  try {
    const bytes = await fetchImageBytes((u, init) => fetch(u, { ...init, headers: { ...init.headers, ...UA } }), url,
      { timeout: 15000 })
    return inspectImage(bytes)
  } catch (error) {
    const reason = String(error.message).replace(/\d{4,}/g, 'N')
    rejected.set(reason, (rejected.get(reason) ?? 0) + 1)
    return null
  }
}
async function pool(items, size, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i) }
  }))
  return out
}
/** Minimal robots.txt reading for `User-agent: *`: the longest matching Allow/Disallow prefix wins. */
function robotsAllow(text, path) {
  let applies = false, best = { len: -1, allow: true }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase(), value = m[2].trim()
    if (key === 'user-agent') { applies = value === '*'; continue }
    if (!applies || (key !== 'allow' && key !== 'disallow') || !value) continue
    const pattern = new RegExp('^' + value.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
      .replace(/\\\$$/, '$'))
    if (pattern.test(path) && value.length > best.len) best = { len: value.length, allow: key === 'allow' }
  }
  return best.allow
}
async function siteIcon(origin) {
  let robots = ''
  try {
    const r = await fetch(origin + '/robots.txt', { headers: UA, redirect: 'error', signal: AbortSignal.timeout(10000) })
    robots = r.ok ? await r.text() : ''
  } catch {}
  for (const path of ICON_PATHS) {
    if (!robotsAllow(robots, path)) continue
    const info = await check(origin + path)
    if (info) return origin + path
  }
  // Icons the homepage itself declares (<link rel="icon" | "apple-touch-icon">), PNG/WebP/JPEG only.
  let html = ''
  try {
    if (!robotsAllow(robots, '/')) return null
    const r = await fetch(origin + '/', { headers: { ...UA, accept: 'text/html' }, redirect: 'follow',
      signal: AbortSignal.timeout(10000) })
    html = r.ok ? (await r.text()).slice(0, 400_000) : ''
  } catch {}
  const declared = []
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? ''
    const href = /\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]
    if (!href || !/(^|\s)(icon|apple-touch-icon|apple-touch-icon-precomposed)(\s|$)/.test(rel)) continue
    try {
      const url = new URL(href.replace(/&amp;/g, '&'), origin + '/')
      if (url.protocol === 'https:' && !url.username && /\.(png|webp|jpe?g)$/i.test(url.pathname)) declared.push(url.href)
    } catch {}
  }
  // Prefer touch icons (larger), then the declared order.
  declared.sort((a, b) => Number(/apple/i.test(b)) - Number(/apple/i.test(a)))
  for (const url of declared) if (await check(url)) return url
  return null
}

const commit = values.commit ?? (await json('https://api.github.com/repos/trustwallet/assets/commits/master')).sha
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Expected a 40-hex commit')
const raw = 'https://raw.githubusercontent.com/trustwallet/assets/' + commit + '/blockchains/'
const tokensFile = join(dataDir, 'tokens.json'), chainsFile = join(dataDir, 'chains.json')
const tokens = JSON.parse(readFileSync(tokensFile, 'utf8'))
const chains = JSON.parse(readFileSync(chainsFile, 'utf8'))

// 1. Chain marks and per-chain asset directories (one tree listing per chain with tokens).
const listing = new Map()
const families = new Map(chains.map(c => [c.id, c.family]))
for (const c of chains) {
  const folder = TW_CHAINS[c.id]
  if (!folder || !tokens.tokens.some(t => t.id.startsWith(c.id + ':') && !t.id.endsWith(':native'))) continue
  try {
    const tree = await json('https://api.github.com/repos/trustwallet/assets/git/trees/' + commit + ':blockchains/' +
      folder + '/assets')
    listing.set(c.id, new Map(tree.tree.filter(e => e.type === 'tree').map(e =>
      [c.family === 'evm' ? e.path.toLowerCase() : e.path, e.path])))
  } catch (error) {
    console.error('no asset listing for', c.id, error.message)
  }
}
const chainLogo = new Map()
await pool(chains, 6, async c => {
  const folder = TW_CHAINS[c.id]
  const url = folder && raw + folder + '/info/logo.png'
  if (url && await check(url)) chainLogo.set(c.id, url)
})

// 2. Bridged tokens: Uniswap's default list names the Ethereum address of many L2 tokens.
const bridged = new Map()
try {
  const list = await json('https://tokens.uniswap.org')
  const numbers = new Map(chains.filter(c => c.family === 'evm').map(c => [c.chainId, c.id]))
  for (const t of list.tokens) {
    const l1 = t.extensions?.bridgeInfo?.['1']?.tokenAddress
    const chain = numbers.get(t.chainId)
    if (l1 && chain) bridged.set(chain + ':' + t.address.toLowerCase(), l1.toLowerCase())
  }
} catch (error) {
  console.error('Uniswap list unavailable:', error.message)
}

// 3. Token references.
const candidates = tokens.tokens.map(t => {
  const split = t.id.indexOf(':'), chain = t.id.slice(0, split), address = t.id.slice(split + 1)
  if (address === 'native') {
    const home = chains.find(c => c.id === chain)?.native.symbol === 'ETH' ? 'ethereum' : chain
    return chainLogo.get(home) ?? null
  }
  const dir = listing.get(chain)?.get(families.get(chain) === 'evm' ? address.toLowerCase() : address)
  if (dir) return raw + TW_CHAINS[chain] + '/assets/' + dir + '/logo.png'
  const l1 = bridged.get(t.id)
  const l1Dir = l1 && listing.get('ethereum')?.get(l1)
  return l1Dir ? raw + 'ethereum/assets/' + l1Dir + '/logo.png' : null
})
const unique = [...new Set(candidates.filter(Boolean))]
rejected.clear()
const ok = new Set((await pool(unique, 8, async url => (await check(url)) ? url : null)).filter(Boolean))
const tokenRejects = Object.fromEntries(rejected)
console.error('token candidates', unique.length, 'without a repository entry', candidates.filter(c => !c).length,
  'rejected', JSON.stringify(tokenRejects))
let tokenRefs = 0
tokens.tokens.forEach((t, i) => {
  delete t.logo
  delete t.logoSource
  const url = candidates[i]
  if (url && ok.has(url)) {
    t.logo = url
    t.logoSource = TW
    tokenRefs++
  }
})

// 4. Exchange marks from the venues' own sites.
const exchanges = JSON.parse(readFileSync(join(dataDir, 'exchanges.json'), 'utf8'))
const venueIcons = await pool(exchanges, 6, async e => SITES[e.id] ? [e.id, await siteIcon(SITES[e.id])] : [e.id, null])
tokens.exchangeLogos = venueIcons.filter(([, url]) => url).map(([id, url]) => ({ id, logo: url, logoSource: SITE }))

// 5. Sources and chain records.
const sources = tokens.sources.filter(s => s.id !== TW && s.id !== SITE)
sources.push(
  { id: TW, url: 'https://github.com/trustwallet/assets', license: 'MIT',
    licenseUrl: 'https://github.com/trustwallet/assets/blob/' + commit + '/LICENSE', version: commit },
  { id: SITE, url: null, license: null, licenseUrl: null, version: null },
)
tokens.sources = sources
for (const c of chains) {
  delete c.logo
  delete c.logoSource
  delete c.tokenLogo
  if (chainLogo.has(c.id)) Object.assign(c, { logo: chainLogo.get(c.id), logoSource: TW })
  if (chainLogo.has(c.id) && ['evm', 'solana'].includes(c.family) && TW_CHAINS[c.id])
    c.tokenLogo = raw + TW_CHAINS[c.id] + '/assets/{address}/logo.png'
}

console.log(JSON.stringify({ commit, chains: chainLogo.size + '/' + chains.length, tokens: tokenRefs + '/' +
  tokens.tokens.length, exchanges: tokens.exchangeLogos.length + '/' + exchanges.length }))
if (!values['dry-run']) {
  writeFileSync(tokensFile, JSON.stringify(tokens, null, 2) + '\n')
  // Keep the file's own number spelling (12.0) so the diff shows only the logo fields.
  const spelled = [...readFileSync(chainsFile, 'utf8').matchAll(/"blockTimeSeconds": ([0-9.]+)/g)].map(m => m[1])
  let n = 0
  writeFileSync(chainsFile, (JSON.stringify(chains, null, 2) + '\n').replace(/"blockTimeSeconds": ([0-9.]+)/g,
    (all, value) => { const original = spelled[n++]; return Number(original) === Number(value) ? '"blockTimeSeconds": ' + original : all }))
}
export { robotsAllow, checksumAddress }
