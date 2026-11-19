import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_KEY } from '@gator/bundle/src/root-key.js';
import { BridgeTransport, loadOrCreateKey, SwarmTransport } from '@gator/net';
import { defaultHandle, identityLockDir, lockIdentity, migrations, Social, withHarness } from '@gator/social';
import { openStore } from '@gator/store';
import { BridgeSession } from './bridge-session.js';
import { startControl, TOKEN_FILES } from './control.js';
import { acquireLock, createDataDir, readConfig, readPrivate, writeConfig } from './files.js';
import { createTools, profileEditor } from './tools.js';

export const PRODUCTS = ['dex', 'reset', 'dmw', 'gator'];
const DAY = 86_400_000;
const HOUR = 3_600_000;

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
const same = (a, b) => canonical(a ?? null) === canonical(b ?? null);

/** Bridge tokens travel in clear text over ws:, so a plain socket must stay on this machine. */
export function checkBridgeUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new TypeError('Invalid --bridge URL'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol === 'wss:' || (parsed.protocol === 'ws:' && loopback)) return parsed.href;
  throw new TypeError('--bridge must be ws://127.0.0.1:<port> (or wss:// for a remote host)');
}

/**
 * Start the social layer for one harness: transport, SQLite store, Social, hourly agent files, local control API.
 * Exactly one of: `transport` (tests, embedding), `bridge` (host peer's key over SC-Bridge) or neither (standalone:
 * own key in dataDir/keys/peer.json over Hyperswarm).
 * @param {{dataDir:string, product?:string, transport?:any, bridge?:{url:string, token?:string, tokenFile?:string},
 *   bootstrap?:Array<string|{host:string,port:number}>, rootKey?:string, agentPosting?:boolean,
 *   profile?:'small'|'normal'|'large', clock?:()=>number, proofs?:false|object, control?:boolean,
 *   lock?:boolean, identityLock?:false|{dir?:string}, log?:(level:string, message:string)=>void, onBridgeLost?:()=>void}} options
 *   identityLock: standalone mode locks its identity per user (one local process per identity); `{dir}` moves the lock
 *   directory, false skips it. With a custom transport it is taken only when given.
 */
export async function startAddon({ dataDir, product = 'gator', transport, bridge, bootstrap, rootKey = ROOT_KEY,
  agentPosting = false, profile, clock, proofs = {}, control = true, lock = true, identityLock, log = () => {},
  onBridgeLost = () => {} }) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('Expected a data directory');
  if (!PRODUCTS.includes(product)) throw new TypeError('--product must be one of ' + PRODUCTS.join(', '));
  if (transport && bridge) throw new TypeError('Pass a transport or a bridge, not both');
  createDataDir(dataDir);
  const cleanup = [];
  const close = async () => {
    for (const step of cleanup.splice(0).reverse()) {
      try { await step(); } catch (error) { log('warn', 'shutdown: ' + error.message); }
    }
  };
  try {
    if (lock) cleanup.push(acquireLock(dataDir));
    let mode = 'custom';
    if (!transport && bridge) {
      mode = 'bridge';
      const url = checkBridgeUrl(bridge.url);
      transport = new BridgeSession(() => new BridgeTransport({ url,
        token: bridge.token ?? (bridge.tokenFile ? readPrivate(bridge.tokenFile) : undefined) }), log);
      transport.on('close', ({ requested }) => {
        if (!requested) {
          log('warn', 'bridge connection lost, reconnecting');
          onBridgeLost();
        }
      });
      cleanup.push(() => transport.close());
      if (!await transport.ready) throw new Error('Bridge connection failed (host down, wrong URL or wrong token)');
    } else if (!transport) {
      mode = 'standalone';
      const wallet = await loadOrCreateKey(dataDir);
      if (identityLock !== false) {
        cleanup.push(lockIdentity(wallet.publicKey.toString('hex'),
          { dir: identityLock?.dir ?? identityLockDir(), harness: 'gator-social (' + product + ')', dataDir }));
      }
      // The Windows seen store checks the directory and lock identities before reclaiming a stale writer.
      if (lock && process.platform !== 'win32') rmSync(join(dataDir, 'seen', '.writer.lock'), { recursive: true, force: true });
      transport = new SwarmTransport({ dataDir, wallet, bootstrap, rootKey });
      cleanup.push(() => transport.close());
    }
    if (mode === 'custom' && identityLock) {
      cleanup.push(lockIdentity(transport.publicKey, { dir: identityLock.dir ?? identityLockDir(), harness: 'gator-social (' + product + ')', dataDir }));
    }
    const ownEcho = mode !== 'bridge';
    const store = openStore({ file: join(dataDir, 'social.db'), profile, migrations });
    cleanup.push(() => store.close());
    const social = new Social({ transport, db: store, rootKey, product, dataDir, clock, proofs });
    social.on('warning', error => log('warn', error.message));
    cleanup.push(() => social.close());
    if (mode === 'bridge') cleanup.push(() => transport.stopReconnecting());
    await social.ready;

    const me = social.publicKey;
    const saveCard = (card, topics) => {
      const { identity, ...config } = readConfig(dataDir);
      const { awaitCard, ...rest } = identity ?? {};
      writeConfig(dataDir, { ...config, ...(identity && { identity: rest }), card, topics });
    };
    // config.json holds this identity's newest card: the owner's edits and the cards other harnesses of the same
    // identity publish (adopted below). Without one, the stored signed card counts.
    const currentCard = () => readConfig(dataDir).card ?? social.card(me);
    const currentTopics = () => readConfig(dataDir).topics ?? social.topics(me) ?? [];
    const editProfile = profileEditor({ social, product, current: currentCard, currentTopics, save: saveCard });
    const publishCard = async (force = false) => {
      const config = readConfig(dataDir);
      let card = currentCard();
      // A fresh standalone identity gets the default card, as gator does, so it shows as an agent with its harness.
      // An imported identity without a card waits for its own (adopted when another harness publishes it).
      if (!card && mode === 'standalone' && !config.identity?.awaitCard) card = { handle: defaultHandle(me), harnesses: [] };
      if (!card) return false;
      const full = { ...card, harnesses: withHarness(card.harnesses, product) };
      const topics = currentTopics();
      if (!force && ownEcho && same(social.card(me), full) && same(social.topics(me) ?? [], topics)) return false;
      const sent = await social.setCard(full, { topics });
      if (sent) saveCard(full, topics);
      return sent;
    };
    // Another harness of this identity changed the card: adopt it, and add this product's tag if it is missing.
    social.on('own-card', ({ card, topics, sent }) => {
      if (sent || !card) return;
      const config = readConfig(dataDir);
      if (same(config.card, card) && same(config.topics ?? [], topics ?? config.topics ?? [])) return;
      saveCard(card, topics ?? config.topics ?? []);
      log('info', 'adopted the profile card another harness of this identity published');
      if (!withHarness(card.harnesses).includes(product)) {
        setImmediate(() => publishCard().catch(error => log('warn', 'profile card: ' + error.message)));
      }
    });
    social.on('elsewhere', ({ channel }) => log('warn', 'this identity is also active in another process (seen on ' + channel + ')'));
    await publishCard().catch(error => log('warn', 'profile card: ' + error.message));
    if (!ownEcho) {
      // The bridge cannot rebroadcast signed copies; publish a fresh card daily instead.
      const timer = setInterval(() => publishCard().catch(error => log('warn', 'profile card: ' + error.message)), DAY);
      timer.unref();
      cleanup.push(() => clearInterval(timer));
    }
    await social.writeAgentFiles();

    const tools = createTools({ social, product, agentPosting, ownEcho, saveCard, editProfile });
    const status = () => {
      const elsewhere = social.identityElsewhere(DAY);
      const { identity } = readConfig(dataDir);
      return {
        running: true, publicKey: social.publicKey, product, mode, agentPosting, peers: transport.peerCount?.() ?? 0,
        channels: transport.channels().length, agentFiles: join(dataDir, 'agent', 'social'), dataDir, pid: process.pid,
        ...(identity?.importedAt && { imported: { at: identity.importedAt, ...(identity.from && { from: identity.from }) } }),
        ...(elsewhere && {
          elsewhere: { lastSeen: new Date(elsewhere.lastSeen).toISOString(), channel: elsewhere.channel },
          warning: 'This identity also signed messages from another process' +
            (Date.now() - elsewhere.lastSeen < HOUR ? ' in the last hour' : ' today') +
            ' (another machine or harness). Expected if you imported it there on purpose; otherwise stop the other copy.',
        }),
      };
    };
    let controlInfo = null;
    if (control) {
      const server = await startControl({
        dataDir, tools, status,
        owner: {
          // {patch, topics?}: merged into the identity's newest card (omitted fields and topics keep).
          // {card, topics?}: the whole card (older clients); only other harnesses' tags are kept.
          async card({ card, patch, topics } = {}) {
            const edit = card ?? patch;
            if (!edit || typeof edit !== 'object' || Array.isArray(edit)) return { sent: false, error: 'Expected {patch} or {card}' };
            const editor = card === undefined ? editProfile : profileEditor({ social, product, currentTopics, save: saveCard,
              current: () => ({ harnesses: currentCard()?.harnesses ?? [] }) });
            try {
              return await editor(edit, card === undefined ? topics : topics ?? []);
            } catch (error) {
              if (error instanceof TypeError || error instanceof RangeError) return { sent: false, error: error.message };
              throw error;
            }
          },
        },
      });
      controlInfo = { port: server.port };
      cleanup.push(async () => {
        await server.close();
        rmSync(join(dataDir, 'control.json'), { force: true });
        for (const file of Object.values(TOKEN_FILES)) rmSync(join(dataDir, file), { force: true });
      });
    }
    return { social, transport, store, tools, mode, publicKey: social.publicKey, control: controlInfo, status, close };
  } catch (error) {
    await close();
    throw error;
  }
}
