# @gator/net

Intercom sidechannel transports for intercom-gator and the shared social layer: `SwarmTransport` (Hyperswarm/HyperDHT),
`BridgeTransport` (SC-Bridge WebSocket on a host peer) and `MemoryTransport` (tests). The contract is DESIGN.md §4.

## Vendored Intercom

`vendor/intercom-sidechannel/` holds `features/sidechannel/{index,managed,channel-options,pow,seen}.js` from
Trac-Systems/intercom at the commit recorded in `VENDOR.json` (PR #43 head `5fd7669`). The files are byte-identical
except for two import rewrites, and `VENDOR.json` records both SHA-256 digests for each file. `index.js` is the
unmodified 0.0.11 release module. Gator always builds the opt-in `ManagedSidechannel` from `managed.js`. To re-vendor:

```sh
node packages/net/scripts/vendor-sync.mjs <intercom checkout> <commit>
```

`test/vendor.test.js` reverses the rewrites and compares the result with the pinned upstream blobs.

Gator's subclass (`src/sidechannel-transport.js`) adds three things on top of upstream:

- An echo of the author's own messages.
- A size check on own frames.
- Stripping of the `relayedBy` stamp from relayed frames (see below).

Earlier open-path and backpressure workarounds were fixed upstream in PR #43 and removed here.

## Keys

A data directory holds two key pairs. Both files are created on first start in `keys/` (0700) with mode 0600.

| File | Used for | Seen by others as |
|---|---|---|
| `keys/peer.json` | Identity. It signs every sidechannel message, owns `soc/u/<key>` and is the key of profile cards and reports. | `from`/`origin` of every message |
| `keys/swarm.json` | Hyperswarm/HyperDHT only: DHT announces and the Noise handshake of every connection. | the connection's remote public key |

### `keys/peer.json` has an empty password (R-APP-16)

`peer.json` uses Intercom's PeerWallet keystore format: Argon2i (libsodium "moderate") plus XSalsa20-Poly1305. Gator
starts unattended, so it follows Intercom's convention for unattended peers and encrypts the file with an **empty
password**. The encryption therefore protects nothing. Anyone who can read the file can decrypt the identity key in
about a second.

The only protection is the file system. The file is 0600 (reset to 0600 on every load) inside `keys/` (0700), inside a
data directory created as 0700. `gator start` refuses a group- or world-accessible data directory, and `gator doctor`
reports one. Root, backups, synced folders and disk images can all read the file. Exclude the data directory from anything that leaves the machine, or use disk encryption. The
key is never printed and never sent over any API. On Windows the POSIX modes do not apply, so the directory ACL is the
only protection.

### A separate swarm key (R-APP-15)

If Hyperswarm used the identity key, every DHT announce and every connection would name the node's identity next to
its IP address. Anyone could then look up `soc/u/<key>`, or the key itself, on the DHT and get the address. The swarm
therefore uses its own key pair in `keys/swarm.json`, created on first start. `SwarmTransport` loads it from `dataDir`,
accepts an explicit `swarmKeyPair`, or creates a fresh pair for each run when no `dataDir` is given. It refuses the
signing key as the swarm key. `transport.swarmPublicKey` returns the hex public key. `swarm.json` is plain JSON
`{publicKey, secretKey}`, because encrypting it with an empty password would add nothing (see above).

Nothing gator uses in the managed sidechannel depends on the two keys being equal. This was checked at `d044d3e`:

- Signatures, owner-only checks and receipts use the signed `from` field and the configured owner key.
- Welcomes are verified against the owner key.
- Rate limits and admission are kept per connection object.

The only upstream feature that reads the connection's Noise key is **invite-only channels**: invites name the
invitee by key and are checked against `connection.remotePublicKey`. Gator never enables invites. A future invite-only
channel would have to issue invites to the swarm key, or this separation would break it.

What the separate key does not hide:

- A directly connected peer still sees the node's own messages arrive first-hand, with the full hop count
  (`ttl` = `relayTtl`) and the earliest timing. That is enough to guess that the author of `soc/u/<key>` is behind
  that connection. Hiding this would need protocol changes such as random initial hop counts or delayed relaying.
- Upstream marks every relayed frame with the relaying node's identity key (`relayedBy`, unsigned, read by no
  receiver). Gator strips this stamp before relaying, so gator nodes do not name themselves to their neighbours.
  Other Intercom apps still add it.
- In bridge mode the host peer's own swarm configuration applies. If the host runs Hyperswarm with its peer key,
  the identity and the address stay linked.

## Events

| Transport | Events |
|---|---|
| all | `'message'(channel, envelope)`, `'peer'(count)` |
| Swarm, Memory | `'message'` also fires once for each successful own `send` |
| Bridge | `'send-error'(channel)`. `'close'({requested, code})` fires exactly once when the WebSocket closes (host gone, network error, failed handshake or authentication, or `close()`). `requested` is true after `close()`. A closed bridge cannot reopen: construct a new `BridgeTransport` and join again. |
