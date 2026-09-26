import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { asAlbumKind } from 'src/dtos/album.dto.js';
import { AlbumKind, AlbumUserRole, SharedSpaceEventType } from 'src/enum.js';

/**
 * Shared space rules (FL-55), kept pure so they can be read and tested on their own.
 *
 * A shared space is an album row with `kind = 'space'`; its members are album
 * users and its roles are the album roles (owner, editor, viewer). Two things
 * are stricter than for a plain album, and both live here:
 *
 * 1. Membership of a space belongs to its owner. An editor of a space may add
 *    and remove photos, but may not invite, change a role, or remove another
 *    member. (For a plain album the upstream rule — an editor may share it —
 *    is unchanged.)
 * 2. A space is only ever entered by accepting an invitation, so `owner` is
 *    never an invitable role and nobody is added to a space silently.
 */

export type SpaceMemberLike = { role: AlbumUserRole; user: { id: string } };
export type SpaceLike = { kind: AlbumKind | string; albumUsers: SpaceMemberLike[] };

/** The roles an invitation may offer. A space has exactly one owner, its creator. */
export const INVITABLE_SPACE_ROLES: readonly AlbumUserRole[] = [AlbumUserRole.Editor, AlbumUserRole.Viewer];

export const isSharedSpace = (album: { kind: AlbumKind | string }): boolean =>
  asAlbumKind(album.kind) === AlbumKind.Space;

/** The album's owner row, which every album has exactly one of. */
export const spaceOwnerId = (album: SpaceLike): string | undefined =>
  album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)?.user.id;

/** The role this user holds, or null when they are not a member. */
export const spaceRoleOf = (album: SpaceLike, userId: string): AlbumUserRole | null =>
  album.albumUsers.find(({ user }) => user.id === userId)?.role ?? null;

export const isSpaceMember = (album: SpaceLike, userId: string): boolean => spaceRoleOf(album, userId) !== null;

/** Refuse a space endpoint pointed at an album or a collection. */
export const requireSharedSpace = (album: { kind: AlbumKind | string }): void => {
  if (!isSharedSpace(album)) {
    throw new BadRequestException('Not a shared space');
  }
};

/**
 * Membership of a shared space is the owner's to manage. This is the check that
 * makes "owner, editor, viewer" mean something beyond the album rules: an editor
 * contributes photos but never changes who is in the space.
 */
export const requireSpaceOwner = (album: SpaceLike, userId: string): void => {
  if (spaceOwnerId(album) !== userId) {
    throw new ForbiddenException('Only the shared space owner can manage its members');
  }
};

export const requireInvitableRole = (role: AlbumUserRole): void => {
  if (!INVITABLE_SPACE_ROLES.includes(role)) {
    throw new BadRequestException('A shared space invitation can offer editor or viewer only');
  }
};

/* -------------------------------------------------------------------------- */
/* Space panels: linked albums, linked people, last-seen marker (FL-55)        */
/* -------------------------------------------------------------------------- */

/** An editor or the owner contributes to a space; a viewer only looks. */
export const canContributeToSpace = (album: SpaceLike, userId: string): boolean => {
  const role = spaceRoleOf(album, userId);
  return role === AlbumUserRole.Owner || role === AlbumUserRole.Editor;
};

export const requireSpaceContributor = (album: SpaceLike, userId: string): void => {
  if (!canContributeToSpace(album, userId)) {
    throw new ForbiddenException('Only a shared space owner or editor can change this');
  }
};

export const requireSpaceMember = (album: SpaceLike, userId: string): void => {
  if (!isSpaceMember(album, userId)) {
    throw new ForbiddenException('Not a member of this shared space');
  }
};

/**
 * What a space may link.
 *
 * "One level" is this rule. A space lists albums, full stop: it never links
 * another space (spaces stay top level and are not contained by anything) and
 * it never links a collection, because a collection is itself a container of
 * albums and linking one would make the space two levels deep. It also refuses
 * to link itself, which is the degenerate case of both.
 *
 * Note what this rule is *not*: it is not a move. FL-52 nests an album by
 * writing `parentId` and the closure rows, and that is deliberately not used
 * here — linking must leave the album exactly where its owner put it, because
 * FL-55's own acceptance says revoking a share must not move personal album
 * placement. The link is a reference in its own table and undoing it deletes
 * only that reference.
 */
export const requireLinkableAlbum = (space: { id: string }, album: { id: string; kind: AlbumKind | string }): void => {
  if (album.id === space.id) {
    throw new BadRequestException('A shared space cannot link itself');
  }

  const kind = asAlbumKind(album.kind);
  if (kind === AlbumKind.Space) {
    throw new BadRequestException('A shared space cannot be linked into another shared space');
  }

  if (kind !== AlbumKind.Album) {
    throw new BadRequestException('A shared space links albums, not collections');
  }
};

/**
 * Who may undo a link: whoever made it, and the space's owner.
 *
 * The person who made a link is answerable for it, and the owner of a space is
 * answerable for what the space shows. Nobody else can undo somebody's link,
 * and a link with no recorded author (its maker's account is gone) is the
 * owner's to clear.
 */
export const canUnlink = (album: SpaceLike, actorId: string, linkedById: string | null): boolean =>
  linkedById === actorId || spaceOwnerId(album) === actorId;

export const requireUnlinkRights = (album: SpaceLike, actorId: string, linkedById: string | null): void => {
  if (!canUnlink(album, actorId, linkedById)) {
    throw new ForbiddenException('Only the person who made this link, or the shared space owner, can remove it');
  }
};

/* -------------------------------------------------------------------------- */
/* Comments, mentions and the activity feed (FL-55)                            */
/* -------------------------------------------------------------------------- */

/**
 * A mention in a comment: `@{<user id>}`.
 *
 * Mentions are ids, never names. Typing somebody's name does not mention them,
 * renaming an account does not break a mention, and the server checks every id
 * against the space's current members before it stores anything — so a mention
 * can only ever reach somebody who is already in the space.
 */
export const MENTION_TOKEN = /@\{([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}/gi;

export const mentionToken = (userId: string): string => `@{${userId}}`;

/** The distinct user ids a comment mentions, in order of first appearance. */
export const parseMentions = (comment: string): string[] => {
  const ids: string[] = [];
  for (const match of comment.matchAll(MENTION_TOKEN)) {
    const id = match[1].toLowerCase();
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
};

/** Every mention must name a current member. A pending invitee or a stranger is refused, not dropped. */
export const requireMentionableMembers = (album: SpaceLike, userIds: string[]): void => {
  if (userIds.some((id) => !isSpaceMember(album, id))) {
    throw new BadRequestException('A mention must name a current member of this shared space');
  }
};

/** Only its author may change what a comment says. */
export const canEditSpaceComment = (comment: { userId: string }, actorId: string): boolean =>
  comment.userId === actorId;

export const requireCommentEditRights = (comment: { userId: string }, actorId: string): void => {
  if (!canEditSpaceComment(comment, actorId)) {
    throw new ForbiddenException('Only the author can edit this comment');
  }
};

/**
 * Who may remove a comment: its author, and anyone who contributes to the
 * space. Moderation is an owner's and an editor's duty; a viewer can remove
 * only what they said themselves.
 */
export const canDeleteSpaceComment = (album: SpaceLike, comment: { userId: string }, actorId: string): boolean =>
  comment.userId === actorId || canContributeToSpace(album, actorId);

export const requireCommentDeleteRights = (album: SpaceLike, comment: { userId: string }, actorId: string): void => {
  if (!canDeleteSpaceComment(album, comment, actorId)) {
    throw new ForbiddenException('Only the author, or a shared space owner or editor, can remove this comment');
  }
};

/* -------------------------------------------------------------------------- */
/* Threaded replies (FL-55)                                                    */
/* -------------------------------------------------------------------------- */

/** The feed events that carry a comment's text: a comment, and a reply to one. */
export const COMMENT_EVENT_TYPES: readonly SharedSpaceEventType[] = [
  SharedSpaceEventType.Comment,
  SharedSpaceEventType.Reply,
];

export const isCommentEventType = (type: SharedSpaceEventType): boolean => COMMENT_EVENT_TYPES.includes(type);

/**
 * A reply is on the same thing as the comment it answers: the same item, or
 * the space itself. The client may leave the item out and inherit it; naming
 * a different one is refused rather than silently moved.
 */
export const requireReplyOnSameItem = (root: { assetId: string | null }, assetId: string | undefined): void => {
  if (assetId !== undefined && assetId !== root.assetId) {
    throw new BadRequestException('A reply is on the same item as the comment it answers');
  }
};

export type CommentThreadInfo = { parentId: string | null; replyCount: number };

/**
 * Arrange a list of comments into one-level threads.
 *
 * `commentIds` are the comments the caller may see; `threads` says which of
 * them are replies and to what. A reply keeps its parent only when that parent
 * is itself in the list — the two are always on the same item, so this only
 * matters if a parent has gone and its reply somehow has not, in which case the
 * reply is shown on its own rather than lost. A parent's `replyCount` counts
 * only replies in the list, so it never counts what the caller would not be
 * shown.
 */
export const threadComments = (
  commentIds: readonly string[],
  threads: readonly { activityId: string; parentActivityId: string }[],
): Map<string, CommentThreadInfo> => {
  const present = new Set(commentIds);
  const parentOf = new Map<string, string>();
  for (const { activityId, parentActivityId } of threads) {
    if (present.has(activityId) && present.has(parentActivityId) && activityId !== parentActivityId) {
      parentOf.set(activityId, parentActivityId);
    }
  }

  // One level deep, whatever is stored: a reply's parent is always a top-level comment.
  const rootOf = (id: string): string | null => {
    let parent = parentOf.get(id) ?? null;
    const seen = new Set([id]);
    while (parent && parentOf.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      parent = parentOf.get(parent)!;
    }
    return parent && !parentOf.has(parent) ? parent : null;
  };

  const info = new Map<string, CommentThreadInfo>();
  for (const id of commentIds) {
    info.set(id, { parentId: rootOf(id), replyCount: 0 });
  }
  for (const { parentId } of info.values()) {
    const parent = parentId ? info.get(parentId) : undefined;
    if (parent) {
      parent.replyCount += 1;
    }
  }
  return info;
};

/**
 * Who a reply notifies as "somebody answered you": the author of the comment
 * it answers, when that is somebody else, they are still in the space, and
 * they are not already being told through a mention in the same reply.
 */
export const replyRecipient = (
  album: SpaceLike,
  root: { userId: string },
  actorId: string,
  mentioned: readonly string[],
): string | null => {
  if (root.userId === actorId || !isSpaceMember(album, root.userId) || mentioned.includes(root.userId)) {
    return null;
  }
  return root.userId;
};

/** The two events that are about a set of items rather than one activity. */
export const ASSET_EVENT_TYPES: readonly SharedSpaceEventType[] = [
  SharedSpaceEventType.AssetsAdded,
  SharedSpaceEventType.AssetsRemoved,
];

export type SpaceEventLike = {
  type: SharedSpaceEventType;
  assetIds: string[];
  /** The item a comment or like is on; null for a space-level comment or like. */
  activityAssetId: string | null;
};

/**
 * Narrow one stored event to what a viewer may see, or drop it.
 *
 * `visible` is the set of asset ids this viewer may see — computed by the
 * caller with the viewer's own hidden-content settings, Locked media excluded,
 * and (for additions) restricted to items still in the space. An asset event
 * keeps only its visible ids and is dropped when none are left; a comment or
 * like on an item the viewer cannot see is dropped whole, because the text may
 * describe it. Member and link events carry no media and pass through. A
 * removal never exposes ids at all: the items are no longer in the space, so a
 * thumbnail would be a control that fails, and the count is all that remains.
 */
export const narrowSpaceEvent = <T extends SpaceEventLike>(
  event: T,
  visible: ReadonlySet<string>,
): (T & { assetIds: string[]; assetCount: number }) | null => {
  if (ASSET_EVENT_TYPES.includes(event.type)) {
    const kept = event.assetIds.filter((id) => visible.has(id));
    if (kept.length === 0) {
      return null;
    }
    return {
      ...event,
      assetIds: event.type === SharedSpaceEventType.AssetsRemoved ? [] : kept,
      assetCount: kept.length,
    };
  }

  if (!event.activityAssetId) {
    return { ...event, assetIds: [], assetCount: 0 };
  }

  if (!visible.has(event.activityAssetId)) {
    return null;
  }

  return { ...event, assetIds: [event.activityAssetId], assetCount: 1 };
};

/** Whether an event is news to this member: after their marker, and not their own doing. */
export const isNewSpaceEvent = (
  event: { actorId: string | null; createdAt: Date },
  viewerId: string,
  lastSeenAt?: Date | null,
): boolean => event.actorId !== viewerId && (!lastSeenAt || event.createdAt.getTime() > lastSeenAt.getTime());
