import { join } from 'node:path';
import DHT from 'hyperdht';
import Hyperswarm from 'hyperswarm';
import { loadOrCreateSwarmKeyPair } from './keys.js';
import { SidechannelTransport } from './sidechannel-transport.js';

export class SwarmTransport extends SidechannelTransport {
  /** Supply a wallet from loadOrCreateKey or keyFromSeed and one private seen directory per running peer.
   * The wallet signs every message. Hyperswarm connects with a separate key pair (`swarmKeyPair`; by default
   * dataDir/keys/swarm.json, created on first start, or a fresh one per run without dataDir), so the DHT key
   * of this node is not its identity. Intercom needs the two to match only on invite-only channels, which gator
   * does not use.
   * @param {{wallet: import('trac-wallet').default, dataDir?: string, seenDir?: string,
   * swarmKeyPair?: {publicKey: Buffer, secretKey: Buffer},
   * bootstrap?: Array<string | {host: string, port: number}>, relayTtl?: number,
   * maxChannels?: number, rootKey?: string, blindRelay?: object|null}} options */
  constructor({ dataDir, wallet, bootstrap, seenDir = join(dataDir, 'seen'), relayTtl, maxChannels, rootKey,
    swarmKeyPair, blindRelay = null }) {
    if (typeof seenDir !== 'string' || !seenDir.trim()) throw new TypeError('Expected a private seen directory');
    const keyPair = swarmKeyPair ?? (dataDir == null ? DHT.keyPair() : loadOrCreateSwarmKeyPair(dataDir));
    if (!Buffer.isBuffer(keyPair?.publicKey) || keyPair.publicKey.length !== 32 ||
        !Buffer.isBuffer(keyPair.secretKey) || keyPair.secretKey.length !== 64) {
      throw new TypeError('Expected a Hyperswarm key pair');
    }
    if (Buffer.isBuffer(wallet?.publicKey) && keyPair.publicKey.equals(wallet.publicKey)) {
      throw new TypeError('The swarm key pair must not be the signing key');
    }
    super({
      wallet, seenDir, relayTtl, maxChannels, rootKey, blindRelay,
      createSwarm: () => new Hyperswarm({
        keyPair: { publicKey: keyPair.publicKey, secretKey: keyPair.secretKey }, bootstrap,
      }),
    });
    /** The Noise/DHT public key peers see on connections (hex). Not the identity in `publicKey`. */
    this.swarmPublicKey = keyPair.publicKey.toString('hex');
  }
}
