import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/** Sign in with Frameleaf (FL-158): a person's own Frameleaf account link and the sign-in handoff. */

const FrameleafAccountLinkResponseSchema = z
  .object({
    available: z.boolean().describe('Sign in with Frameleaf is available on this server (it is linked)'),
    linked: z.boolean(),
    email: z.string().nullable().describe('The linked Frameleaf account’s email'),
    linkedAt: z.string().nullable(),
    lastSignInAt: z.string().nullable(),
  })
  .meta({ id: 'FrameleafAccountLinkResponseDto' });

const FrameleafHandoffResponseSchema = z
  .object({
    code: z.string().describe('A single-use code for signing in on another address of this server'),
    expiresAt: z.string(),
    url: z
      .string()
      .nullable()
      .describe('Where to continue with the code: the home address asked for, when this server published it'),
  })
  .meta({ id: 'FrameleafHandoffResponseDto' });

const FrameleafHandoffRedeemSchema = z
  .object({
    code: z.string().min(16).max(200).describe('The code from POST oauth/frameleaf/handoff'),
    rememberMe: z.boolean().optional(),
  })
  .meta({ id: 'FrameleafHandoffRedeemDto' });

const FrameleafHandoffCreateSchema = z
  .object({
    returnTo: z
      .string()
      .max(2048)
      .optional()
      .describe('The home address to sign in on; only an address this server published for its home network'),
  })
  .meta({ id: 'FrameleafHandoffCreateDto' });

/**
 * FL-230 (NAPI-006): why `POST oauth/frameleaf/exchange` refused a token, so the app can explain it.
 */
export enum FrameleafTokenExchangeErrorCode {
  /** This server is not linked to Frameleaf Cloud. */
  NotLinked = 'frameleaf_exchange_not_linked',
  /** This server is linked, but Sign in with Frameleaf is not available on it. */
  SignInOff = 'frameleaf_exchange_sign_in_off',
  /** The Frameleaf account has no access to this server, or Frameleaf Cloud removed it. */
  NoAccess = 'frameleaf_exchange_no_access',
  /** The token was minted for another server. */
  WrongAudience = 'frameleaf_exchange_wrong_audience',
  /** The token expired, or was minted too long ago. */
  Expired = 'frameleaf_exchange_expired',
  /** The token was already used. */
  Replayed = 'frameleaf_exchange_replayed',
  /** Not a Frameleaf exchange token for this server (signature, issuer, type or claims). */
  Invalid = 'frameleaf_exchange_invalid',
  /** Frameleaf has not verified the account's email. */
  EmailUnverified = 'frameleaf_exchange_email_unverified',
  /** The account this Frameleaf account is linked to is being removed from this server. */
  AccountRemoved = 'frameleaf_exchange_account_removed',
  /** The account with this email here is linked to another Frameleaf account. */
  AccountConflict = 'frameleaf_exchange_account_conflict',
}

const FrameleafTokenExchangeErrorCodeSchema = z
  .enum(FrameleafTokenExchangeErrorCode)
  .describe('Why the token was refused')
  .meta({ id: 'FrameleafTokenExchangeErrorCode' });

const FrameleafTokenExchangeSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .max(16_384)
      .describe(
        'A server-audience token from the Frameleaf identity provider (OAuth token exchange), signed by the issuer this server is linked to, with header typ "frameleaf-exchange+jwt", aud this server\'s client id, iat, exp, a single-use jti and the Sign in with Frameleaf claims',
      ),
    rememberMe: z.boolean().optional(),
  })
  .meta({ id: 'FrameleafTokenExchangeDto' });

const FrameleafTokenExchangeErrorSchema = z
  .object({
    message: z.string(),
    error: z.string(),
    statusCode: z.int(),
    code: FrameleafTokenExchangeErrorCodeSchema,
  })
  .meta({ id: 'FrameleafTokenExchangeErrorDto' });

export class FrameleafAccountLinkResponseDto extends createZodDto(FrameleafAccountLinkResponseSchema) {}
export class FrameleafHandoffResponseDto extends createZodDto(FrameleafHandoffResponseSchema) {}
export class FrameleafHandoffCreateDto extends createZodDto(FrameleafHandoffCreateSchema) {}
export class FrameleafHandoffRedeemDto extends createZodDto(FrameleafHandoffRedeemSchema) {}
export class FrameleafTokenExchangeDto extends createZodDto(FrameleafTokenExchangeSchema) {}
export class FrameleafTokenExchangeErrorDto extends createZodDto(FrameleafTokenExchangeErrorSchema) {}
