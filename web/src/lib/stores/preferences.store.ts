import { persisted } from 'svelte-persisted-store';
import { browser } from '$app/environment';
import { defaultLang } from '$lib/constants';
import { defaultAlbumDirectoryView, type AlbumDirectoryView } from '$lib/frameleaf/album-directory';
import { convertBCP47, getPreferredLocale } from '$lib/utils/i18n';

// Locale to use for formatting dates, numbers, etc.
export const locale = persisted('locale', 'default', {
  serializer: {
    parse: (text) => convertBCP47(text) || 'default',
    stringify: (object) => object ?? '',
  },
});

const preferredLocale = browser ? getPreferredLocale() : undefined;
export const lang = persisted<string>('lang', preferredLocale || defaultLang.code, {
  serializer: {
    parse: (text) => convertBCP47(text),
    stringify: (object) => object ?? '',
  },
});

/**
 * The Map screen's settings sheet (prototype `defaultMapSettings`): a date preset, what to include
 * and whether the in-view list is open. Shared spaces and partner items are included by default.
 */
export interface MapSettings {
  datePreset: 'all' | '30d' | 'year' | 'custom';
  /** Custom range start, `YYYY-MM-DD`; empty when unset. */
  dateAfter: string;
  /** Custom range end, `YYYY-MM-DD`; empty when unset. */
  dateBefore: string;
  includeArchived: boolean;
  withSharedAlbums: boolean;
  withPartners: boolean;
  onlyFavorites: boolean;
  showAssetPanel: boolean;
}

const defaultMapSettings: MapSettings = {
  datePreset: 'all',
  dateAfter: '',
  dateBefore: '',
  includeArchived: false,
  withSharedAlbums: true,
  withPartners: true,
  onlyFavorites: false,
  showAssetPanel: false,
};

const persistedObject = <T>(key: string, defaults: T) =>
  persisted<T>(key, defaults, {
    serializer: {
      parse: (text) => ({ ...defaults, ...JSON.parse(text ?? null) }),
      stringify: JSON.stringify,
    },
  });

export const mapSettings = persistedObject<MapSettings>('map-settings', defaultMapSettings);

export interface AlbumViewSettings {
  view: string;
  filter: string;
  groupBy: string;
  groupOrder: string;
  sortBy: string;
  sortOrder: string;
  /**
   * When true the /albums grid shows every owned album regardless of nesting.
   * When false (default) it shows only top-level (parentId === null) albums and
   * relies on drill-down + the sidebar tree to reach nested ones.
   */
  showAllAlbums: boolean;
  collapsedGroups: {
    // Grouping Option => Array<Group ID>
    [group: string]: string[];
  };
}

export interface PlacesViewSettings {
  groupBy: string;
  collapsedGroups: {
    // Grouping Option => Array<Group ID>
    [group: string]: string[];
  };
}

export enum SortOrder {
  Asc = 'asc',
  Desc = 'desc',
}

export enum AlbumViewMode {
  Cover = 'Cover',
  List = 'List',
}

export enum AlbumFilter {
  All = 'All',
  Owned = 'Owned',
  Shared = 'Shared',
}

export enum AlbumGroupBy {
  None = 'None',
  Year = 'Year',
  Owner = 'Owner',
}

export enum AlbumSortBy {
  Title = 'Title',
  ItemCount = 'ItemCount',
  DateModified = 'DateModified',
  DateCreated = 'DateCreated',
  MostRecentPhoto = 'MostRecentPhoto',
  OldestPhoto = 'OldestPhoto',
}

export const albumViewSettings = persisted<AlbumViewSettings>('album-view-settings', {
  view: AlbumViewMode.Cover,
  filter: AlbumFilter.All,
  groupBy: AlbumGroupBy.Year,
  groupOrder: SortOrder.Desc,
  sortBy: AlbumSortBy.MostRecentPhoto,
  sortOrder: SortOrder.Desc,
  showAllAlbums: false,
  collapsedGroups: {},
});

/**
 * Frameleaf Albums page view (FL-52): filter pill, sort, grid or list, and the
 * collapsed collection shelves. A per-device convenience, never authority; the
 * page repairs a stale or edited value with `normalizeAlbumDirectoryView`.
 */
export const albumDirectoryView = persisted<AlbumDirectoryView>('frameleaf-album-directory', {
  ...defaultAlbumDirectoryView,
});

export enum PlacesGroupBy {
  None = 'None',
  Country = 'Country',
  // Frameleaf (FL-51): country, then state, matching the September 22, 2026 design
  // revision's Places grouping. Kept as its own value (not a variant of Country) so a
  // saved preference from before this story still round-trips through the same enum.
  CountryState = 'CountryState',
}

// FL-83 (PL-1): grouped by country and state by default, as the prototype's Places opens
// grouped (`Places.jsx`); the choice is still persisted once changed.
export const placesViewSettings = persisted<PlacesViewSettings>('places-view-settings', {
  groupBy: PlacesGroupBy.CountryState,
  collapsedGroups: {},
});

export const showDeleteModal = persisted<boolean>('delete-confirm-dialog', true, {});

export const alwaysLoadOriginalFile = persisted<boolean>('always-load-original-file', false, {});

export const playVideoThumbnailOnHover = persisted<boolean>('play-video-thumbnail-on-hover', true, {});

export const loopVideo = persisted<boolean>('loop-video', true, {});

export const autoPlayVideo = persisted<boolean>('auto-play-video', true, {});

// Realtime-transcoding quality: 'auto' lets hls.js adapt, a number pins the rendition by its short side (e.g. 720).
export const videoQuality = persisted<'auto' | number>('video-quality', 'auto', {});

export const alwaysLoadOriginalVideo = persisted<boolean>('always-load-original-video', false, {});

export const albumTreeDropdown = persisted<boolean>('album-tree-open', false, {});

// Primary sidebar width (px) when expanded, and whether it is collapsed to an icon-only rail.
export const sidebarWidth = persisted<number>('sidebar-width', 256, {});

export const sidebarCollapsed = persisted<boolean>('sidebar-collapsed', false, {});
