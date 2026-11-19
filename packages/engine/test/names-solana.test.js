import test from 'node:test'
import assert from 'node:assert/strict'
import { metadataPda, solanaNames } from '../src/sources/names/solana.js'

const address = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const mintKey = Buffer.from('c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61', 'hex')
const pda = '5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq'
const token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const t22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const mpl = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
const account = (owner, bytes) => ({ owner, data: [bytes.toString('base64'), 'base64'], executable: false })
function field(text) {
  const data = Buffer.from(text), size = Buffer.alloc(4)
  size.writeUInt32LE(data.length)
  return Buffer.concat([size, data])
}
function mint(extended) {
  const bytes = Buffer.alloc(extended ? 166 : 82)
  bytes[44] = 6
  bytes[45] = 1
  if (!extended) return account(token, bytes)
  bytes[165] = 1
  const content = Buffer.concat([Buffer.alloc(32), mintKey, field('Inline Coin'), field('IN')])
  const header = Buffer.alloc(4)
  header.writeUInt16LE(19)
  header.writeUInt16LE(content.length, 2)
  return account(t22, Buffer.concat([bytes, header, content]))
}
const metadata = (key = mintKey) => account(mpl, Buffer.concat([Buffer.from([4]), Buffer.alloc(32), key,
  field('Classic Coin\0\0'), field('S\u200bPL\0')]))

test('Token-2022 inline fields precede Metaplex and classic padded Borsh strings share one account read', async () => {
  assert.equal(metadataPda(address), pda)
  // Independently checked vector with three on-curve candidates before bump 252.
  assert.equal(metadataPda('11111111111111111111111111111113'), '71e1YQBKNtj32Eb1xV5GtL5rDmhgD2UTciJ9gSafZJot')
  let requests = 0
  const rpc = { async call(chain, method, [keys, options]) {
    requests++
    assert.equal(method, 'getMultipleAccounts')
    assert.deepEqual(keys, [address, pda, address, pda])
    assert.equal(options.commitment, 'finalized')
    return { context: { slot: 1001 }, value: [mint(true), metadata(), mint(false), metadata()] }
  } }
  assert.deepEqual(await solanaNames({ id: 'solana' }, [{ address }, { address }], rpc), [
    { name: 'Inline Coin', symbol: 'IN', decimals: 6, method: 'spl-token-2022', block: 1001 },
    { name: 'Classic Coin', symbol: 'SPL', decimals: 6, method: 'metaplex', block: 1001 },
  ])
  assert.equal(requests, 1)
})

test('bad mint bytes, wrong PDA mint/owner, malformed TLV, and invalid base58 stay isolated', async () => {
  const bad = mint(true), bytes = Buffer.from(bad.data[0], 'base64')
  bytes.writeUInt16LE(65535, 168)
  const rpc = { call: async () => ({ context: { slot: 1 }, value: [
    account(token, Buffer.alloc(8)), metadata(), mint(false), metadata(Buffer.alloc(32)),
    mint(false), { ...metadata(), owner: token }, account(t22, bytes), metadata(),
  ] }) }
  const rows = await solanaNames({ id: 'solana' }, ['invalid', address, address, address, address].map(address => ({ address })), rpc)
  assert.deepEqual(rows.slice(0, 4), [null, null, { decimals: 6 }, { decimals: 6 }])
  assert.equal(rows[4].method, 'metaplex')
})
