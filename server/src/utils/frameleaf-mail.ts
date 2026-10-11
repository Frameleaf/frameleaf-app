import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import z from 'zod';
import type { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import type { FrameleafInstanceToken } from 'src/utils/frameleaf-dpop.js';
import { MailSignInProvider } from 'src/enum.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';

/**
 * FL-379: sending email from a Gmail or Microsoft account connected by one-click sign-in.
 *
 * Google and Microsoft only return a sign-in to a fixed public address and want a client secret for
 * every token call, so Frameleaf Cloud runs a small broker (FC-160, `packages/contracts/src/instance/mail.ts`).
 * This file is the server's side of that contract and the secret handling around it:
 *
 * - the state value and the PKCE verifier are made here and never leave this server (the cloud gets
 *   the S256 challenge only); the one-time code is handed out once, to the server that started;
 * - the refresh token is kept on this server only, sealed (AES-256-GCM) with a key derived from the
 *   server's own secret file, so a copy of the database alone cannot send mail;
 * - nothing here logs a token, a code, a verifier or a message.
 */

/** The cloud's names for the providers; this server says `gmail` where the cloud says `google`. */
const CLOUD_PROVIDER = { [MailSignInProvider.Gmail]: 'google', [MailSignInProvider.Microsoft]: 'microsoft' } as const;
type CloudMailProvider = (typeof CLOUD_PROVIDER)[MailSignInProvider];

export const cloudMailProvider = (provider: MailSignInProvider): CloudMailProvider => CLOUD_PROVIDER[provider];

const cloudProviderSchema = z.enum(['google', 'microsoft']);

/** `GET /v1/instance/mail/providers`: always a row per provider; unknown future providers are ignored. */
export const mailProvidersResponseSchema = z.object({
  providers: z.array(z.object({ provider: z.string().max(50), available: z.boolean() })).max(20),
});

export const mailSignInStartRequestSchema = z.strictObject({
  provider: cloudProviderSchema,
  state: z.string().regex(/^[\w-]{16,128}$/),
  codeChallenge: z.string().regex(/^[\w-]{43}$/),
});
export type MailSignInStartRequest = z.infer<typeof mailSignInStartRequestSchema>;

export const mailSignInStartResponseSchema = z.object({
  signInId: z.uuid(),
  authorizationUrl: z.url().max(4096),
  expiresAt: z.iso.datetime(),
});

export const mailSignInClaimResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('ready'), state: z.string().max(128), code: z.string().min(1).max(4096) }),
  z.object({ status: z.literal('denied'), state: z.string().max(128) }),
]);
export type MailSignInClaim = z.infer<typeof mailSignInClaimResponseSchema>;

export const mailTokenRequestSchema = z.discriminatedUnion('grant', [
  z.strictObject({
    grant: z.literal('authorization_code'),
    provider: cloudProviderSchema,
    code: z.string().min(1).max(4096),
    codeVerifier: z.string().regex(/^[\w.~-]{43,128}$/),
  }),
  z.strictObject({
    grant: z.literal('refresh_token'),
    provider: cloudProviderSchema,
    refreshToken: z.string().min(1).max(8192),
  }),
]);
export type MailTokenRequest = z.infer<typeof mailTokenRequestSchema>;

export const mailTokenResponseSchema = z.object({
  accessToken: z.string().min(1).max(16_384),
  expiresInSec: z.int().min(1),
  refreshToken: z.string().min(1).max(8192).optional(),
  scope: z.string().max(2000).optional(),
  email: z.string().max(320).optional(),
});
export type MailTokenResponse = z.infer<typeof mailTokenResponseSchema>;

export const mailRevokeRequestSchema = z.strictObject({
  provider: cloudProviderSchema,
  refreshToken: z.string().min(1).max(8192),
});

export const mailRevokeResponseSchema = z.object({ status: z.enum(['revoked', 'not-supported']) });

/** The cloud's error codes for the mail broker (standard envelope `code`). */
export enum MailCloudErrorCode {
  /** 400: the provider said `invalid_grant`. The only signal that the account must sign in again. */
  GrantInvalid = 'mail-grant-invalid',
  /** 404: unknown, expired, already claimed, or started by another server (indistinguishable on purpose). */
  SignInNotFound = 'mail-sign-in-not-found',
  /** 503: the provider is not configured on this deployment. */
  SignInUnavailable = 'mail-sign-in-unavailable',
  /** 502: the provider could not be reached; keep the connection and retry later. */
  ProviderUnavailable = 'mail-provider-unavailable',
}

const hasCode = (error: unknown, status: number, code: MailCloudErrorCode) =>
  error instanceof FrameleafCloudError && error.status === status && error.envelope?.code === code;

/** The provider refused the grant for good: a dead code, a wrong verifier, or a revoked refresh token. */
export const isMailGrantInvalid = (error: unknown) => hasCode(error, 400, MailCloudErrorCode.GrantInvalid);
/** The sign-in is gone (too late, used, or not this server's): start again. */
export const isMailSignInNotFound = (error: unknown) => hasCode(error, 404, MailCloudErrorCode.SignInNotFound);
/** Frameleaf Cloud does not offer this provider (yet). */
export const isMailSignInUnavailable = (error: unknown) => hasCode(error, 503, MailCloudErrorCode.SignInUnavailable);

/** Where the mail broker is and the instance token to call it with. */
export type MailBrokerTarget = { api: string; token: FrameleafInstanceToken };

type Cloud = Pick<FrameleafCloudRepository, 'requestJson'>;

const brokerUrl = (target: MailBrokerTarget, path: string) =>
  `${target.api.replace(/\/+$/, '')}/v1/instance/mail/${path}`;

/** Which providers Frameleaf Cloud has configured. */
export const readMailProviders = async (cloud: Cloud, target: MailBrokerTarget): Promise<MailSignInProvider[]> => {
  const { providers } = await cloud.requestJson(mailProvidersResponseSchema, {
    url: brokerUrl(target, 'providers'),
    dpop: target.token,
  });
  return Object.values(MailSignInProvider).filter((provider) =>
    providers.some((row) => row.provider === cloudMailProvider(provider) && row.available),
  );
};

/** Register a pending sign-in; the answer carries the provider's page to open in the administrator's browser. */
export const startMailSignIn = (cloud: Cloud, target: MailBrokerTarget, request: MailSignInStartRequest) =>
  cloud.requestJson(mailSignInStartResponseSchema, {
    method: 'POST',
    url: brokerUrl(target, 'sign-ins'),
    dpop: target.token,
    body: mailSignInStartRequestSchema.parse(request),
  });

/** Ask for the one-time code of a sign-in this server started. A `ready` answer is given once. */
export const claimMailSignIn = (cloud: Cloud, target: MailBrokerTarget, signInId: string) =>
  cloud.requestJson(mailSignInClaimResponseSchema, {
    method: 'POST',
    url: brokerUrl(target, `sign-ins/${encodeURIComponent(signInId)}/claim`),
    dpop: target.token,
  });

/** Exchange a code, or renew access: the cloud adds the client secret and keeps nothing. */
export const requestMailToken = (cloud: Cloud, target: MailBrokerTarget, request: MailTokenRequest) =>
  cloud.requestJson(mailTokenResponseSchema, {
    method: 'POST',
    url: brokerUrl(target, 'token'),
    dpop: target.token,
    body: mailTokenRequestSchema.parse(request),
  });

/** Revoke at the provider. Microsoft has no revocation for these tokens and answers `not-supported`. */
export const revokeMailToken = (
  cloud: Cloud,
  target: MailBrokerTarget,
  request: z.infer<typeof mailRevokeRequestSchema>,
) =>
  cloud.requestJson(mailRevokeResponseSchema, {
    method: 'POST',
    url: brokerUrl(target, 'revoke'),
    dpop: target.token,
    body: mailRevokeRequestSchema.parse(request),
  });

/** A state value: 32 random bytes, base64url (43 characters). */
export const newMailState = () => randomBytes(32).toString('base64url');
/** A PKCE verifier (RFC 7636): 32 random bytes, base64url (43 characters). */
export const newPkceVerifier = () => randomBytes(32).toString('base64url');
/** The S256 challenge of a PKCE verifier. */
export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

/** The purpose and value the sealing key is derived from with the server's keyed hash (`server-hmac.key`). */
export const MAIL_SEAL_PURPOSE = 'mail-connection-seal';
export const MAIL_SEAL_KEY_NAME = 'v1';

/** The 32-byte sealing key from the server's keyed hash of `MAIL_SEAL_PURPOSE`. */
export const mailSealKey = (keyedHash: string) => createHash('sha256').update(keyedHash).digest();

/**
 * Seal a secret for storage: AES-256-GCM under a random nonce, bound to `context` (the record it
 * belongs to), so a sealed value copied into another record does not open.
 */
export const sealMailSecret = (key: Buffer, context: string, value: unknown): string => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`frameleaf-mail:v1:${context}`));
  const sealed = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), sealed]).toString('base64');
};

/** Open a sealed secret, or null when it does not open (another server's secret file, or a damaged value). */
export const openMailSecret = <T>(key: Buffer, context: string, sealed: string): T | null => {
  try {
    const bytes = Buffer.from(sealed, 'base64');
    if (bytes.length < 29) {
      return null;
    }
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`frameleaf-mail:v1:${context}`));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()) as T;
  } catch {
    return null;
  }
};

/** The address inside a sender such as `Rivera photos <photos@example.com>`, lower-cased. */
export const mailAddressOf = (sender: string) => (/<([^<>]+)>\s*$/.exec(sender)?.[1] ?? sender).trim().toLowerCase();

/**
 * The sender of an email sent through a connected account. Gmail and Microsoft only send as the
 * connected account, so a saved sender that names another address is replaced by the account's own;
 * a saved sender with the account's address keeps its display name.
 */
export const connectedSender = (savedSender: string, email: string) =>
  savedSender.trim() && mailAddressOf(savedSender) === email.toLowerCase() ? savedSender : email;
