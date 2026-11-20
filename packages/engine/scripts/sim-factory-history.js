// Event-driven fluid simulation, using the production unit boundaries and reporter scores.
// Inputs are empirical factory populations and the measured fraction passing the same state decoder.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { loadBundle } from '@gator/bundle'
import { adaptBundle } from '../src/sources/bundle-adapter.js'
import { BUDGETS } from '../src/scheduler/index.js'
import { ReporterSlice, reporterScore } from '../src/coverage/split.js'
import { FORWARD_CAP, HISTORY_CAP, HISTORY_SHARE } from '../src/coverage/backfill.js'
import { MAX_SPAN, PAGE_SIZE, historyRanges } from '../src/coverage/factory-history.js'

const rounded = n => Math.round(n * 100) / 100
const sum = values => values.reduce((total,n) => total+n,0)

export function workload(survey, profile='normal', sharing=true) {
  const catalog = adaptBundle(loadBundle()), units = [], chains = new Map()
  const profileRate = Math.floor(BUDGETS[profile] * HISTORY_SHARE)
  let refreshCalls = 0
  for (const c of survey.chains) {
    const chain = catalog.chains.find(chain => chain.id === c.id)
    // callWhenIdle permits one background dispatch for every four endpoint slots.
    const stateRate = sum(chain.endpoints.map(e=>e.rpm/8))
    const logRate = sum(chain.endpoints.filter(e=>e.logs!==false && (e.range??Infinity)>=c.span).map(e=>e.rpm/8))
    const row = { chain:c.id, pools:0, liquid:0, requests:0, logCalls:0 }
    chains.set(c.id,row)
    for (const f of c.factories) {
      if (!chain.deployments.some(d=>d.address===f.address && d.kind===f.kind)) throw new Error('factory absent from bundle')
      const end = f.mode==='index' ? f.population : c.head+1
      refreshCalls += 1 + Number(f.mode==='index')
      const ranges = historyRanges(c.id, f.address, f.mode, end)
      row.pools += f.population
      for (const unit of ranges) {
        const length = unit.end-unit.start
        const activeBlocks = end-(f.firstBlock??0)
        const exposure = Math.max(0, unit.end-Math.max(unit.start,f.firstBlock??0))
        const pools = f.mode==='index' ? length : f.population*exposure/activeBlocks
        const liquid = pools*f.funded
        let requests, logs
        if (f.mode==='index') {
          // Pinned head, index array, two identities, missing decimals and pool state.
          requests = 5*Math.ceil(pools/PAGE_SIZE)
          // Find the creation tx by historical length and a token-filtered log, then check the receipt.
          const bisections = Math.max(0,Math.ceil(Math.log2((c.head+1)/MAX_SPAN)))
          const proofWindows = Math.ceil((c.head+1)/2**bisections/c.span)
          logs = sharing ? liquid*(1+proofWindows)/2 : 0
          if (sharing) requests += liquid*(bisections+1)+logs
        } else {
          const windows = Math.ceil(length/c.span)
          const activeWindows = Math.max(1,Math.ceil(exposure/c.span))
          const occupied = activeWindows*(1-Math.exp(-pools/activeWindows))
          const pages = Math.max(pools/PAGE_SIZE,occupied)
          logs = windows + Math.max(0,pages-occupied)
          requests = logs + 3*pages + (sharing ? liquid : 0)
        }
        requests += liquid/24 // one batched historical names turn per 24 new assets
        units.push({ ...unit,chain:c.id,factory:f.address,pools,liquid,requests })
        row.requests += requests
        row.logCalls += logs
        row.liquid += liquid
      }
    }
    const logFraction = row.logCalls/row.requests
    row.rate = Math.min(profileRate,stateRate,logRate/logFraction)
    if (!(row.rate>0)) throw new Error('no eligible measured endpoint capacity on '+c.id)
  }
  // Assume one head and, for arrays, a capability call on each six-hour bounds refresh.
  const refreshRate = refreshCalls/360
  return {units,chains,rate:profileRate-refreshRate,refreshRate}
}

/** Approximate the scheduler's factory rotation with equal service per active factory.
 * Redistribute the share after a factory finishes or a chain reaches its public endpoint limit. */
function timeline(chains, ceilings, rate) {
  const jobs = [...chains].map(([chain,factories])=>{
    const sizes = factories.map(f=>f.total).filter(n=>n>0).sort((a,b)=>a-b)
    return {chain,sizes,remaining:sizes.length,perFactory:0,done:0,periods:[]}
  })
  let active = jobs.filter(j=>j.remaining), time = 0, peak=0
  while (active.length) {
    let budget = rate, weight = sum(active.map(j=>j.remaining))
    const capPerFactory = job => ceilings.get(job.chain).rate/job.remaining
    for (const j of [...active].sort((a,b)=>capPerFactory(a)-capPerFactory(b))) {
      j.rate = Math.min(ceilings.get(j.chain).rate,budget*j.remaining/weight)
      budget -= j.rate
      weight -= j.remaining
    }
    peak = Math.max(peak,rate-budget)
    const next = j => j.sizes[j.sizes.length-j.remaining]
    const dt = Math.min(...active.map(j=>(next(j)-j.perFactory)*j.remaining/j.rate))
    for (const j of active) {
      j.periods.push({start:time,done:j.done,until:j.done+dt*j.rate,rate:j.rate})
      j.done += dt*j.rate
      j.perFactory += dt*j.rate/j.remaining
      while (j.remaining && next(j)-j.perFactory<1e-6) j.remaining--
    }
    time += dt
    active = active.filter(j=>j.remaining)
  }
  return {peak,periods:new Map(jobs.map(j=>[j.chain,j.periods]))}
}

export function simulate(work, size, profile='normal') {
  const keys = Array.from({length:size},(_,i)=>i.toString(16).padStart(64,'0'))
  const {copies,split} = new ReporterSlice(keys[0],keys)
  const readers = keys.map(()=>new Map())
  const covered = work.units.map(()=>({first:Infinity,retainedAt:Infinity,sweptAt:Infinity,fraction:0,isolated:Infinity}))
  for (const [id,unit] of work.units.entries()) {
    const ranks = keys.map((key,node)=>({node,score:split ? reporterScore(unit.key,key) : 0}))
    if (split) ranks.sort((a,b)=>b.score-a.score||a.node-b.node)
    for (const {node,score} of ranks.slice(0,copies)) {
      const factories = readers[node]
      const key = unit.chain+'/'+unit.factory
      if (!factories.has(key)) factories.set(key,{chain:unit.chain,units:[],total:0})
      const task = factories.get(key)
      task.units.push({id,score})
      task.total += unit.requests
    }
  }
  let peak=0,limited=0,latestRpc=0
  for (const factories of readers) {
    const grouped = Map.groupBy(factories.values(),f=>f.chain)
    const clock = timeline(grouped,work.chains,work.rate)
    peak = Math.max(peak,clock.peak)
    const events = []
    for (const task of factories.values()) {
      if (split) task.units.sort((a,b)=>b.score-a.score||a.id-b.id)
      let service=0
      for (const {id} of task.units) {
        const u = work.units[id]
        service += u.requests
        // Within a chain, factories alternate spare work. When one finishes, the others use its share.
        const spent = sum(grouped.get(task.chain).map(f=>Math.min(service,f.total)))
        const period = clock.periods.get(task.chain).find(p=>p.until>=spent-1e-5)
        const time = period.start+(spent-period.done)/period.rate
        latestRpc = Math.max(latestRpc,time)
        const c = covered[id]
        c.first = Math.min(c.first,time)
        c.isolated = Math.min(c.isolated,spent/work.chains.get(task.chain).rate)
        events.push({time,id})
      }
    }
    let spare=HISTORY_CAP[profile], previous=0, pending=0, stalled=0, reachedLimit=false
    for (const {id,time} of events.sort((a,b)=>a.time-b.time)) {
      if (spare<=0 && size===1) {reachedLimit=true;break}
      const liquid = work.units[id].liquid
      const c = covered[id]
      const keep = Math.min(spare,liquid), forwards=liquid-keep
      const fraction = liquid ? keep/liquid : 1
      if (forwards>0) reachedLimit=true
      // Forward arrivals are spread over the service interval. With an available peer, drain up
      // to one per minute and delay this reader while the bounded queue is full.
      pending = Math.max(0,pending+forwards-(time-previous))
      stalled += Math.max(0,pending-FORWARD_CAP[profile])
      pending = Math.min(FORWARD_CAP[profile],pending)
      previous=time
      if (fraction===1) c.retainedAt = Math.min(c.retainedAt,time+stalled)
      if (fraction===1 || size>1) c.sweptAt=Math.min(c.sweptAt,time+stalled)
      c.fraction = Math.max(c.fraction,fraction)
      spare -= keep
    }
    if (reachedLimit) limited++
  }
  const rows = new Map([...work.chains].map(([id,c])=>[id,{chain:id,pools:Math.round(c.pools),
    requests:Math.ceil(c.requests),liquid:Math.round(c.liquid),covered:0,days:0,isolatedDays:0,retainedDays:0,sweepDays:0,complete:true}]))
  for (const [id,u] of work.units.entries()) {
    const r=rows.get(u.chain), c=covered[id]
    r.covered += c.fraction*u.liquid
    r.days = Math.max(r.days,c.first/1440)
    r.isolatedDays = Math.max(r.isolatedDays,c.isolated/1440)
    r.retainedDays = Math.max(r.retainedDays,c.retainedAt/1440)
    r.sweepDays = Math.max(r.sweepDays,c.sweptAt/1440)
    if (c.fraction<1) r.complete=false
  }
  const liquid = sum([...work.chains.values()].map(c=>c.liquid))
  const retained = sum([...rows.values()].map(r=>r.covered))
  const rpcTotal = sum([...work.chains.values()].map(c=>c.requests))*copies
  const swept = size>1 ? liquid : retained
  return {nodes:size,copies,peakRpcPerMinute:rounded(peak+work.refreshRate),
    meanRpcPerMinuteDuringRpcOnlySweep:rounded(rpcTotal/(size*latestRpc)+work.refreshRate),
    storageLimitedNodes:limited,
    distinctLiquid:Math.round(liquid),distinctCovered:Math.round(retained),
    distinctScanned:Math.round(swept),
    coveredWithPeerSlotsUpperBound:Math.round(Math.min(liquid,retained+(size>1 ? size*Math.floor(HISTORY_CAP[profile]/2) : 0))),
    // The wire has one first-send slot per minute per node, even with perfect deduplication.
    firstAnnouncementLowerBoundDays:size>1 ? rounded(swept/size/1440) : null,
    chains:[...rows.values()].map(r=>({...r,covered:Math.round(r.covered),days:rounded(r.days),
      isolatedDays:rounded(r.isolatedDays),retainedDays:r.complete ? rounded(r.retainedDays) : null,
      sweepDays:Number.isFinite(r.sweepDays) ? rounded(r.sweepDays) : null}))}
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const args=process.argv.slice(2), profile=args.find(a=>a.startsWith('--profile='))?.slice(10)??'normal'
  if (!Object.hasOwn(BUDGETS,profile)) throw new Error('Unknown profile '+profile)
  const input = args.find(a=>!a.startsWith('--')) ?? new URL('../test/fixtures/factory-survey.json',import.meta.url)
  const survey = JSON.parse(readFileSync(input)), connected = workload(survey,profile)
  for (const size of [1,3,7,20,100])
    console.log(JSON.stringify(simulate(size===1 ? workload(survey,profile,false) : connected,size,profile)))
}
