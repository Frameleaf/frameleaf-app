import { Injectable } from '@nestjs/common';
import { compareSync, hash } from 'bcrypt';
import jwt from 'jsonwebtoken';
import { createHash, createHmac, createPublicKey, createVerify, randomBytes, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** FL-161: the per-server keyed-hash secret, in the identity directory next to the instance key. */
export const SERVER_HMAC_KEY_FILE = 'server-hmac.key';
const SERVER_HMAC_KEY_BYTES = 32;

/**
 * Read the per-server key, creating it once (O_EXCL, 0600, flushed) when it does not exist. A key
 * another process is still writing is read again shortly; a key of any other length is an error.
 */
const loadServerHmacKey = async (directory: string): Promise<Buffer> => {
  const file = join(directory, SERVER_HMAC_KEY_FILE);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const key = randomBytes(SERVER_HMAC_KEY_BYTES);
    try {
      await handle.writeFile(key);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const key = await readFile(file);
    if (key.length === SERVER_HMAC_KEY_BYTES) {
      return key;
    }
    if (key.length > SERVER_HMAC_KEY_BYTES) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`The server key ${file} is damaged; remove it to create a new one`);
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
   * `directory` (the identity directory) and never in the database, so a database backup alone
   * cannot produce one. `purpose` separates the uses of the key.
   */
  async serverKeyedHash(directory: string, purpose: string, value: string): Promise<string> {
    let key = this.serverHmacKeys.get(directory);
    if (!key) {
      key = loadServerHmacKey(directory);
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
