import { createPublicKey } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { FrameleafBuildChannel } from 'src/utils/frameleaf-build-channel.js';
import type { LicenseSigningKey } from 'src/utils/frameleaf-license.js';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';

/**
 * Extra licence-signing keys for pre-release integration builds only (owner decision 2026-09-27).
 *
 * The Frameleaf Cloud e2e run activates licences its dev stack signs. An integration build (see
 * `frameleaf-build-channel.ts`) may trust that stack's keys, read once at startup from a mounted,
 * read-only JWKS file named by `FRAMELEAF_LICENSE_EXTRA_JWKS_FILE`. It is a path, never a URL, so no
 * key is ever fetched at run time. A release build ignores the setting whatever it holds.
 *
 * The keys are only ever added to the set licence certificates are verified with
 * (`FrameleafLicenseService`); every other check on a certificate (alg, typ, kid, signature, aud,
 * iid, sub, cnf, nbf, exp, claims) is unchanged, and no other signature the server verifies reads
 * them. Any problem with the file means nothing extra is trusted.
 */
export const LICENSE_EXTRA_JWKS_ENV = 'FRAMELEAF_LICENSE_EXTRA_JWKS_FILE';

/** The largest JWKS file read, and the most keys it may hold. */
export const LICENSE_EXTRA_JWKS_MAX_BYTES = 64 * 1024;
export const LICENSE_EXTRA_JWKS_MAX_KEYS = 8;

/** Public members a key may carry: the JWK itself plus the cloud's descriptive metadata. */
const ALLOWED_KEY_MEMBERS = new Set([
  'kty',
  'crv',
  'x',
  'kid',
  'alg',
  'use',
  'key_ops',
  'status',
  'notBefore',
  'retireAfter',
]);

const BASE64URL = /^[\w-]+$/;

export type ExtraLicenseKeys =
  | { state: 'unset' }
  | { state: 'ignored'; path: string }
  | { state: 'active'; path: string; keys: LicenseSigningKey[] }
  | { state: 'rejected'; path: string; problem: string };

class JwksProblem extends Error {}

const fail = (problem: string): never => {
  throw new JwksProblem(problem);
};

/**
 * Parse a JWKS strictly: `{ "keys": [...] }` and nothing else; each key an Ed25519 public key
 * (`kty` OKP, `crv` Ed25519, a 32-byte `x`), `alg` EdDSA and `use` sig when present, `key_ops` only
 * `verify`, a `kid` that is the key's RFC 7638 thumbprint, no private or unknown members, no
 * duplicate kids and no kid of a pinned production key. Throws on the first problem.
 */
export const parseExtraLicenseJwks = (text: string, pinned: readonly LicenseSigningKey[]): LicenseSigningKey[] => {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return fail('the file is not JSON');
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return fail('the file is not a JWKS object');
  }
  const members = Object.keys(document);
  if (members.length !== 1 || members[0] !== 'keys') {
    return fail('a JWKS holds only "keys"');
  }
  const keys = (document as { keys: unknown }).keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    return fail('"keys" must be a non-empty array');
  }
  if (keys.length > LICENSE_EXTRA_JWKS_MAX_KEYS) {
    return fail(`at most ${LICENSE_EXTRA_JWKS_MAX_KEYS} keys are allowed`);
  }
  const pinnedKids = new Set(pinned.map(({ kid }) => kid));
  const seen = new Set<string>();
  return keys.map((jwk: unknown, index): LicenseSigningKey => {
    const at = `key ${index}`;
    if (typeof jwk !== 'object' || jwk === null || Array.isArray(jwk)) {
      return fail(`${at} is not an object`);
    }
    const key = jwk as Record<string, unknown>;
    if ('d' in key) {
      return fail(`${at} holds private key material`);
    }
    const unknown = Object.keys(key).filter((member) => !ALLOWED_KEY_MEMBERS.has(member));
    if (unknown.length > 0) {
      return fail(`${at} has members that are not allowed: ${unknown.join(', ')}`);
    }
    if (key.kty !== 'OKP' || key.crv !== 'Ed25519') {
      return fail(`${at} is not an Ed25519 (OKP) key`);
    }
    if (key.alg !== undefined && key.alg !== 'EdDSA') {
      return fail(`${at} names an algorithm other than EdDSA`);
    }
    if (key.use !== undefined && key.use !== 'sig') {
      return fail(`${at} is not a signing key`);
    }
    if (
      key.key_ops !== undefined &&
      !(Array.isArray(key.key_ops) && key.key_ops.length === 1 && key.key_ops[0] === 'verify')
    ) {
      return fail(`${at} may only be used to verify`);
    }
    if (typeof key.x !== 'string' || !BASE64URL.test(key.x) || Buffer.from(key.x, 'base64url').length !== 32) {
      return fail(`${at} has no valid Ed25519 public key`);
    }
    try {
      createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.x }, format: 'jwk' });
    } catch {
      return fail(`${at} has no valid Ed25519 public key`);
    }
    if (typeof key.kid !== 'string' || key.kid !== ed25519Thumbprint({ kty: 'OKP', crv: 'Ed25519', x: key.x })) {
      return fail(`${at} has a kid that is not its RFC 7638 thumbprint`);
    }
    if (pinnedKids.has(key.kid)) {
      return fail(`${at} has the kid of a pinned production key`);
    }
    if (seen.has(key.kid)) {
      return fail(`${at} repeats a kid`);
    }
    seen.add(key.kid);
    return { kid: key.kid, x: key.x, status: 'spare' };
  });
};

/**
 * The extra licence keys this process trusts. On a release build a set path is reported as ignored
 * and the file is never opened. On an integration build the file must be an absolute path to a
 * regular file of at most 64 KiB holding a strict JWKS; anything else is rejected and nothing extra
 * is trusted.
 */
export const loadExtraLicenseKeys = (options: {
  channel: FrameleafBuildChannel;
  path: string | null | undefined;
  pinned: readonly LicenseSigningKey[];
  read?: (path: string) => string;
  size?: (path: string) => { isFile: boolean; size: number };
}): ExtraLicenseKeys => {
  const path = options.path?.trim();
  if (!path) {
    return { state: 'unset' };
  }
  if (options.channel !== 'integration') {
    return { state: 'ignored', path };
  }
  const size =
    options.size ??
    ((file: string) => {
      const stat = statSync(file);
      return { isFile: stat.isFile(), size: stat.size };
    });
  const read = options.read ?? ((file: string) => readFileSync(file, 'utf8'));
  try {
    if (!isAbsolute(path)) {
      fail('the path must be absolute');
    }
    let stat: { isFile: boolean; size: number };
    try {
      stat = size(path);
    } catch {
      return fail('the file cannot be read');
    }
    if (!stat.isFile) {
      fail('the path is not a regular file');
    }
    if (stat.size > LICENSE_EXTRA_JWKS_MAX_BYTES) {
      fail(`the file is larger than ${LICENSE_EXTRA_JWKS_MAX_BYTES} bytes`);
    }
    let text: string;
    try {
      text = read(path);
    } catch {
      return fail('the file cannot be read');
    }
    return { state: 'active', path, keys: parseExtraLicenseJwks(text, options.pinned) };
  } catch (error) {
    if (error instanceof JwksProblem) {
      return { state: 'rejected', path, problem: error.message };
    }
    return { state: 'rejected', path, problem: 'the file could not be checked' };
  }
};

/** The startup log line for each outcome (none when the setting is unset). */
export const extraLicenseKeysLog = (result: ExtraLicenseKeys): { level: 'warn' | 'error'; message: string } | null => {
  switch (result.state) {
    case 'unset': {
      return null;
    }
    case 'ignored': {
      return {
        level: 'warn',
        message: `${LICENSE_EXTRA_JWKS_ENV} is set (${result.path}) but ignored: this is a release build, which trusts only the pinned licence keys`,
      };
    }
    case 'active': {
      return {
        level: 'warn',
        message: `Pre-release build trusting extra licence keys from ${result.path} (kid ${result.keys.map(({ kid }) => kid).join(', ')}). Never use this build in production.`,
      };
    }
    case 'rejected': {
      return {
        level: 'error',
        message: `${LICENSE_EXTRA_JWKS_ENV} (${result.path}) was rejected, so no extra licence keys are trusted: ${result.problem}`,
      };
    }
  }
};
