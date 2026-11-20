import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { loadBundle } from '@gator/bundle'
import { createMemoryHub, MemoryTransport } from '@gator/net'
import { openStore } from '@gator/store'
import { Engine, migrations } from '../src/index.js'
import { RateLimited } from '../src/scheduler/index.js'
import { address, word } from '../src/sources/evm-abi.js'
import { historyRanges } from '../src/coverage/factory-history.js'

const fixture = JSON.parse(readFileSync(new URL('fixtures/factory-history.json',import.meta.url)))
const token = address(fixture.ethereum[0].logs[0].topics[3])
const reporter = '1'.repeat(64)
const at = Math.max(...fixture.ethereum.map(group => Number(group.head.timestamp))) * 1000

// Real 2026-11-20 reads. The replay can regroup the recorded subcalls into other aggregate3 pages.
// Each block fixture includes every signed manager creation at that block.
function replay(failAt = -1) {
  let group = fixture.ethereum[0]
  const calls = []
  const ledger = { ...fixture.metadata, ...fixture.polygon.calls, ...fixture.ethereumV2.calls, ...Object.assign({}, ...fixture.ethereum.map(v => v.calls)) }
  const rpc = { calls, setGroup(g) { group = g },
    async call(chain, method, params) {
      calls.push({chain,method,params})
      if (calls.length === failAt) throw new RateLimited(at + 1)
      if (method === 'eth_getBlockByNumber') {
        if (params[0] === 'latest') return group.head
        return Object.values(fixture.legacy).find(r => r.header.number === params[0])?.header ?? assert.fail('unknown block')
      }
      if (method === 'eth_getLogs') {
        assert.equal(params[0].address, group.logs[0].address)
        const log = group.logs[0]
        if (group.index != null) {
          assert.deepEqual(params[0].topics, [[log.topics[0]], ...log.topics.slice(1,3)])
          assert.ok(Number(params[0].fromBlock) <= group.block && Number(params[0].toBlock) >= group.block)
        } else {
          assert.deepEqual(params[0].topics, [[log.topics[0]]])
          assert.equal(Number(params[0].fromBlock), group.block)
          assert.equal(Number(params[0].toBlock), group.block)
        }
        return group.logs
      }
      if (method === 'eth_getTransactionReceipt') return fixture.legacy[params[0]]?.receipt ?? assert.fail('unknown tx')
      if (method !== 'eth_call') assert.fail(method)
      if (params[0].data === '0x574f2ba3' && params[0].to === group.logs?.[0].address) {
        assert.ok(Object.hasOwn(group.lengths,params[1]))
        return group.lengths[params[1]]
      }
      const args = params[0].data.slice(10)
      assert.ok(params[0].data.startsWith('0x82ad56cb'))
      const n = offset => Number(BigInt('0x' + args.slice(offset,offset+64)))
      const count = n(64), offsets = [], tuples = []
      let offset = count * 32
      for (let i=0;i<count;i++) {
        const pos = 128 + n(128 + 64*i)*2, target = '0x' + args.slice(pos+24,pos+64)
        const data = '0x' + args.slice(pos+256,pos+256+n(pos+192)*2)
        const key = target + '/' + data
        assert.ok(Object.hasOwn(ledger,key),key)
        const value = ledger[key]?.slice(2) ?? ''
        offsets.push(word(offset))
        const tuple = word(Number(ledger[key] != null)) + word(64) + word(value.length/2) + value
        tuples.push(tuple)
        offset += tuple.length/2
      }
      return '0x' + word(32) + word(count) + offsets.join('') + tuples.join('')
    } }
  return rpc
}

async function node(t, { Legacy = Engine, schema = migrations, bundle = loadBundle(), own = reporter,
  wire, storage = openStore, file = ':memory:' } = {}) {
  let now = at
  const sent = [], channels = new Set()
  const transport = wire ?? Object.assign(new EventEmitter(), { publicKey:own, channels:()=>[...channels], peerCount:()=>1,
    join:async ch=>{channels.add(ch);return true}, leave:async ch=>channels.delete(ch),
    send:()=>true })
  const send = transport.send.bind(transport)
  transport.send = (channel,message) => {
    sent.push({channel,from:transport.publicKey,ts:now,message})
    return send(channel,message)
  }
  const store = storage({ file, profile:'normal', migrations:schema })
  const engine = new Legacy({ store,transport,bundle,backgroundJobs:[],clock:()=>now,
    patches:{patchFeed:false},rpcConfig:{fetch:()=>assert.fail('external fetch')} })
  let closed = false
  async function stop() {
    if (closed) return
    closed = true
    await engine.stop()
    store.close()
  }
  t.after(stop)
  await engine.start()
  clearTimeout(engine.timer)
  store.writer.prepare("INSERT OR REPLACE INTO prices(asset,price,at,trust) VALUES ('ethereum:native',?,?,?)")
    .run('1749.488105598267',now,'yellow')
  return {engine,store,sent,advance:ms=>{now+=ms},stop}
}

async function discover(t, options) {
  const sender = await node(t,options), {engine,store} = sender, history = engine.backfill
  const task = history.tasks.find(t=>t.factory.kind==='v4' && t.source.chain.id==='ethereum')
  task.bounds = {mode:'logs'}
  history.rpc = replay(3)
  for (const group of fixture.ethereum) {
    history.rpc.setGroup(group)
    const range = {start:group.block,end:group.block+1,next:group.block,after:-1,span:1}
    if (group===fixture.ethereum[0]) {
      await assert.rejects(history.page(task,range),RateLimited)
      assert.equal(range.next,group.block)
      assert.equal(history.progress.all('ethereum',task.factory.address,'logs').length,0)
    }
    const page = await history.page(task,range)
    assert.equal(page.admitted,1)
    assert.equal(range.next,group.block+1)
  }
  assert.equal(history.rpc.calls.filter(c=>c.method==='eth_getLogs').length,2)
  assert.equal(history.count.get().n,2)
  assert.equal(engine.registry.seedIds.has('ethereum:'+token),false)
  assert.equal(engine.names.factoryDue(),true)
  await engine.names.readFactory(history.rpc)
  assert.equal(engine.names.display('ethereum:'+token).nameSource,'on-chain')
  assert.equal(engine.names.display('ethereum:'+token).symbol,'dmt-nat')
  const amounts = store.reader.prepare("SELECT liquidity FROM pools WHERE chain='ethereum' ORDER BY liquidity").all()
  assert.ok(amounts[0].liquidity > 390 && amounts[0].liquidity < 415)
  assert.ok(amounts[1].liquidity > 2400 && amounts[1].liquidity < 2500)
  for (let i=0;i<2;i++) {
    await history.shareStep(history.sendRow.get(engine.clock()))
    if (i===0) {
      const second = history.sendRow.get(engine.clock())
      await history.shareStep(second)
      assert.equal(sender.sent.filter(f=>f.channel==='gator/new').length,1)
      sender.advance(60_001)
    }
  }
  assert.equal(sender.sent.filter(f=>f.channel==='gator/new').length,2)
  return sender
}

async function enumeratePair(sender) {
  const {engine} = sender, h = engine.backfill, g = fixture.ethereumV2
  const task = h.tasks.find(t => t.source.chain.id==='ethereum' && t.factory.name==='uniswap-v2')
  task.bounds = {mode:'index'}
  h.rpc.setGroup(g)
  const cursor = {start:g.index,next:g.index,end:g.index+1,after:-1,span:1}
  const page = await h.page(task,cursor)
  assert.equal(page.admitted,1)
  assert.equal(page.pools[0].tx,undefined)
  sender.advance(60_001)
  const before = sender.sent.filter(f=>f.channel==='gator/new').length
  for (let i=0; i<16; i++) {
    const row = h.sendRow.get(engine.clock())
    if (!row) break
    await h.shareStep(row)
  }
  assert.equal(sender.sent.filter(f=>f.channel==='gator/new').length,before+1)
  assert.equal(sender.sent.filter(f=>f.channel==='gator/new').at(-1).message.tx,g.logs[0].transactionHash)
}

async function receive(receiver, sender) {
  const {engine} = receiver, rpc = replay()
  engine.hints.rpc = rpc
  for (const frame of sender.sent) {
    if (frame.channel==='gator/new' || frame.channel.startsWith('gator/px/'))
      engine.transport.emit('message',frame.channel,frame)
  }
  assert.equal(engine.hints.size,sender.sent.filter(f=>f.channel==='gator/new').length)
  while (engine.hints.size) await engine.verifyHint()
  return rpc
}

test('backfill alone resolves both DMT-NAT markets; a cold receiver verifies and keeps pricing their funded state', async t => {
  const a = await discover(t), b = await node(t,{own:'2'.repeat(64)})
  const rpc = await receive(b,a)
  assert.equal(b.engine.names.factoryDue(),true)
  await b.engine.names.readFactory(rpc)
  const name = b.store.reader.prepare('SELECT publicOnly,publishAt,symbol FROM engine_names WHERE asset=?').get('ethereum:'+token)
  assert.deepEqual({...name},{publicOnly:1,publishAt:null,symbol:'dmt-nat'})
  b.advance(60_001)
  assert.equal(await b.engine.announcedPools.measure('ethereum',rpc),2)
  for (const g of fixture.ethereum) {
    const id='dex:ethereum:'+g.logs[0].topics[1]
    assert.equal(b.engine.registry.markets.get(id).fromHint,1)
    assert.ok(b.store.reader.prepare('SELECT liquidity FROM pools WHERE pool=?').get(g.logs[0].topics[1]).liquidity>100)
    assert.ok(b.store.reader.prepare('SELECT 1 FROM engine_latest WHERE market=? AND reporter=?').get(id,b.engine.transport.publicKey))
  }
  b.advance(90_001)
  assert.equal(await b.engine.announcedPools.measure('ethereum',rpc),2)
  assert.equal(b.engine.hints.penalties.size,0)
  // A proven peer reporting the exact record suppresses the sender's pending repeat.
  const history=a.engine.backfill, record=a.sent.find(f=>f.channel==='gator/new').message
  a.advance(86_400_001)
  a.engine.book.isProven=()=>true
  history.heard(record,b.engine.transport.publicKey)
  const matching=a.store.reader.prepare('SELECT p.*,h.factory FROM pools p JOIN engine_history_pools h USING(chain,pool) WHERE p.pool=?').get(record.pool)
  const before=a.sent.length
  await history.shareStep(matching)
  assert.equal(a.sent.length,before)
})

test('real Polygon allPairs indices and subcalls are batched and below-floor identities never enter the registry', async t => {
  const {engine,store}=await node(t), h=engine.backfill, g=fixture.polygon
  const task=h.tasks.find(t=>t.source.chain.id==='polygon' && t.factory.name==='uniswap-v2')
  task.bounds={mode:'index'}
  h.rpc=replay()
  h.rpc.setGroup(g)
  const range={start:g.start,next:g.start,end:g.start+2,after:-1,span:1}
  const page=await h.page(task,range)
  assert.deepEqual(page.pools.map(p=>p.pool),g.pools)
  assert.equal(page.admitted,0)
  assert.equal(h.rpc.calls.filter(c=>c.method==='eth_call').length,4)
  assert.equal(h.progress.all('polygon',task.factory.address,'index')[0].next,range.end)
  for (const p of g.pools) assert.equal(engine.registry.markets.has('dex:polygon:'+p),false)
  assert.equal(store.reader.prepare('SELECT count(*) AS n FROM engine_history_pools').get().n,0)
})

test('archived ae1c336 verifies every emitted pool record with unchanged standing and no strikes, mutes or hint penalties', async t => {
  let dir=process.env.GATOR_V010_DIR
  if (!dir) {
    try { execFileSync('git',['cat-file','-e','ae1c336^{commit}'],{stdio:'ignore',cwd:import.meta.dirname}) }
    catch { return t.skip('archived v0.1.0 object absent') }
    dir=mkdtempSync(join(import.meta.dirname,'factory-v010-'))
    t.after(()=>rmSync(dir,{recursive:true,force:true}))
    const packages = ['engine','bundle','store','net','social']
    const archive=execFileSync('git',['archive','ae1c336','packages/bundle','packages/net/vendor',
      ...packages.flatMap(p=>['packages/'+p+'/package.json','packages/'+p+'/src'])],
      {cwd:join(import.meta.dirname,'../../..'),maxBuffer:32<<20})
    execFileSync('tar',['-xf','-','-C',dir],{input:archive})
    const scope = join(dir,'node_modules','@gator')
    mkdirSync(scope,{recursive:true})
    for (const p of packages) symlinkSync(join(dir,'packages',p),join(scope,p),'dir')
  }
  const load=path=>import(pathToFileURL(join(dir,'packages',path)))
  const old=await load('engine/src/index.js'), bundle=(await load('bundle/src/index.js')).loadBundle()
  const legacyNet=await load('net/src/memory.js'), legacyStore=await load('store/src/index.js')
  const hub=createMemoryHub(), senderWire=new MemoryTransport({hub}), oldWire=new legacyNet.MemoryTransport({hub})
  t.after(()=>Promise.all([senderWire.close(),oldWire.close()]))
  const b=await node(t,{Legacy:old.Engine,schema:old.migrations,bundle,wire:oldWire,storage:legacyStore.openStore})
  const signer=senderWire.publicKey, rank=b.engine.hints.rank(signer), arrived=[]
  oldWire.on('message',(ch,env)=>{if(ch==='gator/new' && env.from===signer) arrived.push(env)})
  const a=await discover(t,{wire:senderWire})
  await enumeratePair(a)
  const limit=Date.now()+5000
  while (arrived.length<3 && Date.now()<limit) await delay(20)
  assert.deepEqual(arrived.map(e=>e.message),a.sent.filter(f=>f.channel==='gator/new').map(f=>f.message))
  assert.ok(arrived.every(e=>e.pow.difficulty===16))
  assert.equal(b.engine.hints.size,3)
  b.engine.hints.rpc=replay()
  while (b.engine.hints.size) await b.engine.verifyHint()
  for (const {message} of arrived) assert.ok(b.engine.registry.markets.has('dex:ethereum:'+message.pool))
  assert.equal(b.engine.hints.rank(signer),rank)
  assert.equal(b.engine.hints.penalties.size,0)
  assert.equal(b.engine.book.muted(signer),false)
  assert.equal(b.store.getReporter(signer)?.strikes ?? 0,0)
  await a.stop()
  await b.stop()
})

test('row pressure keeps the first unregistered creation as the restart point; an old hint at capacity is inconclusive', async t => {
  const sender = await node(t), {engine} = sender, h = engine.backfill
  engine.transport.peerCount=()=>0
  const task = h.tasks.find(t => t.factory.kind === 'v4' && t.source.chain.id === 'ethereum')
  task.bounds = { mode:'logs' }
  h.rpc = replay()
  const g = fixture.ethereum[0], r = { start:g.block, next:g.block, end:g.block+1, after:-1, span:1 }
  h.rpc.setGroup(g)
  h.capacity = 0
  await h.page(task,r)
  assert.equal(r.next, g.block)
  assert.equal(h.count.get().n, 0)
  assert.equal(engine.registry.assets.has('ethereum:'+token), false)
  h.capacity = 2
  await h.page(task,r)
  assert.equal(r.next, g.block+1)
  assert.equal(h.count.get().n, 1)
  const receiver = await node(t,{own:'2'.repeat(64)})
  receiver.engine.backfill.capacity = 1
  assert.equal(h.nextRow(at),null)
  engine.transport.peerCount=()=>1
  await h.shareStep(h.sendRow.get(at))
  const frame = sender.sent.find(f => f.channel === 'gator/new')
  receiver.engine.hints.rpc = replay()
  receiver.engine.transport.emit('message','gator/new',frame)
  await receiver.engine.verifyHint()
  assert.equal(receiver.engine.hints.penalties.size, 0)
  assert.equal(receiver.engine.registry.markets.has('dex:ethereum:'+frame.message.pool),false)
  assert.equal(receiver.sent.filter(f=>f.channel==='gator/new').length,0)
})

test('an announced-pool tie keeps 64 deterministic slots and a locally promoted pool leaves the queue', async t => {
  const {engine,store} = await node(t), source = engine.evm.get('ethereum')
  const group = fixture.ethereumV2, chain = 'ethereum', now = engine.clock()
  const token0 = address(group.logs[0].topics[1]), token1 = address(group.logs[0].topics[2])
  const pools = Array.from({length:65},(_,i)=>({
    chain,kind:'v2',dex:'uniswap-v2',pool:'0x'+(i+1).toString(16).padStart(40,'0'),token0,token1,firstSeen:now,
  }))
  source.snapshots = async candidates=>candidates.map(()=>({liquidity:110,price:1}))
  for (const p of pools.toReversed()) {
    engine.registry.pool(p,{},true)
    engine.emit('discovery',{...p,t:'pool',v:1},now,true)
  }
  for (let i=0;i<5;i++) await engine.announcedPools.measure(chain)
  const select = store.reader.prepare('SELECT pool FROM engine_announced_pools WHERE belowSince IS NULL ORDER BY pool')
  assert.deepEqual(select.all().map(r=>r.pool),pools.slice(0,64).map(p=>p.pool))
  engine.registry.pool(pools[0])
  store.writer.prepare('UPDATE engine_announced_pools SET checkAt=? WHERE pool=?').run(now,pools[0].pool)
  await engine.announcedPools.measure(chain)
  assert.equal(select.all().some(r=>r.pool===pools[0].pool),false)
})

test('a full connected reader resumes its bounded forwarding queue on disk and another node registers the pool', async t => {
  const dir = mkdtempSync(join(import.meta.dirname,'history-restart-'))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const file = join(dir,'history.db'), a = await node(t,{file}), h = a.engine.backfill
  const select = reader=>reader.tasks.find(t=>t.source.chain.id==='ethereum' && t.factory.kind==='v4')
  const task = select(h), [first,second] = fixture.ethereum
  task.bounds = {mode:'logs',end:second.block+1,at}
  a.store.setSetting(task.key,task.bounds)
  a.engine.transport.peerCount = ()=>1
  h.capacity=0
  h.forwardCapacity=1
  h.rpc=replay()
  const unit = block=>historyRanges('ethereum',task.factory.address,'logs',task.bounds.end)
    .find(r=>r.start<=block && block<r.end)
  for (const group of [first,second]) {
    h.rpc.setGroup(group)
    const range = {...unit(group.block),next:group.block,end:group.block+1,after:-1,span:1}
    await h.page(task,range)
    assert.equal(range.next,group.block+Number(group===first))
  }
  assert.equal(h.forwardCount.get().n,1)
  assert.equal(h.count.get().n,0)
  await a.stop()
  const resumed=await node(t,{file}), saved=resumed.engine.backfill
  resumed.engine.transport.peerCount=()=>0
  assert.deepEqual(select(saved).bounds,task.bounds)
  const progress=saved.progress.all('ethereum',task.factory.address,'logs')
  assert.ok(progress.some(r=>r.start===unit(second.block).start && r.next===second.block))
  assert.equal(saved.forwardCount.get().n,1)
  saved.rpc=replay()
  await saved.shareStep(saved.forwardRow.get(at))
  assert.equal(saved.forwardCount.get().n,1)
  assert.equal(resumed.sent.filter(m=>m.channel==='gator/new').length,0)
  resumed.advance(60_001)
  resumed.engine.transport.peerCount=()=>1
  await saved.shareStep(saved.forwardRow.get(resumed.engine.clock()))
  assert.equal(saved.forwardCount.get().n,0)
  assert.equal(resumed.engine.registry.assets.has('ethereum:'+token),false)
  assert.ok(resumed.store.getSetting('engine-history/next-send')>resumed.engine.clock())
  const receiver=await node(t,{own:'2'.repeat(64)})
  await receive(receiver,resumed)
  assert.ok(receiver.engine.registry.markets.has('dex:ethereum:'+first.logs[0].topics[1]))
})

test('a one-request-per-minute user limit can complete a historical page over successive 20-minute turns', async t => {
  const n=await node(t), h=n.engine.backfill, g=fixture.ethereum[1], fixtureRpc=replay()
  n.engine.budget.setLimit(1)
  const task=h.tasks.find(t=>t.source.chain.id==='ethereum' && t.factory.kind==='v4')
  task.bounds={mode:'logs'}
  fixtureRpc.setGroup(g)
  let available
  h.rpc={call(...args) {
    if (!available) throw new RateLimited(n.engine.clock()+20*60_000)
    available=false
    return fixtureRpc.call(...args)
  }}
  const range={start:g.block,next:g.block,end:g.block+1,after:-1,span:1}
  for (let i=0;i<8 && range.next<range.end;i++) {
    available=true
    try { await h.page(task,range) }
    catch(e) { assert.ok(e instanceof RateLimited); n.advance(20*60_000) }
  }
  assert.equal(range.next,range.end)
  assert.equal(fixtureRpc.calls.filter(r=>r.method==='eth_getLogs').length,1)
  assert.equal(h.count.get().n,1)
})

test('a misleading archive length cannot permanently hide the creation of a funded indexed pool', async t => {
  const n=await node(t), h=n.engine.backfill, g=fixture.ethereumV2, actual=replay()
  const task=h.tasks.find(t=>t.source.chain.id==='ethereum' && t.factory.name==='uniswap-v2')
  task.bounds={mode:'index'}
  actual.setGroup(g)
  let emptyWindows=0
  h.rpc={call(chain,method,params) {
    if (method==='eth_call' && params[0].data==='0x574f2ba3') return '0x'+word(0)
    if (method==='eth_getLogs' && (Number(params[0].fromBlock)>g.block || Number(params[0].toBlock)<g.block)) {
      emptyWindows++
      return []
    }
    return actual.call(chain,method,params)
  }}
  await h.page(task,{start:g.index,next:g.index,end:g.index+1,after:-1,span:1})
  for (let i=0;i<200;i++) {
    const row=h.nextRow(n.engine.clock())
    if (!row) break
    await h.shareStep(row)
  }
  assert.ok(emptyWindows>1)
  const sent=n.sent.filter(f=>f.channel==='gator/new')
  assert.equal(sent.length,1)
  assert.equal(sent[0].message.tx,g.logs[0].transactionHash)
})
