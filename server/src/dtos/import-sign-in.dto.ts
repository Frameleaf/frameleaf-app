import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * Signing in to a file provider for an import connection (FL-959). `state` and `reason` are plain
 * strings, so a new value is never a new member of an enum the apps decode strictly. No answer holds a
 * provider token: `signInToken` is sealed, opens only on this server for the account that started it,
 * and is only ever sent back to finish the sign-in.
 */
export class ImportSignInParamsDto extends createZodDto(
  z.object({ provider: z.string().regex(/^[a-z0-9-]{1,64}$/) }),
) {}

export class ImportSignInStartDto extends createZodDto(
  z
    .object({
      connectionId: z.uuid().optional().describe('The connection to sign in to again; leave out for a new one'),
    })
    .meta({ id: 'ImportSignInStartDto' }),
) {}

export class ImportSignInCompleteDto extends createZodDto(
  z
    .object({
      signInToken: z.string().min(1).max(4096).describe('The value the start of this sign-in returned'),
      displayName: z.string().trim().min(1).max(200).optional().describe('What to call a new connection'),
      roots: z.array(z.string().max(4096)).max(1000).default([]).describe('Folders for a new connection'),
      dailyCheck: z.boolean().default(false).describe('Look for new photos once a day, for a new connection'),
    })
    .meta({ id: 'ImportSignInCompleteDto' }),
) {}

export class ImportSignInAvailabilityResponseDto extends createZodDto(
  z
    .object({
      available: z.boolean().describe('Whether signing in can be started from this server now'),
      reason: z
        .string()
        .nullable()
        .describe('Why not: `not-linked`, `not-configured`, `not-offered` or `cloud-unreachable`'),
      picker: z
        .object({
          apiKey: z.string().describe("The browser API key for the provider's file picker"),
          appId: z.string().describe('The app id the picker grants access to (for Google, the Cloud project number)'),
        })
        .nullable()
        .describe(
          "What a browser needs to open the provider's own file picker; null when it has none or it is not set up",
        ),
    })
    .meta({ id: 'ImportSignInAvailabilityResponseDto' }),
) {}

export class ImportSignInStartResponseDto extends createZodDto(
  z
    .object({
      authorizationUrl: z.string().describe("The provider's sign-in page, to open in the browser"),
      expiresAt: z.string().describe('When this sign-in stops working (ISO 8601)'),
      signInToken: z.string().describe('Send this back to finish the sign-in'),
    })
    .meta({ id: 'ImportSignInStartResponseDto' }),
) {}

export class ImportSignInCompleteResponseDto extends createZodDto(
  z
    .object({
      state: z.string().describe('`pending` (ask again), `connected`, `denied` or `expired`'),
      connectionId: z.uuid().nullable().describe('The connection, once `connected`'),
    })
    .meta({ id: 'ImportSignInCompleteResponseDto' }),
) {}
