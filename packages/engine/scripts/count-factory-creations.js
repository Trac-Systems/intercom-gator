// Supplement the stratified history survey. For non-enumerable factories try a complete bounded log count.
// Record contract nonces separately; custom factories/deployers can create contracts other than pools.
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { loadBundle } from '@gator/bundle'
import { adaptBundle } from '../src/sources/bundle-adapter.js'
import { multiRead, address, ZERO } from '../src/sources/evm-abi.js'
import { keccak256 } from '../src/intel/keccak.js'
import { RpcClient } from '../src/rpc/index.js'
import { RequestBudget, RateLimited } from '../src/scheduler/index.js'
import { hex } from '../src/coverage/factory-history.js'

const rows=process.argv.slice(2).filter(a=>!a.startsWith('--')).flatMap(file=>readFileSync(file,'utf8').trim().split('\n').map(JSON.parse))
const refine=process.argv.includes('--refine')
const nonceOnly=process.argv.includes('--nonce-only')
const only=process.argv.find(a=>a.startsWith('--chains='))?.slice(9).split(',')
const catalog=adaptBundle(loadBundle()), inventory=rows.filter(r=>r.type==='inventory' && (!only || only.includes(r.chain)))
const budget=new RequestBudget('normal',20)
const rpc=new RpcClient({budget,retries:0,timeout:8000,endpoints:Object.fromEntries(catalog.chains.map(c=>[c.id,
  c.endpoints.map(e=>({...e,rpm:Math.min(e.rpm,6)}))]))})
const print=row=>console.log(JSON.stringify(row))
async function call(fn) {
  for (let i=0;;) {
    try { return await fn() } catch (e) {
      if (e instanceof RateLimited && e.retryAt<Date.now()+61_000) await delay(Math.max(100,e.retryAt-Date.now()))
      else if (++i>=2 || e instanceof RateLimited) throw e
    }
  }
}
async function inspect(c) {
  const chain=catalog.chains.find(d=>d.id===c.chain)
  const direct=(method,params)=>call(()=>rpc.call(c.chain,method,params))
  const fs=c.factories.filter(f=>f.pairs==null&&f.pools==null && (!refine || f.kind!=='v4' &&
    !rows.some(r=>r.type==='log-total' && r.complete && r.chain===c.chain && r.factory===f.address)))
  const candidates=fs.filter(f=>f.kind!=='v4' && !rows.some(r=>r.type==='nonce' && r.chain===c.chain && r.factory===f.address))
  const selector=keccak256('poolDeployer()').slice(0,10)
  let deployers=[]
  if(candidates.length) try {
    deployers=await call(()=>multiRead(rpc,chain,candidates.map(f=>({to:f.address,data:selector})),hex(c.head)))
  } catch {}
  for (const [i,f] of candidates.entries()) {
    const deployer=address(deployers[i]), target=deployer && deployer!==ZERO ? deployer : f.address
    try {
      const nonce=Number(await direct('eth_getTransactionCount',[target,hex(c.head)]))
      if(Number.isSafeInteger(nonce)) print({type:'nonce',chain:c.chain,factory:f.address,target,nonce})
    } catch (e) {
      if (nonceOnly) {
        try {
          const head=Number(await direct('eth_blockNumber',[]))
          let value
          try { value=await direct('eth_getTransactionCount',[target,'latest']) }
          catch { value=(await direct('eth_getProof',[target,[],'latest'])).nonce }
          const nonce=Number(value)
          if (!Number.isSafeInteger(nonce)) throw new Error('invalid account nonce')
          print({type:'nonce',chain:c.chain,factory:f.address,target,nonce,approximateBlock:head})
          continue
        } catch {}
      }
      print({type:'unavailable',chain:c.chain,factory:f.address,reason:e.kind??e.message})
    }
  }
  if (nonceOnly) return
  for (const f of fs) {
    const d=chain.deployments.find(d=>d.address===f.address)
    const topics=d.topics.filter(t=>chain.events[t]?.emitter==='factory'||chain.events[t]?.signature.startsWith('Initialize('))
    // Bound the traffic spent attempting an exact count even when the endpoint has an undocumented span limit.
    const limit=refine ? 92 : 10, sample=rows.filter(r=>r.type==='sample'&&r.chain===c.chain)
    const estimated=c.head*sample.reduce((n,r)=>n+(r.counts[f.address]??0)/(r.end-r.start+1),0)/sample.length
    if(!refine && estimated>12_000)continue
    let lo=0,hi=c.head+1
    // Some gateways accept very wide *sparse* address filters. For tighter gateways leave the survey estimate.
    const query=async(a,b)=>direct('eth_getLogs',[{address:f.address,topics:[topics],fromBlock:hex(a),toBlock:hex(b-1)}])
    let count=0,reads=0,done=false
    const stack=[[lo,hi]]
    try {
      while(stack.length && reads++<limit) {
        const [a,b]=stack.pop()
        try {
          const found=await query(a,b)
          if(!Array.isArray(found)||found.some(l=>l.removed||l.address?.toLowerCase()!==f.address||
            !topics.includes(l.topics?.[0])||Number(l.blockNumber)<a||Number(l.blockNumber)>=b))throw new Error('invalid logs')
          count+=found.length
        } catch(e) {
          const ranges=rpc.chains.get(c.chain).filter(e=>e.logs!==false && !(e.refusedMethods.get('eth_getLogs')>Date.now()))
          const cap=Math.max(...ranges.map(e=>e.range??Infinity))
          if (!ranges.length||Math.ceil((b-a)/cap)>limit-reads||b-a<=1||!['range','timeout','too-large'].includes(e.kind)) throw e
          const m=a+Math.floor((b-a)/2)
          stack.push([a,m],[m,b])
        }
      }
      done=stack.length===0
    } catch {}
    print({type:'log-total',chain:c.chain,factory:f.address,complete:done,count,reads})
  }
}
const iterator=inventory.values()
await Promise.all(Array.from({length:3},async()=>{for(const c of iterator) await inspect(c)}))
print({type:'end',dispatches:budget.dispatches})
