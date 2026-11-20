// Refine a log-only census with stratified Initialize windows inside the measured bytecode lifetime.
// Print the deployment bracket and every successful range. Do not count failed ranges as empty.
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { loadBundle } from '@gator/bundle'
import { adaptBundle } from '../src/sources/bundle-adapter.js'
import { RpcClient } from '../src/rpc/index.js'
import { RequestBudget, RateLimited } from '../src/scheduler/index.js'
import { hex } from '../src/coverage/factory-history.js'

const rows = readFileSync(process.argv[2],'utf8').trim().split('\n').map(JSON.parse)
const previous = process.argv[3] ? readFileSync(process.argv[3],'utf8').trim().split('\n').map(JSON.parse) : null
const catalog = adaptBundle(loadBundle())
const budget = new RequestBudget('normal',14)
const rpc = new RpcClient({ budget, retries:0, timeout:8000,
  endpoints:Object.fromEntries(catalog.chains.map(c=>[c.id,c.endpoints.map(e=>({...e,rpm:Math.min(e.rpm,4)}))])) })
const print = r => console.log(JSON.stringify(r))
async function request(chain,method,params) {
  for (let attempt=0;;) {
    try { return await rpc.call(chain,method,params) } catch (e) {
      if (e instanceof RateLimited && e.retryAt<Date.now()+61_000) await delay(Math.max(100,e.retryAt-Date.now()))
      else if (++attempt>=2 || e instanceof RateLimited || ['range','too-large'].includes(e.kind)) throw e
    }
  }
}
async function inspect(c) {
  const chain = catalog.chains.find(d=>d.id===c.chain)
  const manager = chain.deployments.find(d=>d.kind==='v4')
  const factory = manager ?? chain.deployments.find(d=>d.kind.includes('v3'))
  if (!factory) return
  const prior = previous?.filter(r=>r.chain===c.chain)
  const seen = new Set(prior?.filter(r=>r.type==='manager-sample').map(r=>r.stratum))
  if (prior && (!manager || seen.size===12)) return
  const topics = factory.topics.filter(t=>chain.events[t]?.emitter==='factory'||chain.events[t]?.signature.startsWith('Initialize('))
  const logs = (a,b) => request(c.chain,'eth_getLogs',[{address:factory.address,topics:[topics],fromBlock:hex(a),toBlock:hex(b-1)}])
  let span=prior?.find(r=>r.type==='window')?.span??65_536
  while (!prior) {
    try { await logs(0,span); break } catch (e) {
      if (span<=128) {span=0;break}
      span=Math.max(128,Math.min(e.limit??Infinity,Math.floor(span/2)))
    }
  }
  if (!prior) print({type:'window',chain:c.chain,span})
  if (!manager || !span) return
  const oldLifetime=prior?.find(r=>r.type==='lifetime')
  let lo=oldLifetime?.lo??0,hi=oldLifetime?.hi??c.head
  for (let i=0; !oldLifetime && i<10 && hi-lo>2048; i++) {
    const mid=lo+Math.floor((hi-lo)/2)
    let code
    try { code=await request(c.chain,'eth_getCode',[manager.address,hex(mid)]) } catch { break }
    if (code==='0x') lo=mid+1
    else if (typeof code==='string' && /^0x(?:[a-f0-9]{2})+$/i.test(code)) hi=mid
    else break
  }
  if (!oldLifetime) print({type:'lifetime',chain:c.chain,factory:manager.address,lo,hi})
  const width=Math.floor((c.head+1-lo)/12)
  let step=Math.min(span,prior ? 128 : 4096,width)
  for (let i=0;i<12 && step>0;i++) {
    if (seen.has(i)) continue
    const offset=((Math.imul(i+1,0x85ebca6b)^Math.imul(chain.number,0x9e3779b1))>>>0)/2**32
    const retries=prior?.filter(r=>r.type==='unavailable' && r.stratum===i).length??0
    const fraction=(offset+Math.max(0,retries-1)*0.38196601125)%1
    const start=lo+i*width+Math.floor(fraction*(width-step))
    for (;;) {
      try {
        const entries=await logs(start,start+step)
        if (!Array.isArray(entries)) throw new Error('invalid log response')
        print({type:'manager-sample',chain:c.chain,factory:manager.address,stratum:i,start,end:start+step-1,count:entries.length})
        break
      } catch (e) {
        if (step<=128 || !['range','too-large','timeout'].includes(e.kind) && !e.message?.startsWith('No eligible')) {
          print({type:'unavailable',chain:c.chain,stratum:i,reason:e.kind??e.message})
          break
        }
        step=Math.max(128,Math.min(e.limit??Infinity,Math.floor(step/2)))
      }
    }
  }
}
const iterator = rows.filter(r=>r.type==='inventory').values()
await Promise.all(Array.from({length:4},async()=>{ for(const c of iterator) await inspect(c) }))
print({type:'end',dispatches:budget.dispatches})
