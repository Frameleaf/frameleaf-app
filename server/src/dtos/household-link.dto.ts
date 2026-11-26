import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * Linked Households (FL-952). No field here is an enum: `state` is text with a boolean for each value known
 * today, because a new enum value breaks the native apps' strict decoders. Nothing names the other
 * household's Frameleaf account or an email address.
 */
const HouseholdLinkSchema = z
  .object({
    id: z.string(),
    householdName: z.string().describe('What this server’s administrator calls the other household'),
    peerName: z.string().describe('The other household’s server name'),
    state: z.string().describe('active, paused or ended'),
    active: z.boolean(),
    paused: z.boolean(),
    ended: z.boolean(),
    reason: z
      .string()
      .nullable()
      .describe(
        'Why a link is paused (licence, unlinked, peer-unlinked, key, cloud) or why an active link was not reached (home-network, unreachable)',
      ),
    connectionPath: z.string().nullable().describe('The kind of address that last answered: local, wan, ipv6, relay'),
    lastSeenAt: z.string().nullable(),
    createdAt: z.string(),
    endedAt: z.string().nullable(),
  })
  .meta({ id: 'HouseholdLinkDto' });

export class HouseholdLinkDto extends createZodDto(HouseholdLinkSchema) {}
export class HouseholdInvitationDto extends createZodDto(
  z
    .object({
      invitationId: z.string(),
      token: z.string(),
      code: z.string().describe('The short form of the invitation, easier to read out or type'),
      expiresAt: z.string(),
    })
    .meta({ id: 'HouseholdInvitationDto' }),
) {}
export class HouseholdInvitationPreviewDto extends createZodDto(
  z
    .object({ name: z.string().describe('The inviting household’s server name') })
    .meta({ id: 'HouseholdInvitationPreviewDto' }),
) {}
/** An invitation's 43-character token or its short code, as the administrator typed or pasted it. */
const code = z
  .string()
  .max(100)
  .transform((value) => value.replaceAll(/\s/g, ''))
  .pipe(z.string().regex(/^[A-Za-z0-9_-]{12,43}$/));
const householdName = z.string().trim().min(1).max(80);
export class HouseholdInvitationAcceptDto extends createZodDto(
  z.strictObject({ code, householdName: householdName.optional() }).meta({ id: 'HouseholdInvitationAcceptDto' }),
) {}
export class HouseholdInvitationCodeParamDto extends createZodDto(z.object({ code })) {}
export class HouseholdLinkUpdateDto extends createZodDto(
  z.strictObject({ householdName }).meta({ id: 'HouseholdLinkUpdateDto' }),
) {}
