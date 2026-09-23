import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { PersonResponseSchema } from 'src/dtos/person.dto.js';
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

/* -------------------------------------------------------------------------- */
/* Albums linked into a shared space (FL-55)                                   */
/* -------------------------------------------------------------------------- */

/**
 * One album a member has linked into a shared space.
 *
 * A link is a reference, not a move and not a share. The album keeps its owner,
 * its members, its own access rules and its place in its owner's tree, and
 * nothing here grants a member of the space any access to it. What the space
 * can therefore honestly show is how much of that album is *in the space*:
 * `assetCount` and `thumbnailAssetId` are computed over the assets that are in
 * both, with media marked sensitive and Locked media excluded, so both come
 * from things every member could already see. There is deliberately no link to
 * the album's own page — offering one would be a control that 404s or 403s for
 * everybody except the album's own members.
 */
const SharedSpaceAlbumResponseSchema = z
  .object({
    id: z.uuidv4().describe('The linked album ID'),
    albumName: z.string().describe('The linked album name'),
    icon: z.string().nullable().describe('Icon: a Material Design Icons name (null = default icon)'),
    linkedBy: UserResponseSchema.nullable().describe('The member who linked this album'),
    linkedAt: z.string().meta({ format: 'date-time' }).describe('When the album was linked'),
    assetCount: z
      .int()
      .min(0)
      .describe(
        'Items that are in both this album and the shared space. Media marked sensitive, and Locked media, are not counted.',
      ),
    thumbnailAssetId: z
      .uuidv4()
      .nullable()
      .describe('An item that is already in the shared space, used as the tile picture'),
    canUnlink: z.boolean().describe('True when the caller may remove this link'),
  })
  .meta({ id: 'SharedSpaceAlbumResponseDto' });

const SharedSpaceAlbumsResponseSchema = z
  .object({
    albums: z.array(SharedSpaceAlbumResponseSchema).describe('Albums linked into the shared space, by name'),
  })
  .meta({ id: 'SharedSpaceAlbumsResponseDto' });

const SharedSpaceAlbumParamSchema = z.object({
  id: z.uuidv4().describe('Shared space ID'),
  albumId: z.uuidv4().describe('The album to link or unlink'),
});

/* -------------------------------------------------------------------------- */
/* People linked into a shared space (FL-55)                                   */
/* -------------------------------------------------------------------------- */

/**
 * One person a member has linked into a shared space, as the space knows them.
 *
 * This carries the space's own identity for somebody and nothing borrowed from
 * the linking member's library. `name` is the name the space uses — written
 * when the link was made, never read back into the owner's own `person` row,
 * and never overwritten by a rename there. `coverAssetId` is an item already in
 * the space, so showing it grants nothing; the person's own thumbnail, birth
 * date and hidden flag stay private to their owner and are not in this
 * response at all. The person's underlying identity is likewise absent: there
 * is no person ID here, only this link's ID, so the only thing a member learns
 * is that somebody published a named face into the space.
 */
const SharedSpacePersonResponseSchema = z
  .object({
    id: z.uuidv4().describe('The link ID. Not a person ID: a person is never disclosed across a space.'),
    name: z.string().describe("The name this shared space uses, independent of the owner's own name for them"),
    coverAssetId: z
      .uuidv4()
      .nullable()
      .describe('An item already in the shared space that shows this person, used as the tile picture'),
    assetCount: z
      .int()
      .min(0)
      .describe(
        'Items in the shared space that show this person. Media marked sensitive, and Locked media, are not counted.',
      ),
    linkedBy: UserResponseSchema.describe('The member who linked this person'),
    linkedAt: z.string().meta({ format: 'date-time' }).describe('When the person was linked'),
    canUnlink: z.boolean().describe('True when the caller may remove this link'),
  })
  .meta({ id: 'SharedSpacePersonResponseDto' });

const SharedSpacePeopleResponseSchema = z
  .object({
    linked: z.array(SharedSpacePersonResponseSchema).describe('People published into the shared space'),
    candidates: z
      .array(PersonResponseSchema)
      .describe(
        "People of the caller's own that appear in the shared space and are not linked yet. Only the caller's own people are ever listed here.",
      ),
  })
  .meta({ id: 'SharedSpacePeopleResponseDto' });

const SharedSpacePersonLinkSchema = z
  .object({
    personId: z.uuidv4().describe("A person of the caller's own to publish into the shared space"),
    name: z
      .string()
      .max(255)
      .optional()
      .describe("The name the shared space will use. Defaults to the caller's own name for them."),
  })
  .meta({ id: 'SharedSpacePersonLinkDto' });

const SharedSpacePersonParamSchema = z.object({
  id: z.uuidv4().describe('Shared space ID'),
  linkId: z.uuidv4().describe('The person link to remove'),
});

/* -------------------------------------------------------------------------- */
/* New since your last visit (FL-55)                                           */
/* -------------------------------------------------------------------------- */

/**
 * What has arrived in a shared space since this member last said they had seen
 * it.
 *
 * The marker is per member, because a space is a place several people come back
 * to at different times. `lastVisitedAt` of null means this member has never
 * marked the space seen, so everything in it is new to them. The member's own
 * additions are left out: the question is what other people brought. As with
 * every other read of a space, media marked sensitive and Locked media are
 * excluded, and nothing outside the space's own assets is ever counted.
 */
const SharedSpaceNewResponseSchema = z
  .object({
    lastVisitedAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .describe('When this member last marked the shared space seen; null if they never have'),
    assetCount: z.int().min(0).describe('Items other members added since then'),
    assetIds: z
      .array(z.uuidv4())
      .describe('Up to 500 of those items, so the timeline can show exactly what is new'),
  })
  .meta({ id: 'SharedSpaceNewResponseDto' });

export class SharedSpaceInviteParamDto extends createZodDto(SharedSpaceInviteParamSchema) {}
export class SharedSpacePreviewResponseDto extends createZodDto(SharedSpacePreviewResponseSchema) {}
export class SharedSpaceMemberResponseDto extends createZodDto(SharedSpaceMemberResponseSchema) {}
export class SharedSpaceMembersResponseDto extends createZodDto(SharedSpaceMembersResponseSchema) {}
export class SharedSpaceAlbumResponseDto extends createZodDto(SharedSpaceAlbumResponseSchema) {}
export class SharedSpaceAlbumsResponseDto extends createZodDto(SharedSpaceAlbumsResponseSchema) {}
export class SharedSpaceAlbumParamDto extends createZodDto(SharedSpaceAlbumParamSchema) {}
export class SharedSpacePersonResponseDto extends createZodDto(SharedSpacePersonResponseSchema) {}
export class SharedSpacePeopleResponseDto extends createZodDto(SharedSpacePeopleResponseSchema) {}
export class SharedSpacePersonLinkDto extends createZodDto(SharedSpacePersonLinkSchema) {}
export class SharedSpacePersonParamDto extends createZodDto(SharedSpacePersonParamSchema) {}
export class SharedSpaceNewResponseDto extends createZodDto(SharedSpaceNewResponseSchema) {}
