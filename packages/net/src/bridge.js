import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import WebSocket from 'ws';
import { boundedValue, MAX_CHANNELS, MAX_FRAME_BYTES } from '../vendor/intercom-sidechannel/channel-options.js';
import { joinPolicy } from './policy.js';
import { isApplicationEnvelope } from './sidechannel-transport.js';

const TIMEOUT_MS = 30_000;

function helloKey(peer) {
  if (typeof peer === 'string' && /^[a-f0-9]{64}$/i.test(peer)) return peer.toLowerCase();
  let bytes = peer?.type === 'Buffer' ? peer.data : peer;
  // Bare Buffer extends Uint8Array. Some hosts serialize its indexed properties.
  if (bytes && typeof bytes === 'object' && !Array.isArray(bytes) && Object.keys(bytes).length === 32) {
    bytes = Array.from({ length: 32 }, (_, index) => bytes[index]);
  }
  if (Array.isArray(bytes) && bytes.length === 32 &&
      bytes.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) return Buffer.from(bytes).toString('hex');
  return null;
}

// Keep the DESIGN §4 envelope fields; drop host and relay annotations (`verified`, `relayedBy`).
function bridgeEnvelope({ id, channel, from, origin, ts, ttl, message, sig }) {
  const envelope = { type: 'sidechannel', id, channel, from };
  if (typeof origin === 'string') envelope.origin = origin;
  Object.assign(envelope, { ts, message });
  if (Number.isSafeInteger(ttl) && ttl >= 0) envelope.ttl = ttl;
  if (typeof sig === 'string') envelope.sig = sig;
  return envelope;
}

/** The SC-Bridge host answers `send` with `{type: 'sent', channel}` only and never forwards its own
 * outgoing messages, so unlike the swarm and memory transports a bridge send is not echoed locally as
 * 'message'. The host's hop count comes from its own configuration; there is no setRelayTtl.
 * Emits 'close'({requested, code}) exactly once when the WebSocket closes for any reason (host gone, network
 * error, failed handshake or authentication, or close()). `requested` is true when close() was called first.
 * The transport cannot reopen; to reconnect, construct a new BridgeTransport and join the channels again. */
export class BridgeTransport extends EventEmitter {
  publicKey = '';
  #socket;
  #token;
  #requested = false;
  #hello = false;
  #handshake = Promise.withResolvers();
  #closed = Promise.withResolvers();
  #timer;
  #statsTimer;
  #count = 0;
  #nextId = 1;
  #pending = new Map();
  #joined = new Map();
  #membership = Promise.resolve();

  /** ready resolves to true after the host identifies itself and authentication completes.
   * @param {{url: string | URL, token?: string}} options */
  constructor({ url, token }) {
    super();
    this.#token = token;
    this.ready = this.#handshake.promise;
    this.#socket = new WebSocket(url, { maxPayload: MAX_FRAME_BYTES + 1024, perMessageDeflate: false,
      handshakeTimeout: TIMEOUT_MS });
    this.#timer = setTimeout(() => this.#socket.terminate(), TIMEOUT_MS).unref();
    this.#socket.on('message', bytes => this.#receive(bytes));
    this.#socket.on('error', () => this.#socket.terminate());
    this.#socket.once('close', code => {
      clearTimeout(this.#timer);
      clearInterval(this.#statsTimer);
      this.#token = undefined;
      this.#handshake.resolve(false);
      this.#joined.clear();
      for (const finish of this.#pending.values()) finish(null);
      this.#setCount(0);
      this.#closed.resolve();
      this.emit('close', { requested: this.#requested, code });
    });
  }

  #request(frame, maxBytes = MAX_FRAME_BYTES) {
    if (this.#socket.readyState !== WebSocket.OPEN || this.#pending.size >= 1024 ||
        this.#socket.bufferedAmount > MAX_FRAME_BYTES) return null;
    const id = this.#nextId++;
    let json;
    try {
      json = JSON.stringify({ ...frame, id });
      if (Buffer.byteLength(json) > maxBytes) return null;
    } catch {
      return null;
    }
    const reply = Promise.withResolvers();
    const finish = response => {
      clearTimeout(timer);
      this.#pending.delete(id);
      reply.resolve(response);
    };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS).unref();
    this.#pending.set(id, finish);
    try {
      this.#socket.send(json);
    } catch {
      finish(null);
      return null;
    }
    return reply.promise;
  }

  async #acceptHello(frame) {
    const key = helloKey(frame.peer);
    if (!key || typeof frame.requiresAuth !== 'boolean') return this.#socket.terminate();
    if (frame.requiresAuth) {
      if (!this.#token) return this.#socket.terminate();
      const reply = await this.#request({ type: 'auth', token: this.#token });
      if (reply?.type !== 'auth_ok') return this.#socket.terminate();
    }
    this.#token = undefined;
    if (frame.filter) {
      const reply = await this.#request({ type: 'clear_filter' });
      if (reply?.type !== 'filter_set') return this.#socket.terminate();
    }
    if (this.#socket.readyState !== WebSocket.OPEN) return;
    this.publicKey = key;
    clearTimeout(this.#timer);
    this.#handshake.resolve(true);
    this.#refreshStats();
    // SC-Bridge provides request/reply stats and has no push event for peer count.
    this.#statsTimer = setInterval(() => this.#refreshStats(), TIMEOUT_MS).unref();
  }

  async #refreshStats() {
    const reply = await this.#request({ type: 'stats' });
    if (reply?.type === 'stats' && Number.isSafeInteger(reply.connectionCount) && reply.connectionCount >= 0) {
      this.#setCount(reply.connectionCount);
    }
  }

  #setCount(count) {
    if (this.#count === count) return;
    this.#count = count;
    this.emit('peer', count);
  }

  #receive(bytes) {
    let frame;
    try {
      frame = JSON.parse(bytes.toString('utf8'));
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'hello' && !this.#hello) {
      this.#hello = true;
      void this.#acceptHello(frame);
    } else if (frame.type === 'sidechannel_message') {
      const policy = this.#joined.get(frame.channel);
      // PoW is omitted from bridge events. The host verifies the original signed wire frame; a managed host
      // (--sidechannel-options) also reports its verdict as `verified`. Release hosts omit the field.
      if (policy && frame.verified !== false && isApplicationEnvelope(frame) && boundedValue(frame) &&
          (!policy.ownerWriteOnly || frame.from === policy.ownerKey) &&
          Buffer.byteLength(JSON.stringify(frame.message)) <= policy.maxReceiveBytes) {
        this.emit('message', frame.channel, bridgeEnvelope(frame));
      }
    } else if (Number.isSafeInteger(frame.id)) {
      this.#pending.get(frame.id)?.(frame);
    }
  }

  #schedule(operation) {
    this.#membership = this.#membership.then(operation);
    return this.#membership;
  }

  /** Per-channel admission is configured on the host via --sidechannel-options.
   * @param {string} channel @param {import('./policy.js').ChannelPolicy} [options] */
  join(channel, options) {
    return this.#schedule(async () => {
      if (!await this.ready || this.#socket.readyState !== WebSocket.OPEN) return false;
      let policy;
      try {
        policy = joinPolicy(channel, options);
      } catch {
        return false;
      }
      if (this.#joined.has(channel)) return isDeepStrictEqual(this.#joined.get(channel), policy);
      if (this.#joined.size >= MAX_CHANNELS) return false;
      const sub = await this.#request({ type: 'subscribe', channels: [channel] });
      if (sub?.type !== 'subscribed' || !Array.isArray(sub.channels) || !sub.channels.includes(channel)) return false;
      const reply = await this.#request({ type: 'join', channel });
      if (reply?.type !== 'joined' || reply.channel !== channel || reply.announced === false) {
        await this.#request({ type: 'unsubscribe', channels: [channel] });
        return false;
      }
      this.#joined.set(channel, policy);
      return true;
    });
  }

  leave(channel) {
    return this.#schedule(async () => {
      if (!this.#joined.has(channel)) return false;
      // The host's leave handler also removes this client's subscription.
      const reply = await this.#request({ type: 'leave', channel });
      if (reply?.type !== 'left' || reply.channel !== channel) return false;
      this.#joined.delete(channel);
      return reply.ok === true;
    });
  }

  /** A true return means queued on the socket. Later host rejection emits 'send-error'(channel). */
  send(channel, message) {
    const policy = this.#joined.get(channel);
    if (!policy || (policy.ownerWriteOnly && policy.ownerKey !== this.publicKey) ||
        !message || typeof message !== 'object' || Array.isArray(message) || !boundedValue(message)) return false;
    const reply = this.#request({ type: 'send', channel, message }, policy.maxReceiveBytes);
    if (!reply) return false;
    reply.then(frame => {
      if (frame?.type !== 'sent' || frame.channel !== channel) this.emit('send-error', channel);
    });
    return true;
  }

  // The pinned bridge has no verb for replaying an existing signed envelope.
  rebroadcast() { return false; }
  channels() { return [...this.#joined.keys()]; }
  peerCount() { return this.#count; }

  /** Resolves after the socket has closed and 'close' was emitted. */
  close() {
    this.#requested ||= this.#socket.readyState !== WebSocket.CLOSED;
    if (this.#socket.readyState === WebSocket.CONNECTING) this.#socket.terminate();
    else if (this.#socket.readyState === WebSocket.OPEN) this.#socket.close();
    return this.#closed.promise;
  }
}
