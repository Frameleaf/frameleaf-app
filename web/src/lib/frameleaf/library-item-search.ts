import {
  LibraryItemSearchMode,
  LibraryItemSearchSort,
  type LibraryItemSearchDto,
  type LibraryItemSearchKind,
} from '@frameleaf/sdk';
import type { DiscoveryQuery } from '$lib/components/discovery/query';
import { compilePaletteQuery, paletteSearchBody, readPaletteState } from '$lib/frameleaf/search-palette';

export type LibraryItemSort = 'added' | 'name' | 'rating' | 'color';

/** Boards' sort choices, in menu order; "Closest colour first" only while a colour filter is on. */
export const LIBRARY_ITEM_SORTS: readonly LibraryItemSort[] = ['added', 'name', 'rating', 'color'];

const SERVER_SORT: Record<LibraryItemSort, LibraryItemSearchSort> = {
  added: LibraryItemSearchSort.Added,
  name: LibraryItemSearchSort.Name,
  rating: LibraryItemSearchSort.Rating,
  color: LibraryItemSearchSort.Color,
};

/**
 * The sort the server can apply to this query: smart (meaning) search is always ranked by relevance,
 * and colour order needs a colour to measure against, so either falls back to Recently added.
 */
export const effectiveLibraryItemSort = (query: DiscoveryQuery, sort: LibraryItemSort): LibraryItemSort => {
  if (query.mode === 'smart') {
    return 'added';
  }
  return sort === 'color' && !query.filter.color ? 'added' : sort;
};

/** The same portable filters feed media and bookmarks; unsupported predicates must stay visible. */
export const libraryItemSearchRequest = (
  query: DiscoveryQuery,
  sort: LibraryItemSort = 'added',
  /** Only these kinds, as Boards' Links view asks for; every kind when absent. */
  kinds?: LibraryItemSearchKind[],
): LibraryItemSearchDto => {
  if (query.imageEnrichment) {
    throw new Error('Mixed library enrichment is unavailable');
  }
  const state = readPaletteState(query);
  const normalized = compilePaletteQuery(state.base, { text: state.input, filter: {} }, state.mode);
  if (!normalized) {
    throw new Error('The search exceeds the filter limit');
  }
  const body = paletteSearchBody(normalized);
  return {
    filter: body.filter,
    ...(body.query && { query: body.query }),
    ...(body.queryAssetId && { queryAssetId: body.queryAssetId }),
    mode: normalized.mode === 'smart' ? LibraryItemSearchMode.Smart : LibraryItemSearchMode.Text,
    sort: SERVER_SORT[effectiveLibraryItemSort(query, sort)],
    ...(kinds?.length && { kinds }),
    limit: 100,
  };
};
