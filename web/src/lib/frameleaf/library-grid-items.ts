import { LibraryAssetItemKind, type BookmarkResponseDto, type LibraryItemDto } from '@frameleaf/sdk';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
import { toTimelineAsset } from '$lib/utils/timeline-util';

export type LibraryGridEntry =
  | { kind: 'asset'; key: string; asset: TimelineAsset }
  | { kind: 'bookmark'; key: string; bookmark: BookmarkResponseDto };

/** Signed-in mixed results keep their kind; bookmark IDs never reach a media action. */
export const libraryGridEntries = (items: LibraryItemDto[]): LibraryGridEntry[] =>
  items.map((item) => {
    if (item.kind !== LibraryAssetItemKind.Asset) {
      return { kind: 'bookmark', key: `bookmark:${item.bookmark.id}`, bookmark: item.bookmark };
    }
    if (!('ownerId' in item.asset)) {
      throw new Error('The signed-in library requires an authorized asset record');
    }
    return { kind: 'asset', key: item.asset.id, asset: toTimelineAsset(item.asset) };
  });
