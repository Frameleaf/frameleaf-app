import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import {
  MailConnectionStatusSchema,
  MailSignInProviderSchema,
  MailSignInStateSchema,
  MailSignInUnavailableReasonSchema,
} from 'src/enum.js';

/** FL-379: the connected mail account as an administrator sees it. No token is ever part of it. */
const MailConnectionSchema = z
  .object({
    provider: MailSignInProviderSchema,
    email: z.string().describe('The address of the connected account'),
    status: MailConnectionStatusSchema,
    connectedAt: z.iso.datetime().describe('When the account was connected'),
    needsSignInSince: z.iso
      .datetime()
      .optional()
      .describe('When the provider refused to renew access; emails since then were not sent'),
  })
  .meta({ id: 'MailConnectionDto' });

const MailConnectionStateSchema = z
  .object({
    available: z.boolean().describe('Whether one-click sign-in can be started from this server now'),
    unavailableReason: MailSignInUnavailableReasonSchema.optional(),
    providers: z.array(MailSignInProviderSchema).describe('The providers Frameleaf Cloud offers sign-in for'),
    connection: MailConnectionSchema.nullable().describe('The connected account, or null'),
    signIn: MailSignInStateSchema.describe('`pending` while a sign-in this server started is waiting, else `none`'),
    signInProvider: MailSignInProviderSchema.optional().describe('The provider of the sign-in that is waiting'),
  })
  .meta({ id: 'MailConnectionStateDto' });

const MailSignInStartSchema = z.object({ provider: MailSignInProviderSchema }).meta({ id: 'MailSignInStartDto' });

const MailSignInStartResponseSchema = z
  .object({
    authorizationUrl: z.string().describe("The provider's sign-in page, to open in the administrator's browser"),
    expiresAt: z.iso.datetime().describe('When this sign-in can no longer be finished'),
  })
  .meta({ id: 'MailSignInStartResponseDto' });

const MailSignInCompleteResponseSchema = z
  .object({
    state: MailSignInStateSchema,
    connection: MailConnectionSchema.nullable().describe('The connected account once `state` is `connected`'),
  })
  .meta({ id: 'MailSignInCompleteResponseDto' });

const MailDisconnectResponseSchema = z
  .object({
    provider: MailSignInProviderSchema,
    revoked: z
      .boolean()
      .describe(
        "Whether access was also removed at the provider. False for Microsoft, which offers no way to: the administrator removes Frameleaf under the account's app permissions.",
      ),
  })
  .meta({ id: 'MailDisconnectResponseDto' });

export class MailConnectionDto extends createZodDto(MailConnectionSchema) {}
export class MailConnectionStateDto extends createZodDto(MailConnectionStateSchema) {}
export class MailSignInStartDto extends createZodDto(MailSignInStartSchema) {}
export class MailSignInStartResponseDto extends createZodDto(MailSignInStartResponseSchema) {}
export class MailSignInCompleteResponseDto extends createZodDto(MailSignInCompleteResponseSchema) {}
export class MailDisconnectResponseDto extends createZodDto(MailDisconnectResponseSchema) {}
