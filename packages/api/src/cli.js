import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { keyFromSeed, loadOrCreateKey, SwarmTransport } from '@gator/net';
import { identityDocument } from '@gator/social';
import { verifyRelease } from './bundle.js';
import { daemonPort, httpClient } from './client.js';
import { defaultDir, DEFAULT_PORT } from './local.js';

const usage = `gator start [--data DIR] [--port PORT] [--profile small|normal|large] [--blind-relay-serve] [--blind-relay KEY,...]
gator status | stop | open [--print] | key | doctor | bundle verify
gator version [--latest]
gator key export --out FILE --yes   (secret identity file for gator-social key import; 0600, never printed)
gator price <asset-or-symbol> | search <query> | feed | post <text> | follow <key|@handle>
gator mcp
gator root patch --ops OPS.json --seed-file FILE [--out PATCH.json] [--seq N] [--from-release]
gator root publish --seed-file FILE --patch PATCH.json [--wait SECONDS]
gator root feed --data DIR --out FILE
All commands accept --data DIR or GATOR_DATA.`;

async function listening(port) {
  return new Promise(ok => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = value => { socket.destroy(); ok(value); };
    socket.setTimeout(1500, () => done(false));
    socket.once('connect',() => done(true));
    socket.once('error',() => done(false));
  });
}
async function doctor(dataDir, port) {
  const [major,minor] = process.versions.node.split('.').map(Number);
  const result = { node: process.version, nodeSupported: major > 22 || major === 22 && minor >= 13,
    dataDir, directoryMode: null, privateDirectory: false, port: daemonPort(dataDir,port) };
  try {
    const stat = statSync(dataDir);
    result.directoryMode = (stat.mode & 0o777).toString(8);
    result.privateDirectory = stat.isDirectory() && (process.platform === 'win32' || !(stat.mode & 0o077));
  } catch { /* Uninitialized data directory. */ }
  result.listening = await listening(result.port);
  try { result.bundle = { verified: true, digest: (await verifyRelease()).digest }; }
  catch (e) { result.bundle = { verified: false, error: e.message }; }
  result.connectivity = null;
  if (result.listening) {
    try { result.connectivity = await httpClient(dataDir,{ port })('GET','/network'); } catch { /* Another listener or no matching credentials. */ }
  }
  return result;
}
async function openBrowser(url) {
  const [file,...args] = process.platform === 'darwin' ? ['/usr/bin/open',url] : process.platform === 'win32'
    ? ['rundll32.exe','url.dll,FileProtocolHandler',url] : ['xdg-open',url];
  await new Promise((ok,fail) => {
    const child = spawn(file,args,{ stdio:'ignore',detached:true });
    child.once('error',fail);
    child.once('spawn',() => { child.unref(); ok(); });
  });
}

/** The identity's newest signed card and directory announcement, read-only from gator.db (public, signed copies). */
function ownCardEnvelopes(dir, key) {
  const file = join(dir, 'gator.db');
  if (!existsSync(file)) return {};
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const found = {};
    for (const { slot, envelope } of db.prepare("SELECT slot,envelope FROM social_outbox WHERE slot IN ('card','announce')").all()) {
      const e = JSON.parse(envelope);
      if (e?.from === key) found[slot] = e;
    }
    return found;
  } catch { return {}; } finally { db?.close(); }
}

/** `gator key export`: the identity (Intercom keystore) plus its newest signed card, so another harness
 * (`gator-social key import`) runs the same account with the same profile. Owner only; the secret goes only into
 * the new 0600 file (never printed, never overwrites a file). */
async function exportKey(dir, values, print) {
  if (!values.out) throw new Error('Usage: gator key export --out FILE --yes');
  const out = resolve(values.out);
  if (values.yes !== true) {
    throw new Error(`key export writes this node's secret identity key to ${out}. Whoever holds that file can post as you. ` +
      'Add --yes to confirm. Import it with gator-social key import FILE --yes, then delete the file.');
  }
  const keyFile = join(dir, 'keys', 'peer.json');
  if (!existsSync(keyFile)) throw new Error('No identity in ' + dir + ' yet (gator start creates it)');
  const publicKey = (await loadOrCreateKey(dir)).publicKey.toString('hex'); // checks the keystore decrypts
  const { card, announce } = ownCardEnvelopes(dir, publicKey);
  const doc = identityDocument({ publicKey, keystore: JSON.parse(readFileSync(keyFile, 'utf8')), card, announce, harness: 'gator' });
  try {
    writeFileSync(out, JSON.stringify(doc) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(out + ' exists; choose a new file name');
    throw error;
  }
  return print({ exported: true, publicKey, out, card: !!(card || announce),
    next: 'gator-social key import ' + out + ' --yes (one identity runs in one process per machine)' });
}

/** Root tool (owner of the compiled ROOT_KEY only). `patch` signs ops against the current effective bundle: the
 * verified release plus the chain stored in the data directory. `publish` joins gator/ctl with the root identity from
 * a temporary data directory (no daemon needed) and sends the message once. The seed file is read in-process and
 * never printed, logged or written anywhere. */
async function root(sub, values, dir, io, print) {
  const tool = await import('../../engine/src/patches/root.js');
  const release = await verifyRelease(io.release);
  const seedFile = values['seed-file'];
  if (sub === 'feed' && values.out) {
    return print(tool.exportRootFeed({ dataDir: dir, out: resolve(values.out), release: release.bundle, rootKey: release.rootKey }));
  }
  if (sub === 'patch' && values.ops && seedFile) {
    const ops = JSON.parse(readFileSync(resolve(values.ops), 'utf8'));
    const seq = values.seq === undefined ? undefined : Number(values.seq);
    const stored = tool.readStoredChain(dir);
    const seed = tool.readSeedFile(resolve(seedFile));
    let built;
    try {
      built = tool.buildRootPatch({ release: release.bundle, releaseDigest: release.digest, stored, ops, seed,
        rootKey: release.rootKey, seq, fromRelease: values['from-release'] === true });
    } finally { seed.fill(0); }
    const { message } = built;
    const summary = { seq: message.seq, baseDigest: message.patch.baseDigest, newDigest: message.patch.newDigest,
      ops: message.patch.ops.length, chain: built.chain, stored: built.stored };
    if (!values.out) return print(message);
    writeFileSync(resolve(values.out), JSON.stringify(message, null, 2) + '\n');
    return print({ ...summary, out: resolve(values.out) });
  }
  if (sub === 'publish' && values.patch && seedFile) {
    const wait = values.wait === undefined ? 30 : Number(values.wait);
    if (!Number.isFinite(wait) || wait <= 0 || wait > 600) throw new Error('Invalid --wait (1 to 600 seconds)');
    const message = JSON.parse(readFileSync(resolve(values.patch), 'utf8'));
    const seed = tool.readSeedFile(resolve(seedFile));
    let wallet;
    try {
      if (tool.seedPublicKey(seed) !== release.rootKey) throw new Error('The seed file does not belong to the root key');
      wallet = keyFromSeed(seed.toString('hex'));
    } finally { seed.fill(0); }
    const temp = mkdtempSync(join(tmpdir(), 'gator-root-'));
    let transport;
    try {
      const options = { dataDir: temp, wallet, rootKey: release.rootKey };
      transport = io.transport ? io.transport(options) : new SwarmTransport(options);
      const { peers } = await tool.publishRootPatch({ message, transport, rootKey: release.rootKey,
        wait: wait * 1000, linger: io.linger });
      return print({ sent: true, seq: message.seq, newDigest: message.patch.newDigest, peers });
    } finally {
      try { await transport?.close(); } finally { rmSync(temp, { recursive: true, force: true }); }
    }
  }
  throw new Error(usage);
}

/** Foreground CLI. No command prints a reusable credential. `open` hands a one-time sign-in ticket to the browser and
 * prints it only for `--print` in an interactive terminal (R-APP-06). `io` is for in-process tests only (`release`
 * and `transport` are fixture seams, never read from settings).
 * @param {string[]} argv @param {{stdin?:{isTTY?:boolean}, stdout?:{isTTY?:boolean}, log?:(line:string)=>void,
 *   launch?:(url:string)=>Promise<void>, release?:{dir:string, rootKey:string}, transport?:(options:object)=>object,
 *   linger?:number}} [io] */
export async function main(argv, io = {}) {
  const { stdin = process.stdin, stdout = process.stdout, log = line => console.log(line), launch = openBrowser } = io;
  const { values, positionals: [command,...args] } = parseArgs({ args: argv, allowPositionals: true,
    options: { data:{ type:'string' }, port:{ type:'string' }, profile:{ type:'string' }, print:{ type:'boolean' },
      browser:{ type:'boolean' }, help:{ type:'boolean', short:'h' }, ops:{ type:'string' }, 'seed-file':{ type:'string' },
      out:{ type:'string' }, patch:{ type:'string' }, seq:{ type:'string' }, wait:{ type:'string' },
      'from-release':{ type:'boolean' }, yes:{ type:'boolean' },
      latest:{ type:'boolean' },
      'blind-relay-serve':{ type:'boolean' }, 'blind-relay':{ type:'string' } } });
  if (values.help || !command) { log(usage); return; }
  const dir = values.data ? resolve(values.data) : defaultDir();
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Invalid port');
  const request = httpClient(dir,{ port });
  const print = data => log(JSON.stringify(data,null,2));
  switch (command) {
    case 'version': {
      const { version } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
      if (!values.latest) return print({ version });
      const response = await fetch('https://api.github.com/repos/Trac-Systems/intercom-gator/releases/latest', {
        headers: { accept: 'application/vnd.github+json' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('GitHub release lookup failed (HTTP ' + response.status + ')');
      const { tag_name: latest } = await response.json();
      if (typeof latest !== 'string' || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(latest)) {
        throw new Error('Unexpected release tag from GitHub');
      }
      return print({ version, latest });
    }
    case 'start': {
      const { createGator } = await import('./app.js');
      // A public node relays encrypted links for peers that cannot connect directly (GATOR_BLIND_RELAY_SERVE=1 too).
      const blindRelayServe = values['blind-relay-serve'] === true || process.env.GATOR_BLIND_RELAY_SERVE === '1';
      const blindRelays = values['blind-relay'] ? values['blind-relay'].split(',').map(k => k.trim()).filter(Boolean) : undefined;
      const app = await createGator({ dataDir: dir, port: port ?? DEFAULT_PORT, config: values.profile ? { profile: values.profile } : {},
        blindRelayServe, blindRelays });
      log('Gator listening on http://127.0.0.1:' + app.port + '. Run gator open to sign in.');
      return;
    }
    // Its own credential: stopping (for example before an update) never needs the owner token.
    case 'stop': return print(await httpClient(dir,{ port, credential:'stop' })('POST','/stop',{},{}));
    case 'status': {
      const [me, network] = await Promise.all([request('GET','/me'), request('GET','/network')]);
      return print({ running: true, port: daemonPort(dir,port), key: me.key, profile: me.profile, network });
    }
    case 'open': {
      // Owner only. Agents must never run this (SKILL.md). Check the terminal before touching any credential.
      if (values.print && !(stdin.isTTY && stdout.isTTY)) {
        throw new Error('open --print shows a sign-in link only in an interactive terminal. Run it yourself, or run gator open to use the browser.');
      }
      const { ticket } = await httpClient(dir,{ port, credential:'owner' })('POST','/login-ticket',{},{});
      const url = 'http://127.0.0.1:' + daemonPort(dir,port) + '/auth?t=' + ticket;
      if (values.print) { log(url); log('One-time link, valid for 60 seconds.'); return; }
      try { await launch(url); }
      catch { throw new Error('Could not open a browser. In your own terminal run gator open --print.'); }
      log('Opened the dashboard sign-in in your browser.');
      return;
    }
    case 'key': {
      if (args.length === 1 && args[0] === 'export') return exportKey(dir, values, print);
      if (args.length) break;
      const wallet = await loadOrCreateKey(dir);
      log(wallet.publicKey.toString('hex'));
      return;
    }
    case 'bundle':
      if (args.length === 1 && args[0] === 'verify') return print({ verified: true, digest: (await verifyRelease()).digest });
      break;
    case 'doctor': {
      const state = await doctor(dir,port);
      print(state);
      if (!state.nodeSupported || !state.bundle.verified || !state.privateDirectory || state.listening && !state.connectivity) process.exitCode = 1;
      return;
    }
    case 'price':
      if (args.length) return print(await request('GET','/assets/' + encodeURIComponent(args.join(' ')) + '/price'));
      break;
    case 'search':
      if (args.length) return print(await request('GET','/search',{ q: args.join(' ') }));
      break;
    case 'feed': return print(await request('GET','/feed'));
    case 'post':
      if (args.length) return print(await request('POST','/posts',{},{ text: args.join(' ') }));
      break;
    case 'follow':
      if (args.length === 1) return print(await request('POST','/follow',{},{ key: args[0] }));
      break;
    case 'root':
      if (args.length === 1) return root(args[0], values, dir, io, print);
      break;
    case 'mcp': {
      const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
      const { createMcpServer } = await import('./mcp.js');
      await createMcpServer(request).connect(new StdioServerTransport());
      return;
    }
  }
  throw new Error(usage);
}
