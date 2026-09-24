import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { PersonResponseSchema } from 'src/dtos/person.dto.js';
import { UserResponseSchema } from 'src/dtos/user.dto.js';
import { AlbumUserRoleSchema, SharedSpaceEventTypeSchema } from 'src/enum.js';

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
/* Named recipient shortcuts (FL-55)                                           */
/* -------------------------------------------------------------------------- */

/**
 * A named group of people the owner invites together. Applying it is only a shortcut for sending
 * the same invitations one by one; editing or deleting it never changes anybody's existing access,
 * and its name is visible to its owner only.
 */
const RecipientGroupResponseSchema = z
  .object({
    id: z.uuidv4().describe('Recipient group ID'),
    name: z.string().describe('Name, visible to its owner only'),
    users: z.array(UserResponseSchema).describe('People in the group who still have an account, by name'),
    createdAt: z.string().meta({ format: 'date-time' }).describe('When the group was saved'),
    updatedAt: z.string().meta({ format: 'date-time' }).describe('When the group last changed'),
  })
  .meta({ id: 'RecipientGroupResponseDto' });

const RecipientGroupNameSchema = z.string().trim().min(1).max(100).describe('Name, visible to its owner only');
const RecipientGroupUserIdsSchema = z
  .array(z.uuidv4())
  .max(200)
  .describe('People in the group. Yourself and repeats are dropped.');

const RecipientGroupCreateSchema = z
  .object({ name: RecipientGroupNameSchema, userIds: RecipientGroupUserIdsSchema })
  .meta({ id: 'RecipientGroupCreateDto' });

const RecipientGroupUpdateSchema = z
  .object({ name: RecipientGroupNameSchema.optional(), userIds: RecipientGroupUserIdsSchema.optional() })
  .meta({ id: 'RecipientGroupUpdateDto' });

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
    assetIds: z.array(z.uuidv4()).describe('Up to 500 of those items, so the timeline can show exactly what is new'),
  })
  .meta({ id: 'SharedSpaceNewResponseDto' });

/* -------------------------------------------------------------------------- */
/* The activity feed (FL-55)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One thing that happened in a shared space, as one member may see it.
 *
 * The stored event carries ids; this is what is left after the server has
 * applied the reader's own view. `assetIds` never names an item the reader
 * cannot see — Locked media, media marked sensitive, media hidden by their own
 * settings, or media no longer in the space — and an event with nothing
 * visible left is not sent at all, so the reader cannot even count what was
 * withheld. A removal carries a count and no ids, because the items are gone
 * from the space and a thumbnail would be a control that fails.
 */
const SharedSpaceEventResponseSchema = z
  .object({
    id: z.uuidv4().describe('Event ID'),
    type: SharedSpaceEventTypeSchema,
    createdAt: z.string().meta({ format: 'date-time' }).describe('When it happened'),
    actor: UserResponseSchema.nullable().describe('Who did it; null once that account is gone'),
    targetUser: UserResponseSchema.nullable().describe(
      'The member a member event is about, or the author of the comment a reply answers; null otherwise',
    ),
    subject: z
      .string()
      .nullable()
      .describe("A linked album's or person's name as the space knew it, or the new role; null otherwise"),
    assetIds: z
      .array(z.uuidv4())
      .describe(
        'The items this event is about that the reader may see and that are still in the shared space. Empty for a removal.',
      ),
    assetCount: z.int().min(0).describe('How many of the items this event is about the reader may see'),
    activityId: z.uuidv4().nullable().describe('The comment or like this event announces, if any'),
    comment: z
      .string()
      .nullable()
      .describe('The comment text, for a comment or reply event. Mentions are @{userId} tokens.'),
    mentions: z.array(UserResponseSchema).describe('Members named in the comment'),
  })
  .meta({ id: 'SharedSpaceEventResponseDto' });

const SharedSpaceActivityResponseSchema = z
  .object({
    events: z.array(SharedSpaceEventResponseSchema).describe('Newest first'),
    lastVisitedAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .describe('When this member last marked the shared space seen; null if they never have'),
    unreadCount: z.int().min(0).describe('Events by other members since then that this member may see. Capped at 500.'),
    hasMore: z.boolean().describe('True when older events exist beyond this page'),
  })
  .meta({ id: 'SharedSpaceActivityResponseDto' });

const SharedSpaceActivitySearchSchema = z.object({
  before: z.string().meta({ format: 'date-time' }).optional().describe('Only events before this moment, for paging'),
  take: z.coerce.number().int().min(1).max(200).optional().describe('Page size, 50 by default'),
});

/* -------------------------------------------------------------------------- */
/* Comments on the space and on its items (FL-55)                              */
/* -------------------------------------------------------------------------- */

/**
 * One comment in a shared space: on one of its items, or on the space itself
 * when `assetId` is null. The text keeps its `@{userId}` mention tokens and
 * `mentions` resolves them, so a client renders names without ever having sent
 * one. `canEdit` and `canDelete` are the server's answer for the caller —
 * the author edits, and the author or a space owner or editor removes.
 *
 * Threads are one level deep: a reply names its top-level comment in
 * `parentId`, and a top-level comment carries its `replyCount`. Removing a
 * top-level comment removes its replies with it.
 */
const SharedSpaceCommentResponseSchema = z
  .object({
    id: z.uuidv4().describe('Comment ID'),
    createdAt: z.string().meta({ format: 'date-time' }).describe('When it was written'),
    updatedAt: z.string().meta({ format: 'date-time' }).describe('When it was last edited'),
    user: UserResponseSchema.describe('The author'),
    assetId: z.uuidv4().nullable().describe('The item commented on; null for a comment on the space itself'),
    comment: z.string().describe('The text, with @{userId} mention tokens'),
    mentions: z.array(UserResponseSchema).describe('Members named in the comment'),
    canEdit: z.boolean().describe('True when the caller may change the text'),
    canDelete: z.boolean().describe('True when the caller may remove the comment'),
    parentId: z.uuidv4().nullable().describe('The top-level comment this reply answers; null for a top-level comment'),
    replyCount: z
      .int()
      .min(0)
      .describe('How many replies this comment has that the caller can see; always 0 for a reply'),
  })
  .meta({ id: 'SharedSpaceCommentResponseDto' });

const SharedSpaceCommentsResponseSchema = z
  .object({
    comments: z.array(SharedSpaceCommentResponseSchema).describe('Oldest first'),
  })
  .meta({ id: 'SharedSpaceCommentsResponseDto' });

const SharedSpaceCommentSearchSchema = z.object({
  assetId: z.uuidv4().optional().describe('Comments on this item. Left out, the comments on the space itself.'),
});

const CommentTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(4000)
  .describe('The text. Mention a member with @{userId}; every mention must name a current member.');

const SharedSpaceCommentCreateSchema = z
  .object({
    assetId: z.uuidv4().optional().describe('The item to comment on. Left out, the comment is on the space itself.'),
    comment: CommentTextSchema,
    parentId: z
      .uuidv4()
      .optional()
      .describe(
        'Reply to this comment. Replying to a reply joins the same thread, under its top-level comment. A reply is on the same item as the comment it answers.',
      ),
  })
  .meta({ id: 'SharedSpaceCommentCreateDto' });

const SharedSpaceCommentUpdateSchema = z
  .object({
    comment: CommentTextSchema,
  })
  .meta({ id: 'SharedSpaceCommentUpdateDto' });

const SharedSpaceCommentParamSchema = z.object({
  id: z.uuidv4().describe('Shared space ID'),
  commentId: z.uuidv4().describe('The comment'),
});

export class SharedSpaceInviteParamDto extends createZodDto(SharedSpaceInviteParamSchema) {}
export class SharedSpaceEventResponseDto extends createZodDto(SharedSpaceEventResponseSchema) {}
export class SharedSpaceActivityResponseDto extends createZodDto(SharedSpaceActivityResponseSchema) {}
export class SharedSpaceActivitySearchDto extends createZodDto(SharedSpaceActivitySearchSchema) {}
export class SharedSpaceCommentResponseDto extends createZodDto(SharedSpaceCommentResponseSchema) {}
export class SharedSpaceCommentsResponseDto extends createZodDto(SharedSpaceCommentsResponseSchema) {}
export class SharedSpaceCommentSearchDto extends createZodDto(SharedSpaceCommentSearchSchema) {}
export class SharedSpaceCommentCreateDto extends createZodDto(SharedSpaceCommentCreateSchema) {}
export class SharedSpaceCommentUpdateDto extends createZodDto(SharedSpaceCommentUpdateSchema) {}
export class SharedSpaceCommentParamDto extends createZodDto(SharedSpaceCommentParamSchema) {}
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
export class RecipientGroupResponseDto extends createZodDto(RecipientGroupResponseSchema) {}
export class RecipientGroupCreateDto extends createZodDto(RecipientGroupCreateSchema) {}
export class RecipientGroupUpdateDto extends createZodDto(RecipientGroupUpdateSchema) {}
