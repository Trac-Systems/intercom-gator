import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadBundle } from '@gator/bundle'
import { openStore } from '@gator/store'
import { Engine, migrations } from '../src/index.js'
import { migrations as intelMigrations, createIntel } from '../src/intel/index.js'
import { RateLimited } from '../src/scheduler/index.js'
import { CETUS, HYPERION, STABLES, SUI } from '../src/sources/move/identity.js'
import { suiState } from '../src/sources/move/sui.js'
import { aptosCreations } from '../src/sources/move/aptos.js'

const fixture = name => JSON.parse(readFileSync(new URL('./fixtures/move/' + name + '.json', import.meta.url)))
const sui = fixture('sui-pools'), creations = fixture('sui-events'), trades = fixture('sui-swaps')
const apt = fixture('aptos-pools'), creation = fixture('aptos-creation'), trade = fixture('aptos-swap')
const bundle = loadBundle(), day = 86400_000, start = 1795137840000
const chainId = '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S'
const db = () => openStore({ file:':memory:', migrations:[...migrations,...intelMigrations] })

class Transport extends EventEmitter {
  publicKey = 'a'.repeat(64)
  sent = []
  channels() { return [] }
  join() { return true }
  leave() { return true }
  send(channel,message) { this.sent.push({channel,message}); return true }
}

async function node(t, chain, store, serve) {
  const transport = new Transport(), calls = [], ctx = { now:start,transport,calls }
  const engine = new Engine({store,transport,bundle,clock:()=>ctx.now,random:7,backgroundJobs:[chain+':pools'],
    patches:{patchFeed:false,snapshot:false},
    rpcConfig:{fetch:async (url,init)=>{
      const u=new URL(url), body=init.body ? JSON.parse(init.body) : null
      calls.push({u,body})
      const result = await serve(u,body,ctx)
      if (result instanceof Response) return result
      if (chain==='sui') return Response.json({data:{chainIdentifier:chainId,checkpoint:{timestamp:new Date(ctx.now).toISOString(),sequenceNumber:347112000},...result}})
      return Response.json(result,{headers:{'x-aptos-chain-id':'1','x-aptos-ledger-timestampusec':String(ctx.now*1000),'x-aptos-ledger-version':'8132619868'}})
    }}})
  const intel=createIntel({engine,dailyMarket:()=>[],sampleGlobal(){}})
  await engine.start()
  clearTimeout(engine.timer)
  await intel.start()
  store.writer.prepare('INSERT OR REPLACE INTO engine_references VALUES (?,?,?,?)').run(chain+':'+STABLES[chain][0],'fixture',1,ctx.now)
  engine.book.dirty=true
  engine.book.refresh()
  let stopped=false
  const stop=async()=>{ if(!stopped){stopped=true;await intel.stop();await engine.stop()} }
  t.after(stop)
  return Object.assign(ctx,{engine,intel,source:engine.move.get(chain),stop,async run(fn){
    for(let i=0;i<12;i++)try{return await fn()}catch(e){if(!(e instanceof RateLimited))throw e;ctx.now=Math.max(ctx.now,e.retryAt)}
    assert.fail('did not finish the budgeted read')
  }})
}

function suiServe(u, body) {
  assert.equal(u.origin,'https://graphql.mainnet.sui.io')
  const {query:q,variables:v}=body
  if(q.includes(':object(address:'))return Object.fromEntries(Object.values(v).map((id,i)=>['p'+i,sui.find(r=>r.object.address===id)?.object??null]))
  if(q.includes(':coinMetadata('))return Object.fromEntries(Object.values(v).map((type,i)=>['m'+i,sui[1].metadata[type]??null]))
  if(q.includes('transaction(digest:'))return {transaction:sui.find(r=>r.tx.digest===v.tx)?.tx??null}
  if(q.includes(':objectVersions('))return Object.fromEntries(Object.values(v).map((id,i)=>['p'+i,{nodes:[{previousTransaction:sui.find(r=>r.object.address===id)?.tx}]}]))
  if(v.type===CETUS+'::pool::SwapEvent')return {events:{nodes:trades}}
  assert.fail('unexpected GraphQL operation '+q)
}
const hintFor = (r,dex='cetus')=>{
  const {pool,token0,token1,kind}=suiState(dex,r.object.address,r.object)
  return {t:'pool',v:1,chain:'sui',dex,pool,token0,token1,kind,tx:r.tx.digest,block:r.tx.effects.checkpoint.sequenceNumber}
}
test('scheduled Sui swaps and funded objects publish the right base turnover and only receipt-backed creation hints',async t=>{
  const store=db(), n=await node(t,'sui',store,suiServe)
  try{
    assert.equal(await n.engine.step(),'sui:pools')
    const p=hintFor(sui[0]), source=n.source
    await n.run(()=>source.state())
    n.engine.book.refresh()
    const market=n.engine.registry.known('dex:sui:'+p.pool)
    assert.equal(market.base,'sui:native')
    assert.ok(Math.abs(Number(store.getPrice('sui:native').price)-0.713)<0.003)
    assert.ok(source.known(p.pool).liquidity>400000)
    assert.equal(n.transport.sent.some(e=>e.channel==='gator/new'),false)
    const rows=n.transport.sent.flatMap(e=>e.message.o??[])
    const raw=trades.reduce((v,n)=>v+Number(n.contents.json.atob?n.contents.json.amount_out:n.contents.json.amount_in),0)
    assert.equal(Number(rows.find(r=>r[0]===market.id)[2]),raw/1e9)
    n.now+=60000
    await source.reader.swaps('cetus')
    assert.equal(store.reader.prepare('SELECT count(*) AS n FROM engine_move_swaps').get().n,3)
    await n.run(()=>source.reader.origins())
    await n.run(()=>source.state())
    assert.deepEqual(n.transport.sent.find(e=>e.channel==='gator/new')?.message,p)
    n.now+=day+1
    await n.run(()=>source.state())
    assert.equal(n.transport.sent.flatMap(e=>e.message.o??[]).at(-1)[2],'0')
  }finally{await n.stop();store.close()}
})

test('Sui recent and history pages resume after restart without losing or duplicating candidates',async t=>{
  const store=db(), key='cetus/events', pages=[], page=(nodes,options={})=>({events:{nodes,pageInfo:{hasNextPage:false,hasPreviousPage:false,...options}}})
  const serve=(u,b)=>{pages.push(b.variables);return page([creations[0]],{hasPreviousPage:true,startCursor:'older'})}
  const first=await node(t,'sui',store,serve)
  await first.source.reader.events('cetus')
  assert.equal(first.source.cursor(key).before,'older')
  await first.stop()
  const n=await node(t,'sui',store,(u,b)=>{
    pages.push(b.variables)
    if(b.variables.cursor==='older')return page([creations[1]])
    if(b.variables.cursor==='next')return page([creations[0],creations[2]])
    return page([creations[0]],{hasNextPage:true,endCursor:'next'})
  })
  try{
    n.now+=4*60000
    await n.run(()=>n.source.reader.events('cetus',true))
    assert.equal(pages.at(-1).cursor,'older')
    await n.run(()=>n.source.reader.events('cetus'))
    assert.equal(n.source.cursor(key).after,'next')
    await n.run(()=>n.source.reader.events('cetus'))
    assert.equal(pages.at(-1).cursor,'next')
    assert.equal(n.source.cursor(key).after,null)
    assert.equal(n.source.backlog(),3)
    assert.equal(n.source.candidate(creations[2].contents.json.pool_id).tx,creations[2].transaction.digest)
    const saved=n.source.cursor(key)
    n.engine.store.transaction=()=>{throw new Error('failed transaction')}
    n.now+=4*60000
    await assert.rejects(n.run(()=>n.source.reader.events('cetus')),/failed transaction/)
    assert.deepEqual(n.source.cursor(key),saved)
  }finally{await n.stop();store.close()}
})

test('new Sui receiver checks the creation transaction and typed funded pool before registering and pricing BUCK',async t=>{
  const store=db(), n=await node(t,'sui',store,suiServe)
  const who='b'.repeat(64), hint=hintFor(sui[1]), token='sui:'+hint.token0
  try{
    store.writer.prepare('INSERT OR REPLACE INTO engine_references VALUES (?,?,?,?)').run('sui:native','fixture',0.713,n.now)
    n.engine.book.dirty=true;n.engine.book.refresh()
    const rank=n.engine.hints.rank(who)
    const send=h=>n.transport.emit('message','gator/new',{channel:'gator/new',message:h,from:who,ts:n.now})
    send({...hint,token0:hint.token0.replace('::BUCK','::Buck')})
    assert.equal(n.intel.newTokens.list().length,0)
    await n.run(()=>n.engine.verifyHint())
    assert.ok(n.engine.hints.rank(who)<rank)
    assert.equal(n.engine.registry.assets.has(token),false)
    send(hint)
    await n.run(()=>n.engine.verifyHint())
    n.engine.book.refresh()
    assert.equal(n.engine.registry.assets.get(token).symbol,'BUCK')
    assert.ok(Number(store.getPrice(token).price)>0.9)
    assert.ok(n.intel.newTokens.list().some(r=>r.asset===token && r.liquidityUsd>10000))
    assert.equal(n.engine.registry.known('dex:sui:'+hint.pool).fromHint,1)
    assert.equal(n.transport.sent.some(e=>e.channel==='gator/new'),false)
    assert.ok(n.calls.some(c=>c.body?.query?.includes('transaction(digest:')))
    assert.ok(n.calls.some(c=>c.body?.query?.includes(':object(address:')))
    assert.ok(n.calls.some(c=>c.body?.query?.includes('coinMetadata')))
  }finally{await n.stop();store.close()}
})

test('Aptos factory paging resumes; fresh reserves and a pinned resource price APT and the discovered amAPT',async t=>{
  const store=db(), key='hyperion/factory'
  let lastOffset
  const serve=(u,b)=>{
    assert.equal(u.origin,'https://api.mainnet.aptoslabs.com')
    if(b?.function?.endsWith('all_pools_with_info')){
      const [off,count]=b.arguments.map(Number)
      if(count===1)return apt.find(r=>r.slot===off).page
      lastOffset=off
      if(off===2)return [[apt[0].page[0][0]],{offset:'2',take:'1',total:'3',limit:'20'}]
      return [[apt[1].page[0][0]],{offset:String(off),take:'1',total:String(off+1),limit:'20'}]
    }
    const path=decodeURIComponent(u.pathname)
    const p=apt.find(r=>path.includes(r.page[0][0].pool.inner))
    if(p){assert.ok(u.searchParams.get('ledger_version'));return p.resource}
    if(path.endsWith('::fungible_asset::Metadata'))return apt[1].metadata
    assert.fail('unexpected Aptos route '+path)
  }
  const first=await node(t,'aptos',store,serve)
  first.source.saveCursor(key,{offset:2})
  assert.equal(await first.engine.step(),'aptos:pools')
  assert.equal(lastOffset,2)
  const saved=first.source.cursor(key)
  await first.stop()
  const n=await node(t,'aptos',store,serve)
  try{
    assert.deepEqual(n.source.cursor(key),saved)
    await n.run(()=>n.source.state())
    n.engine.book.refresh()
    assert.ok(Math.abs(Number(store.getPrice('aptos:native').price)-0.407)<0.002)
    n.source.saveCursor(key,{offset:4})
    await n.run(()=>n.source.reader.inventory('hyperion'))
    assert.equal(lastOffset,4)
    const token='aptos:'+apt[1].page[0][0].token_b.inner
    await n.run(()=>n.source.state())
    n.engine.book.refresh()
    assert.equal(n.engine.registry.assets.get(token).symbol,'amAPT')
    assert.ok(Math.abs(Number(store.getPrice(token).price)-0.407)<0.003)
    assert.ok(n.intel.newTokens.list().some(r=>r.asset===token))
    assert.ok(n.transport.sent.some(r=>r.channel.startsWith('gator/px/')))
    assert.equal(n.transport.sent.some(r=>r.channel==='gator/new'),false)
  }finally{await n.stop();store.close()}
})

test('Aptos validates the requested hash, block interval and typed creation, and treats pruned history as inconclusive',async t=>{
  const store=db(), hint={...aptosCreations(creation.tx)[0],block:Number(creation.block.block_height)}
  let pruned=false
  const n=await node(t,'aptos',store,(u,b)=>{
    if(u.pathname.includes('/transactions/by_hash/'))return pruned?new Response('',{status:410}):creation.tx
    if(u.pathname.includes('/blocks/by_version/'))return creation.block
    if(b?.function?.endsWith('get_pool_info'))return creation.state
    throw new Error('unexpected route')
  })
  try{
    for(const [h,result] of [[hint,true],[{...hint,block:hint.block+1},false],[{...hint,token1:'0xa'},false]]){
      const cache=new Map()
      const r=await n.run(()=>n.source.reader.receipt(h,cache))
      assert.equal(!!r,result)
    }
    const cache=new Map()
    assert.equal(await n.run(()=>n.source.verify({...hint,reporter:'b'.repeat(64)},cache)),true)
    assert.equal(n.source.known(hint.pool),undefined) // No supported USD route at this node.
    pruned=true
    assert.equal(await n.run(()=>n.source.reader.receipt(hint,new Map())),null)
  }finally{await n.stop();store.close()}
})

test('a targeted Aptos transaction contributes only the matching pool and deduplicates its swap',async t=>{
  const store=db(), n=await node(t,'aptos',store,(u,b)=>{
    if(b?.query)return {data:{p0:[trade.accountTransaction]}}
    return trade.tx
  })
  try{
    const s=n.source,p=apt[0].page[0][0],pool=p.pool.inner
    s.remember({pool,dex:'hyperion',kind:'clmm',token0:p.token_a.inner,token1:p.token_b.inner,firstSeen:n.now})
    store.writer.prepare("UPDATE engine_move_candidates SET funded=1 WHERE pool=?").run(pool)
    for(let i=0;i<2;i++){
      n.now+=60000
      await n.run(()=>s.reader.recent())
      await n.run(()=>s.reader.recent())
    }
    const rows=store.reader.prepare('SELECT * FROM engine_move_swaps').all()
    assert.equal(rows.length,1)
    assert.equal(rows[0].pool,pool)
    assert.equal(rows[0].a,Number(trade.tx.events[0].data.amount_out))
    assert.equal(rows[0].b,Number(trade.tx.events[0].data.amount_in))
  }finally{await n.stop();store.close()}
})
