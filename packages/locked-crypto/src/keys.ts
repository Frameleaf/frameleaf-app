import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { publicKeyFromPrivate, WrongSecretError } from './format.js';
import { parseRecoveryKey } from './recovery.js';

/*
 * Key file (spec §4.2). Every wrap holds the same 32-byte X25519 private key under AES-256-GCM, with
 * additional data `format|userId|kind`. PIN and passphrase keys come from scrypt (N=2^17, r=8, p=1);
 * the recovery key has 160 random bits, so HKDF-SHA256 is enough.
 *
 * Format 2 adds a server-held pepper to PIN wraps. A six-digit PIN has only 10^6 candidates, so a
 * copy of the key file alone (a media backup, a snapshot) was enough to brute-force a format-1 PIN
 * wrap offline. A peppered wrap mixes a random secret the server keeps outside the key file into the
 * wrap key (HKDF over the scrypt output, with the pepper as the HKDF salt); without the pepper the
 * tag never verifies, so the server's online attempt limit is the only way to try PINs. The wrap
 * records a short pepper fingerprint so a wrong pepper is told apart from a wrong PIN. Format-1
 * wraps (no `pepper` field) still open: a format-2 file may hold both until the PIN wrap is rewritten.
 */

export const KEY_FILE_FORMAT_1 = 'frameleaf-locked-key/1';
export const KEY_FILE_FORMAT_2 = 'frameleaf-locked-key/2';
export const KEY_FILE_FORMATS = [KEY_FILE_FORMAT_1, KEY_FILE_FORMAT_2] as const;
export type LockedKeyFileFormat = (typeof KEY_FILE_FORMATS)[number];
/** Whether `format` is a key file format this version reads and writes. */
export const isKeyFileFormat = (
  format: unknown,
): format is LockedKeyFileFormat =>
  typeof format === 'string' &&
  (KEY_FILE_FORMATS as readonly string[]).includes(format);

const SCRYPT = { N: 131_072, r: 8, p: 1 } as const;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const SALT = 16;
const NONCE = 12;
const KEY = 32;
const TAG = 16;
/** The pepper the server generates; a supplied one may be longer, never shorter. */
export const PEPPER_BYTES = 32;
const MIN_PEPPER_BYTES = 16;
const PEPPER_INFO = 'frameleaf-locked/2/pin-wrap-pepper';

export type WrapKind = 'pin' | 'passphrase' | 'recovery';
export type KeyWrap = {
  kind: WrapKind;
  salt: string;
  nonce: string;
  /** Base64 of the wrapped private key (32 bytes) and its tag (16 bytes). */
  ciphertext: string;
  /** Format 2: the wrap key also depends on the server's pepper; `id` is `pepperId(pepper)`. */
  pepper?: { kdf: 'hkdf-sha256'; id: string };
} & KdfParams;
type KdfParams =
  { kdf: 'scrypt'; N: number; r: number; p: number } | { kdf: 'hkdf-sha256' };

export interface LockedKeyFile {
  format: LockedKeyFileFormat;
  userId: string;
  label: string;
  publicKey: string;
  mode: 'pin' | 'advanced';
  encrypting: boolean;
  wraps: KeyWrap[];
  createdAt: string;
  updatedAt: string;
}

export interface WrapOptions {
  /**
   * The server's pepper for PIN wraps (ignored for other kinds). A PIN wrap made without one is a
   * format-1 wrap, which a copy of the key file can be brute-forced against offline; the server
   * always supplies one.
   */
  pepper?: Buffer;
}

/** A key file whose wrap parameters are not the ones this format defines; never a wrong-secret case. */
export class LockedKeyFileCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockedKeyFileCorruptError';
  }
}

/** A format-2 PIN wrap was opened without the server's pepper, or with a different one. */
export class LockedPepperError extends Error {
  constructor(
    message: string,
    public readonly reason: 'missing' | 'mismatch',
  ) {
    super(message);
    this.name = 'LockedPepperError';
  }
}

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** A short fingerprint of a pepper, stored in the wrap so a wrong pepper is reported as such. */
export const pepperId = (pepper: Buffer): string =>
  createHash('sha256')
    .update(PEPPER_INFO)
    .update(pepper)
    .digest()
    .subarray(0, 8)
    .toString('base64');

const assertPepper = (pepper: Buffer) => {
  if (!Buffer.isBuffer(pepper) || pepper.length < MIN_PEPPER_BYTES) {
    throw new Error(`The pepper must be at least ${MIN_PEPPER_BYTES} bytes`);
  }
};

const aad = (
  file: Pick<LockedKeyFile, 'userId'>,
  kind: WrapKind,
  pepper?: KeyWrap['pepper'],
) =>
  Buffer.from(
    pepper
      ? `${KEY_FILE_FORMAT_2}|${file.userId}|${kind}|pepper:${pepper.id}`
      : `${KEY_FILE_FORMAT_1}|${file.userId}|${kind}`,
    'utf8',
  );

const assertFormat = (file: Pick<LockedKeyFile, 'format'>) => {
  if (!isKeyFileFormat(file.format))
    throw new Error(`Unsupported key file format ${String(file.format)}`);
};

const base64Length = (value: unknown) =>
  typeof value === 'string' ? Buffer.from(value, 'base64').length : -1;

/**
 * A wrap's parameters come from a file anyone with the media root can edit. They are checked against
 * the fixed constants before any derivation, so a hostile `p` or `N` cannot keep a reader busy for
 * hours instead of failing at once. Nothing here depends on the secret.
 */
const assertWrap = (wrap: KeyWrap) => {
  const corrupt = (what: string) =>
    new LockedKeyFileCorruptError(`The key file's ${wrap.kind} wrap ${what}`);
  if (wrap.kdf === 'scrypt') {
    if (wrap.N !== SCRYPT.N || wrap.r !== SCRYPT.r || wrap.p !== SCRYPT.p) {
      throw corrupt(
        `has scrypt parameters other than N=${SCRYPT.N} r=${SCRYPT.r} p=${SCRYPT.p}`,
      );
    }
  } else if (wrap.kdf !== 'hkdf-sha256') {
    throw corrupt(
      `uses an unknown key derivation ${String((wrap as { kdf: unknown }).kdf)}`,
    );
  }
  if (base64Length(wrap.salt) !== SALT)
    throw corrupt(`has a salt that is not ${SALT} bytes`);
  if (base64Length(wrap.nonce) !== NONCE)
    throw corrupt(`has a nonce that is not ${NONCE} bytes`);
  if (base64Length(wrap.ciphertext) !== KEY + TAG)
    throw corrupt(`has a ciphertext that is not ${KEY + TAG} bytes`);
  if (wrap.pepper !== undefined) {
    if (wrap.kind !== 'pin')
      throw corrupt('is peppered, which only a PIN wrap can be');
    if (
      wrap.pepper?.kdf !== 'hkdf-sha256' ||
      base64Length(wrap.pepper.id) !== 8
    ) {
      throw corrupt('has an unreadable pepper record');
    }
  }
};

/** The same text typed on different devices can arrive in different Unicode forms. */
const normalize = (secret: string) => secret.normalize('NFKC');

const deriveWrapKey = async (
  wrap: KdfParams & {
    kind: WrapKind;
    salt: string;
    pepper?: KeyWrap['pepper'];
  },
  secret: string,
  pepper?: Buffer,
) => {
  const salt = Buffer.from(wrap.salt, 'base64');
  if (wrap.kdf === 'hkdf-sha256') {
    let raw: Buffer;
    try {
      raw = parseRecoveryKey(secret);
    } catch {
      throw new WrongSecretError('That is not a valid recovery key');
    }
    return Buffer.from(
      hkdfSync('sha256', raw, salt, 'frameleaf-locked/1/recovery-wrap', KEY),
    );
  }
  if (!wrap.pepper) {
    return scryptAsync(normalize(secret), salt, KEY, {
      ...SCRYPT,
      maxmem: SCRYPT_MAXMEM,
    });
  }
  // checked before the slow derivation, so a missing or wrong pepper fails at once and by name
  if (!pepper) {
    throw new LockedPepperError(
      `This key file's ${wrap.kind} wrap needs the server's Locked pepper`,
      'missing',
    );
  }
  assertPepper(pepper);
  if (pepperId(pepper) !== wrap.pepper.id) {
    throw new LockedPepperError(
      `The Locked pepper supplied is not the one this key file's ${wrap.kind} wrap was made with`,
      'mismatch',
    );
  }
  const stretched = await scryptAsync(normalize(secret), salt, KEY, {
    ...SCRYPT,
    maxmem: SCRYPT_MAXMEM,
  });
  try {
    return Buffer.from(hkdfSync('sha256', stretched, pepper, PEPPER_INFO, KEY));
  } finally {
    stretched.fill(0);
  }
};

const touch = <T extends LockedKeyFile>(file: T): T => ({
  ...file,
  updatedAt: new Date().toISOString(),
});

/**
 * Adds a wrap of `kind` for `privateKey`, replacing any wrap of that kind. A PIN wrap made with
 * `options.pepper` is a format-2 wrap, and the file's format becomes format 2.
 */
export async function wrapKey(
  file: Omit<LockedKeyFile, 'wraps'> & { wraps?: KeyWrap[] },
  privateKey: Buffer,
  kind: WrapKind,
  secret: string,
  options: WrapOptions = {},
): Promise<LockedKeyFile> {
  assertFormat(file);
  if (
    !publicKeyFromPrivate(privateKey).equals(
      Buffer.from(file.publicKey, 'base64'),
    )
  ) {
    throw new Error('The private key does not match the key file');
  }
  if (kind === 'pin' && file.mode === 'advanced')
    throw new Error('An advanced key file never holds a PIN wrap');
  if (secret.length === 0) throw new Error('The secret is empty');
  const pepper = kind === 'pin' ? options.pepper : undefined;
  if (pepper) assertPepper(pepper);

  const salt = randomBytes(SALT).toString('base64');
  const params =
    kind === 'recovery'
      ? ({ kdf: 'hkdf-sha256' } as const)
      : ({ kdf: 'scrypt', ...SCRYPT } as const);
  const pepperRecord: KeyWrap['pepper'] = pepper
    ? { kdf: 'hkdf-sha256', id: pepperId(pepper) }
    : undefined;
  const key = await deriveWrapKey(
    { kind, salt, ...params, pepper: pepperRecord },
    secret,
    pepper,
  );
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(file, kind, pepperRecord));
  const ciphertext = Buffer.concat([
    cipher.update(privateKey),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  key.fill(0);

  const wrap: KeyWrap = {
    kind,
    ...params,
    salt,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    ...(pepperRecord && { pepper: pepperRecord }),
  };
  const wraps = [
    ...(file.wraps ?? []).filter((existing) => existing.kind !== kind),
    wrap,
  ];
  const format = wraps.some((candidate) => candidate.pepper)
    ? KEY_FILE_FORMAT_2
    : file.format;
  return touch({ ...file, format, wraps });
}

/**
 * The private key held by the wrap of `kind`. Throws WrongSecretError if the secret doesn't open it,
 * LockedPepperError if a peppered PIN wrap is opened without its pepper, and
 * LockedKeyFileCorruptError if the wrap's parameters are not this format's.
 */
export async function unwrapKey(
  file: LockedKeyFile,
  kind: WrapKind,
  secret: string,
  options: WrapOptions = {},
): Promise<Buffer> {
  assertFormat(file);
  const wrap = file.wraps.find((candidate) => candidate.kind === kind);
  if (!wrap) throw new WrongSecretError(`This key file has no ${kind} wrap`);
  assertWrap(wrap);
  const key = await deriveWrapKey(
    wrap,
    secret,
    kind === 'pin' ? options.pepper : undefined,
  );
  const sealed = Buffer.from(wrap.ciphertext, 'base64');
  let privateKey: Buffer;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(wrap.nonce, 'base64'),
    );
    decipher.setAAD(aad(file, kind, wrap.pepper));
    decipher.setAuthTag(sealed.subarray(-TAG));
    privateKey = Buffer.concat([
      decipher.update(sealed.subarray(0, -TAG)),
      decipher.final(),
    ]);
  } catch {
    throw new WrongSecretError(
      `That ${kind === 'recovery' ? 'recovery key' : kind} doesn't open this key file`,
    );
  } finally {
    key.fill(0);
  }
  const expected = Buffer.from(file.publicKey, 'base64');
  const actual = publicKeyFromPrivate(privateKey);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    privateKey.fill(0);
    throw new Error(
      'The key file is inconsistent: its private key does not match its public key',
    );
  }
  return privateKey;
}

/** Whether the file's PIN wrap is a format-1 wrap, which `wrapKey` with a pepper should replace. */
export const hasUnpepperedPinWrap = (
  file: Pick<LockedKeyFile, 'wraps'>,
): boolean => file.wraps.some((wrap) => wrap.kind === 'pin' && !wrap.pepper);

/** The key file without its wrap of `kind`. Refuses to remove the last wrap, which would lose the key. */
export function removeWrap(file: LockedKeyFile, kind: WrapKind): LockedKeyFile {
  const wraps = file.wraps.filter((wrap) => wrap.kind !== kind);
  if (wraps.length === 0)
    throw new Error('Removing the last wrap would make the key unrecoverable');
  return touch({ ...file, wraps });
}
