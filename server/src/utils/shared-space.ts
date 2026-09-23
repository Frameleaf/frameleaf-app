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
