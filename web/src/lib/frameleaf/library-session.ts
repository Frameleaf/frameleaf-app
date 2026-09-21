import type { TimelineManagerOptions } from '$lib/managers/timeline-manager/types';

/** Supported production scopes; a picker targets an album but queries the library. */
export type LibraryTimelineScope =
  | { kind: 'library' }
  | { kind: 'album'; id: string }
  | { kind: 'album-picker'; id: string }
  | { kind: 'map'; bbox: string };

export type LibraryTimelineQuery = {
  scope: LibraryTimelineScope;
  // Keep the complete existing endpoint contract, including date/order/privacy and local asset filters.
  filters: Omit<TimelineManagerOptions, 'albumId' | 'timelineAlbumId' | 'bbox'>;
};

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
