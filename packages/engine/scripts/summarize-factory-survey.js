// Combine JSON-lines measurement outputs. Every number used to extrapolate retains its denominator and method.
import { readFileSync } from 'node:fs'
import { loadBundle } from '@gator/bundle'
import { adaptBundle } from '../src/sources/bundle-adapter.js'

const rows = process.argv.slice(2).flatMap(path=>readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse))
const kinds = adaptBundle(loadBundle()).chains
const inventory = rows.filter(r=>r.type==='inventory')
const depths = new Map(rows.filter(r=>r.type==='depth').map(r=>[r.chain+'/'+r.factory,r]))
const kind = (chain,address) => kinds.find(c=>c.id===chain).deployments.find(f=>f.address===address).kind
const fields = ['sample','unpriced','empty','above100','above1k','above10k']
function addDepth(chain,factory,counts) {
  const key = chain+'/'+factory
  const d = depths.get(key) ?? {chain,factory}
  for (const field of fields) d[field] = (d[field]??0) + (counts[field]??0)
  depths.set(key,d)
}
const extra = new Map(rows.filter(r=>['manager-depth','full-depth'].includes(r.type)).map(r=>[[r.type,r.chain,r.factory].join('/'),r]))
for (const r of extra.values()) addDepth(r.chain,r.factory,r)
// These two runs drew uniform V2 index pages. Ethereum also included two targeted periods, so
// none of the Ethereum demonstration is used for extrapolation.
for (const demo of rows.filter(r=>r.type==='end' && r.floors)) {
  for (const chain of ['base','polygon']) {
    const [sample,priced,above100,above1k,above10k] = demo.floors[chain]
    const f = kinds.find(c=>c.id===chain).deployments.find(f=>f.name==='uniswap-v2')
    addDepth(chain,f.address,{sample,above100,above1k,above10k})
    depths.get(chain+'/'+f.address).demoUnpricedOrEmpty = sample-priced
  }
}

function depth(c,f,direct) {
  let samples, method
  if (direct) { samples=[direct]; method='sample' }
  else {
    const peers=[...depths.values()].filter(r=>kind(r.chain,r.factory)===f.kind)
    const same=peers.filter(r=>r.chain===c.id)
    samples=same.length ? same : peers
    method=same.length ? 'same kind on chain' : 'same kind across chains'
  }
  const sample=samples.reduce((n,r)=>n+r.sample,0)
  const above100=samples.reduce((n,r)=>n+r.above100,0)
  return { funded:sample ? above100/sample : 0,depthMethod:method,rateSample:sample,ratePassed:above100,sample:direct?.sample??0,
    above100:direct?.above100??0,above1k:direct?.above1k??0,above10k:direct?.above10k??0,
    empty:direct?.empty??0,unpriced:direct?.unpriced??0,
    ...(direct?.demoUnpricedOrEmpty!=null && {demoUnpricedOrEmpty:direct.demoUnpricedOrEmpty}) }
}

const chains=[]
for (const inv of inventory) {
  const source=rows.filter(r=>r.chain===inv.chain), s=new Map(source.filter(r=>r.type==='sample').map(r=>[r.stratum,r]))
  if (!s.size) throw new Error('missing strata: '+inv.chain)
  const acceptedSpan=source.findLast(r=>r.type==='window')?.span
  const c={ id:inv.chain, head:inv.head, strata:s.size, blocks:[...s.values()].reduce((n,r)=>n+r.end-r.start+1,0),
    span:acceptedSpan || Math.max(...[...s.values()].map(r=>r.end-r.start+1)),spanMeasured:!!acceptedSpan,
    creationWindows:[...s.values()].sort((a,b)=>a.stratum-b.stratum).map(r=>[r.start,r.end,r.counts]),factories:[] }
  for (const f of inv.factories) {
    const records=source.filter(r=>r.factory===f.address)
    const nonceRecord=records.find(r=>r.type==='nonce')
    const nonce=nonceRecord?.nonce
    const full=records.find(r=>r.type==='log-total' && r.complete)
    const manager=records.filter(r=>r.type==='manager-sample')
    const proven=records.findLast(r=>r.type==='known-funded')
    const life=records.find(r=>r.type==='lifetime')
    const observed=[...s.values()].reduce((n,r)=>n+(r.counts[f.address]??0),0)
    const sparse=[...s.values()].reduce((n,r)=>n+(r.counts[f.address]??0)/(r.end-r.start+1),0)
    const firstBlock=life?.lo??0
    let population=f.pairs??f.pools, method='array', mode='index'
    if (population==null) {
      mode='logs'
      if (full && full.count>=observed && (nonce==null || nonce<=full.count+1)) {
        population=full.count; method='full log query'
      } else if (f.kind!=='v4' && nonce>1 && nonce-1>=observed) {
        population=nonce-1; method='creation nonce proxy'
      } else if (manager.length>=6) {
        const density=manager.reduce((n,r)=>n+r.count/(r.end-r.start+1),0)/manager.length
        population=Math.round((inv.head+1-firstBlock)*density); method='manager lifespan sample'
      } else {
        population=Math.round(sparse/s.size*(inv.head+1)); method='chain lifespan sample'
      }
      population=Math.max(population,observed,manager.reduce((n,r)=>n+r.count,0),proven?.above100??0)
    }
    const measuredDepth=depth(c,f,depths.get(c.id+'/'+f.address))
    if (proven) {
      measuredDepth.knownFunded=proven.above100
      measuredDepth.knownAbove1k=proven.above1k
      measuredDepth.knownAbove10k=proven.above10k
      if (population) measuredDepth.funded=Math.max(measuredDepth.funded,Math.min(1,proven.above100/population))
    }
    c.factories.push({address:f.address,name:f.name,kind:f.kind,mode,method,population,
      ...(mode==='logs' && {observed,firstBlock,...(nonce!=null && {nonce}),
        ...(nonceRecord?.approximateBlock && {nonceBlock:nonceRecord.approximateBlock}),...(full && {fullQuery:full.count}),
        ...(life && {deploymentBracket:[life.lo,life.hi]}),
        ...(manager.length>0 && {managerWindows:manager.length,managerCreations:manager.reduce((n,r)=>n+r.count,0),
          managerBlocks:manager.reduce((n,r)=>n+r.end-r.start+1,0),initializations:manager.map(r=>[r.start,r.end,r.count])})}),
      ...measuredDepth})
  }
  chains.push(c)
}
console.log(JSON.stringify({measured:'2026-11-20 UTC',chains},null,2))
