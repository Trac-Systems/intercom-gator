import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { bundleDigest, loadBundle } from '@gator/bundle'
import { channelFor } from '../src/obs/index.js'
import { aptosCreations } from '../src/sources/move/aptos.js'
import { suiState } from '../src/sources/move/sui.js'
import { archive, LocalTransport } from './helpers/archived-receiver.js'

const fixture = file => JSON.parse(readFileSync(new URL('./fixtures/move/' + file + '.json', import.meta.url)))
const sui = fixture('sui-pools'), aptos = fixture('aptos-creation')
const hints = sui.map((r, i) => {
  const p = suiState(i === 2 ? 'turbos' : 'cetus', r.object.address, r.object)
  return { ...p, chain:'sui', tx:r.tx.digest, block:r.tx.effects.checkpoint.sequenceNumber }
})
hints.push({ ...aptosCreations(aptos.tx)[0],block:Number(aptos.block.block_height) })

for (const version of ['0.1.0','0.1.1','0.1.2','0.1.3']) {
  test('archived v' + version + ' accepts the control and ignores both Move families without penalty', async t => {
    const released = archive(t, 'v' + version)
    if (!released) return
    const [eng, bundled, db, mod] = await Promise.all([
      released('engine'), released('bundle'), released('store'), released('engine','intel/index.js'),
    ])
    const store = db.openStore({file:':memory:',migrations:[...eng.migrations,...mod.migrations]})
    const transport = new LocalTransport(), now = 1795137834000, from = 'b'.repeat(64)
    const engine = new eng.Engine({store,transport,bundle:bundled.loadBundle(),clock:()=>now,backgroundJobs:[],
      patches:{patchFeed:false,snapshot:false},rpcConfig:{fetch:()=>assert.fail('archived reader made an RPC')}})
    const intel = mod.createIntel({engine,dailyMarket:()=>[],sampleGlobal(){}})
    const send = (channel,message)=>transport.emit('message',channel,{channel,message,from,ts:now})
    const px = id => send(channelFor(id),{ t:'obs',v:1,b:engine.obs.digest,at:now,o:[[id,'0.715','7',null,null,null,now]] })
    try {
      await engine.start()
      await intel.start()
      assert.equal(engine.obs.digest,bundleDigest(loadBundle()).slice(0,16))
      const rank = engine.hints.rank(from)
      for (const {chain,dex,kind,pool,token0,token1,block,tx} of hints) {
        send('gator/new',{ t:'pool',v:1,chain,dex,kind,pool,token0,token1,block,tx })
        const id='dex:'+chain+':'+pool
        px(id)
        assert.equal(engine.registry.markets.has(id),false)
        assert.equal(store.reader.prepare('SELECT 1 FROM engine_latest WHERE market=?').get(id),undefined)
      }
      px('cex:bitstamp:BTC-USD')
      assert.ok(store.reader.prepare('SELECT 1 FROM engine_latest WHERE market=? AND reporter=?').get('cex:bitstamp:BTC-USD',from))
      assert.equal(intel.newTokens.list().length,0)
      assert.equal(engine.hints.size,0)
      assert.equal(engine.hints.rank(from),rank)
      assert.equal(engine.book.muted(from),false)
      assert.equal(store.reader.prepare('SELECT 1 FROM reporters WHERE key=? AND (strikes>0 OR mutedUntil>?)').get(from,now),undefined)
    } finally { await intel.stop(); await engine.stop(); store.close() }
  })
}
