import { EventEmitter } from 'node:events';
import Protomux from 'protomux';
import { ManagedSidechannel } from '../vendor/intercom-sidechannel/managed.js';
import { boundedValue, integer, MAX_CHANNELS, MAX_FRAME_BYTES } from '../vendor/intercom-sidechannel/channel-options.js';
import { joinPolicy } from './policy.js';
import BlindRelay from '../vendor/intercom-blind-relay/index.js';
import { relayKeys } from '../vendor/intercom-blind-relay/config.js';

// Intercom queues own frames and handshakes behind mux backpressure with these bounds (per connection, per instance).
export { BACKLOG_BYTES, BACKLOG_FRAMES, TOTAL_BACKLOG_BYTES } from '../vendor/intercom-sidechannel/managed.js';

export const SEEN_HOURS = 3;
// managed.js clamps every managed relay hop count to 0..8 (its unexported MAX_HOPS).
export const MAX_RELAY_TTL = 8;

// Bytes a receiver's codec measures for this frame: compact JSON plus its varint length prefix.
function frameSize(payload) {
  const json = Buffer.byteLength(JSON.stringify(payload));
  return json + (json < 0xfd ? 1 : json <= 0xffff ? 3 : 5);
}

// Intercom 5fd7669 answers remote opens during a retry wait, replaces closed sessions on every open and queues own
// frames and handshakes behind backpressure. The subclass adds the author's echo, the own size check and the
// relay without the identity stamp (below).
class GatorSidechannel extends ManagedSidechannel {
  ownSend = false;
  outbound = null;

  // Upstream stamps every relayed copy with this node's identity key (`relayedBy`). The field is unsigned and no
  // receiver reads it, but direct neighbours know this node's address, so it would link soc/u/<identity> to that
  // address (R-APP-15). Relay the signed frame without it. The original size still bounds the shorter copy.
  _sendFrame(record, payload, bytes, kind = 'relay', origin = null) {
    if (kind === 'relay' && payload && Object.hasOwn(payload, 'relayedBy')) {
      const { relayedBy, ...unstamped } = payload;
      payload = unstamped;
    }
    return super._sendFrame(record, payload, bytes, kind, origin);
  }

  /** Sign and send one application message.
   * @returns {object | null} the signed payload broadcast admitted, or null */
  sendOwn(channel, message) {
    this.outbound = null;
    this.ownSend = true;
    try {
      return this.broadcast(channel, message) ? this.outbound : null;
    } finally {
      this.ownSend = false;
      this.outbound = null;
    }
  }

  // broadcast() admits a payload through this gate exactly once, synchronously, before it sends or queues the
  // frame. Keep that signed copy so the transport can show the author its own message. broadcast() is false when
  // every eligible session refused the frame (a full backlog); then nothing is echoed.
  // Refuse our own frame when peers sharing this channel's policy would drop it as oversized.
  _rememberOutbound(payload) {
    if (this.ownSend &&
        frameSize(payload) > (this.channelPolicies.get(payload.channel)?.maxReceiveBytes ?? MAX_FRAME_BYTES)) return false;
    const remembered = super._rememberOutbound(payload);
    if (remembered && this.ownSend) this.outbound = payload;
    return remembered;
  }
}

/** @typedef {{id: string, channel: string, from: string, origin?: string, ts: number,
 * ttl?: number, message: object, sig?: string, pow?: object}} Envelope */
export function isApplicationEnvelope(envelope) {
  return typeof envelope?.id === 'string' && envelope.id.length > 0 &&
    typeof envelope.from === 'string' && /^[a-f0-9]{64}$/.test(envelope.from) &&
    Number.isSafeInteger(envelope.ts) &&
    !!envelope.message && typeof envelope.message === 'object' && !Array.isArray(envelope.message);
}

/** Verify a stored copy from an owner-only channel with the same Intercom signature verifier as a live receipt.
 * Return the normal application envelope so unsigned relay metadata never reaches the consumer. */
export function verifyOwnerEnvelope(wire, channel, ownerKey, maxBytes) {
  if (wire?.type !== 'sidechannel' || wire.channel !== channel || wire.from !== ownerKey ||
      !isApplicationEnvelope(wire) || Buffer.byteLength(wire.id) > 512 ||
      (wire.origin != null && (typeof wire.origin !== 'string' || !/^[a-f0-9]{64}$/.test(wire.origin))) ||
      !boundedValue(wire) || frameSize(wire) > maxBytes) return null;
  const { message, ...metadata } = wire;
  // Intercom's managed admission also caps the outer metadata at 16 KiB.
  if (Buffer.byteLength(JSON.stringify(metadata)) > 16 * 1024 ||
      !ManagedSidechannel.prototype._validAuthorSignature(wire, ownerKey)) return null;
  return receivedEnvelope({ ...wire, verified: true }, wire);
}

/** The managed callback passes the receiver-verified v1 fields (`content`, with `verified`) separately from the
 * wire envelope. Rebuild the DESIGN §4 envelope from the authenticated fields and keep only the transport
 * metadata needed to rebroadcast it unchanged: signature, proof nonce and hop count. Unsigned extras that a
 * relay may add (`relayedBy`, other outer fields) are dropped.
 * @returns {Envelope | null} */
export function receivedEnvelope(content, wire) {
  const sig = wire?.sig || wire?.signature;
  if (content?.verified !== true || typeof sig !== 'string' || !/^[a-f0-9]{128}$/i.test(sig)) return null;
  const envelope = { type: 'sidechannel', id: content.id, channel: content.channel, from: content.from };
  if (typeof content.origin === 'string') envelope.origin = content.origin;
  Object.assign(envelope, { ts: content.ts, message: content.message });
  if (Number.isSafeInteger(wire.ttl) && wire.ttl >= 0) envelope.ttl = wire.ttl;
  envelope.sig = sig.toLowerCase();
  const { nonce, difficulty } = wire.pow ?? {};
  if (Number.isSafeInteger(nonce) && nonce >= 0) {
    envelope.pow = Number.isSafeInteger(difficulty) ? { nonce, difficulty } : { nonce };
  }
  return isApplicationEnvelope(envelope) ? envelope : null;
}

// Both transports use the upstream Protomux framing, codec and admission path.
export class SidechannelTransport extends EventEmitter {
  #side;
  #swarm;
  #starting;
  #closing;
  #rootKey;
  #skipPow;
  #maxChannels;
  #relay = null;

  /** blindRelay: Intercom's blind relay ({serve, relays, ...limits}); relays are Hyperswarm keys of relay peers.
   * A node never lists its own key. Off when serve is false and the list is empty. */
  constructor({ wallet, createSwarm, seenDir, relayTtl = 3, maxChannels = MAX_CHANNELS, rootKey, skipPow = false,
    blindRelay = null }) {
    super();
    if (!Buffer.isBuffer(wallet?.publicKey) || wallet.publicKey.length !== 32 ||
        !Buffer.isBuffer(wallet.secretKey) || wallet.secretKey.length !== 64 || typeof wallet.sign !== 'function') {
      throw new TypeError('Expected an Intercom signing wallet');
    }
    this.#maxChannels = integer(maxChannels, 'maxChannels', 1, MAX_CHANNELS);
    integer(relayTtl, 'relayTtl', 0, Number.MAX_SAFE_INTEGER);
    relayTtl = Math.min(relayTtl, MAX_RELAY_TTL);
    this.publicKey = wallet.publicKey.toString('hex');
    this.#rootKey = rootKey;
    this.#skipPow = skipPow;
    const peer = { wallet };
    this.#side = new GatorSidechannel(peer, {
      relayTtl, welcomeRequired: false, allowRemoteOpen: false,
      seenTtlMs: SEEN_HOURS * 3_600_000,
      seenPersistence: seenDir == null ? undefined : { directory: seenDir, hours: SEEN_HOURS },
      onMessage: (channel, content, connection, wire) => {
        const envelope = this.#closing ? null : receivedEnvelope(content, wire);
        if (envelope?.channel === channel) this.emit('message', channel, envelope);
      },
    });
    this.#swarm = peer.swarm = createSwarm();
    // relays: fixed for this run (local flag); defaults: the release's list, replaceable by root network settings.
    const { relays = [], defaults = [], ...relayOptions } = blindRelay ?? {};
    if (blindRelay && (relayOptions.serve || relays.length || defaults.length)) {
      const self = this.#swarm.keyPair?.publicKey?.toString('hex');
      this.#relay = new BlindRelay(peer, { ...relayOptions, relays: relayKeys(relays).filter(k => k !== self) });
      this.#relay.setRelays(defaults);
    }
    this.#swarm.on('connection', stream => {
      stream.userData = Protomux.from(stream);
      stream.once('close', () => this.emit('peer', this.peerCount()));
      this.emit('peer', this.peerCount());
    });
  }

  /** @param {string} channel @param {import('./policy.js').ChannelPolicy} [options] */
  async join(channel, options) {
    if (this.#closing) return false;
    let policy;
    try {
      policy = joinPolicy(channel, options, this.#rootKey, this.#skipPow);
    } catch {
      return false;
    }
    this.#starting ??= this.#startRelay().then(() => this.#side.start()).catch(error => {
      this.#starting = undefined;
      throw error;
    });
    await this.#starting;
    if (this.#closing || (!this.#side.channels.has(channel) && this.#side.channels.size >= this.#maxChannels)) {
      return false;
    }
    return this.#side.addChannel(channel, policy);
  }

  async leave(channel) {
    await this.#starting;
    if (this.#closing || typeof channel !== 'string' || channel.trim() !== channel) return false;
    return this.#side.removeChannel(channel);
  }

  /** On success the complete signed envelope is also emitted locally as 'message'(channel, envelope), once,
   * synchronously before send returns and whether or not any peer is connected. Remote copies of it are
   * duplicates and never reach this transport's listeners. */
  send(channel, message) {
    if (this.#closing || !this.#side.channels.get(channel)?.announced || !message || typeof message !== 'object' ||
        Array.isArray(message) || !boundedValue(message)) return false;
    // broadcast can defer serialization until a remote mux opens; keep the signed copy stable.
    let snapshot;
    try {
      snapshot = JSON.parse(JSON.stringify(message));
    } catch {
      return false;
    }
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
    const payload = this.#side.sendOwn(channel, snapshot);
    if (!payload) return false;
    this.emit('message', channel, JSON.parse(JSON.stringify(payload)));
    return true;
  }

  /** Apply the root network settings' hop count on a running transport. Later sends and relays use it.
   * @param {number} ttl @returns {number} the effective value, clamped to 0..MAX_RELAY_TTL */
  setRelayTtl(ttl) {
    if (!Number.isSafeInteger(ttl)) throw new TypeError('relayTtl must be an integer');
    this.#side.relayTtl = Math.min(MAX_RELAY_TTL, Math.max(0, ttl));
    return this.#side.relayTtl;
  }

  /** @param {Envelope} envelope */
  rebroadcast(envelope) {
    if (this.#closing || !isApplicationEnvelope(envelope)) return false;
    return this.#side.rebroadcast(envelope);
  }

  channels() {
    if (this.#closing) return [];
    return [...this.#side.channels.values()].filter(entry => entry.announced).map(entry => entry.name);
  }

  peerCount() {
    return this.#closing ? 0 : this.#swarm.connections.size;
  }

  /** A relay that serves must start (fail loudly); a client that cannot install the fallback runs direct-only. */
  async #startRelay() {
    if (!this.#relay) return;
    try {
      await this.#relay.start();
    } catch (error) {
      if (this.#relay.options.serve) throw error;
      this.#relay = null;
      this.emit('relayError', error);
    }
  }

  /** Replace the relay list (root network settings). Static relays given at start stay. @returns {string[]} */
  setRelays(keys) {
    return this.#relay ? this.#relay.setRelays(keys) : [];
  }

  /** Blind relay counters and limits, or null when the feature is off. */
  relayStats() {
    return this.#relay ? this.#relay.stats() : null;
  }

  close() {
    this.#closing ??= Promise.resolve().then(async () => {
      await this.#relay?.stop().catch(() => {});
      // Destroying the DHT also releases outstanding bootstrap/discovery waits.
      await this.#side.stop();
      await this.#swarm.destroy();
      await this.#starting?.catch(() => {});
      await this.#side.stop();
    });
    return this.#closing;
  }
}
