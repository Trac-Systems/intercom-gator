// Read a stratified sample of factory array entries, and sampled creations from the inventory survey.
// The temporary SQLite store supplies the production decimals, USD, funded-state and registry readers.
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { loadBundle } from '@gator/bundle'
import { openStore } from '@gator/store'
import { Engine, migrations } from '../src/index.js'
import { multiRead, address, decodeEvent, word, ZERO } from '../src/sources/evm-abi.js'
import { seedProbesFor } from '../src/sources/evm.js'
import { RateLimited } from '../src/scheduler/index.js'
import { hex } from '../src/coverage/factory-history.js'

const only = process.argv.find(arg => arg.startsWith('--chains='))?.slice(9).split(',')
const managers = process.argv.includes('--managers')
const complete = process.argv.includes('--complete-samples')
const logsOnly = managers || complete || process.argv.includes('--logs')
const anchorsOnly = process.argv.includes('--anchors-only')
const rows = process.argv.slice(2).filter(arg => !arg.startsWith('--')).flatMap(path => readFileSync(path,'utf8').trim().split('\n').map(JSON.parse))
const inventory = new Map(rows.filter(r => r.type === 'inventory' && (!only || only.includes(r.chain))).map(r => [r.chain,r]))
const store = openStore({ file: ':memory:', migrations, profile: 'normal' })
const transport = Object.assign(new EventEmitter(), { publicKey: '1'.repeat(64) })
const engine = new Engine({ bundle: loadBundle(), store, transport, backgroundJobs: [], patches: { patchFeed:false },
  rpcConfig: { retries:1, timeout:8000, requestsPerMinute:30 } })
const print = r => console.log(JSON.stringify(r))
const rand = key => createHash('sha256').update(key).digest().readUInt32BE() / 2**32
async function patient(fn) {
  for (let failures = 0;;) {
    try { return await fn() } catch (error) {
      if (error instanceof RateLimited && error.retryAt < Date.now() + 61_000) {
        await delay(Math.max(100, error.retryAt - Date.now()))
      } else if (++failures === 3 || error instanceof RateLimited) throw error
    }
  }
}

async function measure(c) {
  const source = engine.evm.get(c.chain), chain = source.chain, id = c.chain
  const head = await patient(() => engine.rpc.call(id,'eth_blockNumber'))
  async function read(calls) {
    const values = []
    for (let i = 0; i < calls.length; i += 128)
      values.push(...await patient(() => multiRead(engine.rpc, chain, calls.slice(i,i+128),head)))
    return values
  }

  // Measure USD in direct signed factory pools with a signed stable quote. Use the deepest measured
  // market for each quoted currency. A missing market leaves the candidate unpriced in this survey.
  const available = [...source.quotes.keys()]
  const dollars = available.filter(q => source.usd(q) === 1), quotes = available.filter(q => !dollars.includes(q))
  const probes = []
  for (const quote of anchorsOnly ? available : quotes) for (const stable of dollars) {
    if (quote===stable || dollars.includes(quote) && quote>stable) continue
    const [token0,token1] = [quote,stable].sort()
    const protocols=['v2','v3','pancake-v3','velodrome-v2',...(anchorsOnly ? ['slipstream','solidly-v1'] : [])]
    for (const f of chain.deployments.filter(f => protocols.includes(f.kind))) {
      for (const p of seedProbesFor(source,{dex:f.name,kind:f.kind,token0,token1})) probes.push({...p,quote})
    }
  }
  const resolved = await read(probes.map(p => p.call))
  const pairs = probes.map((p,i) => ({ ...p,pool:address(resolved[i]) })).filter(p => p.pool && p.pool !== ZERO)
  const states = await source.snapshots(pairs,read)
  if (anchorsOnly) {
    const observed = new Map()
    for (const [i,p] of pairs.entries()) if (states[i]?.liquidity>=100)
      observed.set(p.pool,{...p,depth:states[i].liquidity})
    for (const [factory,funded] of Map.groupBy(observed.values(),p=>p.manager))
      print({type:'known-funded',chain:id,factory,above100:funded.length,
        above1k:funded.filter(p=>p.depth>=1000).length,above10k:funded.filter(p=>p.depth>=10000).length})
    return
  }
  const anchors = {}
  const native = engine.registry.assets.get(id + ':native')
  for (const [i,p] of pairs.entries()) {
    const state = states[i]
    if (state?.liquidity >= 1000 && state.liquidity > (anchors[p.quote]?.depth ?? 0)) {
      anchors[p.quote] = { price: p.token0 === p.quote ? state.price : 1/state.price, depth: state.liquidity, pool:p.pool }
    }
  }
  const save = store.writer.prepare('INSERT OR REPLACE INTO prices(asset,price,at,trust) VALUES (?,?,?,?)')
  for (const [q,s] of Object.entries(anchors)) {
    engine.registry.registerToken(id,q,source.metadata(q))
    save.run(id + ':' + q, String(s.price), Date.now(), 'yellow')
    if (source.metadata(q)?.symbol?.toUpperCase() === 'W' + native?.symbol.toUpperCase())
      save.run(id + ':native',String(s.price),Date.now(),'yellow')
  }
  print({type:'anchors',chain:id,head:Number(head),anchors})

  const candidates = []
  const fs = engine.backfill.tasks.filter(t => t.source === source).map(t => t.factory)
  for (const f of fs) {
    const measured = c.factories.find(d => d.address === f.address), count = measured.pairs ?? measured.pools
    if (logsOnly || count == null || !f.array) continue
    const size = Math.min(count, Math.max(24, Math.min(512,Math.ceil(Math.sqrt(count)))))
    const samples = Array.from({length:size},(_,i) => Math.floor((i + rand([id,f.address,i].join('/'))) * count / size))
    const ids = (await read(samples.map(i => ({to:f.address,data:f.array[1] + word(i)})))).map(address)
    if (ids.some(p => !p || p === ZERO)) throw new Error('incomplete factory array')
    const tokens = await read(ids.flatMap(to => [{to,data:'0x0dfe1681'},{to,data:'0xd21220a7'}]))
    for (const [i,pool] of ids.entries()) {
      const token0 = address(tokens[i*2]), token1 = address(tokens[i*2+1])
      candidates.push({ pool, token0, token1, kind:f.kind, manager:f.address, mode:'index' })
    }
  }

  const measured = complete ? [] : rows.filter(r => r.type === (managers ? 'manager-sample' : 'sample') && r.chain === id)
  const samples = new Map(measured.map(r => [r.stratum,managers ? {...r,counts:{[r.factory]:r.count}} : r]))
  const logFactories = fs.filter(f => managers ? f.kind==='v4' : (!f.array ||
    c.factories.find(d => d.address === f.address)?.pairs == null && c.factories.find(d => d.address === f.address)?.pools == null))
  // Pick uniformly from all creation events actually counted for each factory, including dense strata.
  const selected = new Map()
  for (const f of logFactories) {
    const observed = []
    if (complete) {
      const record = rows.find(r=>r.type==='log-total' && r.complete && r.chain===id && r.factory===f.address &&
        r.reads<=3 && r.count>0 && r.count<=6000)
      if (!record) continue
      // Sample the full response where the earlier count finished in <=3 reads. On zkSync
      // this is only the gateway's visible subset, which is preserved separately in the census.
      const r={stratum:0,start:0,end:c.head,counts:{[f.address]:record.count}}
      for (let i=0;i<record.count;i++) observed.push({r,i,score:rand([id,f.address,'full',i].join('/'))})
    }
    for (const r of samples.values()) for (let i=0;i<(r.counts[f.address] ?? 0);i++)
      observed.push({ r,i,score:rand([id,f.address,r.stratum,i].join('/')) })
    for (const {r,i} of observed.sort((a,b)=>a.score-b.score).slice(0,managers || complete ? 96 : 192)) {
      const key = r.stratum + '/' + f.address
      if (!selected.has(key)) selected.set(key,{r,f,indices:[]})
      selected.get(key).indices.push(i)
    }
  }
  async function creationLogs(f,start,end,depth=0) {
    try {
      return await patient(() => engine.rpc.call(id,'eth_getLogs',[{address:f.address,topics:[f.topics],
        fromBlock:hex(start),toBlock:hex(end)}]))
    } catch (e) {
      if (start===end || (complete && depth>=3) || !['range','too-large','timeout'].includes(e.kind) && !e.message?.startsWith('No eligible')) throw e
      const mid = start+Math.floor((end-start)/2)
      return (await creationLogs(f,start,mid,depth+1)).concat(await creationLogs(f,mid+1,end,depth+1))
    }
  }
  for (const {r,f,indices} of selected.values()) {
    try {
      let logs = await creationLogs(f,r.start,r.end)
      if (complete && logs.length!==r.counts[f.address]) {
        logs=[]
        const width=Math.ceil((r.end-r.start+1)/4)
        for (let from=r.start;from<=r.end;from+=width)
          logs.push(...await creationLogs(f,from,Math.min(r.end,from+width-1),2))
      }
      const events = logs.filter(l => !l.removed).sort((a,b) => Number(a.blockNumber)-Number(b.blockNumber)||Number(a.logIndex)-Number(b.logIndex))
      if (events.length !== r.counts[f.address]) throw new Error('expected '+r.counts[f.address]+' creation logs, received '+events.length)
      for (const i of indices) {
        const l = events[i], p = decodeEvent(l,chain.events[l.topics[0]])
        if (p?.type !== 'pool') throw new Error('invalid creation')
        candidates.push({...p,token0:p.token0===ZERO?'native':p.token0,token1:p.token1===ZERO?'native':p.token1,
          kind:f.kind,manager:f.address,mode:'logs'})
      }
    } catch (e) { print({type:'missing-sample',chain:id,factory:f.address,stratum:r.stratum,reason:e.kind ?? e.message}) }
  }
  for (const [factory,batch] of Map.groupBy(candidates,p => p.manager)) {
    const counts = { sample:batch.length, empty:0, unpriced:0, above100:0, above1k:0, above10k:0 }
    const valid = batch.filter(p => p.token0 && p.token1 && p.token0!==ZERO && p.token1!==ZERO && p.token0!==p.token1)
    const decimals = await source.readDecimals(valid,Number(head),read)
    const states = await source.snapshots(valid,read,decimals)
    counts.unpriced = batch.length - valid.length
    for (const s of states) {
      if (s?.empty) counts.empty++
      else if (s?.liquidity == null) counts.unpriced++
      for (const [floor,key] of [[100,'above100'],[1000,'above1k'],[10000,'above10k']]) if (s?.liquidity >= floor) counts[key]++
    }
    print({type:managers?'manager-depth':complete?'full-depth':'depth',chain:id,factory,mode:batch[0].mode,...counts})
  }
}
const all = inventory.values()
await Promise.all(Array.from({length:3},async () => {
  for (const chain of all) {
    try { await measure(chain) } catch (e) { print({type:'unavailable',chain:chain.chain,reason:e.kind ?? e.message}) }
  }
}))
print({type:'end',dispatches:engine.budget.dispatches})
store.close()
