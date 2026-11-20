import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { writeFiles } from './agents.js';
import { avatarRoom, parseAvatar } from './avatar.js';
import { CardProofs } from './proofs.js';
import { BOUNDS, DAY, FOLLOW_CAP, HOUR, PRODUCTS, isKey, lane, policyFor, settingsFor } from './policy.js';
import { LANE_LIMITS } from './retention.js';
import { FeedStore } from './storage.js';
import { isCard, validEnvelope, validMessage } from './validate.js';

export { migrations } from './schema.js';
export { AGENT_HEADER, AGENT_SECTION_MARKER } from './agents.js';
export { extractText } from './validate.js';
export { AVATAR_MAX_BYTES, AVATAR_RULE, AVATAR_SIZE, avatarHash, avatarRoom, imageInfo, isAvatar, parseAvatar, readAvatarFile } from './avatar.js';
export { cardProblem, cleanTopics, defaultHandle, editCard, MAX_HARNESSES, proofSteps, withHarness } from './card.js';
export { identityLockDir, lockIdentity } from './identity-lock.js';
export { IDENTITY_FORMAT, identityDocument, readIdentityDocument } from './identity-file.js';

// A message signed with this node's own key that this process did not send, signed within this window, means the
// identity is live in another process (another machine or harness). The network key is never on the wire
// (R-APP-15), so the signature is the evidence; old replays and our own copies do not count.
const ELSEWHERE_WINDOW = 10 * 60000;
const WANT_INTERVAL = 30 * 60000;
const ANSWER_INTERVAL = 10 * 60000;
const PUBLIC_SEEN_CAP = 1024;

/**
 * @typedef {{id:string, key:string}} PostRef
 * @typedef {{handle:string, harnesses:string[], name?:string, bio?:string, links?:string[],
 *   proofs?:{dns?:string, github?:string}, avatar?:string}} Card  avatar: base64 96×96 PNG/WebP ≤ 6 KB
 * @typedef {{id:string, channel:string, from:string, ts:number, message:object, sig?:string,
 *   origin?:string, ttl?:number, pow?:object}} Envelope
 * @typedef {EventEmitter & {publicKey:string, join:(channel:string, policy:object)=>Promise<boolean>,
 *   leave:(channel:string)=>Promise<boolean>, send:(channel:string, message:object)=>boolean,
 *   rebroadcast:(envelope:Envelope)=>boolean, channels:()=>string[], peerCount?:()=>number, setRelayTtl?:(ttl:number)=>void}} Transport
 * @typedef {import('node:sqlite').DatabaseSync} Database
 * @typedef {{writer:Database, reader:Database, profile:string, transaction:Function, onPrune?:Function, onEvict?:Function}} Store
 * @typedef {{scope?:'following'|'latest'|'official'|'mentions'|'directory'|'profile', key?:string,
 *   before?:number|(PostRef & {ts:number}), limit?:number}} TimelineOptions
 * @typedef {{profile?:'small'|'normal'|'large', directoryCap?:number, laneRows?:number, laneBytes?:number, laneRate?:number, windowMs?:number,
 * nearDuplicateMs?:number, rates?:{posts?:number, likes?:number, cards?:number, follows?:number}}} Limits
 */
const integer = (n, low, high, field) => {
  if (!Number.isSafeInteger(n) || n < low || n > high) throw new TypeError('Invalid ' + field);
  return n;
};
function keyCheck(key) { if (!isKey(key)) throw new TypeError('Expected a lowercase ed25519 public key'); }

/** One local identity and its subscriptions. Await ready before accessing the transport. */
export class Social extends EventEmitter {
  #joined = new Map();
  #transient = new Map();
  #unregisterPrune;
  #unregisterEvict;
  #queue = Promise.resolve();
  #closed = false;
  #closing;
  #timer;
  #store;
  #proofs;
  #settings;
  #onMessage;
  #own;
  #inbox;
  #fixed;
  #sending = 0;
  #elsewhere = null;
  #answer;
  #onFirstPeer;

  /**
   * @param {{transport:Transport, db:Store|Database, rootKey:string, product?:string|string[], dataDir:string,
   * clock?:(()=>number)|{now:()=>number}, limits?:Limits, useRootMutes?:boolean,
   * proofs?:false|{resolveTxt?:typeof import('node:dns/promises').resolveTxt|null, fetch?:typeof fetch}}} options
   */
  constructor({ transport, db, rootKey, product = 'gator', dataDir, clock = Date.now, limits = {}, useRootMutes, proofs = {} }) {
    super();
    keyCheck(rootKey);
    keyCheck(transport.publicKey);
    if (!dataDir || typeof dataDir !== 'string') throw new TypeError('Expected a data directory');
    this.publicKey = transport.publicKey;
    this.transport = transport;
    this.rootKey = rootKey;
    this.dataDir = dataDir;
    this.now = typeof clock.now === 'function' ? () => clock.now() : clock;
    const profile = limits.profile ?? db.profile ?? 'normal';
    if (!Object.hasOwn(FOLLOW_CAP, profile)) throw new TypeError('Unknown machine profile');
    this.followCap = FOLLOW_CAP[profile];
    this.limits = {
      followCap: this.followCap,
      directoryCap: integer(limits.directoryCap ?? 5000, 1, 50000, 'directory cap'),
      windowMs: integer(limits.windowMs ?? 600000, 1, DAY, 'rate window'),
      nearDuplicateMs: integer(limits.nearDuplicateMs ?? 600000, 0, DAY, 'near duplicate window'),
      rates: { ...limits.rates }
    };
    for (const [name, max] of Object.entries(LANE_LIMITS[profile])) {
      this.limits[name] = integer(limits[name] ?? max, 1, max, name);
    }
    for (const [name, value] of Object.entries(this.limits.rates)) {
      if (!Object.hasOwn(BOUNDS.rates, name)) throw new TypeError('Unknown rate');
      integer(value, 1, BOUNDS.rates[name][2], 'local rate');
    }
    this.#store = new FeedStore(db, this.publicKey, this.limits, rootKey, this.now);
    this.#proofs = new CardProofs(this.#store, proofs === false ? { resolveTxt: null } : proofs, this.now);
    this.#settings = settingsFor(this.#store.state('net'));
    if (useRootMutes !== undefined) this.setUseRootMutes(useRootMutes);
    this.#own = 'soc/u/' + this.publicKey;
    this.#inbox = 'soc/r/' + this.publicKey;
    const products = Array.isArray(product) ? product : [product];
    if (products.some(p => !PRODUCTS.includes(p))) throw new TypeError('Unknown product');
    this.#fixed = ['soc/official', this.#own, this.#inbox, 'soc/dir', 'soc/all', ...products.flatMap(p => ['soc/p/' + p, 'soc/pr/' + p])];
    this.#onMessage = (channel, envelope) => this.#receive(channel, envelope);
    transport.on('message', this.#onMessage);
    this.ready = this.#enqueue(async () => {
      try {
        this.#store.transaction(() => {
          this.#store.removeReservedCards();
          this.#store.initializeContacts(this.now());
          this.#store.prune(this.now());
          this.#store.retention.initialize();
        });
        await this.#sync();
        // A broadcast to zero peers has only a local echo. Wait for discovery on an isolated start.
        if (!this.#closed && transport.peerCount?.() === 0) {
          this.#onFirstPeer = count => {
            if (!count) return;
            transport.off('peer', this.#onFirstPeer);
            this.#enqueue(() => this.#requestPosts()).catch(err => this.#warn(err));
          };
          transport.on('peer', this.#onFirstPeer);
        } else if (!this.#closed) await this.#requestPosts();
      } catch (err) {
        transport.off('message', this.#onMessage);
        clearTimeout(this.#answer?.timer);
        this.#answer = null;
        for (const channel of this.#joined.keys()) await this.#leave(channel);
        throw err;
      }
      this.#unregisterPrune = db.onPrune?.((_writer, { now }) => this.#store.prune(now));
      this.#unregisterEvict = db.onEvict?.((_writer, pressure) => this.#store.retention.pressure(pressure));
      this.#timer = setInterval(() => this.maintain().catch(err => this.#warn(err)), HOUR);
      this.#timer.unref();
    });
  }

  #warn(err) {
    this.lastError = err;
    this.emit('warning', err);
  }
  #enqueue(fn) {
    if (this.#closed) return Promise.reject(new Error('Social is closed'));
    const job = this.#queue.then(fn);
    this.#queue = job.catch(() => {});
    return job;
  }
  #rates() {
    const rates = { ...this.#settings.rates };
    for (const [key, value] of Object.entries(this.limits.rates)) {
      rates[key] = this.#settings.seq < 0 ? value : Math.min(value, rates[key]);
    }
    return rates;
  }
  #desired() {
    return new Set([...this.#fixed, ...this.#store.activeFollows().map(r => 'soc/u/' + r.key)]);
  }
  async #join(channel) {
    const policy = policyFor(channel, this.rootKey, this.#settings);
    const signature = JSON.stringify(policy);
    if (this.#joined.get(channel) === signature) return;
    if (this.#joined.has(channel)) await this.#leave(channel);
    this.#joined.set(channel, signature);
    try {
      if (!await this.transport.join(channel, policy)) throw new Error('Social channel join failed: ' + channel);
    } catch (err) { this.#joined.delete(channel); throw err; }
  }
  async #leave(channel) {
    if (!await this.transport.leave(channel) && this.transport.channels().includes(channel)) {
      throw new Error('Social channel leave failed: ' + channel);
    }
    this.#joined.delete(channel);
  }
  async #sync() {
    const channels = this.#desired();
    for (const channel of this.#transient.keys()) channels.add(channel);
    for (const channel of this.#joined.keys()) if (!channels.has(channel)) await this.#leave(channel);
    // Parallel: each join announces on the DHT, and a dozen in a row took tens of seconds at startup.
    const results = await Promise.allSettled([...channels].map(channel => this.#join(channel)));
    const failed = results.find(r => r.status === 'rejected');
    if (failed) throw failed.reason;
    if (this.#settings.seq >= 0) await this.transport.setRelayTtl?.(this.#settings.relayTtl);
    if (this.#settings.seq >= 0 && this.#settings.relays) this.transport.setRelays?.(this.#settings.relays);
  }
  #receive(channel, envelope) {
    if (this.#closed || !this.#joined.has(channel) ||
        this.#joined.get(channel) !== JSON.stringify(policyFor(channel, this.rootKey, this.#settings)) ||
        (this.#transient.has(channel) && envelope?.from !== this.publicKey) ||
        !validEnvelope(channel, envelope, this.rootKey, this.#settings)) return;
    const now = this.now();
    // Cards, announcements and root controls retain their signed time on rebroadcast.
    const fresh = e => e.ts <= now + 5 * 60000 && (e.channel === 'soc/official' ||
      ['card', 'announce'].includes(e.message.t) || e.ts >= now - 30 * DAY);
    if (!fresh(envelope)) return;
    if (envelope.from === this.publicKey && channel !== 'soc/all') this.#noticeElsewhere(envelope, now);
    let e = envelope;
    if (e.message.t === 'want') {
      if (e.from !== this.publicKey && !this.#store.hidden(e.from) &&
          this.#store.transaction(() => this.#store.retention.admit('public', now))) {
        this.#scheduleAnswer(now, e.message.since);
      }
      return;
    }
    if (e.message.t === 'share') {
      e = e.message.original;
    } else if (e.message.t === 'mention') {
      if (channel !== this.#inbox || !this.#store.mayMention(envelope.from, now) || !this.#store.mentionsMe(e.message.original.message.text)) return;
      e = e.message.original;
    }
    if (!fresh(e) || (e.message.original && !fresh(e.message.original))) return;
    if (envelope.message.t === 'share' && this.#answer) {
      const seen = this.#answer.seen;
      const key = e.from + '/' + e.id;
      seen.delete(key);
      seen.set(key, now);
      if (seen.size > PUBLIC_SEEN_CAP) seen.delete(seen.keys().next().value);
    }
    const result = this.#store.transaction(() => {
      if (envelope.message.t === 'share' && envelope.from === this.publicKey && e.from === this.publicKey) {
        this.#store.saveShare(envelope, now);
      }
      return this.#store.receive(e, now, this.#rates(), lane(channel));
    });
    if (result?.settingsChanged) {
      this.#settings = settingsFor(e.message);
      this.#enqueue(() => this.#sync()).catch(err => this.#warn(err));
    }
    if (result?.proofKey) this.#proofs.check(result.proofKey, { followedOnly: true }).catch(err => this.#warn(err));
    if (e.from === this.publicKey && ['card', 'announce'].includes(e.message.t)) {
      // Another harness of this identity may have changed the card; consumers keep their copy current.
      this.emit('own-card', { card: this.card(this.publicKey), topics: this.topics(this.publicKey), sent: this.#sending > 0 });
    }
    if (!result?.ref) return;
    const row = this.#store.sql('SELECT * FROM posts WHERE key=? AND id=?').get(result.ref.key, result.ref.id);
    if (!row) return; // The inbound lane can be smaller than one post.
    // Queue forwarding before notifying consumers. Only the author's first, signed own-lane copy fans out.
    if (channel === this.#own) {
      if (this.#sending && e.message.t === 'post') this.#enqueue(() => this.#share(e)).catch(err => this.#warn(err));
      this.#enqueue(() => this.#fanout(e, result.mentioned)).catch(err => this.#warn(err));
    }
    const post = this.#store.present(row);
    this.emit('post', post);
    if (e.message.t === 'notice') this.emit('notice', post);
    if (result.mention) this.emit('mention', post);
  }

  async #send(channel, message, mirror = false) {
    if (!validMessage(message, this.publicKey, this.rootKey)) throw new TypeError('Invalid social ' + message.t);
    if (!mirror && !this.#store.canSend(this.publicKey, message, this.now(), this.#rates())) return false;
    if (Buffer.byteLength(JSON.stringify(message)) > policyFor(channel, this.rootKey, this.#settings).maxReceiveBytes) return false;
    if (!this.#fixed.includes(channel) && (!this.#joined.has(channel) || this.#transient.has(channel))) await this.#holdForSend(channel);
    else await this.#join(channel);
    // Swarm and memory transports echo the signed copy synchronously inside send().
    this.#sending++;
    try { return this.transport.send(channel, message); }
    finally { this.#sending--; }
  }
  #noticeElsewhere(e, now) {
    if (this.#sending || e.ts < now - ELSEWHERE_WINDOW || e.ts > now + ELSEWHERE_WINDOW) return;
    if (this.#store.sql('SELECT 1 FROM social_seen WHERE key=? AND id=?').get(e.from, e.id)) return;
    const first = !this.#elsewhere;
    this.#elsewhere = { lastSeen: now, channel: e.channel, type: e.message?.t ?? null };
    if (first) this.emit('elsewhere', { ...this.#elsewhere });
  }
  // Intercom may finish opening a remote mux after send() returns. Give a one-off reply
  // lane time to flush while bounding the number of extra channel sessions.
  async #holdForSend(channel) {
    const old = this.#transient.get(channel);
    if (old) clearTimeout(old);
    else if (this.#transient.size >= 8) {
      const [eldest, timer] = this.#transient.entries().next().value;
      clearTimeout(timer);
      this.#transient.delete(eldest);
      await this.#leave(eldest);
    }
    const timer = setTimeout(() => {
      if (!this.#closed) this.#enqueue(async () => {
        if (this.#transient.get(channel) !== timer) return;
        this.#transient.delete(channel);
        if (this.#joined.has(channel)) await this.#leave(channel);
      }).catch(err => this.#warn(err));
    }, 30000);
    timer.unref();
    this.#transient.delete(channel);
    this.#transient.set(channel, timer);
    try { await this.#join(channel); }
    catch (err) {
      clearTimeout(timer);
      this.#transient.delete(channel);
      throw err;
    }
  }
  async #fanout(e, mentioned) {
    const m = e.message;
    const recipient = m.parent?.key ?? m.target?.key;
    if (recipient && ['reply', 'repost'].includes(m.t)) {
      const row = this.#store.sql('SELECT channel FROM posts WHERE key=? AND id=?').get(recipient, (m.parent ?? m.target).id);
      const channel = m.t === 'reply' && row?.channel.startsWith('soc/p/') ?
        'soc/pr/' + row.channel.slice(6) : 'soc/r/' + recipient;
      const copy = m.t === 'repost' ? { t: 'repost', v: 1, target: m.target } : { ...m };
      if (!await this.#send(channel, { ...copy, sourceId: e.id }, true)) this.#warn(new Error('Reply lane send failed: ' + channel));
    }
    for (const key of mentioned) {
      if (key !== this.publicKey && key !== recipient && !this.#store.hidden(key)) {
        if (!await this.#send('soc/r/' + key, { t: 'mention', v: 1, original: e }, true)) this.#warn(new Error('Mention send failed: ' + key));
      }
    }
  }
  async #share(original) {
    try {
      if (!await this.#send('soc/all', { t: 'share', v: 1, original }, true)) this.#warn(new Error('Public share send failed'));
    } catch (err) { this.#warn(err); }
  }
  async #requestPosts({ onlyIfEmpty = false } = {}) {
    const now = this.now();
    if (this.#closed || this.transport.peerCount?.() === 0 ||
        now - (this.#store.state('publicWantAt') ?? -Infinity) < WANT_INTERVAL) return;
    if (onlyIfEmpty && this.#store.timeline({ scope: 'latest', limit: 1 }).length) return;
    try {
      if (await this.#send('soc/all', { t: 'want', v: 1 }, true)) this.#store.setState('publicWantAt', now);
    } catch (err) { this.#warn(err); }
  }
  #scheduleAnswer(at, since = 0) {
    if (this.#answer || at - (this.#store.state('publicAnswerAt') ?? -Infinity) < ANSWER_INTERVAL) return;
    const answer = { seen: new Map() };
    this.#answer = answer;
    answer.timer = setTimeout(() => {
      this.#enqueue(async () => {
        try {
          const now = this.now();
          if (this.#closed || now - at >= HOUR) return;
          let answering = false;
          for (const row of this.#store.recentPublicPosts(Math.max(since, now - 7 * DAY))) {
            if (this.#closed || answer.seen.get(row.key + '/' + row.id) >= at) continue;
            if (!answering) {
              this.#store.setState('publicAnswerAt', now);
              answering = true;
            }
            await this.#share(JSON.parse(row.envelope));
          }
        } finally { this.#answer = null; }
      }).catch(err => this.#warn(err));
    }, 2000 + Math.floor(Math.random() * 10001));
    answer.timer.unref();
  }
  async #publish(fn) {
    await this.ready;
    const sent = await this.#enqueue(fn);
    await this.#queue; // Includes fan-out scheduled by synchronous local delivery.
    return sent;
  }
  #reference(value) {
    const ref = this.#store.ref(value);
    if (!ref) throw new TypeError('Unknown or ambiguous post id');
    return ref;
  }

  /** Publish a signed profile card and a directory announcement.
   * @param {Card} card @param {{topics?:string[]}} [options] @returns {Promise<boolean>} */
  async setCard(card, { topics } = {}) {
    // A card update from any harness keeps the identity's directory topics unless it names new ones.
    topics ??= this.topics(this.publicKey) ?? [];
    // Older harnesses supply this exact generated default on first start.
    if (this.publicKey !== this.rootKey && [8, 12].some(n => card?.handle === 'gator_' + this.publicKey.slice(0, n))) {
      card = { ...card, handle: 'peer_' + card.handle.slice(6) };
    }
    if (!isCard(card, this.publicKey, this.rootKey)) throw new TypeError('Invalid social card');
    const announce = { t: 'announce', v: 1, channel: this.#own, card, topics };
    if (!validMessage(announce, this.publicKey, this.rootKey)) throw new TypeError('Invalid directory announcement');
    if (card.avatar && parseAvatar(card.avatar).bytes.length > this.avatarRoom(card, { topics })) {
      throw new RangeError('The avatar does not fit into the signed card; use a smaller image');
    }
    return this.#publish(async () => {
      const sent = await this.#send(this.#own, { ...card, t: 'card', v: 1 });
      return sent && this.#send('soc/dir', announce);
    });
  }
  /** @param {string} text @param {{tags?:string[], tickers?:{sym:string,asset?:string}[], quote?:PostRef}} [opts] */
  async post(text, opts = {}) {
    return this.#publish(() => this.#send(this.#own, { ...opts, t: 'post', v: 1, text }));
  }
  /** @param {PostRef|string} parent @param {string} text */
  async reply(parent, text) {
    return this.#publish(() => this.#send(this.#own, { t: 'reply', v: 1, parent: this.#reference(parent), text }));
  }
  /** @param {PostRef|string} target */
  async like(target) {
    return this.#publish(() => {
      const ref = this.#reference(target);
      return this.#send('soc/r/' + ref.key, { t: 'like', v: 1, target: ref });
    });
  }
  /** @param {PostRef|string} target */
  async repost(target) {
    return this.#publish(() => {
      const ref = this.#reference(target);
      const row = this.#store.visibleEnvelope(ref);
      if (!row) throw new TypeError('A repost requires a locally witnessed original');
      const original = JSON.parse(row.envelope);
      if (original.message.t === 'repost') {
        const target = original.message.target;
        const cached = this.#store.visibleEnvelope(target);
        const source = original.message.original ?? (cached && JSON.parse(cached.envelope));
        if (!source) throw new TypeError('The original of this repost has not arrived');
        return this.#send(this.#own, { t: 'repost', v: 1, target, original: source });
      }
      return this.#send(this.#own, { t: 'repost', v: 1, target: ref, original });
    });
  }
  async follow(key) {
    keyCheck(key);
    return this.#publish(async () => {
      if (key === this.publicKey || this.#store.sql('SELECT 1 FROM follows WHERE key=?').get(key)) return false;
      if (this.#store.sql('SELECT count(*) n FROM follows').get().n >= this.followCap) throw new RangeError('Follow cap reached');
      await this.#join('soc/u/' + key);
      try { this.#store.sql('INSERT INTO follows VALUES(?)').run(key); }
      catch (err) { await this.#sync(); throw err; }
      this.#proofs.check(key, { followedOnly: true }).catch(err => this.#warn(err));
      // The subscription is durable even if its optional public announcement fails.
      try { await this.#send(this.#own, { t: 'follow', v: 1, key }); }
      catch (err) { this.#warn(err); }
      return true;
    });
  }
  async unfollow(key) {
    keyCheck(key);
    return this.#publish(async () => {
      if (!this.#store.sql('SELECT 1 FROM follows WHERE key=?').get(key)) return false;
      const channel = 'soc/u/' + key;
      if (this.#joined.has(channel)) await this.#leave(channel);
      try { this.#store.sql('DELETE FROM follows WHERE key=?').run(key); }
      catch (err) { await this.#sync(); throw err; }
      // A profile downgrade can leave saved subscriptions waiting for a slot.
      await this.#sync();
      return true;
    });
  }
  mute(key) {
    keyCheck(key);
    return !!this.#store.sql('INSERT OR IGNORE INTO mutes VALUES(?)').run(key).changes;
  }
  unmute(key) {
    keyCheck(key);
    return !!this.#store.sql('DELETE FROM mutes WHERE key=?').run(key).changes;
  }
  setUseRootMutes(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Expected a boolean');
    this.#store.setState('useRootMutes', enabled);
  }
  /** @param {TimelineOptions} [options] */
  timeline(options) { return this.#store.timeline(options); }
  thread(id) { return this.#store.thread(id); }
  /** Renderers can read cached cards. An explicit profile view may request a refresh. */
  profile(key, { verify = false } = {}) {
    keyCheck(key);
    if (verify) this.#proofs.check(key).catch(err => this.#warn(err));
    return this.#store.profile(key);
  }
  resolveHandle(handle) { return this.#store.resolveHandle(handle); }
  /** Directory topics of a key's newest announcement, or null. */
  topics(key) {
    keyCheck(key);
    const row = this.#store.sql('SELECT topics FROM directory WHERE key=?', this.#store.reader).get(key);
    return row ? JSON.parse(row.topics) : null;
  }
  /** When this identity was last seen signing in another process: {lastSeen, channel, type} or null.
   * @param {number} [withinMs] only report sightings this recent */
  identityElsewhere(withinMs = Infinity) {
    const seen = this.#elsewhere;
    return seen && this.now() - seen.lastSeen <= withinMs ? { ...seen } : null;
  }
  /** The stored signed card of a key as published (with an inline base64 avatar), or null. */
  card(key) {
    keyCheck(key);
    return this.#store.card(key);
  }
  /** A stored avatar by SHA-256: {type, bytes, base64, hash, width, height} or null. */
  avatar(hash) { return this.#store.avatar(hash); }
  /** Raw avatar bytes that still fit beside this card (without its avatar) under the current card size caps. */
  avatarRoom(card, { topics = [] } = {}) {
    return avatarRoom(card ?? {}, this.#own, topics, Math.min(this.#settings.caps.owner, this.#settings.caps.directory));
  }
  directory(options) { return this.#store.directory(options); }
  counts(id) { return this.#store.counts(id); }
  networkSettings() { return structuredClone(this.#settings); }

  /** Recheck a known card now using the configured proof providers. */
  verifyProofs(key) {
    keyCheck(key);
    return this.#proofs.check(key, { force: true });
  }
  /** Write dir/social/*.md, defaulting to dataDir/agent/social/*.md. */
  writeAgentFiles(dir = join(this.dataDir, 'agent')) {
    return this.#enqueue(() => writeFiles(this.#store, dir));
  }
  /** Also callable with an injected clock for deterministic maintenance. */
  maintain() {
    return this.#enqueue(async () => {
      const now = this.now();
      this.#store.transaction(() => this.#store.prune(now));
      try {
        await this.#sync();
        await this.#requestPosts({ onlyIfEmpty: true });
        for (const row of this.#store.sql('SELECT * FROM social_outbox ORDER BY ts DESC,slot').all()) {
          if (row.last_sent > now - (row.slot === 'card' ? 6 * HOUR : DAY)) continue;
          if (this.transport.rebroadcast(JSON.parse(row.envelope))) {
            this.#store.sql('UPDATE social_outbox SET last_sent=? WHERE slot=? AND envelope=?').run(now, row.slot, row.envelope);
          }
        }
      } finally {
        await writeFiles(this.#store, join(this.dataDir, 'agent'));
      }
    });
  }
  /** Release social subscriptions. The owning harness closes its shared db and transport. */
  close() {
    if (!this.#closing) {
      this.#closed = true;
      if (this.#onFirstPeer) this.transport.off('peer', this.#onFirstPeer);
      clearTimeout(this.#answer?.timer);
      this.#answer = null;
      this.#proofs.close();
      this.transport.off('message', this.#onMessage);
      this.#closing = this.#queue.then(async () => {
        clearInterval(this.#timer);
        this.#unregisterPrune?.();
        this.#unregisterEvict?.();
        for (const timer of this.#transient.values()) clearTimeout(timer);
        this.#transient.clear();
        for (const channel of this.#joined.keys()) await this.#leave(channel);
      });
    }
    return this.#closing;
  }
}
