import { randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync,
  readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import DHT from 'hyperdht';
import tracCrypto from 'trac-crypto-api';
import PeerWallet from 'trac-wallet';

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

function readKey(file, label = 'peer') {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16_384) throw new Error(`Invalid ${label} keystore`);
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/** Load or exclusively create the harness key in dataDir/keys/peer.json.
 * @param {string} dataDir @returns {Promise<PeerWallet>} */
export async function loadOrCreateKey(dataDir) {
  const dir = join(dataDir, 'keys');
  const file = join(dir, 'peer.json');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let json;
  try {
    json = readKey(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const wallet = walletFromPair(DHT.keyPair());
    // Prepare the complete file before opening with wx, including the expensive KDF.
    const contents = serialize(wallet);
    let fd;
    try {
      fd = openSync(file, 'wx', 0o600);
    } catch (openError) {
      if (openError.code !== 'EEXIST') throw openError;
    }
    if (fd !== undefined) {
      try {
        writeFileSync(fd, contents);
        fsyncSync(fd);
        return wallet;
      } catch (writeError) {
        unlinkSync(file);
        throw writeError;
      } finally {
        closeSync(fd);
      }
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

/** Load or create the Hyperswarm (Noise) key pair in dataDir/keys/swarm.json (0600, plain JSON like
 * `{publicKey, secretKey}` in hex). It is deliberately not the signing identity, so that the key this node
 * announces and connects with on the DHT does not name its soc/u/<identity> channel. Synchronous; no KDF.
 * Concurrent first starts agree on one key pair. A corrupt file is rejected and left untouched.
 * @param {string} dataDir @returns {{publicKey: Buffer, secretKey: Buffer}} */
export function loadOrCreateSwarmKeyPair(dataDir) {
  const dir = join(dataDir, 'keys');
  const file = join(dir, 'swarm.json');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    return swarmPair(readKey(file, 'swarm'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const pair = DHT.keyPair();
  const contents = JSON.stringify({ publicKey: pair.publicKey.toString('hex'), secretKey: pair.secretKey.toString('hex') });
  // Write a complete private file, then hard-link it into place: a link never replaces an existing file, so
  // a concurrent first start either wins or reads the winner's complete file.
  const temp = join(dir, `.swarm-${randomBytes(8).toString('hex')}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temp, file);
  } catch (error) {
    if (error.code !== 'EEXIST') {
      // Filesystems without hard links: exclusive create.
      if (!['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV'].includes(error.code)) throw error;
      let target;
      try {
        target = openSync(file, 'wx', 0o600);
      } catch (openError) {
        if (openError.code !== 'EEXIST') throw openError;
      }
      if (target !== undefined) {
        try {
          writeFileSync(target, contents);
          fsyncSync(target);
        } finally {
          closeSync(target);
        }
      }
    }
  } finally {
    unlinkSync(temp);
  }
  return swarmPair(readKey(file, 'swarm'));
}
