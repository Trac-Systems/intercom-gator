import { policyFor, verifyOwnerEnvelope } from '../../../net/src/index.js'

export const MAX_FEED_BYTES = 1 << 20
export const DEFAULT_FEED = 'https://raw.githubusercontent.com/Trac-Systems/intercom-gator/main/patches/'
const ctlLimit = policyFor('gator/ctl').maxReceiveBytes

/** A config override is a raw GitHub directory or JSON file. Only the release digest comes from the node. */
export function feedUrl(setting, release) {
  if (setting === false) return null
  const raw = setting === true || setting === undefined ? DEFAULT_FEED : setting
  if (typeof raw !== 'string' || !raw.startsWith('https://') || /[\s\\?#]/.test(raw))
    throw new Error('feed-url')
  let url
  try { url = new URL(raw) } catch { throw new Error('feed-url') }
  if (url.origin !== 'https://raw.githubusercontent.com' || url.username || url.password ||
      url.pathname.split('/').filter(Boolean).length < 3) throw new Error('feed-url')
  if (!/^[a-f0-9]{64}$/.test(release)) throw new Error('release')
  if (!url.pathname.endsWith('.json')) url.pathname = url.pathname.replace(/\/?$/, '/') + release + '.json'
  return url.href
}

export function verifiedPatchEnvelope(wire, rootKey) {
  if (wire?.message?.t !== 'patch') return null
  return verifyOwnerEnvelope(wire, 'gator/ctl', rootKey, ctlLimit)
}
