import { RateLimited } from '../scheduler/index.js'

export const dexJobs = new Map([
  ['tron', { id: 'tron:sunswap', name: 'SunSwap' }],
  ['sui', { id: 'sui:pools', name: 'Sui pools' }],
  ['aptos', { id: 'aptos:pools', name: 'Aptos pools' }],
  ['ton', { id: 'ton:dex', name: 'STON.fi + DeDust', interval: 2500 }],
  ['near', { id: 'near:ref', name: 'Ref Finance' }],
])

/** Run one available family task per scheduler turn. Resume the same task after a budget deferral. */
export async function runDexTasks(source, tasks = source.tasks) {
  for (let i = 0; i < tasks.length; i++) {
    const turn = source.turn
    source.turn = (turn + 1) % tasks.length
    try {
      if (await tasks[turn]()) return
    } catch (error) {
      if (error instanceof RateLimited) source.turn = turn
      throw error
    }
  }
}

/** Route background reads and market spot checks through the same public reader and its request budget. */
export function registerDexJob(chain, source) {
  const { engine, client } = source
  const { id, interval = 5000 } = dexJobs.get(chain)
  engine.registerJob({ id, marketChain: chain, interval,
    ready: () => engine.clock() >= client.next && !!client.endpoint,
    run: () => source.run(), spotCheck: (market, reads) => source.state(market.split(':')[2], reads) })
  return source
}
