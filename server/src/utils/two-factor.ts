import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * FL-793: two-step sign-in with an authenticator app (RFC 6238 TOTP: HMAC-SHA1, 6 digits, 30-second
 * steps) and one-time recovery codes. Pure helpers; storage and sign-in live in `AuthService`.
 *
 * ponytail: RFC 6238 is ~20 lines on node:crypto, so no otplib dependency.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
/** A code from the step before or after the server's clock is accepted (phone clocks drift). */
const TOTP_DRIFT_STEPS = 1;

/** How long a sign-in that passed the password may wait for its code. */
export const TWO_FACTOR_CHALLENGE_SECONDS = 5 * 60;
/** "Trust this browser": how long a browser skips the code step. */
export const TWO_FACTOR_TRUST_DAYS = 30;
export const RECOVERY_CODE_COUNT = 10;
/** No 0/o, 1/l/i: read off paper without mistakes. 31 symbols × 10 ≈ 49 bits per code. */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export const base32Encode = (bytes: Buffer): string => {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32[(value << (5 - bits)) & 31];
  }
  return output;
};

export const base32Decode = (text: string): Buffer => {
  const clean = text.toUpperCase().replaceAll(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) {
      throw new Error('Invalid base32');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
};

/** A new authenticator secret (160 bits, the RFC 4226 recommendation), base32 as apps expect it. */
export const newTotpSecret = () => base32Encode(randomBytes(20));

export const totpStep = (now: Date) => Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);

export const totpCode = (secret: string, step: number): string => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest.at(-1)! & 15;
  const binary = digest.readUInt32BE(offset) & 0x7f_ff_ff_ff;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
};

/**
 * The time step `code` belongs to, or null when it matches none near `now`. The caller must refuse a
 * step at or before the last one used, so a code works once.
 */
export const matchTotp = (secret: string, code: string, now: Date): number | null => {
  const digits = code.replaceAll(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) {
    return null;
  }
  const current = totpStep(now);
  for (let step = current - TOTP_DRIFT_STEPS; step <= current + TOTP_DRIFT_STEPS; step++) {
    if (safeEqual(totpCode(secret, step), digits)) {
      return step;
    }
  }
  return null;
};

/** The `otpauth://` address an authenticator app reads from the QR code. */
export const otpauthUri = (issuer: string, account: string, secret: string) => {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const query = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${query}`;
};

/** Ten new recovery codes, shown once as `xxxxx-xxxxx`. */
export const newRecoveryCodes = (): string[] =>
  Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const chars = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]);
    return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`;
  });

/** What is stored for a recovery code: SHA-256 of it, case and dashes ignored (the codes are random, so no salt). */
export const hashRecoveryCode = (code: string) =>
  createHash('sha256')
    .update(code.toLowerCase().replaceAll(/[^a-z0-9]/g, ''))
    .digest();

const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** HMAC under the server's own key (`CryptoRepository.serverKeyedHash`, bound to a purpose by the caller). */
export type ServerMac = (value: string) => Promise<string>;

/**
 * A signed, expiring token: `payload.mac`. `binding` is mixed into the MAC but never sent (the account's
 * password hash), so the token stops working when the password changes.
 */
export const signToken = async (mac: ServerMac, payload: object, binding: string): Promise<string> => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${await mac(`${body}\0${binding}`)}`;
};

/**
 * The payload of a token from `signToken`, or null when it is malformed, forged, bound to something else
 * or past its `exp` (seconds since the epoch). `binding` comes from the account the payload names, so
 * parse first with `peekToken`, look the account up, then verify.
 */
export const verifyToken = async <T extends { exp: number }>(
  mac: ServerMac,
  token: string,
  binding: string,
  now: Date,
): Promise<T | null> => {
  const [body, signature, extra] = token.split('.', 3);
  if (!body || !signature || extra !== undefined) {
    return null;
  }
  if (!safeEqual(signature, await mac(`${body}\0${binding}`))) {
    return null;
  }
  const payload = peekToken<T>(token);
  return payload && payload.exp * 1000 > now.getTime() ? payload : null;
};

/** The unverified payload of a token: only to find which account to verify it against. */
export const peekToken = <T>(token: string): T | null => {
  try {
    const value = JSON.parse(Buffer.from(token.split('.', 1)[0] ?? '', 'base64url').toString()) as unknown;
    return value && typeof value === 'object' ? (value as T) : null;
  } catch {
    return null;
  }
};
