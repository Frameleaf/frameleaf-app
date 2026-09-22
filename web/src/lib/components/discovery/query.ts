import type { MetadataSearchDto, SearchFilter, SmartSearchDto } from '@immich/sdk';

/**
 * The one library query every Frameleaf view shares. It is portable: it travels in a URL, it is
 * stored in presets and it is handed to the search API unchanged. Layout is deliberately absent —
 * layout is device-local and lives on the session, not on the query.
 *
 * Ported from the approved prototype (`design/frameleaf/template/src/reference/query.ts`,
 * `search.mjs`) for FL-31. The September 22, 2026 interaction revision adds the single Filter
 * control model (active-filter badge and filter-panel deep links) and the cumulative paging
 * summary; both are expressed here as pure functions over a query.
 */
export type DiscoveryMode = 'text' | 'smart';
export type DiscoveryGrouping = 'all' | 'months' | 'years';
export type DiscoveryView = 'photos' | 'map' | 'moments';

export type DiscoveryQuery = {
  version: 1;
  text: string;
  mode: DiscoveryMode;
  filter: SearchFilter;
  grouping: DiscoveryGrouping;
  view: DiscoveryView;
  spaceId?: string;
  petIds?: string[];
};

export const DISCOVERY_MODES: readonly DiscoveryMode[] = ['text', 'smart'];
export const DISCOVERY_GROUPINGS: readonly DiscoveryGrouping[] = ['all', 'months', 'years'];
export const DISCOVERY_VIEWS: readonly DiscoveryView[] = ['photos', 'map', 'moments'];

export const emptyDiscoveryQuery = (): DiscoveryQuery => ({
  version: 1,
  text: '',
  mode: 'text',
  filter: {},
  grouping: 'all',
  view: 'photos',
});

export const readDiscoveryQuery = (url: URL): DiscoveryQuery => {
  const raw = url.searchParams.get('dq');
  if (!raw) {
    return emptyDiscoveryQuery();
  }
  try {
    const query = JSON.parse(raw);
    if (query.version !== 1 || typeof query.filter !== 'object' || Array.isArray(query.filter) || !query.filter) {
      return emptyDiscoveryQuery();
    }
    return { ...emptyDiscoveryQuery(), ...query };
  } catch {
    return emptyDiscoveryQuery();
  }
};

export const discoveryUrl = (query: DiscoveryQuery) =>
  `/discover?${new URLSearchParams({ dq: JSON.stringify(query) })}`;

export const contextDiscoveryQuery = (url: URL): DiscoveryQuery => {
  if (url.pathname === '/discover') {
    return readDiscoveryQuery(url);
  }
  const result = emptyDiscoveryQuery();
  const albumId = url.pathname.match(/^\/albums\/([\da-f-]{36})(?:\/|$)/i)?.[1];
  const spaceId = url.pathname.match(/^\/spaces\/([\da-f-]{36})(?:\/|$)/i)?.[1];
  if (albumId) {
    result.filter = { albumIds: { any: [albumId] } };
  }
  if (spaceId) {
    result.spaceId = spaceId;
  }
  if (url.pathname.startsWith('/map')) {
    result.view = 'map';
  }
  return result;
};

export const fromLegacySearch = (dto: MetadataSearchDto & Pick<SmartSearchDto, 'query'>): DiscoveryQuery => {
  const result = emptyDiscoveryQuery();
  if (dto.filter) {
    result.filter = structuredClone(dto.filter);
  } else {
    const filter: SearchFilter = {};
    for (const field of [
      'city',
      'country',
      'state',
      'make',
      'model',
      'lensModel',
      'type',
      'visibility',
      'rating',
      'isFavorite',
      'isMotion',
      'isOffline',
      'isEncoded',
    ] as const) {
      if (dto[field] !== undefined) {
        Object.assign(filter, { [field]: { eq: dto[field] } });
      }
    }
    for (const field of ['personIds', 'albumIds', 'tagIds'] as const) {
      if (dto[field]?.length) {
        Object.assign(filter, { [field]: { all: dto[field] } });
      }
    }
    if (dto.tagIds === null) {
      filter.hasTags = { eq: false };
    }
    if (dto.isNotInAlbum) {
      filter.hasAlbums = { eq: false };
    }
    // Only the supplied bound is written; an undefined operand is not a condition and would be
    // rejected by the session's structural validation on the way back out of a URL.
    if (dto.takenAfter || dto.takenBefore) {
      filter.takenAt = {
        ...(dto.takenAfter ? { gte: dto.takenAfter } : {}),
        ...(dto.takenBefore ? { lte: dto.takenBefore } : {}),
      };
    }
    if (dto.originalFileName) {
      filter.originalFileName = { like: `%${dto.originalFileName}%` };
    }
    if (dto.description) {
      filter.description = { like: `%${dto.description}%` };
    }
    if (dto.originalPath) {
      filter.originalPath = { startsWith: dto.originalPath };
    }
    if (dto.ocr) {
      filter.ocr = { matches: dto.ocr };
    }
    result.filter = filter;
  }
  result.text = dto.query ?? '';
  result.mode = result.text ? 'smart' : 'text';
  return result;
};

export const withDiscoveryFacet = (query: DiscoveryQuery, field: string, value: string): DiscoveryQuery => {
  const result = structuredClone(query);
  if (['personIds', 'tagIds', 'albumIds'].includes(field)) {
    const key = field as 'personIds' | 'tagIds' | 'albumIds';
    const selected = result.filter[key]?.any ?? [];
    result.filter[key] = { any: [...new Set([...selected, value])] };
  } else {
    Object.assign(result.filter, { [field]: { eq: value } });
  }
  return result;
};

export const withoutDiscoveryFilter = (query: DiscoveryQuery, field: string): DiscoveryQuery => {
  const result = structuredClone(query);
  delete result.filter[field as keyof SearchFilter];
  return result;
};

export const formatMomentTime = (milliseconds: number) => {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/* -------------------------------------------------------------------------- */
/* The single Filter control                                                   */
/* -------------------------------------------------------------------------- */

/**
 * September 22, 2026 revision: structured filtering sits behind one Filter control in the results
 * toolbar, with a badge carrying the active filter count and a menu that deep-links into a section
 * of the filter panel. `all` is the catch-all section; it also owns every field no other section
 * claims, so a filter arriving from a URL or a saved preset always has a home to open into.
 */
export type DiscoveryFilterSection = 'people' | 'date' | 'places' | 'media' | 'tags' | 'all';

export const DISCOVERY_FILTER_SECTIONS: readonly DiscoveryFilterSection[] = [
  'people',
  'date',
  'places',
  'media',
  'tags',
  'all',
];

const SECTION_FIELDS: Record<Exclude<DiscoveryFilterSection, 'all'>, readonly string[]> = {
  people: ['personIds', 'hasPeople'],
  date: ['takenAt', 'createdAt', 'updatedAt', 'trashedAt'],
  places: ['city', 'state', 'country'],
  media: [
    'type',
    'visibility',
    'rating',
    'isFavorite',
    'isMotion',
    'isOffline',
    'isEncoded',
    'make',
    'model',
    'lensModel',
    'fileSizeInBytes',
  ],
  tags: ['tagIds', 'hasTags'],
};

/** The filter panel section a field belongs to. Unclaimed fields open the All filters section. */
export const filterSectionForField = (field: string): DiscoveryFilterSection => {
  for (const section of DISCOVERY_FILTER_SECTIONS) {
    if (section !== 'all' && SECTION_FIELDS[section].includes(field)) {
      return section;
    }
  }
  return 'all';
};

/**
 * Fields carrying an active condition, in a stable order. An `or` branch counts once: the badge
 * reports how many things the user has narrowed by, not how many operands were written.
 */
export const activeFilterFields = (query: DiscoveryQuery): string[] => {
  const filter = query?.filter;
  if (!filter || typeof filter !== 'object') {
    return [];
  }
  return Object.entries(filter)
    .filter(([, condition]) => {
      if (Array.isArray(condition)) {
        return condition.length > 0;
      }
      return !!condition && typeof condition === 'object' && Object.keys(condition).length > 0;
    })
    .map(([field]) => field)
    .sort();
};

/** The fields a section owns. `all` owns every field present in the query. */
export const fieldsInFilterSection = (query: DiscoveryQuery, section: DiscoveryFilterSection): string[] =>
  activeFilterFields(query).filter((field) => section === 'all' || filterSectionForField(field) === section);

/** The number for the Filter control's badge. Free text is a separate entry point, so it is excluded. */
export const activeFilterCount = (query: DiscoveryQuery): number => activeFilterFields(query).length;

export const isDiscoveryFilterActive = (query: DiscoveryQuery): boolean => activeFilterCount(query) > 0;

/** Sections that currently hold a condition, for marking entries in the Filter menu. */
export const activeFilterSections = (query: DiscoveryQuery): DiscoveryFilterSection[] => {
  const sections = new Set(activeFilterFields(query).map((field) => filterSectionForField(field)));
  return DISCOVERY_FILTER_SECTIONS.filter((section) => sections.has(section));
};

/**
 * The destination the results are already shown under. A chip that merely restates it is not
 * drawn: a person page does not need a "People: Ada" chip, Favorites does not need a favourite chip.
 */
export type DiscoveryDestination = {
  kind: 'library' | 'album' | 'space' | 'person' | 'tag' | 'place' | 'favorites' | 'archive' | 'trash' | 'search';
  id?: string;
};

const DESTINATION_FIELDS: Record<DiscoveryDestination['kind'], readonly string[]> = {
  library: [],
  album: ['albumIds'],
  space: [],
  person: ['personIds'],
  tag: ['tagIds'],
  place: ['city', 'state', 'country'],
  favorites: ['isFavorite'],
  archive: ['visibility'],
  trash: ['visibility', 'trashedAt'],
  search: [],
};

/** Filter fields the destination already states in its own title. */
export const destinationFilterFields = (destination?: DiscoveryDestination): string[] => [
  ...(DESTINATION_FIELDS[destination?.kind ?? 'library'] ?? []),
];

/**
 * Fields that should be drawn as removable filter chips. Chips exist only while a filter is
 * active and never restate the destination.
 */
export const discoveryChipFields = (query: DiscoveryQuery, destination?: DiscoveryDestination): string[] => {
  const suppressed = new Set(destinationFilterFields(destination));
  return activeFilterFields(query).filter((field) => !suppressed.has(field));
};

/** Clear every structured filter while keeping the text query, grouping and view. */
export const withoutDiscoveryFilters = (query: DiscoveryQuery): DiscoveryQuery => ({
  ...structuredClone(query),
  filter: {},
});

/* -------------------------------------------------------------------------- */
/* Cumulative paging                                                           */
/* -------------------------------------------------------------------------- */

export type DiscoveryPaging = {
  /** Pages already loaded, cumulative: Show more raises this, it never replaces the page. */
  page: number;
  pageSize: number;
  /** Items currently rendered, capped by the total when it is known. */
  shown: number;
  /** Total matches reported by the server, or null while it is unknown. */
  total: number | null;
  hasMore: boolean;
  remaining: number | null;
};

export const DEFAULT_DISCOVERY_PAGE_SIZE = 60;

/**
 * Cumulative paging for the Show more control. `page` counts loaded pages, so the visible run is
 * always 1..page * pageSize; this is what makes the summary read "Showing n of m" rather than a
 * range. An unknown total (the server has not counted yet) keeps Show more available.
 */
export const discoveryPaging = (
  page: number,
  total: number | null,
  pageSize: number = DEFAULT_DISCOVERY_PAGE_SIZE,
): DiscoveryPaging => {
  const size = Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 1000) : DEFAULT_DISCOVERY_PAGE_SIZE;
  const current = Math.max(1, Number.isInteger(page) ? page : 1);
  const count = Number.isInteger(total) && (total as number) >= 0 ? (total as number) : null;
  const requested = current * size;
  const shown = count === null ? requested : Math.min(requested, count);
  return {
    page: count === null ? current : Math.max(1, Math.min(current, Math.ceil(count / size) || 1)),
    pageSize: size,
    shown,
    total: count,
    hasMore: count === null ? true : shown < count,
    remaining: count === null ? null : count - shown,
  };
};

export type DiscoveryPageSummary = {
  /** i18n key for the cumulative "Showing n of m" line under the results. */
  key: 'no_results' | 'frameleaf_library_showing_all' | 'frameleaf_library_showing_of';
  values: { shown: number; total: number };
  hasMore: boolean;
};

/** The cumulative summary; the caller translates `key` with `values`. */
export const discoveryPageSummary = (paging: DiscoveryPaging): DiscoveryPageSummary => {
  const total = paging.total ?? paging.shown;
  if (paging.total === 0) {
    return { key: 'no_results', values: { shown: 0, total: 0 }, hasMore: false };
  }
  if (!paging.hasMore) {
    return { key: 'frameleaf_library_showing_all', values: { shown: total, total }, hasMore: false };
  }
  return { key: 'frameleaf_library_showing_of', values: { shown: paging.shown, total }, hasMore: true };
};
