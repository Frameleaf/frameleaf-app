import { LibraryItemSearchMode, LibraryItemSearchSort, type LibraryItemSearchDto } from '@frameleaf/sdk';
import type { DiscoveryQuery } from '$lib/components/discovery/query';
import { compilePaletteQuery, paletteSearchBody, readPaletteState } from '$lib/frameleaf/search-palette';

/** The same portable filters feed media and bookmarks; unsupported predicates must stay visible. */
export const libraryItemSearchRequest = (
  query: DiscoveryQuery,
  sort: 'added' | 'color' = 'added',
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
    sort: sort === 'color' ? LibraryItemSearchSort.Color : LibraryItemSearchSort.Added,
    limit: 100,
  };
};
