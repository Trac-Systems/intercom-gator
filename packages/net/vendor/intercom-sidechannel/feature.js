// Sidechannel uses only the trac-peer Feature constructor.
export default class Feature {
  constructor(peer, config) {
    Object.assign(this, { peer, key: '', config });
  }
}
