import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { UserResponseSchema } from 'src/dtos/user.dto.js';
import { AlbumUserRoleSchema } from 'src/enum.js';

/**
 * What a recipient is shown about a shared space before they accept (FL-55).
 *
 * This is the only thing a pending recipient can read, and it deliberately
 * carries no asset: no ids, no thumbnail, no file names, no people and no
 * places. The counts and dates are computed with sensitive/Locked media
 * excluded, so an item the owner marked Sensitive does not even move the
 * number a recipient sees. Accepting is what grants access to the space's
 * photos; everything from that point on runs through the ordinary album
 * access checks.
 */
const SharedSpacePreviewResponseSchema = z
  .object({
    id: z.uuidv4().describe('Shared space ID'),
    albumName: z.string().describe('Shared space name'),
    description: z.string().describe('Shared space description'),
    icon: z.string().nullable().describe('Icon: a Material Design Icons name (null = default icon)'),
    owner: UserResponseSchema.describe('Who owns the shared space'),
    invitedBy: UserResponseSchema.nullable().describe('Who sent the invitation'),
    role: AlbumUserRoleSchema.describe('The role the recipient gets on accept'),
    invitedAt: z.string().meta({ format: 'date-time' }).describe('When the invitation was sent'),
    accepted: z.boolean().describe('True once the recipient has joined the space'),
    memberCount: z.int().min(0).describe('People already in the shared space, including its owner'),
    assetCount: z
      .int()
      .min(0)
      .describe('Items the recipient would see. Media marked sensitive, and Locked media, are not counted.'),
    startDate: z
      .string()
      .meta({ format: 'date-time' })
      .optional()
      .describe('Earliest item date, sensitive and Locked media excluded'),
    endDate: z
      .string()
      .meta({ format: 'date-time' })
      .optional()
      .describe('Latest item date, sensitive and Locked media excluded'),
  })
  .meta({ id: 'SharedSpacePreviewResponseDto' });

/** One person in a shared space, whether they have joined yet or not. */
const SharedSpaceMemberResponseSchema = z
  .object({
    user: UserResponseSchema,
    role: AlbumUserRoleSchema,
    pending: z.boolean().describe('True while the invitation has not been accepted'),
    invitedAt: z.string().meta({ format: 'date-time' }).optional().describe('When a pending invitation was sent'),
  })
  .meta({ id: 'SharedSpaceMemberResponseDto' });

const SharedSpaceMembersResponseSchema = z
  .object({
    members: z.array(SharedSpaceMemberResponseSchema).describe('Members and pending invitations, owner first'),
  })
  .meta({ id: 'SharedSpaceMembersResponseDto' });

const SharedSpaceInviteParamSchema = z.object({
  id: z.uuidv4().describe('Shared space ID'),
  userId: z.uuidv4().describe('The invited user'),
});

export class SharedSpaceInviteParamDto extends createZodDto(SharedSpaceInviteParamSchema) {}
export class SharedSpacePreviewResponseDto extends createZodDto(SharedSpacePreviewResponseSchema) {}
export class SharedSpaceMemberResponseDto extends createZodDto(SharedSpaceMemberResponseSchema) {}
export class SharedSpaceMembersResponseDto extends createZodDto(SharedSpaceMembersResponseSchema) {}
