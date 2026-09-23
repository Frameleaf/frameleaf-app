import {
  AlbumKind,
  AlbumUserRole,
  type AlbumResponseDto,
  type PersonResponseDto,
  type SharedSpaceAlbumResponseDto,
  type SharedSpaceMemberResponseDto,
  type SharedSpaceNewResponseDto,
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

/* -------------------------------------------------------------------------- */
/* The space page's panels (FL-55)                                            */
/* -------------------------------------------------------------------------- */

/**
 * The panels a shared space page offers, in the order they appear.
 *
 * `timeline` first, because a space is somewhere you look at photos before it
 * is anything else; `people`, `places` and `activity` are ways back into the
 * same set; `albums` and `members` are how the space is put together.
 */
export const SPACE_PANELS = ['timeline', 'albums', 'people', 'places', 'activity', 'members'] as const;

export type SpacePanel = (typeof SPACE_PANELS)[number];

export const isSpacePanel = (value: string | null | undefined): value is SpacePanel =>
  !!value && (SPACE_PANELS as readonly string[]).includes(value);

/**
 * The albums this member could link into the space.
 *
 * One level, and one level only: a space links albums, never another space and
 * never a collection, because a collection is itself a container and linking
 * one would make the space two deep. The space itself and anything already
 * linked are gone too, so the picker never offers a no-op. The server enforces
 * all of this again — this is only about not offering a control that will be
 * refused.
 */
export const linkableAlbums = (
  albums: AlbumResponseDto[],
  spaceId: string,
  linkedIds: Iterable<string> = [],
): AlbumResponseDto[] => {
  const linked = new Set(linkedIds);
  return albums.filter(
    (album) => album.id !== spaceId && album.kind === AlbumKind.Album && !linked.has(album.id),
  );
};

/**
 * Whether a linked album has anything to show yet.
 *
 * A link is a reference: it says "this album belongs to this space", not "copy
 * these photos here". So a freshly linked album can honestly be empty in the
 * space until somebody adds its items, and the panel says so rather than
 * implying a broken link.
 */
export const linkedAlbumIsEmpty = (album: Pick<SharedSpaceAlbumResponseDto, 'assetCount'>): boolean =>
  album.assetCount === 0;

/** Whether the "new since your last visit" banner has anything to say. */
export const hasNewSinceVisit = (info: Pick<SharedSpaceNewResponseDto, 'assetCount'> | null | undefined): boolean =>
  !!info && info.assetCount > 0;

/**
 * The ids the timeline is narrowed to when a member asks to see only what is
 * new, or `undefined` to show the whole space.
 *
 * The server caps the list, so a very large catch-up shows the most it can name
 * rather than a number nothing backs up; when the count is bigger than the
 * list, the banner says how many there are and the filter shows the ones it
 * has. An empty filter would mean "show nothing", which is never what is meant,
 * so it collapses to `undefined`.
 */
export const newSinceFilter = (
  info: SharedSpaceNewResponseDto | null | undefined,
  showing: boolean,
): Set<string> | undefined => {
  if (!showing || !info || info.assetIds.length === 0) {
    return undefined;
  }
  return new Set(info.assetIds);
};

/** True when the banner is showing fewer ids than it counted. */
export const newSinceIsPartial = (info: Pick<SharedSpaceNewResponseDto, 'assetCount' | 'assetIds'>): boolean =>
  info.assetIds.length < info.assetCount;

/**
 * The name a person link is offered under before the member edits it.
 *
 * It defaults to the member's own name for them purely as a convenience; the
 * space stores its own copy, so changing it here never renames the person in
 * the member's library, and renaming them there never changes what the space
 * calls them.
 */
export const defaultSpacePersonName = (person: Pick<PersonResponseDto, 'name'>): string => person.name ?? '';

/** People worth offering: the caller's own, seen in the space, that have a name or a face count. */
export const spacePersonCandidates = (people: PersonResponseDto[]): PersonResponseDto[] =>
  people.filter((person) => !person.isHidden);
