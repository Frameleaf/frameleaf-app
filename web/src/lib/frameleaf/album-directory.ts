import {
  AlbumKind,
  AlbumUserRole,
  type AlbumCollectionResponseDto,
  type AlbumResponseDto,
  type AlbumTreeResponseDto,
  type UserResponseDto,
} from '@frameleaf/sdk';

/*
 * FL-1836 (approved design 2026-11-27, prototype `src/AlbumsV2.jsx`): one Albums page with one structure at
 * every level. A collection, or an album holding albums, is one tile that opens in place; Group by (Kind by
 * default, Source, Year, Month, Owner, None), Sort and Order arrange the level; empty albums are hidden unless
 * asked for.
 */
export const albumDirectoryFilters = ['all', 'owned', 'shared', 'smart', 'folders'] as const;
export type AlbumDirectoryFilter = (typeof albumDirectoryFilters)[number];

export const albumDirectorySorts = ['date', 'title', 'opened', 'modified', 'items', 'custom'] as const;
export type AlbumDirectorySort = (typeof albumDirectorySorts)[number];

export const albumDirectoryGroups = ['kind', 'source', 'year', 'month', 'owner', 'none'] as const;
export type AlbumDirectoryGroup = (typeof albumDirectoryGroups)[number];

export const albumDirectoryOrders = ['asc', 'desc'] as const;
export type AlbumDirectoryOrder = (typeof albumDirectoryOrders)[number];

export const albumDirectoryViews = ['grid', 'list'] as const;
export type AlbumDirectoryViewMode = (typeof albumDirectoryViews)[number];

export interface AlbumDirectoryView {
  filter: AlbumDirectoryFilter;
  sort: AlbumDirectorySort;
  order: AlbumDirectoryOrder;
  group: AlbumDirectoryGroup;
  view: AlbumDirectoryViewMode;
  hideEmpty: boolean;
  collectionsFirst: boolean;
  /** Group ids whose section is folded. */
  collapsed: string[];
}

export const defaultAlbumDirectoryView: AlbumDirectoryView = {
  filter: 'all',
  sort: 'date',
  order: 'desc',
  group: 'kind',
  view: 'grid',
  hideEmpty: true,
  collectionsFirst: false,
  collapsed: [],
};

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => list.includes(value as T);

/** Sorts saved before FL-1836, and the order each one meant. */
const legacySorts: Record<string, [AlbumDirectorySort, AlbumDirectoryOrder]> = {
  'recent-photo': ['date', 'desc'],
  'oldest-photo': ['date', 'asc'],
  created: ['modified', 'desc'],
};

/** Repair a persisted view (per-device convenience only) so a stale or edited value never breaks the page. */
export const normalizeAlbumDirectoryView = (value: unknown): AlbumDirectoryView => {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const legacy = typeof raw.sort === 'string' ? legacySorts[raw.sort] : undefined;
  const sort = oneOf(albumDirectorySorts, raw.sort) ? raw.sort : (legacy?.[0] ?? defaultAlbumDirectoryView.sort);
  const fallbackOrder = legacy?.[1] ?? (sort === 'title' ? 'asc' : defaultAlbumDirectoryView.order);
  return {
    filter: oneOf(albumDirectoryFilters, raw.filter) ? raw.filter : defaultAlbumDirectoryView.filter,
    sort,
    order: oneOf(albumDirectoryOrders, raw.order) ? raw.order : fallbackOrder,
    group: oneOf(albumDirectoryGroups, raw.group) ? raw.group : defaultAlbumDirectoryView.group,
    view: oneOf(albumDirectoryViews, raw.view) ? raw.view : defaultAlbumDirectoryView.view,
    hideEmpty: typeof raw.hideEmpty === 'boolean' ? raw.hideEmpty : defaultAlbumDirectoryView.hideEmpty,
    collectionsFirst:
      typeof raw.collectionsFirst === 'boolean' ? raw.collectionsFirst : defaultAlbumDirectoryView.collectionsFirst,
    collapsed: Array.isArray(raw.collapsed)
      ? // The newest 200: folds are kept per level, so the oldest give way rather than new ones being refused.
        raw.collapsed.filter((id): id is string => typeof id === 'string').slice(-200)
      : [],
  };
};

/**
 * An album as the full directory sends it (with its members), or as the slim rail list sends it
 * (FL-1796, `GET /albums/rail`), which carries only the viewer's own role.
 */
export type AlbumWithRole = Pick<AlbumResponseDto, 'albumUsers'> | { role: AlbumUserRole };

export const roleOf = (album: AlbumWithRole, userId: string): AlbumUserRole | null =>
  'role' in album ? album.role : (album.albumUsers.find(({ user }) => user.id === userId)?.role ?? null);

export const ownerOf = (album: AlbumResponseDto): UserResponseDto | undefined =>
  album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)?.user;

export const isOwner = (album: AlbumWithRole, userId: string) => roleOf(album, userId) === AlbumUserRole.Owner;

/** "Merge with…" is for plain albums the person owns: not smart albums, collections, spaces or partner copies. */
export const canMerge = (album: AlbumResponseDto, userId: string) =>
  album.kind === AlbumKind.Album && !album.isSmart && !album.origin && isOwner(album, userId);

/** The same name once spaces and case are set aside, which is what makes two albums look like duplicates. */
export const sameAlbumName = (a: string, b: string) => {
  const normal = (name: string) => name.trim().replaceAll(/\s+/g, ' ').toLowerCase();
  return normal(a) === normal(b);
};

/** Owners and editors may change an album or add to a collection. */
export const canEdit = (album: AlbumWithRole, userId: string) => {
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
    case 'folders': {
      return !!album.folderAlbum;
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

/**
 * Names compare as people read them in the viewer's language, so "2026-11-19 - …" and "Album 10" fall in order
 * (FL-139: the chosen locale, never the browser's by accident).
 */
const nameCollators = new Map<string | undefined, Intl.Collator>();
export const nameCollatorFor = (locale?: string) => {
  let collator = nameCollators.get(locale);
  if (!collator) {
    collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
    nameCollators.set(locale, collator);
  }
  return collator;
};

/**
 * The order a level is listed in. `opened` is the albums opened on this device, most recent first
 * (`recentAlbumIds`); albums never opened here follow by when they last changed.
 */
/**
 * What a tile stands for when sorting and grouping: for a collection, or an album holding albums, its photos'
 * dates and items with everything inside it (the server's numbers cover the album's own photos only).
 */
export interface AlbumFacts {
  startDate?: string;
  endDate?: string;
  assetCount: number;
}
const ownFacts = (album: AlbumResponseDto): AlbumFacts => album;

export const compareAlbums =
  (
    sort: AlbumDirectorySort,
    order: AlbumDirectoryOrder = 'desc',
    opened: string[] = [],
    facts: (album: AlbumResponseDto) => AlbumFacts = ownFacts,
    locale?: string,
  ) =>
  (a: AlbumResponseDto, b: AlbumResponseDto): number => {
    const collator = nameCollatorFor(locale);
    const compareNames = (x: AlbumResponseDto, y: AlbumResponseDto) =>
      collator.compare(x.albumName, y.albumName) || x.id.localeCompare(y.id);
    const flip = order === 'asc' ? -1 : 1;
    switch (sort) {
      case 'title': {
        return (order === 'asc' ? 1 : -1) * compareNames(a, b);
      }
      case 'items': {
        return flip * (facts(b).assetCount - facts(a).assetCount) || compareNames(a, b);
      }
      case 'date': {
        return compareDates(facts(a).endDate, facts(b).endDate, order) || compareNames(a, b);
      }
      case 'opened': {
        const rank = (album: AlbumResponseDto) => {
          const index = opened.indexOf(album.id);
          return index === -1 ? Infinity : index;
        };
        if (rank(a) !== rank(b)) {
          // Albums never opened on this device go last whichever way the list runs.
          if (rank(a) === Infinity || rank(b) === Infinity) {
            return rank(a) === Infinity ? 1 : -1;
          }
          return (rank(a) < rank(b) ? -1 : 1) * flip;
        }
        return compareDates(a.updatedAt, b.updatedAt, order) || compareNames(a, b);
      }
      case 'modified': {
        return compareDates(a.updatedAt, b.updatedAt, order) || compareNames(a, b);
      }
      case 'custom': {
        // The server returns every group in the person's own order (FL-52); a stable sort keeps it.
        return 0;
      }
    }
  };

/** What a section of the page holds; its heading words are the page's to choose (`groupLabel`). */
export interface AlbumGroup {
  /** `kind:albums`, `source:folders`, `year:2026`, `month:2026-11`, `owner:<user id>`, `none`, … */
  id: string;
  albums: AlbumResponseDto[];
}

export interface AlbumBrowse {
  /** The collection or album being looked inside, or undefined at the top level. */
  here?: AlbumResponseDto;
  /** From the top level down to `here`, for the path bar. */
  path: AlbumResponseDto[];
  groups: AlbumGroup[];
  /** Every album and collection listed on screen, in order, for Select all. */
  listed: AlbumResponseDto[];
  /** Albums directly inside each album or collection that are shown (empty ones left out while hidden). */
  inside: Map<string, number>;
  /**
   * Items in each album or collection with everything inside it: the server's total for a collection
   * (`AlbumCollectionResponseDto.assetCount`), otherwise the album's own items and those of the albums in it.
   */
  items: Map<string, number>;
  totals: { albums: number; collections: number; spaces: number; emptyHidden: number };
  /** Items at this level left out because they are empty (`hideEmpty`): an order can't be arranged around them. */
  hiddenHere: number;
  /** Where each album sits in the hierarchy the page browses (`effectiveParents`), for "in …" under a result. */
  parents: Map<string, string | null>;
  /** This level holds an album whose parent cycle the page broke; the server can't arrange such a group. */
  cycleHere: boolean;
  searching: boolean;
  /** Nothing to show here (after filter, search and hiding empty albums). */
  empty: boolean;
}

export interface BrowseOptions {
  inside: string | null;
  filter: AlbumDirectoryFilter;
  sort: AlbumDirectorySort;
  order: AlbumDirectoryOrder;
  group: AlbumDirectoryGroup;
  hideEmpty: boolean;
  collectionsFirst: boolean;
  search: string;
  userId: string;
  /** Albums opened on this device, most recent first. */
  opened?: string[];
  /** The viewer's language, for comparing names. */
  locale?: string;
}

const kindKey = (album: AlbumResponseDto) =>
  album.kind === AlbumKind.Space
    ? 'kind:spaces'
    : album.isSmart
      ? 'kind:smart'
      : album.kind === AlbumKind.Collection
        ? 'kind:collections'
        : 'kind:albums';
const kindOrder = ['kind:collections', 'kind:albums', 'kind:smart', 'kind:spaces'];
const sourceOrder = ['source:made', 'source:folders', 'source:shared', 'source:smart', 'source:spaces'];

export const groupKeyOf = (
  album: AlbumResponseDto,
  group: AlbumDirectoryGroup,
  userId: string,
  facts: (album: AlbumResponseDto) => AlbumFacts = ownFacts,
): string => {
  switch (group) {
    case 'kind': {
      return kindKey(album);
    }
    case 'source': {
      if (album.kind === AlbumKind.Space) {
        return 'source:spaces';
      }
      if (album.isSmart) {
        return 'source:smart';
      }
      if (!isOwner(album, userId)) {
        return 'source:shared';
      }
      return album.folderAlbum ? 'source:folders' : 'source:made';
    }
    case 'year': {
      const date = facts(album).endDate ?? facts(album).startDate;
      return date ? `year:${date.slice(0, 4)}` : 'year:none';
    }
    case 'month': {
      const date = facts(album).endDate ?? facts(album).startDate;
      return date ? `month:${date.slice(0, 7)}` : 'month:none';
    }
    case 'owner': {
      const owner = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)?.user;
      return !owner || owner.id === userId ? 'owner:me' : `owner:${owner.id}`;
    }
    case 'none': {
      return 'none';
    }
  }
};

/** Sections in the order they are shown: fixed for kind and source, by date for year and month, you first for owner. */
const orderGroups = (groups: AlbumGroup[], group: AlbumDirectoryGroup, order: AlbumDirectoryOrder) => {
  const at = (list: string[], id: string) => {
    const index = list.indexOf(id);
    return index === -1 ? list.length : index;
  };
  const byDate = (a: AlbumGroup, b: AlbumGroup) => {
    // "No photos yet" goes last whichever way the dates run.
    if (a.id.endsWith(':none') || b.id.endsWith(':none')) {
      return Number(a.id.endsWith(':none')) - Number(b.id.endsWith(':none'));
    }
    return order === 'asc' ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id);
  };
  switch (group) {
    case 'kind': {
      return groups.sort((a, b) => at(kindOrder, a.id) - at(kindOrder, b.id));
    }
    case 'source': {
      return groups.sort((a, b) => at(sourceOrder, a.id) - at(sourceOrder, b.id));
    }
    case 'year':
    case 'month': {
      return groups.sort(byDate);
    }
    case 'owner': {
      return groups.sort((a, b) => Number(b.id === 'owner:me') - Number(a.id === 'owner:me'));
    }
    case 'none': {
      return groups;
    }
  }
};

/**
 * Lay out one level of the directory the way the page renders it (FL-1836). Without a search the level
 * is what sits directly in `inside` (the top level when null; an album whose parent the viewer cannot
 * see counts as top level). A search looks through every level below `inside` instead, and each result
 * says where it lives. Spaces never count as empty.
 */
export const browseAlbumDirectory = (tree: AlbumTreeResponseDto, options: BrowseOptions): AlbumBrowse => {
  const {
    inside,
    filter,
    sort,
    order,
    group,
    hideEmpty,
    collectionsFirst,
    search,
    userId,
    opened = [],
    locale,
  } = options;
  const everything = directoryAlbums(tree);
  const byId = new Map(everything.map((album) => [album.id, album]));
  const parentOf = effectiveParents(everything);
  const rawParentOf = effectiveParents(everything, { breakCycles: false });
  const children = new Map<string, AlbumResponseDto[]>();
  for (const album of everything) {
    const parentId = parentOf.get(album.id);
    if (parentId) {
      const list = children.get(parentId);
      if (list) {
        list.push(album);
      } else {
        children.set(parentId, [album]);
      }
    }
  }
  // Everything inside each album, once: a plain array, so no browser needs iterator helpers (FL-1836 recheck).
  const below = new Map<string, AlbumResponseDto[]>();
  const descendants = (album: AlbumResponseDto): AlbumResponseDto[] => {
    const known = below.get(album.id);
    if (known) {
      return known;
    }
    const list: AlbumResponseDto[] = [];
    below.set(album.id, list);
    const seen = new Set([album.id]);
    const stack = [...(children.get(album.id) ?? [])];
    while (stack.length > 0) {
      const child = stack.pop()!;
      if (!seen.has(child.id)) {
        seen.add(child.id);
        list.push(child);
        stack.push(...(children.get(child.id) ?? []));
      }
    }
    return list;
  };

  const factsMemo = new Map<string, AlbumFacts>();
  const factsOf = (album: AlbumResponseDto): AlbumFacts => {
    if (album.kind !== AlbumKind.Collection && !children.has(album.id)) {
      return album;
    }
    let facts = factsMemo.get(album.id);
    if (!facts) {
      facts = { startDate: album.startDate, endDate: album.endDate, assetCount: album.assetCount };
      for (const child of descendants(album)) {
        facts.assetCount += child.assetCount;
        if (child.endDate && (!facts.endDate || child.endDate > facts.endDate)) {
          facts.endDate = child.endDate;
        }
        if (child.startDate && (!facts.startDate || child.startDate < facts.startDate)) {
          facts.startDate = child.startDate;
        }
      }
      factsMemo.set(album.id, facts);
    }
    return facts;
  };

  const contentMemo = new Map<string, boolean>();
  const hasContent = (album: AlbumResponseDto): boolean => {
    let known = contentMemo.get(album.id);
    if (known === undefined) {
      known =
        album.kind === AlbumKind.Space ||
        album.assetCount > 0 ||
        !!album.statsPending ||
        // A collection with nothing in it yet is a place to put albums, not an empty album.
        (album.kind === AlbumKind.Collection && !children.has(album.id)) ||
        descendants(album).some((child) => child.assetCount > 0 || !!child.statsPending);
      contentMemo.set(album.id, known);
    }
    return known;
  };
  const shown = (album: AlbumResponseDto) => !hideEmpty || hasContent(album);
  /** A tile passes the filter when it, or anything inside it, does: a collection of smart albums shows under Smart. */
  const passes = (album: AlbumResponseDto) =>
    matchesFilter(album, filter, userId) || descendants(album).some((child) => matchesFilter(child, filter, userId));

  const here = inside ? byId.get(inside) : undefined;
  const path = here ? [...albumAncestorsIn(byId, here), here] : [];
  const searching = searchTokens(search).length > 0;
  const belowHere = here ? new Set(descendants(here).map(({ id }) => id)) : undefined;
  const level = searching
    ? everything.filter(
        (album) => album.id !== here?.id && (!belowHere || belowHere.has(album.id)) && matchesSearch(album, search),
      )
    : everything.filter((album) => (parentOf.get(album.id) ?? null) === (here?.id ?? null));

  const holds = (album: AlbumResponseDto) => (album.kind === AlbumKind.Collection || children.has(album.id) ? 0 : 1);
  const compare = compareAlbums(sort, order, opened, factsOf, locale);
  const filtered = level.filter((album) => (searching ? matchesFilter(album, filter, userId) : passes(album)));
  const listed = filtered
    .filter((album) => shown(album))
    .sort((a, b) => (collectionsFirst ? holds(a) - holds(b) : 0) || compare(a, b));

  const sections = new Map<string, AlbumResponseDto[]>();
  for (const album of listed) {
    const key = groupKeyOf(album, group, userId, factsOf);
    const list = sections.get(key);
    if (list) {
      list.push(album);
    } else {
      sections.set(key, [album]);
    }
  }
  const groups = orderGroups(
    [...sections].map(([id, albums]) => ({ id, albums })),
    group,
    order,
  );

  const insideCounts = new Map<string, number>();
  for (const [id, list] of children) {
    insideCounts.set(id, list.filter((child) => child.kind !== AlbumKind.Space && shown(child)).length);
  }

  const itemTotals = new Map<string, number>();
  for (const album of everything) {
    if (children.has(album.id) || album.kind === AlbumKind.Collection) {
      itemTotals.set(album.id, factsOf(album).assetCount);
    }
  }

  const emptyHidden = hideEmpty
    ? everything.filter((album) => album.kind === AlbumKind.Album && !hasContent(album)).length
    : 0;

  return {
    here,
    path,
    groups,
    listed: groups.flatMap(({ albums }) => albums),
    inside: insideCounts,
    items: itemTotals,
    totals: {
      albums: everything.filter((album) => album.kind === AlbumKind.Album).length,
      collections: everything.filter((album) => album.kind === AlbumKind.Collection).length,
      spaces: everything.filter((album) => album.kind === AlbumKind.Space).length,
      emptyHidden,
    },
    hiddenHere: filtered.length - listed.length,
    parents: parentOf,
    cycleHere: level.some((album) => parentOf.get(album.id) !== rawParentOf.get(album.id)),
    searching,
    empty: listed.length === 0,
  };
};

/**
 * Where each album sits in the hierarchy the page browses, as the server's own hierarchy does
 * (`albumOrderGroup` with `hierarchy`): an album whose parent the viewer can't see, a shared space, and
 * an album under a shared space are at the top level; so is any album caught in a parent cycle.
 */
export const effectiveParents = (
  albums: AlbumResponseDto[],
  { breakCycles = true }: { breakCycles?: boolean } = {},
): Map<string, string | null> => {
  const byId = new Map(albums.map((album) => [album.id, album]));
  const parents = new Map<string, string | null>();
  for (const album of albums) {
    const parent = album.parentId ? byId.get(album.parentId) : undefined;
    parents.set(
      album.id,
      parent && album.kind !== AlbumKind.Space && parent.kind !== AlbumKind.Space ? parent.id : null,
    );
  }
  for (const album of breakCycles ? albums : []) {
    const seen = new Set([album.id]);
    for (let up = parents.get(album.id); up; up = parents.get(up) ?? null) {
      if (seen.has(up)) {
        parents.set(album.id, null);
        break;
      }
      seen.add(up);
    }
  }
  return parents;
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
  // FL-1836: the siblings the page shows together, as the server groups them with `hierarchy: true`.
  const all = directoryAlbums(tree);
  const album = all.find(({ id }) => id === albumId);
  if (!album) {
    return undefined;
  }
  // The server's own grouping, which leaves a parent cycle as it is (`albumOrderGroup` with `hierarchy`).
  const parents = effectiveParents(all, { breakCycles: false });
  const parentId = parents.get(albumId) ?? null;
  const isSpace = album.kind === AlbumKind.Space;
  return {
    parentId,
    ids: all
      .filter(
        (item) =>
          (parents.get(item.id) ?? null) === parentId &&
          (parentId !== null || (item.kind === AlbumKind.Space) === isSpace),
      )
      .map(({ id }) => id),
  };
};

/**
 * The part of an album's order group the page shows as one run: at the top level the albums tree lists every
 * collection before every album, so each kind is arranged on its own and the saved order keeps collections
 * first, as shown. Inside an album or collection the run is the whole group.
 */
export const orderBandOf = (tree: AlbumTreeResponseDto, albumId: string) => {
  const group = orderGroupOf(tree, albumId);
  if (!group) {
    return undefined;
  }
  if (group.parentId !== null) {
    return { group, band: group.ids };
  }
  const byId = albumsById(tree);
  const isCollection = (id: string) => byId.get(id)?.kind === AlbumKind.Collection;
  const mine = isCollection(albumId);
  return { group, band: group.ids.filter((id) => isCollection(id) === mine) };
};

/** Apply a change to an album's run (`orderBandOf`) and give back the whole group to save, or undefined. */
export const arrangeInGroup = (
  tree: AlbumTreeResponseDto,
  albumId: string,
  change: (band: string[]) => string[] | undefined,
): AlbumOrderGroup | undefined => {
  const found = orderBandOf(tree, albumId);
  const changed = found && change(found.band);
  if (!found || !changed) {
    return undefined;
  }
  const inBand = new Set(found.band);
  const before = found.group.ids.filter((id) => !inBand.has(id));
  const byId = albumsById(tree);
  // Collections stay ahead of albums at the top level, as the page shows them.
  const ids =
    found.group.parentId === null && byId.get(albumId)?.kind !== AlbumKind.Collection
      ? [...before, ...changed]
      : [...changed, ...before];
  return { parentId: found.group.parentId, ids };
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

/** The legacy directory is a flat projection; parent IDs retain the full hierarchy. */
export const directoryAlbums = (tree: AlbumTreeResponseDto): AlbumResponseDto[] => [
  ...tree.collections.flatMap(({ collection, albums }) => [collection, ...albums]),
  ...tree.albums,
  ...tree.spaces,
];

/** Every album of a directory by id. Build it once when asking about many albums (`albumAncestorsIn`). */
export const albumsById = (tree: AlbumTreeResponseDto) => new Map(directoryAlbums(tree).map((item) => [item.id, item]));

export const albumAncestors = (tree: AlbumTreeResponseDto, album: AlbumResponseDto): AlbumResponseDto[] =>
  albumAncestorsIn(albumsById(tree), album);

export const albumAncestorsIn = (
  visible: Map<string, AlbumResponseDto>,
  album: AlbumResponseDto,
): AlbumResponseDto[] => {
  const ancestors: AlbumResponseDto[] = [];
  const visited = new Set([album.id]);
  let parent = album.parentId ? visible.get(album.parentId) : undefined;
  while (parent && !visited.has(parent.id)) {
    ancestors.unshift(parent);
    visited.add(parent.id);
    parent = parent.parentId ? visible.get(parent.parentId) : undefined;
  }
  return ancestors;
};

export const canDropOnCollection = (
  album: AlbumResponseDto | undefined,
  collection: AlbumResponseDto,
  userId: string,
): boolean =>
  !!album &&
  album.id !== collection.id &&
  album.kind !== AlbumKind.Space &&
  collection.kind !== AlbumKind.Space &&
  isOwner(album, userId) &&
  canEdit(collection, userId) &&
  album.parentId !== collection.id;

export const canTakeOut = (album: AlbumResponseDto | undefined, userId: string): boolean =>
  !!album && album.kind !== AlbumKind.Space && album.parentId !== null && isOwner(album, userId);

/** Editable parents, excluding the moving node and all of its visible descendants. */
export const moveTargets = (
  tree: AlbumTreeResponseDto,
  album: AlbumResponseDto,
  userId: string,
): AlbumCollectionResponseDto[] => {
  const all = directoryAlbums(tree);
  return all
    .filter(
      (candidate) =>
        candidate.kind !== AlbumKind.Space &&
        candidate.id !== album.id &&
        canEdit(candidate, userId) &&
        albumAncestors(tree, candidate).every(({ id }) => id !== album.id),
    )
    .sort((a, b) => a.albumName.localeCompare(b.albumName))
    .map((collection) => {
      const albums = all.filter(({ parentId }) => parentId === collection.id);
      return {
        collection,
        albums,
        albumCount: albums.length,
        assetCount: albums.reduce((total, child) => total + child.assetCount, collection.assetCount),
      };
    });
};

/** "Aug 2026", "Jun – Aug 2026" or "2025 – 2026" for a run of capture dates. */
const spanFormats = new Map<string | undefined, Record<'monthYear' | 'month' | 'year', Intl.DateTimeFormat>>();
/** Making a formatter is slow enough to matter when thousands of tiles update together. */
const spanFormatters = (locale?: string) => {
  let formats = spanFormats.get(locale);
  if (!formats) {
    // Month and year only: with no day and no time there is nothing for the account's date or time format
    // to change, so these stay as they were.
    formats = {
      // eslint-disable-next-line no-restricted-syntax -- no day or time for the account's format to change
      monthYear: new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' }),
      // eslint-disable-next-line no-restricted-syntax -- no day or time for the account's format to change
      month: new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }),
      // eslint-disable-next-line no-restricted-syntax -- no day or time for the account's format to change
      year: new Intl.DateTimeFormat(locale, { year: 'numeric', timeZone: 'UTC' }),
    };
    spanFormats.set(locale, formats);
  }
  return formats;
};

export const monthSpan = (earliest: string | undefined, latest: string | undefined, locale?: string): string => {
  if (!latest) {
    return '';
  }
  const last = new Date(latest);
  if (Number.isNaN(last.getTime())) {
    return '';
  }
  const first = new Date(earliest || latest);
  const { monthYear, month, year } = spanFormatters(locale);
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
  /** Null clears it, so the kind's default icon shows. */
  icon: string | null;
  /** One of the album colours, or null for none. Left out, the colour is not changed. */
  color?: string | null;
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
