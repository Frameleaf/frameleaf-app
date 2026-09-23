import {
  AlbumKind,
  AlbumUserRole,
  type AlbumResponseDto,
  type SharedSpaceMemberResponseDto,
  type SharedSpacePreviewResponseDto,
} from '@immich/sdk';
import { createLibrarySession, type LibraryViewState } from '$lib/frameleaf/library-session';

/**
 * Shared space rules on the client (FL-55).
 *
 * These mirror what the server enforces; they exist so the UI can offer the
 * right controls, never to decide access. Every action still goes to an
 * endpoint that checks the same rule again, and its answer wins.
 *
 * A shared space is an album with `kind: "space"`, so its roles are the album
 * roles. The space-only rules are:
 *
 * - its owner manages membership (an editor adds photos, not people);
 * - somebody joins only by accepting an invitation they can preview first;
 * - `owner` is never offered as a role.
 */

export const SPACE_ROLE_OPTIONS: readonly AlbumUserRole[] = [AlbumUserRole.Editor, AlbumUserRole.Viewer];

export const isSpace = (album: Pick<AlbumResponseDto, 'kind'>): boolean => album.kind === AlbumKind.Space;

export const spaceOwner = (space: Pick<AlbumResponseDto, 'albumUsers'>) =>
  space.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)?.user;

export const spaceRole = (space: Pick<AlbumResponseDto, 'albumUsers'>, userId?: string): AlbumUserRole | null =>
  (userId && space.albumUsers.find(({ user }) => user.id === userId)?.role) || null;

export const isSpaceOwner = (space: Pick<AlbumResponseDto, 'albumUsers'>, userId?: string): boolean =>
  !!userId && spaceOwner(space)?.id === userId;

/** An editor or the owner may add photos to the space. A viewer may not. */
export const canContribute = (space: Pick<AlbumResponseDto, 'albumUsers'>, userId?: string): boolean => {
  const role = spaceRole(space, userId);
  return role === AlbumUserRole.Owner || role === AlbumUserRole.Editor;
};

/** Only the owner may invite, change a role, or remove somebody else. */
export const canManageMembers = isSpaceOwner;

/**
 * Whether the signed-in person may take this member out of the space. Anybody
 * may take themselves out (leave); only the owner may remove anyone else; and
 * the owner is never removable, because a space always has exactly one.
 */
export const canRemoveMember = (
  space: Pick<AlbumResponseDto, 'albumUsers'>,
  actorId: string | undefined,
  member: Pick<SharedSpaceMemberResponseDto, 'user' | 'role'>,
): boolean => {
  if (member.role === AlbumUserRole.Owner) {
    return false;
  }
  return member.user.id === actorId || isSpaceOwner(space, actorId);
};

/** Owner first, then the people who have joined, then the invitations nobody has answered. */
export const sortMembers = (members: SharedSpaceMemberResponseDto[]): SharedSpaceMemberResponseDto[] =>
  [...members].sort((left, right) => {
    const rank = (member: SharedSpaceMemberResponseDto) =>
      member.pending ? 2 : member.role === AlbumUserRole.Owner ? 0 : 1;
    return rank(left) - rank(right) || (left.user.name || '').localeCompare(right.user.name || '');
  });

/**
 * The people already accounted for on a space, so the invite picker never
 * offers somebody who is already in it or already holds an invitation.
 */
export const alreadyInvolvedIds = (members: SharedSpaceMemberResponseDto[]): Set<string> =>
  new Set(members.map(({ user }) => user.id));

/** A recipient preview is worth showing only while it is still an offer. */
export const pendingInvitations = (
  invitations: SharedSpacePreviewResponseDto[],
): SharedSpacePreviewResponseDto[] => invitations.filter(({ accepted }) => !accepted);

/* -------------------------------------------------------------------------- */
/* Bulk "add everything matching" into a space (FL-32's snapshot path)         */
/* -------------------------------------------------------------------------- */

/** What a bulk add draws from: the whole library, or one album the user picked. */
export type SpaceAddSource = { kind: 'library' } | { kind: 'album'; id: string };

/**
 * The view state an "add everything matching" operation is frozen against.
 *
 * This is a plain library view, never the space itself: FL-32 refuses a space
 * scope because a shared space is not expressible as a search, and the whole
 * point of the snapshot is that the operation touches exactly the set the
 * server can enumerate for the signed-in user. The destination space is the
 * action's payload, not the scope.
 */
export const spaceAddScope = (source: SpaceAddSource): LibraryViewState => {
  const state = createLibrarySession().state;
  return {
    ...state,
    scope: source.kind === 'album' ? { kind: 'album', id: source.id } : { kind: 'library' },
    query: { ...state.query },
  };
};

/** The albums offered as a source: plain albums only, and never the space itself. */
export const addSourceOptions = (albums: AlbumResponseDto[], spaceId: string): AlbumResponseDto[] =>
  albums.filter((album) => album.id !== spaceId && album.kind === AlbumKind.Album);
