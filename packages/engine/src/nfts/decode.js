// Pure decoders for NFT marketplace sale events (Seaport OrderFulfilled, Blur Exchange V2 packed executions,
// Limit Break Payment Processor V2). Each returns a normalized fill or null; nothing here touches the network.
import { address, ZERO } from '../sources/evm-abi.js'

/** Event layouts by protocol id. Topics are Keccak-256 of the canonical signature (checked in tests). */
export const PROTOCOLS = Object.freeze({
  seaport: {
    'OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],(uint8,address,uint256,uint256,address)[])':
      '0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31',
  },
  'blur-v2': {
    'Execution721Packed(bytes32,uint256,uint256)': '0x1d5e12b51dee5e4d34434576c3fb99714a85f57b0fd546ada4b0bddd736d12b2',
    'Execution721TakerFeePacked(bytes32,uint256,uint256,uint256)':
      '0x0fcf17fac114131b10f37b183c6a60f905911e52802caeeb3e6ea210398b81ab',
    'Execution721MakerFeePacked(bytes32,uint256,uint256,uint256)':
      '0x7dc5c0699ac8dd5250cbe368a2fc3b4a2daadb120ad07f6cccea29f83482686e',
  },
  'payment-processor-v2': {
    'BuyListingERC721(address,address,address,address,address,uint256,uint256)':
      '0xffb29e9cf48456d56b6d414855b66a7ec060ce2054dcb124a1876310e1b7355c',
    'BuyListingERC1155(address,address,address,address,address,uint256,uint256,uint256)':
      '0x1217006325a98bdcc6afc9c44965bb66ac7460a44dc57c2ac47622561d25c45a',
    'AcceptOfferERC721(address,address,address,address,address,uint256,uint256)':
      '0x8b87c0b049fe52718fe6ff466b514c5a93c405fb0de8fbd761a23483f9f9e198',
    'AcceptOfferERC1155(address,address,address,address,address,uint256,uint256,uint256)':
      '0x6f4c56c4b9a9d2479f963d802b19d17b02293ce1225461ac0cb846c482ee3c3e',
  },
})
export const TOPICS = Object.freeze(Object.fromEntries(Object.entries(PROTOCOLS).map(([id, events]) => [id, Object.values(events)])))

const MASK160 = (1n << 160n) - 1n
const MASK88 = (1n << 88n) - 1n
const NFT_TYPES = new Set([2, 3, 4, 5])
const PAY_TYPES = new Set([0, 1])
const MAX_ITEMS = 64

function words(data) {
  if (typeof data !== 'string' || !/^0x(?:[0-9a-f]{64})*$/i.test(data) || data.length > 2 + 64 * 4096) return null
  return (data.slice(2).match(/.{64}/g) ?? []).map((w) => BigInt('0x' + w))
}
const addr = (n) => (n == null || n >> 160n ? null : '0x' + n.toString(16).padStart(40, '0'))
const party = (a) => (a && a !== ZERO ? a : null)

/** A dynamic array of static tuples at a byte offset. */
function tupleArray(w, offset, size) {
  if (offset == null || offset % 32n) return null
  const at = Number(offset / 32n)
  if (!Number.isSafeInteger(at) || at >= w.length) return null
  const n = Number(w[at])
  if (!Number.isSafeInteger(n) || n > MAX_ITEMS || at + 1 + n * size > w.length) return null
  return Array.from({ length: n }, (_, i) => w.slice(at + 1 + i * size, at + 1 + (i + 1) * size))
}

/** Seaport 1.x OrderFulfilled: one event per order. Listings carry the NFT in `offer` and the payment in
 * `consideration`; accepted offers (bids) the reverse. Swaps (NFT on both sides) and gifts (no payment) are null. */
export function decodeSeaport(log) {
  if (log.topics?.length !== 3) return null
  const w = words(log.data)
  if (!w || w.length < 6) return null
  const offerer = address(log.topics[1]), recipient = addr(w[1])
  const offer = tupleArray(w, w[2], 4), consideration = tupleArray(w, w[3], 5)
  if (!offerer || !offer || !consideration || recipient == null) return null
  const item = ([type, token, id, amount, to]) => {
    const t = Number(type), a = addr(token)
    if (type > 5n || !a || (NFT_TYPES.has(t) && !amount)) return null
    return { type: t, token: a, id, amount, recipient: to == null ? null : addr(to) }
  }
  const spent = offer.map(item), received = consideration.map(item)
  if (spent.includes(null) || received.includes(null)) return null
  const nftOut = spent.filter((i) => NFT_TYPES.has(i.type)), nftIn = received.filter((i) => NFT_TYPES.has(i.type))
  if (!!nftOut.length === !!nftIn.length) return null
  const listing = nftOut.length > 0
  const items = (listing ? nftOut : nftIn).map((i) => ({ collection: i.token, tokenId: i.id.toString(),
    qty: i.amount, standard: i.type % 2 ? 'erc1155' : 'erc721' }))
  const payments = (listing ? received : spent).filter((i) => PAY_TYPES.has(i.type))
    .map((i) => ({ token: i.type === 0 ? 'native' : i.token, amount: i.amount }))
  if (!payments.length) return null
  // Payment items paid to someone other than the seller: marketplace fee and creator royalty.
  const seller = listing ? offerer : party(recipient)
  const fees = listing ? received.filter((i) => PAY_TYPES.has(i.type) && i.recipient !== offerer).length
    : received.filter((i) => PAY_TYPES.has(i.type)).length
  const buyer = listing ? party(recipient) : party(nftIn[0].recipient) ?? offerer
  return { items, payments, seller, buyer, fees }
}

/** Blur Exchange V2 packs one ERC-721 execution into two words (side|price|collection, tokenId|index|trader).
 * Side 0 = a listing was taken (trader = seller), 1 = a bid was taken (trader = buyer). Paid in ETH or Blur Pool. */
export function decodeBlurV2(log) {
  const w = words(log.data)
  if (log.topics?.length !== 1 || !w || (w.length !== 3 && w.length !== 4)) return null
  const [, tokenTrader, packed] = w
  const side = packed >> 248n, price = (packed >> 160n) & MASK88
  const collection = addr(packed & MASK160), trader = addr(tokenTrader & MASK160)
  if (side > 1n || !price || !collection || collection === ZERO || !trader) return null
  return {
    items: [{ collection, tokenId: (tokenTrader >> 168n).toString(), qty: 1n, standard: 'erc721' }],
    payments: [{ token: 'native', amount: price }],
    seller: side === 0n ? trader : null, buyer: side === 1n ? trader : null, fees: null,
  }
}

/** Payment Processor V2 (Magic Eden EVM and others): flat events with indexed parties and collection. */
export function decodePaymentProcessor(log, signature) {
  const w = words(log.data)
  const multi = signature.includes('ERC1155'), offer = signature.startsWith('AcceptOffer')
  if (log.topics?.length !== 4 || !w || w.length !== (multi ? 5 : 4)) return null
  const [a, b, collection] = log.topics.slice(1).map(address)
  const coin = addr(w[1]), qty = multi ? w[3] : 1n, price = w[multi ? 4 : 3]
  if (!a || !b || !collection || coin == null || !qty || !price) return null
  return {
    items: [{ collection, tokenId: w[2].toString(), qty, standard: multi ? 'erc1155' : 'erc721' }],
    payments: [{ token: coin === ZERO ? 'native' : coin, amount: price }],
    seller: offer ? a : b, buyer: offer ? b : a, fees: null,
  }
}

const bySignature = new Map()
for (const [protocol, events] of Object.entries(PROTOCOLS))
  for (const [signature, topic] of Object.entries(events)) bySignature.set(topic, { protocol, signature })

/** Decode one log by its topic0. Returns null for unknown topics or malformed data. */
export function decodeSale(log) {
  const known = bySignature.get(log?.topics?.[0])
  if (!known || log.removed) return null
  const fill = known.protocol === 'seaport' ? decodeSeaport(log)
    : known.protocol === 'blur-v2' ? decodeBlurV2(log) : decodePaymentProcessor(log, known.signature)
  return fill && { ...fill, protocol: known.protocol }
}
