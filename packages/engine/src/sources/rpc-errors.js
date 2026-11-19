// What an upstream refusal means for rotation (2026-11-19 probes of every bundle endpoint). Only the kind
// leaves this module; provider messages stay in memory and are never logged or reported.
//
//   reverted      the call itself failed (contract revert): a valid answer, not an endpoint fault
//   range         eth_getLogs block range over the endpoint's limit ("ranges over 100 blocks", "max block range 1000")
//   addresses     eth_getLogs address filter over the endpoint's limit ("A maximum of 10 addresses is allowed")
//   inputs        a key list over the endpoint's limit (Pocket getMultipleAccounts: "Too many inputs provided; max 50")
//   method        the endpoint refuses this method or request class ("Archive requests require a personal token",
//                 "Indexed requests ...", "Method not found")
//   rate-limited  per-IP rate limit (HTTP 429, -32029, -32011 "request limit reached", -32005 "limit exceeded")
//   quota         a daily or plan quota is spent ("You've reached the usage limit for your current plan")
//   key           needs an API key or paid plan now ("Apikey not found", "chain is not available on free plan")
//   blocked       refused by a CDN or region block (HTTP 403 page)
//   gone          permanently moved or removed (HTTP 404/410, DNS failure)
//   lagging       the node has not reached the requested block or slot yet (a block-pinned read whose height came from
//                 a faster endpoint: "header not found", Solana -32016 "Minimum context slot has not been reached")
//   timeout, too-large, server, network, error

const pick = (text, patterns) => {
  for (const re of patterns) {
    const m = text.match(re)
    if (m) {
      const n = Number(m[1].replaceAll(',', ''))
      if (Number.isSafeInteger(n) && n > 0) return n
    }
  }
  return null
}

/** @param {{status?: number, code?: number, message?: string, name?: string}} error */
export function classifyRpcError({ status = 0, code, message = '', name } = {}) {
  const m = String(message ?? '')
  if (code === 3 || /execution reverted|\brevert(ed)?\b/i.test(m)) return { kind: 'reverted' }
  if (name === 'TimeoutError' || /time ?out|timed out/i.test(m)) return { kind: 'timeout' }
  if (/exceeds byte limit|exceeded response limit|response size/i.test(m)) return { kind: 'too-large' }
  if (/more than \d[\d,]* results|too many results/i.test(m)) return { kind: 'too-large' }
  // Reads past the node's head, worded per client; checked before `range` ("invalid block range" is not a cap).
  if (code === -32019 || /block is out of range|unsupported block number|invalid block (height|range|number)/i.test(m))
    return { kind: 'lagging' }
  if (/too many (inputs|keys|accounts|pubkeys)|max(imum)? (of )?\d+ (inputs|keys|accounts|pubkeys)/i.test(m))
    return { kind: 'inputs', limit: pick(m, [/max(?:imum)?(?: of)?\s*(\d[\d,]*)/i, /(\d[\d,]*)\s*(?:inputs|keys|accounts|pubkeys)/i]) }
  if (/addresses/i.test(m) && /maximum|too many|allowed|limit/i.test(m))
    return { kind: 'addresses', limit: pick(m, [/(\d[\d,]*)\s*addresses/i, /addresses[^0-9]{0,30}(\d[\d,]*)/i]) }
  if (/block range|ranges? over|range (is )?too (large|wide|big)|too many blocks|blocks? range|max(imum)? (block )?range/i.test(m))
    return { kind: 'range', limit: pick(m, [/(\d[\d,]*)\s*blocks?\b/i, /range[^0-9]{0,40}(\d[\d,]*)/i]) }
  if (code === -32601 || /archive requests|indexed requests|method not found|method .{0,40}not (supported|available|allowed|enabled|whitelisted)|unsupported method|disabled on (the )?public tier/i.test(m))
    return { kind: 'method' }
  if (/usage limit|quota|daily limit|credits/i.test(m)) return { kind: 'quota' }
  if (status === 429 || [-32029, -32011, -32030, -32090].includes(code) || /rate.?limit|too many requests|request limit|limit exceeded|capacity|throttl/i.test(m))
    return { kind: 'rate-limited' }
  if (status === 401 || /api.?key|personal token|paid plan|chain is not available|unsupported platform|no longer available|sign up|unauthori[sz]ed/i.test(m))
    return { kind: 'key' }
  if (status === 403) return { kind: 'blocked' }
  if (status === 404 || status === 410 || /ENOTFOUND|EAI_AGAIN/.test(m)) return { kind: 'gone' }
  if (code === -32016 || /header not found|unknown block|block not found|missing trie node|not (yet )?available|after last accepted|unfinalized|is not processed|minimum context slot|not been reached/i.test(m))
    return { kind: 'lagging' }
  if (status >= 500 || /temporary internal error|internal error|please retry/i.test(m)) return { kind: 'server' }
  if (!status && /fetch failed|ECONN|socket|EPROTO|certificate|ETIMEDOUT/i.test(m)) return { kind: 'network' }
  return { kind: 'error' }
}

/** Kinds that refuse one request shape while the endpoint keeps serving others. */
export const SHAPE_REFUSALS = new Set(['range', 'addresses', 'inputs', 'method'])
/** Kinds after which the endpoint is unusable for a long while (no keyless access from this network). */
export const LONG_REFUSALS = new Set(['key', 'blocked', 'gone', 'quota'])
