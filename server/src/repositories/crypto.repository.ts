import { Injectable } from '@nestjs/common';
import { compareSync, hash } from 'bcrypt';
import jwt from 'jsonwebtoken';
import { createHash, createHmac, createPublicKey, createVerify, randomBytes, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

/** FL-161: the per-server keyed-hash secret, in the identity directory next to the instance key. */
export const SERVER_HMAC_KEY_FILE = 'server-hmac.key';
const SERVER_HMAC_KEY_BYTES = 32;

/** `link()` failures where the file system cannot hard-link (SMB/CIFS, FUSE, another device). */
const NO_HARD_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV']);
/** File flush failures that only mean the mount cannot flush (some FUSE file systems). */
const FILE_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']);

/**
 * A new key in a temporary file beside `file` (O_EXCL, 0600), ready to be linked or renamed. It is
 * flushed where the mount can flush; a mount that cannot (some FUSE file systems) is accepted, like
 * the instance key (`InstanceIdentityRepository.writeKeyExclusive`).
 */
const writeServerHmacKeyFile = async (file: string) => {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  const key = randomBytes(SERVER_HMAC_KEY_BYTES);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(key);
    await handle.sync().catch((error: NodeJS.ErrnoException) => {
      if (!FILE_SYNC_UNSUPPORTED.has(error.code ?? '')) {
        throw error;
      }
    });
  } catch (error) {
    // never leave a partly written key behind
    await handle.close().catch(() => {
      // the write error is the one reported
    });
    await unlink(temporary).catch(() => {
      // already gone
    });
    throw error;
  }
  await handle.close();
  return { temporary, key };
};

const readServerHmacKey = async (file: string): Promise<Buffer | null> => {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

/** The key now on disk, which must be whole. */
const readBackServerHmacKey = async (file: string): Promise<Buffer> => {
  const key = await readServerHmacKey(file);
  if (key?.length === SERVER_HMAC_KEY_BYTES) {
    return key;
  }
  throw new Error(`The server key ${file} could not be read back`);
};

/**
 * Put a new key in place when none exists: hard-linked from its temporary file, which fails when
 * another process created one first (whose key is then used). Where the file system cannot hard-link
 * (SMB/CIFS, FUSE, another device), the temporary file is renamed into place after checking that no
 * key appeared meanwhile, as the instance key does.
 */
const createServerHmacKey = async (file: string, temporary: string, key: Buffer): Promise<Buffer> => {
  try {
    await link(temporary, file);
    return key;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (code !== 'EEXIST' && !NO_HARD_LINK.has(code)) {
      throw error;
    }
    if (code === 'EEXIST' || (await readServerHmacKey(file))) {
      return readBackServerHmacKey(file);
    }
    await rename(temporary, file);
    // a process that raced this one may have renamed its own key in last: use what is on disk
    return readBackServerHmacKey(file);
  }
};

/**
 * Read the per-server key, creating it when it does not exist. A key only ever appears whole: it is
 * written to a temporary file and then linked (or renamed) into place. A key of the wrong length is
 * replaced by an atomic rename, and `onReset` is told, because every token made with the old key
 * stops matching; the key is then read back, so two processes replacing it at once agree on one.
 */
const loadServerHmacKey = async (directory: string, onReset: (file: string) => void): Promise<Buffer> => {
  const file = join(directory, SERVER_HMAC_KEY_FILE);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = await readServerHmacKey(file);
  if (existing?.length === SERVER_HMAC_KEY_BYTES) {
    return existing;
  }
  const { temporary, key } = await writeServerHmacKeyFile(file);
  try {
    if (existing) {
      await rename(temporary, file);
      onReset(file);
      return await readBackServerHmacKey(file);
    }
    return await createServerHmacKey(file, temporary, key);
  } finally {
    await unlink(temporary).catch(() => {
      // renamed into place, or already gone
    });
  }
};

@Injectable()
export class CryptoRepository {
  private serverHmacKeys = new Map<string, Promise<Buffer>>();

  randomUUID(): string {
    return randomUUID();
  }

  randomBytes(size: number) {
    return randomBytes(size);
  }

  hashBcrypt(data: string | Buffer, saltOrRounds: string | number) {
    return hash(data, saltOrRounds);
  }

  compareBcrypt(data: string | Buffer, encrypted: string) {
    return compareSync(data, encrypted);
  }

  hashSha256(value: string) {
    return createHash('sha256').update(value).digest();
  }

  verifySha256(value: string, encryptedValue: string, publicKey: string) {
    const publicKeyBuffer = Buffer.from(publicKey, 'base64');
    const cryptoPublicKey = createPublicKey({
      key: publicKeyBuffer,
      type: 'spki',
      format: 'pem',
    });

    const verifier = createVerify('SHA256');
    verifier.update(value);
    verifier.end();
    const encryptedValueBuffer = Buffer.from(encryptedValue, 'base64');
    return verifier.verify(cryptoPublicKey, encryptedValueBuffer);
  }

  hashSha1(value: string | Buffer): Buffer {
    return createHash('sha1').update(value).digest();
  }

  /**
   * Streams a file from disk and returns a digest.
   *
   * @param filepath Path to the file (or Buffer accepted by createReadStream).
   * @param algorithm Hash algorithm; defaults to `sha1` for backward
   *   compatibility with legacy callers (library scan, motion-photo extract).
   *   New code that needs to verify against a stored asset checksum should
   *   pass the algorithm explicitly — see `hashFileMatching` for a helper.
   */
  hashFile(filepath: string | Buffer, algorithm: 'sha1' | 'sha256' = 'sha1'): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const hash = createHash(algorithm);
      const stream = createReadStream(filepath);
      stream.on('error', (error) => reject(error));
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest()));
    });
  }

  hashFileDigests(filepath: string | Buffer): Promise<{ sha1: Buffer; sha256: Buffer; sizeInBytes: number }> {
    return new Promise((resolve, reject) => {
      const sha1 = createHash('sha1');
      const sha256 = createHash('sha256');
      let sizeInBytes = 0;
      const stream = createReadStream(filepath);
      stream.on('error', reject);
      stream.on('data', (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        sizeInBytes += bytes.length;
        sha1.update(bytes);
        sha256.update(bytes);
      });
      stream.on('end', () => resolve({ sha1: sha1.digest(), sha256: sha256.digest(), sizeInBytes }));
    });
  }

  /**
   * Hashes a file with the algorithm that produces the same digest length as
   * the supplied reference. Used when comparing a freshly-computed digest of a
   * moved/copied file against the checksum already stored for the asset, where
   * the stored algorithm may be either SHA-1 (legacy rows, 20 bytes) or
   * SHA-256 (new rows, 32 bytes). Unknown lengths fall back to SHA-1.
   */
  hashFileMatching(filepath: string | Buffer, reference: Buffer): Promise<Buffer> {
    const algorithm = reference.length === 32 ? 'sha256' : 'sha1';
    return this.hashFile(filepath, algorithm);
  }

  /**
   * FL-161: an HMAC-SHA256 (base64url) of `value` under this server's own key, which lives in
   * `directory` (the identity directory), not in the database: a database dump, or someone who can
   * read the database, cannot produce one on their own. The identity directory sits on the media
   * volume, where database backups are written too, so a copy of that whole volume carries the key as
   * well and must be protected like the server itself. `purpose` separates the uses of the key.
   */
  async serverKeyedHash(directory: string, purpose: string, value: string): Promise<string> {
    let key = this.serverHmacKeys.get(directory);
    if (!key) {
      key = loadServerHmacKey(directory, (file) =>
        LoggingRepository.create(CryptoRepository.name).warn(
          `The server key ${file} was damaged and has been replaced. Shared links must be unlocked with their password again, and sign-in rate-limit counters start over.`,
        ),
      );
      this.serverHmacKeys.set(directory, key);
      // a failure is not remembered: the next call tries again
      void key.catch(() => this.serverHmacKeys.delete(directory));
    }
    return createHmac('sha256', await key)
      .update(`${purpose}\0${value}`)
      .digest('base64url');
  }

  randomBytesAsText(bytes: number) {
    return randomBytes(bytes).toString('base64').replaceAll(/\W/g, '');
  }

  signJwt(payload: string | object | Buffer, secret: string, options?: jwt.SignOptions): string {
    // eslint-disable-next-line import-x/no-named-as-default-member
    return jwt.sign(payload, secret, { algorithm: 'HS256', ...options });
  }

  verifyJwt<T = any>(token: string, secret: string): T {
    // eslint-disable-next-line import-x/no-named-as-default-member
    return jwt.verify(token, secret, { algorithms: ['HS256'] }) as T;
  }
}
