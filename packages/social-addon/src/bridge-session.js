import { EventEmitter } from 'node:events';

/** Keep Social's identity, listeners and channel policies across single-use SC-Bridge connections. */
export class BridgeSession extends EventEmitter {
  publicKey = '';
  #connect;
  #log;
  #active;
  #opening;
  #restoring;
  #desired = new Map();
  #stopping = false;
  #timer;
  #backoff = 1000;

  /** @param {() => import('@gator/net').BridgeTransport} connect */
  constructor(connect, log) {
    super();
    this.#connect = connect;
    this.#log = log;
    this.ready = this.#open();
  }

  async #open() {
    const bridge = this.#opening = this.#connect();
    bridge.once('close', info => {
      if (this.#opening === bridge) this.#opening = null;
      if (this.#active !== bridge) return;
      this.#active = null;
      if (!info.requested) this.#retry();
      this.emit('close', info);
    });
    try {
      if (!await bridge.ready || this.#stopping || this.#opening !== bridge) return false;
      if (this.publicKey && bridge.publicKey !== this.publicKey) {
        throw new Error('Bridge peer identity changed');
      }
      bridge.on('message', (channel, envelope) => this.emit('message', channel, envelope));
      bridge.on('send-error', channel => this.emit('send-error', channel));
      bridge.on('peer', count => {
        if (this.#active === bridge) this.emit('peer', count);
      });
      for (const [channel, policy] of this.#desired) {
        if (!await bridge.join(channel, policy)) return false;
      }
      if (this.#stopping || this.#opening !== bridge) return false;
      this.publicKey = bridge.publicKey;
      this.#active = bridge;
      this.#opening = null;
      this.#backoff = 1000;
      if (bridge.peerCount()) this.emit('peer', bridge.peerCount());
      return true;
    } finally {
      if (this.#active !== bridge) await bridge.close();
    }
  }

  #retry() {
    if (this.#stopping) return;
    const delay = this.#backoff * (0.75 + 0.25 * Math.random());
    this.#backoff = Math.min(60_000, this.#backoff * 2);
    this.#timer = setTimeout(async () => {
      this.#restoring = this.#open().catch(error => {
        this.#log('warn', 'Bridge reconnect failed: ' + error.message);
        return false;
      });
      const restored = await this.#restoring;
      this.#restoring = null;
      if (!restored) this.#retry();
    }, delay);
  }

  async join(channel, policy) {
    if (this.#restoring) await this.#restoring;
    if (!await this.#active?.join(channel, policy)) return false;
    this.#desired.set(channel, policy);
    return true;
  }

  async leave(channel) {
    if (this.#restoring) await this.#restoring;
    const active = this.#active;
    if (!active) return this.#desired.delete(channel);
    const left = await active.leave(channel);
    if (left || !active.channels().includes(channel)) this.#desired.delete(channel);
    return left;
  }

  channels() { return this.#active?.channels() ?? []; }
  peerCount() { return this.#active?.peerCount() ?? 0; }
  send(channel, message) { return this.#active?.send(channel, message) ?? false; }
  rebroadcast() { return false; } // SC-Bridge has no signed replay verb.

  stopReconnecting() {
    this.#stopping = true;
    clearTimeout(this.#timer);
    return this.#opening?.close();
  }

  async close() {
    await this.stopReconnecting();
    await this.#active?.close();
  }
}
