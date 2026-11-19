// The subset of trac-peer's Feature base (src/artifacts/feature.js) that the blind relay uses: it reads only
// `peer.swarm`. gator has no trac-peer, so this stands in for it; index.js and config.js are otherwise unchanged.
export default class Feature {
  constructor(peer, config) {
    this.peer = peer;
    this.key = '';
    this.config = config;
  }
}
