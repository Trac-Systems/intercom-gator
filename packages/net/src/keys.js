import { randomBytes } from 'node:crypto';
import { closeSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import DHT from 'hyperdht';
import tracCrypto from 'trac-crypto-api';
import PeerWallet from 'trac-wallet';
import { ensureWindowsDirectory, openPrivateRead, sameIdentity, windowsDirectory, windowsLstat } from './private-file.js';

// This is the synchronous construction path used by PeerWallet.fromKeyPair in 1.0.1.
function walletFromPair(pair) {
  return new PeerWallet({ __fromKeyPair: true, ...pair });
}

/** Derive an Intercom wallet directly from a raw 32-byte Ed25519 seed.
 * @param {string} seedHex @returns {PeerWallet} */
export function keyFromSeed(seedHex) {
  if (typeof seedHex !== 'string' || !/^[a-f0-9]{64}$/i.test(seedHex)) {
    throw new TypeError('Expected a 32-byte hexadecimal Ed25519 seed');
  }
  return walletFromPair(DHT.keyPair(Buffer.from(seedHex, 'hex')));
}

function serialize(wallet) {
  const plain = Buffer.from(JSON.stringify({
    publicKey: wallet.publicKey.toString('hex'),
    secretKey: wallet.secretKey.toString('hex'),
    mnemonic: null,
    derivationPath: null,
  }));
  try {
    // Same keystore and empty-password convention as Intercom's unattended PeerWallet.
    const fields = tracCrypto.data.encrypt(plain, Buffer.alloc(0));
    return JSON.stringify(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.toString('hex')])));
  } finally {
    plain.fill(0);
  }
}

function deserialize(json) {
  let plain;
  try {
    const { nonce, salt, ciphertext } = JSON.parse(json);
    if (!/^[a-f0-9]{48}$/i.test(nonce) || !/^[a-f0-9]{32}$/i.test(salt) ||
        typeof ciphertext !== 'string' || !/^(?:[a-f0-9]{2}){17,}$/i.test(ciphertext)) {
      throw new Error();
    }
    plain = tracCrypto.data.decrypt({
      nonce: Buffer.from(nonce, 'hex'), salt: Buffer.from(salt, 'hex'), ciphertext: Buffer.from(ciphertext, 'hex'),
    }, Buffer.alloc(0));
    const pair = JSON.parse(plain);
    if (typeof pair.secretKey !== 'string' || !/^[a-f0-9]{128}$/i.test(pair.secretKey)) throw new Error();
    const wallet = keyFromSeed(pair.secretKey.slice(0, 64));
    if (pair.publicKey !== wallet.publicKey.toString('hex') || pair.secretKey !== wallet.secretKey.toString('hex')) {
      throw new Error();
    }
    return wallet;
  } catch {
    // A JSON parser error may contain an excerpt of the decrypted file.
    throw new Error('Invalid peer keystore');
  } finally {
    plain?.fill(0);
  }
}

export function readKey(file, label = 'peer') {
  const fd = openPrivateRead(file);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16_384) throw new Error(`Invalid ${label} keystore`);
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function prepareKeys(dataDir) {
  const dir = join(dataDir, 'keys');
  if (process.platform === 'win32') {
    const parent = ensureWindowsDirectory(dataDir), keys = ensureWindowsDirectory(dir);
    if (!sameIdentity(parent, windowsDirectory(dataDir))) throw new Error('Key directory changed during create');
    return keys;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return null;
}

// On failure, close before unlinking (Windows sharing rules) and only remove
// the directory entry that still names the file this call created.
function writeNewKey(file, contents, parent) {
  const fd = openSync(file, 'wx', 0o600);
  let created, failure;
  try {
    created = fstatSync(fd, { bigint: true });
    if (parent && (!sameIdentity(parent, windowsDirectory(dirname(file))) ||
        !sameIdentity(windowsLstat(file), created))) throw new Error('Key path changed during create');
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } catch (error) {
    failure = error;
  } finally { closeSync(fd); }
  if (failure) {
    if (created && (!parent || sameIdentity(parent, windowsDirectory(dirname(file))))) {
      const current = lstatSync(file, { bigint: true, throwIfNoEntry: false });
      if (current && sameIdentity(created, current)) unlinkSync(file);
    }
    throw failure;
  }
}

/** Load or exclusively create the harness key in dataDir/keys/peer.json.
 * @param {string} dataDir @returns {Promise<PeerWallet>} */
export async function loadOrCreateKey(dataDir) {
  const dir = join(dataDir, 'keys');
  const file = join(dir, 'peer.json');
  const parent = prepareKeys(dataDir);
  let json;
  try {
    json = readKey(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const wallet = walletFromPair(DHT.keyPair());
    // Prepare the complete file before opening with wx, including the expensive KDF.
    const contents = serialize(wallet);
    try {
      writeNewKey(file, contents, parent);
      return wallet;
    } catch (openError) {
      if (openError.code !== 'EEXIST') throw openError;
    }
  }
  // Another process can open the new inode between wx and the single small write.
  for (let retry = 0; !json && retry < 10; retry++) {
    await delay(10);
    json = readKey(file);
  }
  return deserialize(json);
}

function swarmPair(json) {
  try {
    const { publicKey, secretKey } = JSON.parse(json);
    if (typeof secretKey !== 'string' || !/^[a-f0-9]{128}$/.test(secretKey)) throw new Error();
    const pair = DHT.keyPair(Buffer.from(secretKey.slice(0, 64), 'hex'));
    if (publicKey !== pair.publicKey.toString('hex') || secretKey !== pair.secretKey.toString('hex')) throw new Error();
    return pair;
  } catch {
    throw new Error('Invalid swarm keystore');
  }
}

function readSwarmKey(file) {
  let json = readKey(file, 'swarm');
  // On volumes without hard links, a concurrent reader can see the empty
  // exclusive-create file before the winning process completes its first write.
  if (!json) {
    const wait = new Int32Array(new SharedArrayBuffer(4));
    for (let retry = 0; !json && retry < 10; retry++) {
      Atomics.wait(wait, 0, 0, 10);
      json = readKey(file, 'swarm');
    }
  }
  return swarmPair(json);
}

/** Load or create the Hyperswarm (Noise) key pair in dataDir/keys/swarm.json (0600, plain JSON like
 * `{publicKey, secretKey}` in hex). It is deliberately not the signing identity, so that the key this node
 * announces and connects with on the DHT does not name its soc/u/<identity> channel. Synchronous; no KDF.
 * Concurrent first starts agree on one key pair. A corrupt file is rejected and left untouched.
 * @param {string} dataDir @returns {{publicKey: Buffer, secretKey: Buffer}} */
export function loadOrCreateSwarmKeyPair(dataDir) {
  const dir = join(dataDir, 'keys');
  const file = join(dir, 'swarm.json');
  const parent = prepareKeys(dataDir);
  try {
    return readSwarmKey(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const pair = DHT.keyPair();
  const contents = JSON.stringify({ publicKey: pair.publicKey.toString('hex'), secretKey: pair.secretKey.toString('hex') });
  // Write a complete private file, then hard-link it into place: a link never replaces an existing file, so
  // a concurrent first start either wins or reads the winner's complete file.
  const temp = join(dir, `.swarm-${randomBytes(8).toString('hex')}.tmp`);
  writeNewKey(temp, contents, parent);
  try {
    linkSync(temp, file);
  } catch (error) {
    if (error.code !== 'EEXIST') {
      // libuv also maps Windows ERROR_INVALID_FUNCTION to EISDIR (e.g. on
      // volumes without hard links). A sharing violation can report EBUSY.
      const windowsFallback = process.platform === 'win32' && ['EISDIR', 'EBUSY'].includes(error.code);
      if (!windowsFallback && !['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV'].includes(error.code)) throw error;
      try {
        writeNewKey(file, contents, parent);
      } catch (openError) {
        if (openError.code !== 'EEXIST') throw openError;
      }
    }
  } finally {
    unlinkSync(temp);
  }
  return readSwarmKey(file);
}
