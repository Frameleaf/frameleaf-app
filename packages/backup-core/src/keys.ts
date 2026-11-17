import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

export const FORMAT = 'frameleaf-repository';
export const VERSION = 1;

const NONCE = 12;
const TAG = 16;

/** The key is wrong, or the stored bytes were changed. AES-GCM cannot tell the two apart. */
export class UnsealError extends Error {
  override name = 'UnsealError';
  constructor() {
    super('Could not open this data: the key is wrong or the data is damaged');
  }
}

export interface RepositoryKeys {
  /** HMAC key that names blobs, so names say nothing about content without the key. */
  id: Buffer;
  /** Base key for blob encryption; each blob gets its own key from it. */
  blob: Buffer;
  /** Seeds the chunker's table, so chunk boundaries depend on the key. */
  cut: Buffer;
  /** Encrypts pack trailers, index objects and snapshots. */
  meta: Buffer;
}

export const derive = (key: Buffer, salt: Buffer, info: string, length = 32) =>
  Buffer.from(hkdfSync('sha256', key, salt, `${FORMAT}/${VERSION} ${info}`, length));

export function deriveKeys(master: Buffer, repoId: string): RepositoryKeys {
  if (master.length !== 32) {
    throw new RangeError('The repository key must be 32 bytes');
  }
  const salt = Buffer.from(repoId);
  return {
    id: derive(master, salt, 'id'),
    blob: derive(master, salt, 'blob'),
    cut: derive(master, salt, 'cut'),
    meta: derive(master, salt, 'meta'),
  };
}

export const blobId = (keys: RepositoryKeys, plain: Uint8Array) => createHmac('sha256', keys.id).update(plain).digest();

/** nonce(12) | ciphertext | tag(16) */
export function seal(key: Buffer, aad: Buffer, plain: Uint8Array): Buffer {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

export function unseal(key: Buffer, aad: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < NONCE + TAG) {
    throw new UnsealError();
  }
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, NONCE));
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(NONCE, sealed.length - TAG)), decipher.final()]);
  } catch {
    throw new UnsealError();
  }
}

/** flag(1) | sealed. The flag says whether the plaintext was compressed, and is authenticated with the id. */
export function sealBlob(keys: RepositoryKeys, id: Buffer, plain: Buffer): Buffer {
  const packed = plain.length >= 64 ? zstdCompressSync(plain) : plain;
  // Photos and video don't shrink: keep them as they are unless compression saves at least 1/16.
  const compressed = packed !== plain && packed.length <= plain.length - (plain.length >> 4);
  const flag = Buffer.from([compressed ? 1 : 0]);
  return Buffer.concat([
    flag,
    seal(derive(keys.blob, id, 'blob'), Buffer.concat([id, flag]), compressed ? packed : plain),
  ]);
}

export function openBlob(keys: RepositoryKeys, id: Buffer, blob: Buffer): Buffer {
  const flag = blob.subarray(0, 1);
  if (flag[0] !== 0 && flag[0] !== 1) {
    throw new UnsealError();
  }
  const plain = unseal(derive(keys.blob, id, 'blob'), Buffer.concat([id, flag]), blob.subarray(1));
  return flag[0] === 1 ? zstdDecompressSync(plain) : plain;
}
