import { BlockList, isIP } from 'node:net'

// Separate lists: node's BlockList matches IPv4 addresses against ::ffff:0:0/96 and IPv4 rules against mapped IPv6.
const v4 = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8], // this network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and broadcast
])
  v4.addSubnet(net, prefix, 'ipv4')
const v6 = new BlockList()
for (const [net, prefix] of [
  ['::', 96], // unspecified, loopback and IPv4-compatible
  ['::ffff:0:0', 96], // IPv4-mapped (write a public IPv4 literal instead)
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds any IPv4)
  ['fc00::', 7], // unique-local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
])
  v6.addSubnet(net, prefix, 'ipv6')

const localSuffix = /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/

/** True when a patched endpoint may point at this URL host (WHATWG-normalised `URL.hostname`). */
export function publicHost(hostname) {
  let host = String(hostname).toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  host = host.replace(/\.$/, '')
  const family = isIP(host)
  if (family === 4) return !v4.check(host, 'ipv4')
  if (family === 6) return !v6.check(host, 'ipv6')
  // Single-label names (including `localhost`) resolve through local search domains.
  return host.includes('.') && !localSuffix.test(host)
}

const urlLike = /^[a-z][a-z0-9+.-]*:\/\//i
const schemeLike = /^(?:https?|wss?|ftp|file|data|javascript|blob|gopher):/i

/** Reason a string from patch data is not an allowed endpoint URL, or null. Strings that do not look like a URL
 * (notes, relative routes, field paths) are not endpoint values and return null. */
export function urlProblem(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/^[\u0000- ]+/, '')
  if (!urlLike.test(trimmed) && !schemeLike.test(trimmed)) return null
  if (!/^(?:https|wss):\/\//.test(value)) return 'scheme'
  if (/[\u0000- \u007f\\]/.test(value)) return 'characters'
  const authority = value.slice(value.indexOf('//') + 2).split(/[/?#]/, 1)[0]
  // A template or user info in the authority would let runtime data choose the host.
  if (!authority || /[{}@%]/.test(authority)) return 'authority'
  let url
  try {
    url = new URL(value)
  } catch {
    return 'syntax'
  }
  if (!['https:', 'wss:'].includes(url.protocol) || url.username || url.password) return 'scheme'
  return publicHost(url.hostname) ? null : 'host'
}

function* strings(value, depth = 0) {
  if (typeof value === 'string') yield value
  else if (value !== null && typeof value === 'object' && depth < 64)
    for (const child of Object.values(value)) yield* strings(child, depth + 1)
}

const known = new WeakMap()
/** URL-like strings already present in a root-signed bundle. They were accepted before and are not new. */
function knownUrls(bundle) {
  let set = known.get(bundle)
  if (!set) {
    set = new Set()
    for (const s of strings(bundle)) if (urlLike.test(s)) set.add(s)
    known.set(bundle, set)
  }
  return set
}

/** First URL problem among the strings a patch adds to `base`, or null. */
export function patchUrlProblem(ops, base) {
  const seen = knownUrls(base)
  for (const op of ops)
    if (op && typeof op === 'object' && Object.hasOwn(op, 'value'))
      for (const s of strings(op.value)) {
        if (seen.has(s)) continue
        const problem = urlProblem(s)
        if (problem) return problem
      }
  return null
}
