import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { CLOUD_BACKUP_KEY_BYTES } from 'src/utils/cloud-backup.js';
import { KeyEscrowBlob } from 'src/utils/frameleaf-cloud-backup.js';

/**
 * Key escrow (FL-164, CLD-302; Frameleaf Cloud BAK-002 "Escrow"): in server key mode only, the bucket key
 * wrapped under an administrator's passphrase and stored with Frameleaf Cloud as an opaque blob. The key
 * is derived with Node's `scrypt` (N = 2^17, r = 8, p = 1, a random 16-byte salt) and the bucket key sealed
 * with AES-256-GCM (a random 12-byte nonce; the 16-byte tag is appended to the ciphertext, as the contract
 * says). Frameleaf Cloud checks the shape only: it never has the passphrase and cannot unwrap the blob.
 */

export const ESCROW_SCRYPT = Object.freeze({ N: 131_072, r: 8, p: 1 });
/** scrypt needs 128 · N · r bytes (128 MiB here); Node refuses more than 32 MiB unless told otherwise. */
const ESCROW_SCRYPT_MAXMEM = 256 * 1024 * 1024;
const ESCROW_SALT_BYTES = 16;
const ESCROW_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
/** Binds a blob to what it is, so no other AES-GCM ciphertext under the same passphrase passes for one. */
const ESCROW_AAD = Buffer.from('frameleaf-backup-key-escrow/1');
/** The shortest passphrase escrow accepts. */
export const ESCROW_MIN_PASSPHRASE = 12;
export const ESCROW_BLOB_VERSION = 1;

/** RFC 7914 scrypt, as escrow uses it; `keyLength` and the cost are parameters so the RFC's vectors can be checked. */
export const scryptDerive = (
  passphrase: string,
  salt: Buffer,
  options: { N: number; r: number; p: number; keyLength: number },
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(
      passphrase.normalize('NFKC'),
      salt,
      options.keyLength,
      { N: options.N, r: options.r, p: options.p, maxmem: ESCROW_SCRYPT_MAXMEM },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });

const wrappingKey = (passphrase: string, salt: Buffer) =>
  scryptDerive(passphrase, salt, { ...ESCROW_SCRYPT, keyLength: 32 });

/** Why a passphrase cannot be used for escrow, or null. */
export const escrowPassphraseProblem = (passphrase: string): string | null =>
  passphrase.normalize('NFKC').length < ESCROW_MIN_PASSPHRASE
    ? `Use a passphrase of at least ${ESCROW_MIN_PASSPHRASE} characters.`
    : null;

/** Wrap the bucket key under a passphrase. `salt` and `nonce` are only given by tests. */
export const wrapBucketKey = async (
  key: Buffer,
  passphrase: string,
  options: { salt?: Buffer; nonce?: Buffer } = {},
): Promise<KeyEscrowBlob> => {
  if (key.length !== CLOUD_BACKUP_KEY_BYTES) {
    throw new Error('A bucket key is 256 bits');
  }
  const problem = escrowPassphraseProblem(passphrase);
  if (problem) {
    throw new Error(problem);
  }
  const salt = options.salt ?? randomBytes(ESCROW_SALT_BYTES);
  const nonce = options.nonce ?? randomBytes(ESCROW_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', await wrappingKey(passphrase, salt), nonce);
  cipher.setAAD(ESCROW_AAD);
  const ciphertext = Buffer.concat([cipher.update(key), cipher.final(), cipher.getAuthTag()]);
  return {
    version: ESCROW_BLOB_VERSION,
    kdf: { name: 'scrypt', ...ESCROW_SCRYPT, salt: salt.toString('base64') },
    cipher: 'aes-256-gcm',
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
};

/** The bucket key back from a blob and its passphrase; a wrong passphrase or an altered blob is refused. */
export const unwrapBucketKey = async (blob: KeyEscrowBlob, passphrase: string): Promise<Buffer> => {
  const sealed = Buffer.from(blob.ciphertext, 'base64');
  if (sealed.length <= GCM_TAG_BYTES) {
    throw new Error('This key copy is damaged.');
  }
  const salt = Buffer.from(blob.kdf.salt, 'base64');
  const key = await scryptDerive(passphrase, salt, { N: blob.kdf.N, r: blob.kdf.r, p: blob.kdf.p, keyLength: 32 });
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.nonce, 'base64'));
  decipher.setAAD(ESCROW_AAD);
  decipher.setAuthTag(sealed.subarray(sealed.length - GCM_TAG_BYTES));
  let opened: Buffer;
  try {
    opened = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - GCM_TAG_BYTES)), decipher.final()]);
  } catch {
    throw new Error('This passphrase does not open the key copy.');
  }
  if (opened.length !== CLOUD_BACKUP_KEY_BYTES) {
    throw new Error('This key copy does not hold a bucket key.');
  }
  return opened;
};
