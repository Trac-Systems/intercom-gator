import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { EndpointBucket, RateLimited, RequestBudget } from '../src/scheduler/index.js'
import { HttpSources } from '../src/sources/http.js'
import { MoveClient } from '../src/sources/move/client.js'
import { CETUS, SUI, assetAddress, digest, fa, metadata, moveType, rawRatio, validPool } from '../src/sources/move/identity.js'
import { suiState } from '../src/sources/move/sui.js'
import { aptosCreations, thalaRatio } from '../src/sources/move/aptos.js'

const fixture = name => JSON.parse(readFileSync(new URL('./fixtures/move/' + name + '.json', import.meta.url)))
const sui = fixture('sui-pools'), aptos = fixture('aptos-pools'), aptCreation = fixture('aptos-creation')

test('Move identities preserve type case and unify framework native spellings', () => {
  assert.equal(moveType('0'.repeat(63) + '2::sui::SUI'), SUI)
  assert.equal(assetAddress('sui', SUI), 'native')
  assert.equal(assetAddress('aptos', fa('0x' + 'a'.padStart(64, '0'))), 'native')
  assert.equal(assetAddress('aptos', '0x1::aptos_coin::AptosCoin'), 'native')
  assert.equal(moveType('0x2::sui::Sui'), '0x2::sui::Sui')
  assert.equal(moveType('0x2::sui::SUI<T>'), null)
  assert.equal(digest('1'.repeat(44)), false)
  assert.equal(digest(sui[0].tx.digest), true)
  assert.deepEqual(metadata({ name: ' A\u200bB ', symbol: ' Q\n', decimals: 0 }, 'id'), { name: 'AB',symbol:'Q',decimals:0 })
  assert.equal(metadata({ name:'<img>', symbol:'', decimals:6 }), null)
  assert.equal(metadata({ name:'Coin', symbol:'C', decimals:78 }), null)
})

test('mainnet Cetus and Turbos objects require the deployed Move type and yield SUI/USDC', () => {
  for (const [i, dex] of [[0,'cetus'],[2,'turbos']]) {
    const obj = sui[i].object
    const p = suiState(dex, obj.address, obj)
    assert.ok(p.active)
    const nativeFirst = p.token0 === SUI
    const price = nativeFirst ? rawRatio(p.sqrt, 9, 6) : 1 / rawRatio(p.sqrt, 6, 9)
    assert.ok(Math.abs(price - 0.713) < 0.003)
    assert.ok(unitsPositive(p.raw0) && unitsPositive(p.raw1))
    const fake = structuredClone(obj)
    fake.asMoveObject.contents.type.repr = fake.asMoveObject.contents.type.repr.replace(/0x[0-9a-f]+/, '0xff')
    assert.equal(suiState(dex, obj.address, fake), null)
  }
  const p = suiState('cetus', sui[0].object.address, sui[0].object)
  assert.equal(validPool({ ...p,chain:'sui',tx:sui[0].tx.digest,block:67053316 }), true)
  assert.equal(validPool({ ...p,chain:'sui',tx:CETUS,block:67053316 }), false)
})
function unitsPositive(raw) { return BigInt(raw) > 0n }

test('Aptos CLMM fixed point, weighted reserves and stable invariant use their own prices', () => {
  assert.ok(Math.abs(rawRatio(aptos[0].resource.data.sqrt_price, 8, 6) - 0.407) < 0.002)
  const r = aptCreation.state[0]
  const [x,y] = r.balances.map(Number), [w0,w1] = r.weights_opt.vec[0].map(Number)
  assert.equal(thalaRatio(r,x,y), y/x*w0/w1)
  const stable = {pool_type:100,amp_factor_opt:{vec:['100']},balances_normalized_opt:{vec:[['100000','100000']]}}
  assert.equal(thalaRatio(stable, 1, 1), 1)
  stable.balances_normalized_opt.vec[0] = ['200000','100000']
  const price = thalaRatio(stable,2,1)
  assert.ok(price > 0.98 && price < 1)
})

test('Aptos creation requires a successful transaction and the exact deployed event', () => {
  const { tx } = aptCreation
  const [p] = aptosCreations(tx)
  assert.equal(p.pool, aptCreation.state[0].pool.inner)
  assert.equal(p.token1, aptCreation.state[0].assets_metadata[1].inner)
  assert.equal(p.firstSeen, Math.floor(Number(tx.timestamp)/1000))
  assert.deepEqual(aptosCreations({ ...tx, success:false }), [])
  assert.deepEqual(aptosCreations({ ...tx, events:[{...tx.events[0],type:'0x1::pool::PoolCreationEvent'}] }), [])
})

function budget(profile, limit, response) {
  let now = 0, requests = 0
  const clock = () => now, budget = new RequestBudget(profile, limit, clock)
  const http = new HttpSources({budget,clock,fetch:async () => { requests++; return response?.() ?? Response.json({}) }})
  const endpoint = {protocol:'aptos-rest',url:'https://example.com/v1',limits:60}
  const bundle = {chains:[{id:'aptos',family:'aptos',endpoints:[endpoint]}]}
  return { client:new MoveClient({profile,bundle,http,clock,budget},'aptos'), http, budget,
    advance:ms=>{now+=ms}, requests:()=>requests }
}
test('family, peer, global and shared-host budgets charge actual dispatches, including refusals', async () => {
  for(const [profile,rate] of [['small',2],['normal',4],['large',6]]) {
    const n=budget(profile)
    for(let i=0;i<rate;i++) {
      await n.client.request('/view')
      await assert.rejects(n.client.request('/view'), RateLimited)
      n.advance(60000/rate)
    }
    assert.equal(n.requests(), rate)
    assert.equal(n.budget.dispatches, rate)
  }
  const limited=budget('normal', 12)
  await limited.client.request('/view', null, true)
  limited.advance(60_000)
  await assert.rejects(limited.client.request('/view',null,true), RateLimited)
  await limited.client.request('/view')
  const backoff=budget('normal',undefined,()=>new Response('',{status:429,headers:{'Retry-After':'180'}}))
  await assert.rejects(backoff.client.request('/view'), {status:429})
  assert.equal(backoff.client.next,180000)
  assert.equal(backoff.http.hosts.get('https://example.com').next, 180000)
  const shared=budget('normal')
  shared.http.hosts.set('https://example.com',new EndpointBucket(4,()=>0))
  await shared.http.getPublic('https://example.com/other',4)
  await assert.rejects(shared.client.request('/view',null,true),RateLimited)
  assert.equal(shared.client.peerNext,0)
  assert.equal(shared.requests(),1)
})
