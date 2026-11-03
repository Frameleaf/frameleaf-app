import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { publicKeyFromPrivate, WrongSecretError } from './format.js';
import { parseRecoveryKey } from './recovery.js';

/*
 * Key file (spec §4.2). Every wrap holds the same 32-byte X25519 private key under AES-256-GCM, with
 * additional data `format|userId|kind`. PIN and passphrase keys come from scrypt (N=2^17, r=8, p=1);
 * the recovery key has 160 random bits, so HKDF-SHA256 is enough.
 */

const FORMAT = 'frameleaf-locked-key/1';
const SCRYPT = { N: 131_072, r: 8, p: 1 } as const;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const TAG = 16;

export type WrapKind = 'pin' | 'passphrase' | 'recovery';
export type KeyWrap = {
  kind: WrapKind;
  salt: string;
  nonce: string;
  /** Base64 of the wrapped private key (32 bytes) and its tag (16 bytes). */
  ciphertext: string;
} & KdfParams;
type KdfParams = { kdf: 'scrypt'; N: number; r: number; p: number } | { kdf: 'hkdf-sha256' };

export interface LockedKeyFile {
  format: 'frameleaf-locked-key/1';
  userId: string;
  label: string;
  publicKey: string;
  mode: 'pin' | 'advanced';
  encrypting: boolean;
  wraps: KeyWrap[];
  createdAt: string;
  updatedAt: string;
}

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const aad = (file: Pick<LockedKeyFile, 'format' | 'userId'>, kind: WrapKind) =>
  Buffer.from(`${file.format}|${file.userId}|${kind}`, 'utf8');

const assertFormat = (file: Pick<LockedKeyFile, 'format'>) => {
  if (file.format !== FORMAT) throw new Error(`Unsupported key file format ${String(file.format)}`);
};

/** The same text typed on different devices can arrive in different Unicode forms. */
const normalize = (secret: string) => secret.normalize('NFKC');

const deriveWrapKey = async (wrap: KdfParams & { salt: string }, secret: string) => {
  const salt = Buffer.from(wrap.salt, 'base64');
  if (wrap.kdf === 'hkdf-sha256') {
    let raw: Buffer;
    try {
      raw = parseRecoveryKey(secret);
    } catch {
      throw new WrongSecretError('That is not a valid recovery key');
    }
    return Buffer.from(hkdfSync('sha256', raw, salt, 'frameleaf-locked/1/recovery-wrap', 32));
  }
  return scryptAsync(normalize(secret), salt, 32, { N: wrap.N, r: wrap.r, p: wrap.p, maxmem: SCRYPT_MAXMEM });
};

const touch = <T extends LockedKeyFile>(file: T): T => ({ ...file, updatedAt: new Date().toISOString() });

/** Adds a wrap of `kind` for `privateKey`, replacing any wrap of that kind. */
export async function wrapKey(
  file: Omit<LockedKeyFile, 'wraps'> & { wraps?: KeyWrap[] },
  privateKey: Buffer,
  kind: WrapKind,
  secret: string,
): Promise<LockedKeyFile> {
  assertFormat(file);
  if (!publicKeyFromPrivate(privateKey).equals(Buffer.from(file.publicKey, 'base64'))) {
    throw new Error('The private key does not match the key file');
  }
  if (kind === 'pin' && file.mode === 'advanced') throw new Error('An advanced key file never holds a PIN wrap');
  if (secret.length === 0) throw new Error('The secret is empty');

  const salt = randomBytes(16).toString('base64');
  const params = kind === 'recovery' ? ({ kdf: 'hkdf-sha256' } as const) : ({ kdf: 'scrypt', ...SCRYPT } as const);
  const key = await deriveWrapKey({ salt, ...params }, secret);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(file, kind));
  const ciphertext = Buffer.concat([cipher.update(privateKey), cipher.final(), cipher.getAuthTag()]);
  key.fill(0);

  const wrap: KeyWrap = {
    kind,
    ...params,
    salt,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  return touch({ ...file, wraps: [...(file.wraps ?? []).filter((existing) => existing.kind !== kind), wrap] });
}

/** The private key held by the wrap of `kind`. Throws WrongSecretError if the secret doesn't open it. */
export async function unwrapKey(file: LockedKeyFile, kind: WrapKind, secret: string): Promise<Buffer> {
  assertFormat(file);
  const wrap = file.wraps.find((candidate) => candidate.kind === kind);
  if (!wrap) throw new WrongSecretError(`This key file has no ${kind} wrap`);
  const key = await deriveWrapKey(wrap, secret);
  const sealed = Buffer.from(wrap.ciphertext, 'base64');
  let privateKey: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(wrap.nonce, 'base64'));
    decipher.setAAD(aad(file, kind));
    decipher.setAuthTag(sealed.subarray(-TAG));
    privateKey = Buffer.concat([decipher.update(sealed.subarray(0, -TAG)), decipher.final()]);
  } catch {
    throw new WrongSecretError(`That ${kind === 'recovery' ? 'recovery key' : kind} doesn't open this key file`);
  } finally {
    key.fill(0);
  }
  const expected = Buffer.from(file.publicKey, 'base64');
  const actual = publicKeyFromPrivate(privateKey);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    privateKey.fill(0);
    throw new Error('The key file is inconsistent: its private key does not match its public key');
  }
  return privateKey;
}

/** The key file without its wrap of `kind`. Refuses to remove the last wrap, which would lose the key. */
export function removeWrap(file: LockedKeyFile, kind: WrapKind): LockedKeyFile {
  const wraps = file.wraps.filter((wrap) => wrap.kind !== kind);
  if (wraps.length === 0) throw new Error('Removing the last wrap would make the key unrecoverable');
  return touch({ ...file, wraps });
}
