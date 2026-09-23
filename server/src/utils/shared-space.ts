import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { asAlbumKind } from 'src/dtos/album.dto.js';
import { AlbumKind, AlbumUserRole } from 'src/enum.js';

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
