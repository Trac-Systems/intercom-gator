import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT_KEY } from '@gator/bundle/src/root-key.js';
import { AVATAR_RULE, cardProblem, cleanTopics, editCard, identityLockDir, parseAvatar, proofSteps, readAvatarFile } from '@gator/social';
import { PRODUCTS, startAddon } from './addon.js';
import { proxyTools, socialClient } from './client.js';
import { createDataDir, defaultDataDir, readConfig, writeConfig } from './files.js';
import { importIdentity, ownPublicKey } from './identity.js';
import { serveMcp } from './mcp.js';
import { createTools, shownCard, UNTRUSTED } from './tools.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const HELP = `gator-social ${VERSION} — the intercom-gator social feed next to any agent harness

  gator-social run [options]       run the feed (keep it running; Ctrl-C stops)
      --product dex|reset|dmw|gator  which product channels to join (default gator)
      --bridge <ws url> --token-file <path>
                                     use the host Intercom peer's key over its SC-Bridge
                                     (default: standalone, own key in <data>/keys/peer.json)
      --agent-posting                let the agent post, reply, follow and set the profile (default off)
      --profile small|normal|large   machine profile (default: detected)
      --bootstrap host:port[,...]    custom HyperDHT bootstrap nodes (standalone only)
      --mcp                          also serve MCP on stdin/stdout in this process
      --exit-on-stdin-close          stop when stdin closes (for harnesses that spawn gator-social:
                                     it then never outlives its parent, even after a crash)
  gator-social mcp                 MCP server (stdio) for the running feed: feed_read, feed_post, reply,
                                   follow, like, repost, mute, profile
  gator-social status              is it running, which key, how many peers, identity warnings
  gator-social read [--scope following|latest|official|mentions|directory] [--limit N]
  gator-social card [--handle <h>] [--name <n>] [--bio <b>] [--avatar <file>] [--links url,url]
                    [--dns <domain>] [--github <user>] [--topics a,b]
                                   owner only: change your public profile card (published now if running).
                                   Omitted options keep their value; '' removes one (e.g. --avatar '').
                                   Proofs: DNS TXT intercom-gator=<key>; a public gist containing <key>.
  gator-social key                 print this data directory's public key (never the secret)
  gator-social key import <file> --yes [--replace]
                                   owner only, while stopped: sign as the identity from \`gator key export\`.
                                   Its newest card (handle, name, avatar, links, proofs, topics) comes along.
                                   --replace keeps an existing other identity aside (keys/peer.<key>.json).
                                   One identity runs in one process per machine.

  --data <dir>   data directory (default $GATOR_SOCIAL_DATA or ~/.gator-social)

Agent files (replaced hourly): <data>/agent/social/{official,following,mentions,directory}.md
${UNTRUSTED}
`;

const OPTIONS = {
  data: { type: 'string' }, product: { type: 'string' }, bridge: { type: 'string' }, 'token-file': { type: 'string' },
  'agent-posting': { type: 'boolean' }, profile: { type: 'string' }, bootstrap: { type: 'string' }, mcp: { type: 'boolean' },
  'exit-on-stdin-close': { type: 'boolean' },
  scope: { type: 'string' }, limit: { type: 'string' }, handle: { type: 'string' }, name: { type: 'string' },
  bio: { type: 'string' }, topics: { type: 'string' }, avatar: { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
  links: { type: 'string' }, dns: { type: 'string' }, github: { type: 'string' }, yes: { type: 'boolean' }, replace: { type: 'boolean' },
};
const ALLOWED = {
  run: ['data', 'product', 'bridge', 'token-file', 'agent-posting', 'profile', 'bootstrap', 'mcp', 'exit-on-stdin-close'],
  mcp: ['data'], status: ['data'], read: ['data', 'scope', 'limit'],
  card: ['data', 'handle', 'name', 'bio', 'topics', 'avatar', 'links', 'dns', 'github'], key: ['data', 'yes', 'replace'],
};

function bootstrapList(value) {
  return value.split(',').map(entry => {
    const match = /^([^:\s]+):(\d{1,5})$/.exec(entry.trim());
    if (!match || Number(match[2]) > 65535) throw new TypeError('--bootstrap expects host:port[,host:port]');
    return { host: match[1], port: Number(match[2]) };
  });
}

/** @param {string[]} argv @param {{env?:NodeJS.ProcessEnv, stdout?:NodeJS.WritableStream, stderr?:NodeJS.WritableStream,
 *   stdin?:NodeJS.ReadableStream, signals?:boolean}} [io] */
export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr,
  stdin = process.stdin, signals = true } = {}) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const print = value => stdout.write((typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n');
  if (values.version) return print(VERSION), 0;
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') return print(HELP), 0;
  if (!Object.hasOwn(ALLOWED, command) || positionals.length > (command === 'key' ? 3 : 1)) throw new TypeError('Unknown command. See gator-social help');
  const extra = Object.keys(values).find(k => !ALLOWED[command].includes(k));
  if (extra) throw new TypeError(`--${extra} does not apply to ${command}`);
  const dataDir = values.data ? resolve(values.data) : defaultDataDir(env);

  if (command === 'status') {
    try { return print(await socialClient(dataDir).status()), 0; }
    catch (error) { print({ running: false, dataDir, reason: error.message }); return 1; }
  }
  if (command === 'read') {
    const limit = values.limit === undefined ? 20 : Number(values.limit);
    const result = await socialClient(dataDir).call('feed_read', { scope: values.scope ?? 'following', limit });
    print(result.value);
    return result.isError ? 1 : 0;
  }
  if (command === 'card') {
    // The same edit as the dashboard and MCP profile.set: merged into the identity's newest card.
    const patch = {};
    for (const name of ['handle', 'name', 'bio', 'dns', 'github']) if (values[name] !== undefined) patch[name] = values[name];
    if (values.links !== undefined) patch.links = values.links.split(',').map(s => s.trim()).filter(Boolean);
    if (values.avatar === '') patch.avatar = '';
    else if (values.avatar !== undefined) {
      const image = parseAvatar(await readAvatarFile(resolve(values.avatar)));
      if (!image) throw new TypeError(AVATAR_RULE);
      patch.avatar = image.base64;
    }
    const topics = values.topics === undefined ? undefined : cleanTopics(values.topics);
    try {
      const result = await socialClient(dataDir).editCard(patch, topics);
      print(result);
      return result.sent ? 0 : 1;
    } catch (error) {
      if (!/not running/.test(error.message)) throw error;
      createDataDir(dataDir);
      const config = readConfig(dataDir);
      const key = await ownPublicKey(dataDir);
      if (!config.card && !patch.handle && !key) throw new TypeError('card needs --handle (no card and no identity yet)');
      // The product tag is added by run, which knows the product.
      const card = editCard(config.card ?? null, patch, { key: key ?? '' });
      const problem = cardProblem(card, { key, rootKey: ROOT_KEY });
      if (problem) throw new TypeError(problem);
      const { identity, ...rest } = config;
      const { awaitCard, ...kept } = identity ?? {};
      writeConfig(dataDir, { ...rest, ...(identity && { identity: kept }), card, topics: topics ?? config.topics ?? [] });
      const prove = key ? proofSteps(key, card.proofs) : {};
      print({ saved: true, card: shownCard(card), note: 'Published when gator-social run starts.', ...(Object.keys(prove).length && { prove }) });
      return 0;
    }
  }
  if (command === 'key') {
    const [, sub, file] = positionals;
    if (sub === undefined) return print({ publicKey: await ownPublicKey(dataDir), dataDir }), 0;
    if (sub !== 'import' || !file) throw new TypeError('Usage: gator-social key [import <file> --yes [--replace]]');
    if (values.yes !== true) {
      throw new TypeError('key import makes ' + dataDir + ' sign as the identity in ' + file + ' (whoever holds that file can post ' +
        'as you). Run it only for a file you exported yourself with gator key export, then add --yes.');
    }
    print(await importIdentity({ dataDir, file: resolve(file), rootKey: ROOT_KEY, replace: values.replace === true }));
    return 0;
  }
  if (command === 'mcp') {
    const client = socialClient(dataDir);
    // The definitions are static; a throwaway set gives names, descriptions and schemas.
    const definitions = createTools({ social: { publicKey: '' }, product: 'gator' });
    await serveMcp({ tools: proxyTools(client, definitions), info: { name: 'gator-social', version: VERSION },
      instructions: UNTRUSTED, input: stdin, output: stdout });
    return 0;
  }

  // run
  const product = values.product ?? 'gator';
  if (!PRODUCTS.includes(product)) throw new TypeError('--product must be one of ' + PRODUCTS.join(', '));
  if (!!values.bridge !== !!values['token-file']) throw new TypeError('--bridge and --token-file go together');
  if (values['token-file'] && !isAbsolute(values['token-file'])) throw new TypeError('--token-file must be an absolute path');
  if (values.mcp && values['exit-on-stdin-close']) throw new TypeError('--mcp already stops when stdin closes');
  if (values.bridge && values.bootstrap) throw new TypeError('--bootstrap is for standalone mode');
  if (values.profile && !['small', 'normal', 'large'].includes(values.profile)) throw new TypeError('--profile must be small, normal or large');
  const log = (level, message) => stderr.write(`[gator-social] ${level}: ${message}\n`);
  const stopped = Promise.withResolvers();
  const addon = await startAddon({
    dataDir, product, agentPosting: values['agent-posting'] === true, profile: values.profile, log,
    // Same proof checks as gator: DNS TXT and public GitHub gists (rate limited, see @gator/social proofs.js).
    proofs: { fetch: globalThis.fetch }, identityLock: { dir: identityLockDir(env) },
    bridge: values.bridge ? { url: values.bridge, tokenFile: values['token-file'] } : undefined,
    bootstrap: values.bootstrap ? bootstrapList(values.bootstrap) : undefined,
  });
  const info = { publicKey: addon.publicKey, product, mode: addon.mode, agentPosting: values['agent-posting'] === true,
    agentFiles: addon.status().agentFiles };
  // With --mcp, stdout carries the protocol; everything else goes to stderr.
  (values.mcp ? stderr : stdout).write('gator-social running ' + JSON.stringify(info) + '\n');
  const stop = () => stopped.resolve();
  if (signals) for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
  if (values['exit-on-stdin-close'] && !values.mcp) {
    stdin.on('end', stop);
    stdin.on('close', stop);
    stdin.on('error', stop);
    stdin.resume();
  }
  if (values.mcp) {
    serveMcp({ tools: addon.tools, info: { name: 'gator-social', version: VERSION }, instructions: UNTRUSTED,
      input: stdin, output: stdout }).then(stop, stop);
  }
  await stopped.promise;
  if (signals) for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, stop);
  await addon.close();
  return 0;
}
