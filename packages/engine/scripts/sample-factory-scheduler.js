// Run ordinary foreground jobs and the history job concurrently against two signed public chains.
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { loadBundle } from '@gator/bundle'
import { openStore } from '@gator/store'
import { Engine, migrations } from '../src/index.js'
import { BACKFILL_JOB } from '../src/coverage/backfill.js'
import { historyRanges } from '../src/coverage/factory-history.js'
import { nativeRate } from './factory-survey-usd.js'

const eras = process.argv.includes('--eras')
const useReference = process.argv.includes('--reference-feed')
const chains = eras ? ['ethereum','polygon'] : ['arbitrum','optimism']
const foreground = process.argv.includes('--logs-only') ? ['logs'] : ['logs','state','seed','trades']
const jobs = [BACKFILL_JOB,...chains.flatMap(chain=>foreground.map(job=>'evm:'+chain+':'+job))]
const store = openStore({file:':memory:',profile:'normal',migrations})
const all = [], history = []
let sent = 0, errors = 0
const transport = Object.assign(new EventEmitter(),{
  publicKey:'1'.repeat(64),channels:()=>[],join:async()=>true,leave:async()=>true,peerCount:()=>0,
  send(channel) { if (channel==='gator/new') sent++; return true },
})
const engine = new Engine({
  bundle:loadBundle(),store,transport,backgroundJobs:jobs,patches:{patchFeed:false},
  rpcConfig:{requestsPerMinute:eras ? 160 : 80,retries:0,timeout:5000,
    fetch(url,options) { all.push(Date.now()); return fetch(url,options) }},
})
const charge = engine.backfill.budget.take.bind(engine.backfill.budget)
engine.backfill.budget.take = () => { charge(); history.push(Date.now()) }
engine.backfill.tasks = engine.backfill.tasks.filter(t=>chains.includes(t.source.chain.id))
for (const endpoints of engine.rpc.chains.values())
  for (const e of endpoints) e.bucket.rate = Math.min(eras ? 3 : 2,e.bucket.rate)
engine.on('sourceError',()=>errors++)
// An isolated node without CEX jobs can have no native USD conversion after a book refresh.
// For the controlled feed scenario, use the actually measured signed native/USDC price for
// one hour, and only while the ordinary price store has no fresh native observation.
const nativePrices=new Map()
if (useReference) for (const chain of chains) {
  const source=engine.evm.get(chain), usd=source.usd.bind(source)
  source.usd=asset=>{
    const price=usd(asset), ref=nativePrices.get(chain), cutoff=Date.now()-3_600_000
    if (price!=null || asset!=='native' || !ref || ref.at<cutoff ||
        source.assetPrice.get(chain+':native',cutoff)) return price
    return ref.price
  }
}
// Two predeclared, age-targeted durable checkpoints exercise actual scheduler resume. No
// token or pool is supplied. The output contains every admitted pool in those and later pages.
async function resumeEra(block) {
  const h = engine.backfill, t=h.tasks.find(t=>t.source.chain.id==='ethereum')
  while (h.busy) await delay(50)
  const start = Math.floor(block/256)*256, end=start+256
  const range = historyRanges('ethereum',t.factory.address,'logs',end)[0]
  h.mark.run('ethereum',t.factory.address,'logs',range.start,start,-1,256,Date.now())
  t.bounds={mode:'logs',end,at:Date.now()}
  store.setSetting(t.key,t.bounds)
  t.plan=t.work=null
  t.wake=0
  console.log(JSON.stringify({type:'resume',chain:'ethereum',start,end:end-1}))
  for (const chain of chains) {
    try {
      const measured=await nativeRate(engine,engine.evm.get(chain))
      nativePrices.set(chain,{price:measured.price,at:Date.now()})
      console.log(JSON.stringify(measured))
    }
    catch (e) { console.log(JSON.stringify({type:'anchor-error',chain,reason:e.kind??e.message})) }
  }
}
if (eras) {
  engine.backfill.tasks=engine.backfill.tasks.filter(t=>t.factory.name===(t.source.chain.id==='ethereum' ? 'uniswap-v4' : 'uniswap-v2'))
  await resumeEra(23_467_351)
}
const count = table => store.reader.prepare('SELECT count(*) AS n FROM '+table).get().n
function peak(times) {
  let max=0, first=0
  for (const [i,t] of times.entries()) {
    while (times[first]<=t-60_000) first++
    max = Math.max(max,i-first+1)
  }
  return max
}
await engine.start()
const start = Date.now(), duration = Number(process.argv[2]??21)*60_000
try {
  let second = false
  while (Date.now()-start<duration) {
    await delay(60_000)
    console.log(JSON.stringify({minute:Math.round((Date.now()-start)/60_000),calls:all.length,history:history.length,
      peak:peak(all),historyPeak:peak(history),retained:count('engine_history_pools'),progress:count('engine_history_ranges'),
      admitted:store.reader.prepare('SELECT chain,count(*) AS n FROM engine_history_pools GROUP BY chain').all(),
      registered:count('pools'),sent,errors,latestScanner:Object.fromEntries(jobs.filter(j=>j!==BACKFILL_JOB)
        .map(j=>[j,engine.scheduler.jobs.get(j).lastOk??null]))}))
    if (eras && !second && Date.now()-start>=duration/2) { second=true; await resumeEra(23_747_800) }
  }
  if (eras) console.log(JSON.stringify({type:'admissions',markets:store.reader.prepare(
    'SELECT h.chain,h.pool,p.token0,p.token1,h.block,p.liquidity FROM engine_history_pools h JOIN pools p USING(chain,pool) ORDER BY h.chain,h.pool').all()}))
} finally { await engine.stop(); store.close() }
