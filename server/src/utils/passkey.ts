import { isIP } from 'node:net';
import type { Request } from 'express';
import type { IncomingHttpHeaders } from 'node:http';
import type { FrameleafRequest } from 'src/middleware/frameleaf-via.middleware.js';
import type { LoginDetails } from 'src/services/auth.service.js';
import { requestHosts } from 'src/utils/websocket-origin.js';

/**
 * FL-836: passkeys (WebAuthn) for local accounts. The rules shared by the passkey endpoints: where a
 * passkey may be made or used, how long a ceremony lasts, and how the server names a passkey's
 * authenticator.
 */

/** How long a registration or sign-in challenge can be answered. */
export const PASSKEY_CHALLENGE_SECONDS = 5 * 60;
/** How long a password check lasts before adding a passkey asks for it again. */
export const PASSKEY_PASSWORD_PROOF_SECONDS = 10 * 60;
/** Longest passkey name. */
export const PASSKEY_NAME_LENGTH = 40;
/** What the browser's window may take, a little under the challenge's life. */
export const PASSKEY_CEREMONY_TIMEOUT_MS = 4 * 60 * 1000;

/** Why passkeys can't be used at the address a page is open on. */
export const PasskeyUnavailableReason = {
  /** A plain http address (other than localhost): browsers offer passkeys only on https. */
  Insecure: 'insecure',
  /** An https address that isn't this server's external domain or Frameleaf address. */
  Address: 'address',
} as const;
export type PasskeyUnavailableReason = (typeof PasskeyUnavailableReason)[keyof typeof PasskeyUnavailableReason];

export type PasskeyPlace =
  { available: true; origin: string; rpId: string } | { available: false; reason: PasskeyUnavailableReason };

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

const originOf = (value: string | null | undefined): URL | null => {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
};

/**
 * The origin of the page that sent the request: its `Origin` header (every browser sends one on a
 * POST), or else the address it was sent to.
 */
export const requestOrigin = (headers: IncomingHttpHeaders, isSecure: boolean): string | null => {
  const origin = originOf(first(headers.origin));
  if (origin) {
    return origin.origin;
  }
  const host = requestHosts(headers).at(-1);
  return host ? (originOf(`${isSecure ? 'https' : 'http'}://${host}`)?.origin ?? null) : null;
};

const isLocalhost = (hostname: string) => hostname === 'localhost';

/**
 * Where a passkey may be made and used. The relying party is the page's own host, accepted only when
 * it is `localhost` or one of `trusted` (the external domain and the Frameleaf relay and public
 * addresses), and only over https except on localhost. Browsers enforce the same secure-context rule;
 * the server refuses any other address so a page that merely proxies it can't collect passkeys.
 */
export const passkeyPlace = (origin: string | null, trusted: Array<string | null | undefined>): PasskeyPlace => {
  const url = originOf(origin);
  if (!url) {
    return { available: false, reason: PasskeyUnavailableReason.Address };
  }
  if (isLocalhost(url.hostname)) {
    return { available: true, origin: url.origin, rpId: url.hostname };
  }
  if (url.protocol !== 'https:') {
    return { available: false, reason: PasskeyUnavailableReason.Insecure };
  }
  const trustedOrigins = new Set(
    trusted.map((value) => originOf(value)).flatMap((value) => (value?.protocol === 'https:' ? [value.origin] : [])),
  );
  // an IP address can't be a relying party
  if (isIP(url.hostname.replaceAll(/^\[|\]$/g, '')) || !trustedOrigins.has(url.origin)) {
    return { available: false, reason: PasskeyUnavailableReason.Address };
  }
  return { available: true, origin: url.origin, rpId: url.hostname };
};

/** The WebAuthn user handle of an account: its id's 16 bytes (never the email). */
export const passkeyUserHandle = (userId: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.from(userId.replaceAll('-', ''), 'hex'));

/** The challenge a browser answered, read from its `clientDataJSON`; null when unreadable. */
export const answeredChallenge = (clientDataJSON: unknown): string | null => {
  if (typeof clientDataJSON !== 'string') {
    return null;
  }
  try {
    const data: unknown = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8'));
    const challenge = (data as { challenge?: unknown } | null)?.challenge;
    return typeof challenge === 'string' && challenge.length > 0 && challenge.length <= 128 ? challenge : null;
  } catch {
    return null;
  }
};

/** A tidy passkey name: spaces collapsed, trimmed, at most PASSKEY_NAME_LENGTH characters. */
export const cleanPasskeyName = (name: string) => name.replaceAll(/\s+/g, ' ').trim().slice(0, PASSKEY_NAME_LENGTH);

/**
 * The authenticators people use most, by AAGUID (from the community list at
 * github.com/passkeydeveloper/passkey-authenticator-aaguids). Kept here rather than fetched, so the
 * server never calls out to name a passkey. Anything else is named by the browser alone.
 */
const PROVIDERS: Record<string, string> = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud Keychain',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
  '50726f74-6f6e-5061-7373-50726f746f6e': 'Proton Pass',
  'fdb141b2-5d84-443e-8a35-4698c205a502': 'KeePassXC',
};

/** The password manager or kind of device a passkey is saved in, when the server knows it. */
export const passkeyProvider = (aaguid: string | null | undefined): string | null =>
  (aaguid && PROVIDERS[aaguid.toLowerCase()]) || null;

/**
 * FL-836: whether the request itself arrived over https: directly, through a trusted proxy (Express
 * `trust proxy`), or through the Frameleaf edge worker, which vouches for its `X-Forwarded-Proto`.
 */
export const passkeyDetails = (req: Request, details: LoginDetails): LoginDetails => ({
  ...details,
  isSecure: details.isSecure || (req as FrameleafRequest).frameleafForwarded?.proto === 'https',
});
