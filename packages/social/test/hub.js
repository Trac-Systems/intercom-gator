import { EventEmitter } from 'node:events';
import { generateKeyPairSync, sign, verify } from 'node:crypto';

// Independent encoder for the pinned Intercom stable JSON signature input.
function bytes(e) {
  const payload = { kind: 'sidechannel_message_v1', id: e.id, from: e.from, origin: e.origin,
    ts: e.ts, message: e.message, channel: e.channel };
  return Buffer.from(JSON.stringify(payload, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ?
    Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));
}

export class Hub {
  peers = new Set();
  envelopes = [];
  resends = [];
  now = 1800000000000;

  peer() {
    const hub = this;
    const keys = generateKeyPairSync('ed25519');
    let sequence = 0;
    const transport = new class extends EventEmitter {
      publicKey = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
      policies = new Map();
      async join(channel, policy) { this.policies.set(channel, { ...policy }); return true; }
      async leave(channel) { return this.policies.delete(channel); }
      channels() { return [...this.policies.keys()]; }
      peerCount() { return hub.peers.size - 1; }
      setRelayTtl(n) { this.ttl = n; }
      async close() { hub.peers.delete(this); }
      envelope(channel, message, overrides) {
        const e = { type: 'sidechannel', from: this.publicKey, origin: this.publicKey,
          id: this.publicKey + ':' + hub.now + ':' + (++sequence).toString(36).padStart(8, '0'), channel,
          message, ts: hub.now, ttl: 3, ...overrides };
        e.sig = sign(null, bytes(e), keys.privateKey).toString('hex');
        return e;
      }
      send(channel, message) {
        if (!this.policies.has(channel)) return false;
        const e = this.envelope(channel, message);
        if (!this.allowed(e, this)) return false;
        hub.envelopes.push(e);
        return this.deliver(e);
      }
      rebroadcast(e) { hub.resends.push(e); return this.deliver(e); }
      allowed(e, receiver) {
        const p = receiver.policies.get(e.channel);
        return p && (!p.ownerWriteOnly || e.from === p.ownerKey) &&
          Buffer.byteLength(JSON.stringify(e)) <= p.maxReceiveBytes && e.from === this.publicKey &&
          verify(null, bytes(e), keys.publicKey, Buffer.from(e.sig, 'hex'));
      }
      deliver(e) {
        let delivered = false;
        for (const receiver of hub.peers) if (this.allowed(e, receiver)) {
          receiver.emit('message', e.channel, structuredClone(e));
          delivered = true;
        }
        return delivered;
      }
    }();
    hub.peers.add(transport);
    return transport;
  }
}
