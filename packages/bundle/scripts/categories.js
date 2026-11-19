// Rebuild the optional fields in data/tokens.json. Only this maintenance command downloads metadata.
//   node packages/bundle/scripts/categories.js [--check]
// Fetch only exact chain/address info.json files from the revision pinned in tokens.sources.
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { loadBundle, validateBundle } from '../src/index.js'
import { checksumAddress } from '../../engine/src/logos/index.js'
import { nativeCategoryId } from '../../engine/src/registry/native-category.js'
import { ISSUERS } from '../../engine/src/sources/supply-issuer.js'

const issuers = new Set(Object.values(ISSUERS).flatMap(issuer => Object.values(issuer.deployments)))
const quotes = new Set(['DAI', 'USDC', 'USDC.e', 'USDT', 'USDT0', 'USD₮0', 'USDbC', 'USDG', 'USDB', 'BUSD', 'cUSD'])
const wrappedQuotes = new Set(['WETH', 'WBNB', 'WAVAX', 'WPOL', 'WMNT', 'WBERA', 'WXDAI', 'WFTM', 'wS'])
const folders = { bsc: 'smartchain', avalanche: 'avalanchec', gnosis: 'xdai', robinhood: 'robinhoodchain' }
const tw = 'trustwallet-assets'
const localSources = ['gator-rules', 'gator-linked', 'gator-curated']

function protocolRules(bundle) {
  const rules = new Map([...issuers].map(id => [id, 'stablecoin']))
  for (const chain of bundle.chains) {
    const id = chain.id + ':native', category = nativeCategoryId(id)
    if (category) rules.set(id, category)
  }
  for (const { chain, quoteTokens } of bundle.dex.evm) {
    for (const q of quoteTokens) {
      const id = chain + ':' + q.address
      if (quotes.has(q.symbol)) rules.set(id, 'stablecoin')
      else if (wrappedQuotes.has(q.symbol)) rules.set(id, 'wrapped-bridged')
    }
  }
  rules.set('solana:So11111111111111111111111111111111111111112', 'wrapped-bridged')
  return rules
}

// Only use narrow tags. A protocol working with stablecoins need not issue a pegged governance token.
// "defi", "staking", "nft" and "governance" also appear on oracle, utility and game tokens.
function taggedCategory(token, record) {
  if (!record || !Array.isArray(record.tags)) return null
  const tags = new Set(record.tags.map(tag => tag.toLowerCase()))
  if (tags.has('stablecoin') && !tags.has('governance') && !/governance/i.test(token.name)) return 'stablecoin'
  if (tags.has('privacy')) return 'privacy'
  if (tags.has('memes')) return 'meme'
  if (tags.has('gamefi')) return 'gaming'
  // A wrapped deployment's tag cannot tell us the primary sector of a multi-chain project.
  if (!token.links?.length && (tags.has('binance-peg') || tags.has('wrapped'))) return 'wrapped-bridged'
  return null
}

/** Recompute automatic entries from immutable inputs. The signed manual rows are the editable source of truth. */
export function categorise(bundle, metadata) {
  const rules = protocolRules(bundle)
  const data = structuredClone(bundle.tokens)
  const direct = new Map()
  const annotations = data.sources.flatMap(s => s.assetCategories ?? [])
  for (const t of [...data.tokens, ...annotations]) {
    if (t.categorySource !== 'gator-curated') {
      delete t.category
      delete t.categorySource
      delete t.categoryReason
      const category = rules.get(t.id) ?? taggedCategory(t, metadata.get(t.id))
      if (category) {
        t.category = category
        t.categorySource = rules.has(t.id) ? 'gator-rules' : tw
      }
    }
    if (t.category && t.links?.length && !t.id.endsWith(':native')) direct.set(t.id, t)
  }
  // Use only direct, reciprocal bundle links. Never join by labels or propagate through inferred rows.
  for (const t of data.tokens) {
    if (t.category || t.id.endsWith(':native')) continue
    const categories = new Set()
    for (const id of t.links) {
      const sibling = direct.get(id)
      if (sibling?.links.includes(t.id)) categories.add(sibling.category)
    }
    if (categories.size === 1) {
      t.category = [...categories][0]
      t.categorySource = 'gator-linked'
    }
  }
  for (const id of localSources) {
    if (!data.sources.some(s => s.id === id))
      data.sources.push({ id, url: null, license: null, version: null, licenseUrl: null })
  }
  for (const source of data.sources) {
    const rows = annotations.filter(t => t.categorySource === source.id)
    if (rows.length) source.assetCategories = rows.sort((a, b) => a.id < b.id ? -1 : Number(a.id > b.id))
    else delete source.assetCategories
  }
  return data
}

async function readMetadata(bundle) {
  const source = bundle.tokens.sources.find(s => s.id === tw)
  if (!/^[0-9a-f]{40}$/.test(source?.version)) throw new Error('Expected a pinned Trust Wallet commit')
  const raw = 'https://raw.githubusercontent.com/trustwallet/assets/' + source.version + '/'
  const evm = new Set(bundle.chains.filter(c => c.family === 'evm').map(c => c.id))
  const rules = protocolRules(bundle)
  const jobs = [...bundle.tokens.tokens, ...bundle.tokens.sources.flatMap(s => s.assetCategories ?? [])]
    .filter(t => t.categorySource !== 'gator-curated' && !rules.has(t.id) && !t.id.endsWith(':native'))
  let next = 0
  const metadata = new Map()
  async function readOne() {
    while (next < jobs.length) {
      const { id } = jobs[next++], separator = id.indexOf(':')
      const chain = id.slice(0, separator), address = id.slice(separator + 1)
      const key = evm.has(chain) ? checksumAddress(address) : address
      const path = 'blockchains/' + (folders[chain] ?? chain) + '/assets/' + encodeURIComponent(key) + '/info.json'
      const res = await fetch(raw + path, { redirect: 'error', signal: AbortSignal.timeout(20_000) })
      if (res.status === 404) continue
      if (!res.ok) throw new Error('Trust Wallet HTTP ' + res.status + ' for ' + id)
      const record = await res.json()
      const recordAddress = evm.has(chain) ? record.id?.toLowerCase() : record.id
      if (recordAddress === address) metadata.set(id, record)
    }
  }
  await Promise.all(Array.from({ length: 8 }, readOne))
  return metadata
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { check: { type: 'boolean' } } })
  const bundle = loadBundle()
  const data = categorise(bundle, await readMetadata(bundle))
  validateBundle({ ...bundle, tokens: data })
  const file = new URL('../data/tokens.json', import.meta.url)
  const json = JSON.stringify(data, null, 2) + '\n'
  if (values.check) {
    if (await readFile(file, 'utf8') !== json) throw new Error('Category rebuild differs from tokens.json')
  } else {
    const temp = new URL('tokens-' + randomUUID() + '.tmp', file)
    try {
      await writeFile(temp, json, { flag: 'wx' })
      await rename(temp, file)
    } finally {
      await rm(temp, { force: true })
    }
  }
  console.log(data.tokens.filter(t => t.category).length + '/' + data.tokens.length + ' bundle assets categorised')
}
