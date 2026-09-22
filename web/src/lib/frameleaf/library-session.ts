import type { MetadataSearchDto, SmartSearchDto } from '@immich/sdk';
import type { TimelineManagerOptions } from '$lib/managers/timeline-manager/types';

/** Supported production scopes; a picker targets an album but queries the library. */
export type LibraryTimelineScope =
  | { kind: 'library' }
  | { kind: 'album'; id: string }
  | { kind: 'album-picker'; id: string }
  | { kind: 'map'; bbox: string };

export type LibrarySearchTerms = MetadataSearchDto & Pick<SmartSearchDto, 'query' | 'queryAssetId'>;

/** Endpoint-specific variants retain their real paging/filter contracts instead of converting scopes. */
export type LibraryQuery =
  | {
      scope: LibraryTimelineScope;
      filters: Omit<TimelineManagerOptions, 'albumId' | 'timelineAlbumId' | 'bbox'>;
    }
  | {
      scope: { kind: 'search' };
      search: { kind: 'metadata' | 'smart'; terms: LibrarySearchTerms } | { kind: 'ask'; query: string };
    };

export type LibrarySearchQuery = Extract<LibraryQuery, { scope: { kind: 'search' } }>;
export type LibraryTimelineQuery = Exclude<LibraryQuery, LibrarySearchQuery>;

/** Adapt the existing portable URL terms without dropping any supported structured filters. */
export function librarySearchQuery({
  terms,
  ask,
  smartSearch,
  askSearch,
}: {
  terms: LibrarySearchTerms;
  ask: string;
  smartSearch: boolean;
  askSearch: boolean;
}): LibrarySearchQuery | null {
  if (Object.keys(terms).length > 0) {
    const kind = smartSearch && ('query' in terms || 'queryAssetId' in terms) ? 'smart' : 'metadata';
    return { scope: { kind: 'search' }, search: { kind, terms } };
  }
  return askSearch && ask.trim() ? { scope: { kind: 'search' }, search: { kind: 'ask', query: ask.trim() } } : null;
}

export function libraryTimelineOptions({ scope, filters }: LibraryTimelineQuery): TimelineManagerOptions {
  switch (scope.kind) {
    case 'library': {
      return { ...filters };
    }
    case 'album': {
      return { ...filters, albumId: scope.id };
    }
    case 'album-picker': {
      return { ...filters, timelineAlbumId: scope.id };
    }
    case 'map': {
      return { ...filters, bbox: scope.bbox };
    }
  }
}
