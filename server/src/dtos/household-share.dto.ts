import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * Linked Households (FL-979), the space owner's API. `role` and `state` are plain text, because a new enum value
 * breaks the native apps' strict decoders. No field here holds an email address.
 */
const role = z.string().refine((value) => value === 'viewer' || value === 'contributor', 'viewer or contributor');

const HouseholdDirectoryEntrySchema = z
  .object({ id: z.string(), name: z.string(), hasAvatar: z.boolean() })
  .meta({ id: 'HouseholdDirectoryEntryDto' });
const HouseholdShareMemberSchema = z
  .object({
    shareId: z.string(),
    remoteUserId: z.string(),
    displayName: z.string(),
    role: z.string().describe('viewer or contributor'),
    state: z.string().describe('invited, accepted or left'),
  })
  .meta({ id: 'HouseholdShareMemberDto' });
const HouseholdShareLinkSchema = z
  .object({
    linkId: z.string(),
    householdName: z.string(),
    reachable: z.boolean().describe('Whether the other household answered with its directory'),
    directory: z.array(HouseholdDirectoryEntrySchema),
    members: z.array(HouseholdShareMemberSchema),
  })
  .meta({ id: 'HouseholdShareLinkDto' });

export class HouseholdShareMemberDto extends createZodDto(HouseholdShareMemberSchema) {}
export class HouseholdShareLinkDto extends createZodDto(HouseholdShareLinkSchema) {}
export class HouseholdShareInviteDto extends createZodDto(
  z.strictObject({ linkId: z.uuid(), remoteUserId: z.uuid(), role }).meta({ id: 'HouseholdShareInviteDto' }),
) {}
export class HouseholdShareRoleDto extends createZodDto(
  z.strictObject({ role }).meta({ id: 'HouseholdShareRoleDto' }),
) {}
export class HouseholdShareMemberParamDto extends createZodDto(
  z.object({ id: z.uuid(), shareId: z.uuid(), remoteUserId: z.uuid() }),
) {}
