import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { keyFromSeed } from './keys.js';
import { SidechannelTransport } from './sidechannel-transport.js';

/** Isolated discovery and connections, shared only by transports given this hub. */
export function createMemoryHub() {
  return new Set();
}

// Protomux expects a framed stream. Object mode preserves each write boundary.
function socketPair() {
  const streams = [0, 1].map(i => new Duplex({
    objectMode: true,
    read() {},
    write(frame, encoding, done) {
      const copy = Buffer.from(frame);
      queueMicrotask(() => {
        if (!streams[1 - i].destroyed) streams[1 - i].push(copy);
        done();
      });
    },
    destroy(error, done) {
      streams[1 - i].destroy();
      done(error);
    },
  }));
  return streams;
}

class MemorySwarm extends EventEmitter {
  connections = new Set();
  topics = new Set();
  neighbors = new Set();

  constructor(hub, publicKey) {
    super();
    this.hub = hub;
    this.publicKey = publicKey;
    hub.add(this);
  }

  join(topic) {
    const key = topic.toString('hex');
    this.topics.add(key);
    for (const other of this.hub) {
      if (this === other || !other.topics.has(key) || this.neighbors.has(other)) continue;
      const [left, right] = socketPair();
      this.connect(other, left);
      other.connect(this, right);
    }
  }

  connect(other, socket) {
    this.neighbors.add(other);
    this.connections.add(socket);
    socket.remotePublicKey = other.publicKey;
    socket.once('close', () => {
      this.connections.delete(socket);
      this.neighbors.delete(other);
    });
    this.emit('connection', socket);
  }

  leave(topic) {
    this.topics.delete(topic.toString('hex'));
  }

  flush() {
    return nextTurn();
  }

  async destroy() {
    this.hub.delete(this);
    for (const socket of this.connections) socket.destroy();
    await this.flush();
  }
}

export class MemoryTransport extends SidechannelTransport {
  /** skipPow is test-only. Peers exercise real signatures and the normal size and owner checks either way.
   * @param {{hub?: ReturnType<typeof createMemoryHub>, wallet?: import('trac-wallet').default,
   * skipPow?: boolean, rootKey?: string, relayTtl?: number, maxChannels?: number}} [options] */
  constructor({ hub = createMemoryHub(), wallet = keyFromSeed(randomBytes(32).toString('hex')),
    skipPow = false, rootKey, relayTtl, maxChannels } = {}) {
    // Like SwarmTransport, connections carry a transport key that is not the signing identity.
    const swarmKey = randomBytes(32);
    super({
      wallet, relayTtl, maxChannels, rootKey, skipPow,
      createSwarm: () => new MemorySwarm(hub, swarmKey),
    });
    this.swarmPublicKey = swarmKey.toString('hex');
  }
}
