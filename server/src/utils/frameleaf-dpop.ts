import { createHash, randomUUID } from 'node:crypto';
import { MlAdmissionRefusal } from 'src/enum.js';
import { FrameleafCloudError, base64url } from 'src/utils/frameleaf-cloud.js';

/**
 * RFC 9449 (DPoP) for Frameleaf Cloud instance tokens (FL-178, the app side of FC-66). The cloud
 * accepts bearer instance tokens only while its `instance.bearer_compat` flag is on, which it is not
 * in production, so every instance token is bound to this server's identity key:
 *
 * - The token request (`POST {issuer}/token`) carries a proof and keeps its `private_key_jwt` client
 *   assertion; both are signed by the same key, and the token's `cnf.jkt` is that key's thumbprint.
 * - Every api and ml call sends `Authorization: DPoP <token>` and a fresh proof with `ath`.
 * - `POST {api}/v1/instances` carries a proof by the key being linked, without `ath`.
 */

/** The public half of an Ed25519 identity key, as a JWK. */
export type Ed25519PublicJwk = { kty: 'OKP'; crv: 'Ed25519'; x: string };

/**
 * One identity key's signing capability: its RFC 7638 thumbprint, its public JWK and compact EdDSA
 * JWS signing with a caller-chosen header. A signer is bound to one key for its whole life, so the
 * client assertion, every proof and the token's `cnf.jkt` always name the same key, even when a
 * rotation replaces the current key meanwhile.
 */
export type FrameleafKeySigner = {
  kid: string;
  publicJwk: Ed25519PublicJwk;
  sign: (header: Record<string, unknown>, payload: Record<string, unknown>) => string;
};

/** An instance access token and the key it is bound to (`cnf.jkt`). */
export type FrameleafInstanceToken = { accessToken: string; signer: FrameleafKeySigner };

/** Response header carrying a server-provided nonce (RFC 9449 section 8). */
export const DPOP_NONCE_HEADER = 'dpop-nonce';

/** The error code of a nonce challenge, from the token endpoint (400) or a resource (401). */
export const USE_DPOP_NONCE = 'use_dpop_nonce';

/** The longest nonce this server keeps; the cloud's are far shorter. */
const MAX_NONCE_LENGTH = 512;

/**
 * Whether a `DPoP-Nonce` value is usable: `1*NQCHAR` (RFC 9449 section 8), that is %x21, %x23-5B and
 * %x5D-7E (visible ASCII except `"` and `\`), at most `MAX_NONCE_LENGTH` characters. Checked by
 * character code rather than a character class, so no regex rewrite can change the allowed set.
 */
export const isUsableNonce = (value: string | null | undefined): value is string => {
  if (!value || value.length > MAX_NONCE_LENGTH) {
    return false;
  }
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x21 || code > 0x7e || code === 0x22 || code === 0x5c) {
      return false;
    }
  }
  return true;
};

/**
 * The `htu` of a request (RFC 9449 section 4.2): scheme, host, the port only when it is not the
 * scheme's default, and the path; never the query or the fragment. Scheme and host are lower case.
 */
export const dpopHtu = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
};

/** `ath`: base64url of the SHA-256 of the access token's ASCII value (RFC 9449 section 4.2). */
export const dpopAth = (accessToken: string): string =>
  createHash('sha256').update(accessToken, 'ascii').digest('base64url');

/**
 * A DPoP proof JWT (RFC 9449 section 4.2). Header `{typ:"dpop+jwt", alg:"EdDSA", jwk}` with the
 * public key only and no `kid`; payload `{jti, htm, htu, iat, nonce?, ath?}`. `iat` is this server's
 * clock in whole seconds (the cloud allows ±60 s), and `jti` is new for every proof (the cloud refuses
 * a reuse within 5 minutes). `ath` is only for a call that presents an access token, never for the
 * token request itself.
 */
export const createDpopProof = (
  signer: FrameleafKeySigner,
  request: { htm: string; htu: string; nonce?: string; accessToken?: string },
  now = Date.now(),
): string => {
  const { kty, crv, x } = signer.publicJwk;
  return signer.sign(
    { typ: 'dpop+jwt', alg: 'EdDSA', jwk: { kty, crv, x } },
    {
      jti: randomUUID(),
      htm: request.htm.toUpperCase(),
      htu: dpopHtu(request.htu),
      iat: Math.floor(now / 1000),
      ...(request.nonce && { nonce: request.nonce }),
      ...(request.accessToken && { ath: dpopAth(request.accessToken) }),
    },
  );
};

/** A `private_key_jwt` client assertion (RFC 7523): header `{alg:"EdDSA", typ:"JWT", kid}`. */
export const signClientAssertion = (signer: FrameleafKeySigner, claims: Record<string, unknown>): string =>
  signer.sign({ alg: 'EdDSA', typ: 'JWT', kid: signer.kid }, claims);

/**
 * Whether a failed answer is a DPoP nonce challenge: `400 {error:"use_dpop_nonce"}` from the token
 * endpoint, or a 401 with code `use_dpop_nonce` or `WWW-Authenticate: DPoP error="use_dpop_nonce"`
 * from api and ml. Such an answer never means the token is bad.
 */
export const isNonceChallenge = (
  status: number,
  code: string | null | undefined,
  wwwAuthenticate: string | null | undefined,
): boolean => {
  if (status !== 400 && status !== 401) {
    return false;
  }
  if (code === USE_DPOP_NONCE) {
    return true;
  }
  // the quoted-string or the bare token form of the auth-param (RFC 7235 section 2.1), the value
  // ending at the closing quote, or at a delimiter or the end (never `use_dpop_nonce_other`)
  return /(?:^|[\s,])error\s*=\s*(?:"use_dpop_nonce"|use_dpop_nonce(?=[\s,;]|$))/i.test(wwwAuthenticate ?? '');
};

/**
 * The token endpoint answered with a token response this server parsed, but will not use: not
 * DPoP-bound, or bound to (or minted for) another key (FL-178). Thrown only by `accessToken`, after
 * the answer passed `tokenResponseSchema`, so it proves the cloud checked the client assertion and
 * issued a token for that key. Any other failure, including a 200 that is not a token response (a
 * captive portal's HTML, invalid JSON, an oversized body), is a plain `FrameleafCloudError`.
 */
export class BoundTokenRefusedError extends FrameleafCloudError {
  constructor(problem: string) {
    super(
      MlAdmissionRefusal.CloudUnavailable,
      200,
      `Frameleaf Cloud issued a token this server will not use: ${problem}`,
    );
    this.name = 'BoundTokenRefusedError';
  }
}

/**
 * Why an issued token must not be used with `signer`, or null (FL-178, FC-66). The token type must
 * be `DPoP` (compared without case, RFC 6749 section 7.1), and the token (a JWT) must be bound to
 * this very key: `cnf.jkt` is its thumbprint, and `frameleaf_kid` (the key whose client assertion
 * minted it), when present, names the same key. A token bound to another key would only be refused
 * by the cloud, and a bearer token would be sent where only bound tokens are accepted.
 */
export const boundTokenProblem = (
  response: { access_token: string; token_type?: string },
  signer: FrameleafKeySigner,
): string | null => {
  if (response.token_type?.toLowerCase() !== 'dpop') {
    return `the token type is ${response.token_type ?? 'missing'}, not DPoP`;
  }
  let claims: { cnf?: { jkt?: unknown }; frameleaf_kid?: unknown } | null = null;
  try {
    const [, payload] = response.access_token.split('.', 3);
    claims = payload ? (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof claims) : null;
  } catch {
    claims = null;
  }
  if (!claims || typeof claims !== 'object') {
    return 'the token is not a JWT this server can read';
  }
  if (claims.cnf?.jkt !== signer.kid) {
    return 'the token is not bound to this server’s key (cnf.jkt)';
  }
  if (claims.frameleaf_kid !== undefined && claims.frameleaf_kid !== signer.kid) {
    return 'the token was minted for another key of this server (frameleaf_kid)';
  }
  return null;
};

/** Compact EdDSA JWS parts, for signers that hold the private key (see `InstanceIdentityRepository`). */
export const jwsSigningInput = (header: Record<string, unknown>, payload: Record<string, unknown>): string =>
  `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
