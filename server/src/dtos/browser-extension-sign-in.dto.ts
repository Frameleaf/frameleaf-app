import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * FL-655: Save to Frameleaf signs in with your Frameleaf account. The extension opens the browser's
 * sign-in window on this server's Allow page; Allow makes a single-use code, which the extension
 * exchanges (with its code verifier) for an access listed in API keys.
 */

const BrowserExtensionClientSchema = z
  .enum(['chrome', 'edge'])
  .describe('The browser Save to Frameleaf runs in')
  .meta({ id: 'BrowserExtensionClient' });

const SignInRequestShape = {
  redirectUri: z
    .string()
    .max(2048)
    .describe('The extension’s return address: https://<extension id>.chromiumapp.org/ or a path under it'),
  codeChallenge: z.string().max(128).describe('The base64url SHA-256 of the extension’s code verifier'),
  codeChallengeMethod: z.literal('S256').describe('Only S256 is accepted'),
  state: z.string().min(16).max(512).describe('Returned unchanged to the extension'),
  client: BrowserExtensionClientSchema,
  installationId: z
    .string()
    .regex(/^[\w-]{16,128}$/)
    .describe('A random id this installation of the extension made once; its access replaces only its own'),
};

const BrowserExtensionSignInStartSchema = z
  .object(SignInRequestShape)
  .strict()
  .meta({ id: 'BrowserExtensionSignInStartDto' });

const BrowserExtensionSignInStartResponseSchema = z
  .object({
    accessName: z.string().describe('How the access is listed in API keys, e.g. “Save to Frameleaf · Chrome”'),
    alreadyAllowed: z
      .boolean()
      .describe('This browser’s extension already has access to your account, so Allow is not asked again'),
  })
  .meta({ id: 'BrowserExtensionSignInStartResponseDto' });

const BrowserExtensionSignInAuthorizeSchema = z
  .object({
    ...SignInRequestShape,
    allow: z.boolean().describe('true for Allow, false for Cancel'),
  })
  .strict()
  .meta({ id: 'BrowserExtensionSignInAuthorizeDto' });

const BrowserExtensionSignInAuthorizeResponseSchema = z
  .object({
    redirectUrl: z
      .string()
      .describe('Where the sign-in window goes next: the return address with the code (or the cancellation) and state'),
  })
  .meta({ id: 'BrowserExtensionSignInAuthorizeResponseDto' });

const BrowserExtensionSignInExchangeSchema = z
  .object({
    code: z.string().min(16).max(200).describe('The single-use code from the return address'),
    codeVerifier: z.string().min(43).max(128).describe('The code verifier the challenge was made from'),
    redirectUri: z.string().max(2048).describe('The same return address the sign-in started with'),
  })
  .strict()
  .meta({ id: 'BrowserExtensionSignInExchangeDto' });

const BrowserExtensionSignInExchangeResponseSchema = z
  .object({
    secret: z
      .string()
      .describe('The new access key, shown once; it can only save captures and list collections and tags'),
    apiKeyId: z.uuidv4().describe('The access, as listed in API keys'),
    name: z.string().describe('How the access is listed in API keys'),
    userId: z.uuidv4(),
    serverId: z.string(),
  })
  .meta({ id: 'BrowserExtensionSignInExchangeResponseDto' });

const BrowserExtensionSignInErrorSchema = z
  .object({
    message: z.string(),
    error: z.string(),
    statusCode: z.int(),
    code: z
      .enum(['expired', 'invalid'])
      .describe('expired: the code is too old, sign in again; invalid: anything else')
      .meta({ id: 'BrowserExtensionSignInErrorCode' }),
  })
  .meta({ id: 'BrowserExtensionSignInErrorDto' });

const BrowserExtensionSignInInfoSchema = z
  .object({
    version: z.int().describe('The extension sign-in this server supports (1)'),
  })
  .meta({ id: 'BrowserExtensionSignInInfoDto' });

export class BrowserExtensionSignInStartDto extends createZodDto(BrowserExtensionSignInStartSchema) {}
export class BrowserExtensionSignInStartResponseDto extends createZodDto(BrowserExtensionSignInStartResponseSchema) {}
export class BrowserExtensionSignInAuthorizeDto extends createZodDto(BrowserExtensionSignInAuthorizeSchema) {}
export class BrowserExtensionSignInAuthorizeResponseDto extends createZodDto(
  BrowserExtensionSignInAuthorizeResponseSchema,
) {}
export class BrowserExtensionSignInExchangeDto extends createZodDto(BrowserExtensionSignInExchangeSchema) {}
export class BrowserExtensionSignInExchangeResponseDto extends createZodDto(
  BrowserExtensionSignInExchangeResponseSchema,
) {}
export class BrowserExtensionSignInErrorDto extends createZodDto(BrowserExtensionSignInErrorSchema) {}
export class BrowserExtensionSignInInfoDto extends createZodDto(BrowserExtensionSignInInfoSchema) {}
