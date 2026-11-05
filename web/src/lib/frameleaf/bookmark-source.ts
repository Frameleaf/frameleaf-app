import type { AssetSourceResponseDto, BookmarkResponseDto } from '@frameleaf/sdk';

/**
 * Where a saved link came from: the server's `CaptureSourceDto`, sent as `source` in the owner's own
 * read of a bookmark (`GET /bookmarks/:id`). Typed here until the SDK is regenerated; the field is
 * optional, so an older server (or the redacted search projection) simply leaves it out.
 */
export type BookmarkCaptureSource = {
  captureId: string;
  pageUrl: string;
  mediaUrl?: string | null;
  title: string;
  capturedAt: string;
  note?: string | null;
  creator?: string | null;
  licenseUrl?: string | null;
};

export type BookmarkWithSource = BookmarkResponseDto & { source?: BookmarkCaptureSource | null };

/** The link's source in the shape the Source section reads (`AssetSources`); none when it has none. */
export const bookmarkSources = (bookmark: BookmarkWithSource): AssetSourceResponseDto[] =>
  bookmark.source
    ? [
        {
          ...bookmark.source,
          id: bookmark.source.captureId,
          assetId: '',
          createdAt: bookmark.source.capturedAt,
          importedFrom: null,
        },
      ]
    : [];
