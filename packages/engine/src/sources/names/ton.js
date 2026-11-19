import { createHash } from 'node:crypto'
import { get as httpsGet } from 'node:https'
import { lookup } from 'node:dns'
import { publicHost, urlProblem } from '../../patches/urls.js'
import { EndpointBucket, RateLimited } from '../../scheduler/index.js'
import { decodeText, validDecimals } from './text.js'

/** Toncenter v2 returns the decoded cell tree alongside the serialized BOC in each stack cell. */
class Slice {
  constructor(cell) {
    this.length = cell?.data?.len
    this.refs = cell?.refs
    const text = cell?.data?.b64
    if (cell?.special !== false || !Number.isInteger(this.length) || this.length < 0 || this.length > 1023 ||
        !Array.isArray(this.refs) || this.refs.length > 4 || typeof text !== 'string' || text.length > 172)
      throw new Error('Invalid TON cell')
    this.bytes = Buffer.from(text, 'base64')
    if (this.bytes.length !== Math.ceil(this.length / 8) || this.bytes.toString('base64') !== text)
      throw new Error('Invalid TON cell data')
    this.pos = 0
  }
  take(bits) {
    if (this.pos + bits > this.length) throw new Error('Truncated TON cell')
    let value = 0
    for (let i = 0; i < bits; i++, this.pos++)
      value = 2 * value + ((this.bytes[this.pos >> 3] >> (7 - this.pos % 8)) & 1)
    return value
  }
}

// HashmapE stores a presence bit and a root reference. Each Patricia edge uses one of three HmLabel encodings.
function dictionary(slice, keyBits) {
  const found = new Map()
  let cells = 0
  function edge(cell, bits, prefix) {
    if (++cells > 512) throw new Error('TON dictionary too large')
    const s = new Slice(cell)
    let length = 0, repeated = null
    if (s.take(1) === 0) {
      while (s.take(1)) if (++length > bits) throw new Error('Invalid TON label')
    } else {
      if (s.take(1)) repeated = s.take(1)
      length = s.take(Math.ceil(Math.log2(bits + 1)))
    }
    if (length > bits) throw new Error('Invalid TON label')
    for (let i = 0; i < length; i++) prefix = 2n * prefix + BigInt(repeated ?? s.take(1))
    const remaining = bits - length
    if (s.pos !== s.length || s.refs.length !== (remaining ? 2 : 1)) throw new Error('Invalid TON dictionary edge')
    if (!remaining) found.set(prefix, s.refs[0])
    else {
      edge(s.refs[0], remaining - 1, 2n * prefix)
      edge(s.refs[1], remaining - 1, 2n * prefix + 1n)
    }
  }
  const present = slice.take(1)
  if (slice.pos !== slice.length || slice.refs.length !== present) throw new Error('Invalid TON dictionary root')
  if (present) edge(slice.refs[0], keyBits, 0n)
  return found
}

function snake(slice, bytes) {
  for (;;) {
    if ((slice.length - slice.pos) % 8 || slice.refs.length > 1 || bytes.length + (slice.length - slice.pos) / 8 > 4096)
      throw new Error('Invalid TON snake string')
    while (slice.pos < slice.length) bytes.push(slice.take(8))
    if (!slice.refs.length) return
    slice = new Slice(slice.refs[0])
  }
}

function contentField(cell) {
  const slice = new Slice(cell), type = slice.take(8), bytes = []
  if (type === 0) snake(slice, bytes)
  else if (type === 1) {
    const chunks = dictionary(slice, 32)
    for (let i = 0; i < chunks.size; i++) snake(new Slice(chunks.get(BigInt(i))), bytes)
  } else return null
  return decodeText(Uint8Array.from(bytes))
}

const fieldKeys = ['name', 'symbol', 'decimals', 'uri'].map(field =>
  [field, BigInt('0x' + createHash('sha256').update(field).digest('hex'))])

export function jettonContent(result) {
  const item = result?.result?.stack?.[3]
  if (result?.ok !== true || result.result.exit_code !== 0 || item?.[0] !== 'cell') throw new Error('Invalid jetton stack')
  const slice = new Slice(item[1]?.object), prefix = slice.take(8)
  if (prefix === 1) {
    const bytes = []
    snake(slice, bytes)
    return { uri: decodeText(Uint8Array.from(bytes)) }
  }
  if (prefix !== 0) throw new Error('Unknown jetton content type')
  const dict = dictionary(slice, 256), fields = {}
  for (const [field, key] of fieldKeys) if (dict.has(key)) fields[field] = contentField(dict.get(key))
  return fields
}

const publicUri = uri => typeof uri === 'string' && uri.length <= 2048 && uri.startsWith('https://') && !urlProblem(uri)

// Resolve inside the socket lookup itself. A second DNS lookup after validation could select a private address.
function lookupPublic(host, options, done) {
  lookup(host, { ...options, all: true }, (error, answers) => {
    if (error) return done(error)
    if (!answers.length || answers.some(a => !publicHost(a.address))) return done(new Error('Private metadata host'))
    if (options.all) return done(null, answers)
    done(null, answers[0].address, answers[0].family)
  })
}

/** No redirects or credentials. All contract-directed requests share one rate bucket and the profile budget. */
export function offchainReader(engine, get = httpsGet) {
  const bucket = new EndpointBucket(12, engine.clock)
  return async uri => {
    if (!publicUri(uri)) throw new Error('Invalid jetton content URI')
    bucket.take(engine.budget)
    const timeout = AbortSignal.timeout(engine.http.timeout ?? 8000)
    const signal = engine.http.signal ? AbortSignal.any([timeout, engine.http.signal]) : timeout
    const response = await new Promise((resolve, reject) => {
      get(uri, { signal, lookup: lookupPublic, agent: false, headers: { accept: 'application/json' } }, resolve)
        .on('error', reject)
    })
    const max = 32 * 1024
    if (response.statusCode !== 200 || Number(response.headers['content-length']) > max) {
      response.destroy()
      throw new Error('Jetton content unavailable')
    }
    const chunks = []
    let size = 0
    for await (const chunk of response) {
      size += chunk.length
      if (size > max) throw new Error('Jetton content too large')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
}

export async function jettonName(fields, getJson) {
  let document
  if ((!fields.name || !fields.symbol || fields.decimals == null) && publicUri(fields.uri)) {
    try { document = await getJson(fields.uri) }
    catch (error) {
      if (error instanceof RateLimited || (!fields.name && !fields.symbol)) throw error
      // Preserve any measured on-chain fields while the off-chain part is unavailable.
    }
  }
  const places = fields.decimals ?? document?.decimals ?? (fields.uri && !document ? null : 9)
  const decimals = typeof places === 'string' && /^\d{1,3}$/.test(places) ? Number(places) : places
  return { name: fields.name ?? document?.name, symbol: fields.symbol ?? document?.symbol,
    decimals: validDecimals(decimals) ? decimals : null, method: document ? 'jetton-https' : 'jetton-tep64' }
}
