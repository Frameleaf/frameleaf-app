import type { AlbumResponseDto } from '@frameleaf/sdk';
import { orderBy } from 'lodash-es';
import { get } from 'svelte/store';
import {
  AlbumGroupBy,
  AlbumSortBy,
  SortOrder,
  albumViewSettings,
  locale,
  type AlbumViewSettings,
} from '$lib/stores/preferences.store';
import { normalizeSearchString } from '$lib/utils/string-utils';

/**
 * -------------
 * Album Search
 * -------------
 */
const albumSearchTokens = (value: string) => normalizeSearchString(value).match(/[\p{Letter}\p{Number}]+/gu) ?? [];

/**
 * Tokenized, order-insensitive album search: every query token must appear
 * somewhere in the album name or description, so `2004 family vacation`
 * matches `2004 - Family Vacation - Disneyland` despite the punctuation.
 */
export const createAlbumSearchPredicate = (searchQuery: string) => {
  const queryTokens = albumSearchTokens(searchQuery);
  if (queryTokens.length === 0) {
    return () => true;
  }

  return (album: AlbumResponseDto) => {
    const albumText = albumSearchTokens(`${album.albumName} ${album.description}`).join(' ');
    return queryTokens.every((token) => albumText.includes(token));
  };
};

/**
 * -------------
 * Album Sorting
 * -------------
 */
export interface AlbumSortOptionMetadata {
  id: AlbumSortBy;
  defaultOrder: SortOrder;
  columnStyle: string;
}

export const sortOptionsMetadata: AlbumSortOptionMetadata[] = [
  {
    id: AlbumSortBy.Title,
    defaultOrder: SortOrder.Asc,
    columnStyle: 'text-start w-8/12 sm:w-4/12 md:w-4/12 xl:w-[30%] 2xl:w-[40%]',
  },
  {
    id: AlbumSortBy.ItemCount,
    defaultOrder: SortOrder.Desc,
    columnStyle: 'text-center w-4/12 m:w-2/12 md:w-2/12 xl:w-[15%] 2xl:w-[12%]',
  },
  {
    id: AlbumSortBy.DateModified,
    defaultOrder: SortOrder.Desc,
    columnStyle: 'text-center hidden sm:block w-3/12 xl:w-[15%] 2xl:w-[12%]',
  },
  {
    id: AlbumSortBy.DateCreated,
    defaultOrder: SortOrder.Desc,
    columnStyle: 'text-center hidden sm:block w-3/12 xl:w-[15%] 2xl:w-[12%]',
  },
  {
    id: AlbumSortBy.MostRecentPhoto,
    defaultOrder: SortOrder.Desc,
    columnStyle: 'text-center hidden xl:block xl:w-[15%] 2xl:w-[12%]',
  },
  {
    id: AlbumSortBy.OldestPhoto,
    defaultOrder: SortOrder.Desc,
    columnStyle: 'text-center hidden xl:block xl:w-[15%] 2xl:w-[12%]',
  },
];

/**
 * --------------
 * Album Grouping
 * --------------
 */
export interface AlbumGroup {
  id: string;
  name: string;
  albums: AlbumResponseDto[];
}

export const groupAlbumsByYear = (
  albums: AlbumResponseDto[],
  order: SortOrder,
  useStartDate: boolean,
  unknownYear: string,
): AlbumGroup[] => {
  const groups = Object.create(null) as Record<string, AlbumGroup>;
  for (const album of albums) {
    const date = useStartDate ? album.startDate : album.endDate;
    const id = date ? String(new Date(date).getFullYear()) : unknownYear;
    (groups[id] ??= { id, name: id, albums: [] }).albums.push(album);
  }
  const sign = order === SortOrder.Desc ? -1 : 1;
  return Object.values(groups).sort((a, b) => {
    if (a.id === unknownYear) {
      return 1;
    }
    return b.id === unknownYear ? -1 : (Number.parseInt(a.id) - Number.parseInt(b.id)) * sign;
  });
};

export const groupAlbumsByOwner = (
  albums: AlbumResponseDto[],
  order: SortOrder,
  currentUserId: string,
  language: string | undefined,
  ownedLabel: string,
): AlbumGroup[] => {
  const groups = Object.create(null) as Record<string, AlbumGroup>;
  for (const album of albums) {
    const owner = album.albumUsers[0].user;
    (groups[owner.id] ??= {
      id: owner.id,
      name: owner.id === currentUserId ? ownedLabel : owner.name,
      albums: [],
    }).albums.push(album);
  }
  const sign = order === SortOrder.Desc ? -1 : 1;
  let collator: Intl.Collator | undefined;
  return Object.values(groups).sort((a, b) => {
    if (a.id === currentUserId) {
      return -sign;
    }
    if (b.id === currentUserId) {
      return sign;
    }
    collator ??= new Intl.Collator(language);
    return collator.compare(a.name, b.name) * sign;
  });
};

export interface AlbumGroupOptionMetadata {
  id: AlbumGroupBy;
  defaultOrder: SortOrder;
  isDisabled: () => boolean;
}

export const groupOptionsMetadata: AlbumGroupOptionMetadata[] = [
  {
    id: AlbumGroupBy.None,
    defaultOrder: SortOrder.Asc,
    isDisabled: () => false,
  },
  {
    id: AlbumGroupBy.Year,
    defaultOrder: SortOrder.Desc,
    isDisabled() {
      const disabledWithSortOptions: string[] = [AlbumSortBy.DateCreated, AlbumSortBy.DateModified];
      return disabledWithSortOptions.includes(get(albumViewSettings).sortBy);
    },
  },
  {
    id: AlbumGroupBy.Owner,
    defaultOrder: SortOrder.Asc,
    isDisabled: () => false,
  },
];

export const findGroupOptionMetadata = (groupBy: string) => {
  // Default is no grouping
  const defaultGroupOption = groupOptionsMetadata[0];
  return groupOptionsMetadata.find(({ id }) => groupBy === id) ?? defaultGroupOption;
};

export const getSelectedAlbumGroupOption = (settings: AlbumViewSettings) => {
  const defaultGroupOption = AlbumGroupBy.None;
  const albumGroupOption = settings.groupBy ?? defaultGroupOption;

  if (findGroupOptionMetadata(albumGroupOption).isDisabled()) {
    return defaultGroupOption;
  }
  return albumGroupOption;
};

/**
 * ----------------------------
 * Album Groups Collapse/Expand
 * ----------------------------
 */
const getCollapsedAlbumGroups = (settings: AlbumViewSettings) => {
  settings.collapsedGroups ??= {};
  const { collapsedGroups, groupBy } = settings;
  collapsedGroups[groupBy] ??= [];
  return collapsedGroups[groupBy];
};

export const isAlbumGroupCollapsed = (settings: AlbumViewSettings, groupId: string) => {
  if (settings.groupBy === AlbumGroupBy.None) {
    return false;
  }
  return settings.collapsedGroups?.[settings.groupBy]?.includes(groupId) ?? false;
};

export const toggleAlbumGroupCollapsing = (groupId: string) => {
  const settings = get(albumViewSettings);
  if (settings.groupBy === AlbumGroupBy.None) {
    return;
  }
  const collapsedGroups = getCollapsedAlbumGroups(settings);
  const groupIndex = collapsedGroups.indexOf(groupId);
  if (groupIndex === -1) {
    // Collapse
    collapsedGroups.push(groupId);
  } else {
    // Expand
    collapsedGroups.splice(groupIndex, 1);
  }
  albumViewSettings.set(settings);
};

interface AlbumSortOption {
  [option: string]: (order: SortOrder, albums: AlbumResponseDto[]) => AlbumResponseDto[];
}

const sortUnknownYearAlbums = (a: AlbumResponseDto, b: AlbumResponseDto) => {
  if (!a.endDate) {
    return 1;
  }
  if (!b.endDate) {
    return -1;
  }
  return 0;
};

export const stringToSortOrder = (order: string) => {
  return order === 'desc' ? SortOrder.Desc : SortOrder.Asc;
};

const sortOptions: AlbumSortOption = {
  /** Sort by album title */
  [AlbumSortBy.Title]: (order, albums) => {
    const sortSign = order === SortOrder.Desc ? -1 : 1;
    let collator: Intl.Collator | undefined;
    return albums.slice().sort((a, b) => {
      collator ??= new Intl.Collator(get(locale));
      return collator.compare(a.albumName, b.albumName) * sortSign;
    });
  },

  /** Sort by asset count */
  [AlbumSortBy.ItemCount]: (order, albums) => {
    return orderBy(albums, 'assetCount', [order]);
  },

  /** Sort by last modified */
  [AlbumSortBy.DateModified]: (order, albums) => {
    return orderBy(albums, [({ updatedAt }) => new Date(updatedAt)], [order]);
  },

  /** Sort by creation date */
  [AlbumSortBy.DateCreated]: (order, albums) => {
    return orderBy(albums, [({ createdAt }) => new Date(createdAt)], [order]);
  },

  /** Sort by the most recent photo date */
  [AlbumSortBy.MostRecentPhoto]: (order, albums) => {
    albums = orderBy(albums, [({ endDate }) => (endDate ? new Date(endDate) : '')], [order]);
    return albums.sort(sortUnknownYearAlbums);
  },

  /** Sort by the oldest photo date */
  [AlbumSortBy.OldestPhoto]: (order, albums) => {
    albums = orderBy(albums, [({ startDate }) => (startDate ? new Date(startDate) : '')], [order]);
    return albums.sort(sortUnknownYearAlbums);
  },
};

export const sortAlbums = (albums: AlbumResponseDto[], { sortBy, orderBy }: { sortBy: string; orderBy: string }) => {
  const sort = Object.hasOwn(sortOptions, sortBy) ? sortOptions[sortBy] : sortOptions[AlbumSortBy.DateModified];
  const order = stringToSortOrder(orderBy);

  return sort(order, albums);
};
