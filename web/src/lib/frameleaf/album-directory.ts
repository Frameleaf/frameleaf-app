import {
  AlbumKind,
  AlbumUserRole,
  type AlbumCollectionResponseDto,
  type AlbumResponseDto,
  type AlbumTreeResponseDto,
  type UserResponseDto,
} from '@immich/sdk';

/**
 * Pure rules for the Albums page (FL-52). Vocabulary: an album holds photos, a
 * collection is a named group of albums one level deep, a shared space stays at
 * the top level. Nothing here touches the DOM or the network; the server's
 * GET /albums/tree already applied access, so this module only filters, sorts
 * and searches what the user is allowed to see.
 */

export const albumDirectoryFilters = ['all', 'owned', 'shared', 'smart'] as const;
export type AlbumDirectoryFilter = (typeof albumDirectoryFilters)[number];

export const albumDirectorySorts = [
  'modified',
  'created',
  'title',
  'items',
  'recent-photo',
  'oldest-photo',
  'custom',
] as const;
export type AlbumDirectorySort = (typeof albumDirectorySorts)[number];

export const albumDirectoryViews = ['grid', 'list'] as const;
export type AlbumDirectoryViewMode = (typeof albumDirectoryViews)[number];

export interface AlbumDirectoryView {
  filter: AlbumDirectoryFilter;
  sort: AlbumDirectorySort;
  view: AlbumDirectoryViewMode;
  /** Collection ids whose shelf is collapsed. */
  collapsed: string[];
}

export const defaultAlbumDirectoryView: AlbumDirectoryView = {
  filter: 'all',
  sort: 'modified',
  view: 'grid',
  collapsed: [],
};

const isFilter = (value: unknown): value is AlbumDirectoryFilter =>
  albumDirectoryFilters.includes(value as AlbumDirectoryFilter);
const isSort = (value: unknown): value is AlbumDirectorySort =>
  albumDirectorySorts.includes(value as AlbumDirectorySort);
const isViewMode = (value: unknown): value is AlbumDirectoryViewMode =>
  albumDirectoryViews.includes(value as AlbumDirectoryViewMode);

/** Repair a persisted view (per-device convenience only) so a stale or edited value never breaks the page. */
export const normalizeAlbumDirectoryView = (value: unknown): AlbumDirectoryView => {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    filter: isFilter(raw.filter) ? raw.filter : defaultAlbumDirectoryView.filter,
    sort: isSort(raw.sort) ? raw.sort : defaultAlbumDirectoryView.sort,
    view: isViewMode(raw.view) ? raw.view : defaultAlbumDirectoryView.view,
    collapsed: Array.isArray(raw.collapsed)
      ? raw.collapsed.filter((id): id is string => typeof id === 'string').slice(0, 200)
      : [],
  };
};

export const roleOf = (album: AlbumResponseDto, userId: string): AlbumUserRole | null =>
  album.albumUsers.find(({ user }) => user.id === userId)?.role ?? null;

export const ownerOf = (album: AlbumResponseDto): UserResponseDto | undefined =>
  album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)?.user;

export const isOwner = (album: AlbumResponseDto, userId: string) => roleOf(album, userId) === AlbumUserRole.Owner;

/** Owners and editors may change an album or add to a collection. */
export const canEdit = (album: AlbumResponseDto, userId: string) => {
  const role = roleOf(album, userId);
  return role === AlbumUserRole.Owner || role === AlbumUserRole.Editor;
};

/** Everyone who can see the album except the current user, for the avatar stack. */
export const othersOf = (album: AlbumResponseDto, userId: string): UserResponseDto[] =>
  album.albumUsers.map(({ user }) => user).filter((user) => user.id !== userId);

/** Shared with people (not merely reachable through a public link). */
export const isSharedWithPeople = (album: AlbumResponseDto) => album.albumUsers.length > 1;

export const matchesFilter = (album: AlbumResponseDto, filter: AlbumDirectoryFilter, userId: string): boolean => {
  switch (filter) {
    case 'all': {
      return true;
    }
    case 'owned': {
      return isOwner(album, userId);
    }
    case 'shared': {
      return isSharedWithPeople(album) || album.shared;
    }
    case 'smart': {
      return album.isSmart === true;
    }
  }
};

const searchTokens = (query: string) => query.trim().toLowerCase().split(/\s+/).filter(Boolean);

export const matchesSearch = (album: AlbumResponseDto, query: string): boolean => {
  const tokens = searchTokens(query);
  if (tokens.length === 0) {
    return true;
  }
  const text = `${album.albumName} ${album.description}`.toLowerCase();
  return tokens.every((token) => text.includes(token));
};

const time = (value: string | undefined) => (value ? new Date(value).getTime() : NaN);

/** Missing dates sort last whichever way the list runs. */
const compareDates = (a: string | undefined, b: string | undefined, direction: 'asc' | 'desc') => {
  const left = time(a);
  const right = time(b);
  if (Number.isNaN(left) && Number.isNaN(right)) {
    return 0;
  }
  if (Number.isNaN(left)) {
    return 1;
  }
  if (Number.isNaN(right)) {
    return -1;
  }
  return direction === 'asc' ? left - right : right - left;
};

export const compareAlbums = (sort: AlbumDirectorySort) => (a: AlbumResponseDto, b: AlbumResponseDto) => {
  switch (sort) {
    case 'title': {
      return a.albumName.localeCompare(b.albumName) || a.id.localeCompare(b.id);
    }
    case 'items': {
      return b.assetCount - a.assetCount || a.albumName.localeCompare(b.albumName);
    }
    case 'created': {
      return compareDates(a.createdAt, b.createdAt, 'desc') || a.albumName.localeCompare(b.albumName);
    }
    case 'recent-photo': {
      return compareDates(a.endDate, b.endDate, 'desc') || a.albumName.localeCompare(b.albumName);
    }
    case 'oldest-photo': {
      return compareDates(a.startDate, b.startDate, 'asc') || a.albumName.localeCompare(b.albumName);
    }
    case 'modified': {
      return compareDates(a.updatedAt, b.updatedAt, 'desc') || a.albumName.localeCompare(b.albumName);
    }
    case 'custom': {
      // The server returns every group in the person's own order (FL-52); a stable sort keeps it.
      return 0;
    }
  }
};

export interface AlbumShelf {
  collection: AlbumResponseDto;
  /** Albums shown under the shelf after filter and search. */
  albums: AlbumResponseDto[];
  /** Every album in the collection, for the mosaic and the counts. */
  all: AlbumResponseDto[];
  albumCount: number;
  assetCount: number;
}

export interface AlbumDirectoryArrangement {
  shelves: AlbumShelf[];
  /** Albums that stand on their own. */
  albums: AlbumResponseDto[];
  spaces: AlbumResponseDto[];
  /** Totals over everything visible to the user, before filter and search. */
  totals: { albums: number; collections: number; shared: number };
  searching: boolean;
  empty: boolean;
}

export interface ArrangeOptions {
  filter: AlbumDirectoryFilter;
  sort: AlbumDirectorySort;
  search: string;
  userId: string;
}

/**
 * Lay the tree out the way the page renders it. While searching, a shelf shows
 * the albums that match; a collection whose own name matches keeps all of its
 * albums; shelves with no hit disappear. Without a search, a shelf stays
 * visible when it or any of its albums passes the filter.
 */
export const arrangeAlbumDirectory = (
  tree: AlbumTreeResponseDto,
  { filter, sort, search, userId }: ArrangeOptions,
): AlbumDirectoryArrangement => {
  const compare = compareAlbums(sort);
  const searching = searchTokens(search).length > 0;
  const passes = (album: AlbumResponseDto) => matchesFilter(album, filter, userId) && matchesSearch(album, search);

  const shelves: AlbumShelf[] = [];
  for (const node of [...tree.collections].sort((a, b) => compare(a.collection, b.collection))) {
    const all = [...node.albums].sort(compare);
    const listed = all.filter((album) => matchesFilter(album, filter, userId));
    const hits = listed.filter((album) => matchesSearch(album, search));
    const selfMatch = passes(node.collection);
    const albums = searching ? (hits.length > 0 ? hits : selfMatch ? listed : []) : listed;
    const visible = searching
      ? hits.length > 0 || selfMatch
      : albums.length > 0 || matchesFilter(node.collection, filter, userId);
    if (visible) {
      shelves.push({
        collection: node.collection,
        albums,
        all,
        albumCount: node.albumCount,
        assetCount: node.assetCount,
      });
    }
  }

  const albums = tree.albums.filter((node) => passes(node)).sort(compare);
  const spaces = tree.spaces.filter((node) => passes(node)).sort(compare);

  const everything = [
    ...tree.collections.flatMap((node) => [node.collection, ...node.albums]),
    ...tree.albums,
    ...tree.spaces,
  ];
  const totals = {
    albums: everything.filter((album) => album.kind === AlbumKind.Album).length,
    collections: tree.collections.length,
    shared: everything.filter((album) => isSharedWithPeople(album)).length,
  };

  return {
    shelves,
    albums,
    spaces,
    totals,
    searching,
    empty: shelves.length === 0 && albums.length === 0 && spaces.length === 0,
  };
};

/**
 * One group of the directory a custom order applies to (FL-52): the albums inside a collection, or
 * at the top level the collections, the albums on their own or the shared spaces. `ids` is the
 * whole group in the order the server returned it, which is the order a reorder must send back.
 */
export interface AlbumOrderGroup {
  parentId: string | null;
  ids: string[];
}

export const orderGroupOf = (tree: AlbumTreeResponseDto, albumId: string): AlbumOrderGroup | undefined => {
  if (tree.collections.some(({ collection }) => collection.id === albumId)) {
    return { parentId: null, ids: tree.collections.map(({ collection }) => collection.id) };
  }
  for (const node of tree.collections) {
    if (node.albums.some(({ id }) => id === albumId)) {
      return { parentId: node.collection.id, ids: node.albums.map(({ id }) => id) };
    }
  }
  if (tree.albums.some(({ id }) => id === albumId)) {
    return { parentId: null, ids: tree.albums.map(({ id }) => id) };
  }
  if (tree.spaces.some(({ id }) => id === albumId)) {
    return { parentId: null, ids: tree.spaces.map(({ id }) => id) };
  }
};

/** The group's ids with `albumId` moved `step` places (−1 earlier, +1 later); undefined at an end. */
export const moveInOrder = (ids: string[], albumId: string, step: -1 | 1): string[] | undefined => {
  const from = ids.indexOf(albumId);
  const to = from + step;
  if (from === -1 || to < 0 || to >= ids.length) {
    return undefined;
  }
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, albumId);
  return next;
};

/** The group's ids with `albumId` placed just before `targetId` (a drop on the target); undefined when nothing moves. */
export const placeBefore = (ids: string[], albumId: string, targetId: string): string[] | undefined => {
  if (albumId === targetId || !ids.includes(albumId) || !ids.includes(targetId)) {
    return undefined;
  }
  const next = ids.filter((id) => id !== albumId);
  next.splice(next.indexOf(targetId), 0, albumId);
  return next.every((id, index) => id === ids[index]) ? undefined : next;
};

/** Only the owner reorganises an album, only an album moves, and only into a collection the user can edit. */
export const canDropOnCollection = (
  album: AlbumResponseDto | undefined,
  collection: AlbumResponseDto,
  userId: string,
): boolean =>
  !!album &&
  album.id !== collection.id &&
  album.kind === AlbumKind.Album &&
  collection.kind === AlbumKind.Collection &&
  isOwner(album, userId) &&
  canEdit(collection, userId) &&
  album.parentId !== collection.id;

export const canTakeOut = (album: AlbumResponseDto | undefined, userId: string): boolean =>
  !!album && album.kind === AlbumKind.Album && album.parentId !== null && isOwner(album, userId);

/** Collections the user may move an album into, in title order. */
export const moveTargets = (
  tree: AlbumTreeResponseDto,
  album: AlbumResponseDto,
  userId: string,
): AlbumCollectionResponseDto[] =>
  tree.collections
    .filter((node) => node.collection.id !== album.id && canEdit(node.collection, userId))
    .sort((a, b) => a.collection.albumName.localeCompare(b.collection.albumName));

/** "Aug 2026", "Jun – Aug 2026" or "2025 – 2026" for a run of capture dates. */
export const monthSpan = (earliest: string | undefined, latest: string | undefined, locale?: string): string => {
  if (!latest) {
    return '';
  }
  const last = new Date(latest);
  if (Number.isNaN(last.getTime())) {
    return '';
  }
  const first = new Date(earliest || latest);
  const monthYear = new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const month = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
  const year = new Intl.DateTimeFormat(locale, { year: 'numeric', timeZone: 'UTC' });
  if (Number.isNaN(first.getTime()) || monthYear.format(first) === monthYear.format(last)) {
    return monthYear.format(last);
  }
  if (year.format(first) === year.format(last)) {
    return `${month.format(first)} – ${month.format(last)} ${year.format(last)}`;
  }
  return `${year.format(first)} – ${year.format(last)}`;
};

/** Default icon for a node without one; any Material Design Icons name is valid. */
export const defaultIconFor = (kind: AlbumKind | string | undefined): string => {
  switch (kind) {
    case AlbumKind.Space: {
      return 'mdiAccountMultipleOutline';
    }
    case AlbumKind.Collection: {
      return 'mdiFolderMultipleOutline';
    }
    default: {
      return 'mdiImageAlbum';
    }
  }
};

/**
 * What the Frameleaf edit dialog saves for an album, a collection or a shared space
 * (`CollectionFormDialog` in the design's `CollectionHeader.jsx`). `parentId` is present only
 * when the collection field was offered, so leaving it out never moves the album.
 */
export interface AlbumDetailsDraft {
  albumName: string;
  description: string | null;
  icon: string;
  parentId?: string | null;
}

/**
 * What an open album or shared-space page does when somebody leaves or is taken out of it (FL-53):
 * `refresh` when it is someone else; `exit` when the viewer was removed by someone else and can no
 * longer read the page; `ignore` when the viewer left from this tab, because that leave action
 * already navigates and a second navigation would race it. An owner is never removed.
 */
export const removalOutcome = (
  removal: { albumId: string; userId: string },
  page: { albumId: string; userId: string; isOwner: boolean; leftLocally: boolean },
): 'ignore' | 'refresh' | 'exit' => {
  if (removal.albumId !== page.albumId) {
    return 'ignore';
  }
  if (removal.userId !== page.userId || page.isOwner) {
    return 'refresh';
  }
  return page.leftLocally ? 'ignore' : 'exit';
};
