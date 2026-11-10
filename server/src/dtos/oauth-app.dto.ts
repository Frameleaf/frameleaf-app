import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * FL-803 (E3-03): connected apps. The OAuth protocol endpoints themselves (authorize redirect,
 * token, revoke, registration, discovery) speak standard OAuth and are left out of the API
 * description; these are the ones the Allow page and Settings use.
 */

const AuthorizeRequestShape = {
  responseType: z.string().max(50).describe('Must be `code`'),
  clientId: z.string().max(100).describe('The app’s client id'),
  redirectUri: z.string().max(2048).describe('The return address, exactly as the app registered it'),
  scope: z.string().max(1000).optional().describe('Space-separated scopes; empty means `library:read`'),
  state: z.string().max(2048).optional().describe('Returned unchanged to the app'),
  codeChallenge: z.string().max(128).describe('The base64url SHA-256 of the app’s code verifier'),
  codeChallengeMethod: z.string().max(20).describe('Only S256 is accepted'),
  resource: z.string().max(2048).optional().describe('The resource (RFC 8707) the app wants access to'),
};

const OAuthAppAuthorizeStartSchema = z.object(AuthorizeRequestShape).strict().meta({ id: 'OAuthAppAuthorizeStartDto' });

const OAuthAppClientSchema = z
  .object({
    id: z.string().describe('The app’s client id'),
    name: z
      .string()
      .describe(
        'For a verified app the name Frameleaf knows it by; otherwise the name the app gave itself (plain text)',
      ),
    verified: z.boolean().describe('Frameleaf checked who made this app (every return address is that app’s own)'),
    maker: z.string().nullable().describe('Who made a verified app; null otherwise'),
    knownApp: z
      .string()
      .nullable()
      .describe('Free text naming a verified app for its icon (claude, chatgpt, homeassistant); null otherwise'),
    returnTo: z.string().describe('Where the app sends you back to, such as claude.ai or localhost:33418'),
  })
  .meta({ id: 'OAuthAppClientDto' });

const OAuthAppAuthorizeStartResponseSchema = z
  .object({
    client: OAuthAppClientSchema,
    scopes: z.array(z.string()).describe('The scopes the app asked for, all of which this server offers'),
  })
  .meta({ id: 'OAuthAppAuthorizeStartResponseDto' });

const OAuthAppAuthorizeSchema = z
  .object({ ...AuthorizeRequestShape, allow: z.boolean().describe('true for Allow, false for Deny') })
  .strict()
  .meta({ id: 'OAuthAppAuthorizeDto' });

const OAuthAppAuthorizeResponseSchema = z
  .object({
    redirectUrl: z
      .string()
      .describe(
        'Where the browser goes next: the app’s return address with the code (or access_denied), state and iss',
      ),
  })
  .meta({ id: 'OAuthAppAuthorizeResponseDto' });

const OAuthAppGrantSchema = z
  .object({
    id: z.string().describe('The grant id; Remove revokes it'),
    client: OAuthAppClientSchema,
    scopes: z.array(z.string()).describe('What you allowed'),
    createdAt: z.string().describe('When you chose Allow'),
    lastUsedAt: z.string().nullable().describe('When the app last used its access, to the hour; null if never'),
    lastUsedVia: z
      .string()
      .nullable()
      .describe('How it last connected, as free text: home, direct or relay (remote access); null if unknown'),
  })
  .meta({ id: 'OAuthAppGrantDto' });

const OAuthAppAdminClientSchema = z
  .object({
    client: OAuthAppClientSchema,
    selfRegistered: z.boolean().describe('The app registered itself'),
    createdAt: z.string(),
    activeUsers: z.int().describe('How many people currently allow it'),
  })
  .meta({ id: 'OAuthAppAdminClientDto' });

export class OAuthAppAuthorizeStartDto extends createZodDto(OAuthAppAuthorizeStartSchema) {}
export class OAuthAppAuthorizeStartResponseDto extends createZodDto(OAuthAppAuthorizeStartResponseSchema) {}
export class OAuthAppAuthorizeDto extends createZodDto(OAuthAppAuthorizeSchema) {}
export class OAuthAppAuthorizeResponseDto extends createZodDto(OAuthAppAuthorizeResponseSchema) {}
export class OAuthAppGrantDto extends createZodDto(OAuthAppGrantSchema) {}
export class OAuthAppAdminClientDto extends createZodDto(OAuthAppAdminClientSchema) {}
export type OAuthAppClientDto = z.infer<typeof OAuthAppClientSchema>;
