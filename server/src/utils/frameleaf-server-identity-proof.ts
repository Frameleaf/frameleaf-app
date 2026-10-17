import { BadRequestException } from '@nestjs/common';
import { createPublicKey, verify } from 'node:crypto';
import { base64url } from 'src/utils/frameleaf-cloud.js';

/**
 * FL-430: proof that an unencrypted (home network, `http://`) address answers for the server an app
 * signed in to. The app pins this server's identity keys (the Ed25519 instance key Frameleaf Cloud
 * already knows, published as `identityKeys: [{kid, jwk}]` by `GET /server/identity` and by the cloud's
 * `GET /v1/instances`) over a trusted path. Before it attaches a session token on an unencrypted route
 * it sends a fresh nonce to `POST /server/identity/challenge` and verifies the returned compact JWS:
 *
 * - protected header: `{"alg":"EdDSA","typ":"frameleaf-lan-identity+jwt","kid":"<kid>"}`
 * - payload: the UTF-8 string `frameleaf-lan-identity-v1|<instanceId>|<nonce>|<iat>|<origin>` (not
 *   JSON), base64url-encoded as the JWS payload segment
 * - signature: Ed25519 over the ASCII bytes `<header b64url>.<payload b64url>` (RFC 8037)
 *
 * This proves the answering host holds the private key; it is not channel binding. A live
 * man-in-the-middle on plain http can still relay requests, so apps should prefer https or the relay.
 */
export const LAN_IDENTITY_JWS_TYPE = 'frameleaf-lan-identity+jwt';
export const LAN_IDENTITY_PAYLOAD_PREFIX = 'frameleaf-lan-identity-v1';

/** 16 to 96 random bytes, base64url without padding. */
export const IDENTITY_NONCE_MIN_LENGTH = 22;
export const IDENTITY_NONCE_MAX_LENGTH = 128;
export const IDENTITY_NONCE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;

/** A host (name, IPv4, or bracketed IPv6) with an optional port; nothing that could add a `|`. */
const HOST_PATTERN = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/;
const MAX_HOST_LENGTH = 261;

export type LanIdentityClaims = { instanceId: string; nonce: string; iat: number; origin: string };

export const lanIdentityPayload = ({ instanceId, nonce, iat, origin }: LanIdentityClaims): string =>
  [LAN_IDENTITY_PAYLOAD_PREFIX, instanceId, nonce, String(iat), origin].join('|');

/** The JWS signing input `<header>.<payload>` for one key. */
export const lanIdentitySigningInput = (kid: string, claims: LanIdentityClaims): string =>
  `${base64url(Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: LAN_IDENTITY_JWS_TYPE, kid })))}.${base64url(
    Buffer.from(lanIdentityPayload(claims), 'utf8'),
  )}`;

/** Sign the challenge with `signBytes` (an Ed25519 signer for the key named `kid`): a compact JWS. */
export const signLanIdentity = (
  signer: { kid: string; signBytes: (data: Buffer) => Buffer },
  claims: LanIdentityClaims,
): string => {
  const input = lanIdentitySigningInput(signer.kid, claims);
  return `${input}.${base64url(signer.signBytes(Buffer.from(input)))}`;
};

/** Rejects a nonce that is not 22-128 base64url characters (400). */
export const assertIdentityNonce = (nonce: unknown): string => {
  if (typeof nonce !== 'string' || !IDENTITY_NONCE_PATTERN.test(nonce)) {
    throw new BadRequestException(
      `nonce must be ${IDENTITY_NONCE_MIN_LENGTH}-${IDENTITY_NONCE_MAX_LENGTH} base64url characters`,
    );
  }
  return nonce;
};

/** What `identityRequestOrigin` reads from a request, after `frameleafViaMiddleware` ran. */
export type IdentityOriginRequest = {
  headers: { host?: string };
  socket?: { encrypted?: boolean } | null;
  /** Set by `frameleafViaMiddleware` only for a request the edge worker vouched for with its secret. */
  frameleafForwarded?: { proto: string | null; host: string | null } | null;
};

/**
 * The origin the request actually arrived on, `<scheme>://<host>[:port]`, lowercased (FL-430). One
 * server answers on many origins at once (LAN addresses, the relay hostname and custom hostnames, a
 * direct internet address) and the app accepts a proof only when this equals the origin it dialled.
 *
 * - Through remote access (relay, direct, or LAN through the edge worker) the scheme and host are the
 *   `X-Forwarded-Proto` / `X-Forwarded-Host` the edge worker vouched for with `FRAMELEAF_EDGE_SECRET`
 *   (`frameleafForwarded`); that is the only source of forwarded values trusted here.
 * - Otherwise the Host header as received and this connection's own scheme. `X-Forwarded-*` from
 *   anyone else is ignored, including Express's `trust proxy` (which by default trusts every private
 *   address, so any LAN peer).
 *
 * Anything that is not a plain host is refused (400), so the signed payload can never carry an extra
 * `|` field.
 */
export const identityRequestOrigin = (request: IdentityOriginRequest): string => {
  const forwarded = request.frameleafForwarded ?? null;
  const ownScheme = request.socket?.encrypted ? 'https' : 'http';
  const scheme = (forwarded?.proto ?? ownScheme).toLowerCase();
  const host = (forwarded?.host ?? request.headers.host ?? '').toLowerCase();
  if ((scheme !== 'http' && scheme !== 'https') || host.length > MAX_HOST_LENGTH || !HOST_PATTERN.test(host)) {
    throw new BadRequestException('The request has no usable Host header');
  }
  return `${scheme}://${host}`;
};

/**
 * What an app does (reference for tests and the native clients): check the header, the signature
 * against a pinned `{kid, jwk}`, and return the payload fields; null when anything does not match.
 */
export const verifyLanIdentity = (
  jws: string,
  pinned: { kid: string; jwk: { kty: 'OKP'; crv: 'Ed25519'; x: string } }[],
): LanIdentityClaims | null => {
  const parts = jws.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [headerPart, payloadPart, signaturePart] = parts;
  try {
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (header.alg !== 'EdDSA' || header.typ !== LAN_IDENTITY_JWS_TYPE) {
      return null;
    }
    const key = pinned.find((candidate) => candidate.kid === header.kid);
    if (!key) {
      return null;
    }
    const publicKey = createPublicKey({ key: key.jwk, format: 'jwk' });
    if (
      !verify(null, Buffer.from(`${headerPart}.${payloadPart}`), publicKey, Buffer.from(signaturePart, 'base64url'))
    ) {
      return null;
    }
    const fields = Buffer.from(payloadPart, 'base64url').toString('utf8').split('|');
    if (fields.length !== 5 || fields[0] !== LAN_IDENTITY_PAYLOAD_PREFIX || !/^\d+$/.test(fields[3])) {
      return null;
    }
    return { instanceId: fields[1], nonce: fields[2], iat: Number(fields[3]), origin: fields[4] };
  } catch {
    return null;
  }
};
