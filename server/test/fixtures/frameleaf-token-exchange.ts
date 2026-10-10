import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { FRAMELEAF_EXCHANGE_TOKEN_TYPE } from 'src/utils/frameleaf-sign-in.js';

/**
 * FL-230 (NAPI-006): the server-audience token a native app gets from the Frameleaf identity provider
 * (RFC 8693 token exchange, Frameleaf Cloud's C2) and presents at `POST /oauth/frameleaf/exchange`.
 *
 * Minted here with a test key so every claim can be varied; the cloud's own FC-86 golden tokens
 * (`frameleaf-cloud-contracts/identity/exchange/`) are verified as published in
 * `frameleaf-auth.service.spec.ts` as well.
 *
 * - header `typ` = `frameleaf-exchange+jwt` (explicit typing, RFC 8725 section 3.11), so an ordinary,
 *   reusable ID token is never accepted in its place;
 * - `iss` = the link's issuer, `aud` = this server's client id (its instance id);
 * - `iat`, `exp` (at most two minutes later) and a unique `jti` (one use);
 * - the claims a Sign in with Frameleaf ID token carries (`identity/instance-claims.json`), including
 *   the instance-access result `frameleaf_role` and `frameleaf_access`.
 */
export type ExchangeTokenOptions = {
  key: CryptoKey;
  kid: string;
  alg: 'RS256' | 'EdDSA';
  issuer: string;
  audience: string | string[];
  /** Claims to add or replace; `undefined` removes one. */
  claims?: Record<string, unknown>;
  typ?: string | null;
  issuedAt?: number;
  lifetimeSeconds?: number;
  jti?: string | null;
  subject?: string;
};

export const exchangeClaims = () => ({
  email: 'Remote@Example.test',
  email_verified: true,
  name: 'Remote Person',
  frameleaf_role: 'user',
  frameleaf_access: 'viewer',
  sid: 'fl-app-sid',
  auth_time: Math.floor(Date.now() / 1000) - 30,
});

export const mintExchangeToken = async ({
  key,
  kid,
  alg,
  issuer,
  audience,
  claims = {},
  typ = FRAMELEAF_EXCHANGE_TOKEN_TYPE,
  issuedAt = Math.floor(Date.now() / 1000),
  lifetimeSeconds = 120,
  jti = randomUUID(),
  subject = 'fl-sub',
}: ExchangeTokenOptions) => {
  const payload: Record<string, unknown> = { ...exchangeClaims(), ...claims };
  for (const [name, value] of Object.entries(payload)) {
    if (value === undefined) {
      delete payload[name];
    }
  }
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg, kid, ...(typ && { typ }) })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + lifetimeSeconds);
  if (jti) {
    jwt.setJti(jti);
  }
  return jwt.sign(key);
};
