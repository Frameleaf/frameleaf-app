import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/** Linked Households (FL-994): a space another household offered this account. `state` is plain text. */
const HouseholdInboundShareSchema = z
  .object({
    id: z.string(),
    householdName: z.string().describe('What this server calls the other household'),
    spaceName: z.string(),
    ownerName: z.string(),
    state: z.string().describe('invited, accepted or left'),
    albumId: z.string().nullable().describe('The local space, once accepted'),
    lastPulledAt: z.string().nullable(),
    lastError: z
      .string()
      .nullable()
      .describe('A short machine word, such as over-quota, bad-page, file-too-large or unreachable'),
  })
  .meta({ id: 'HouseholdInboundShareDto' });

export class HouseholdInboundShareDto extends createZodDto(HouseholdInboundShareSchema) {}
