import { LibraryAssetItemKind, LibraryBookmarkItemKind, LibraryScope, type BookmarkResponseDto } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { assetFactory } from '@test-data/factories/asset-factory';
import { libraryGridEntries } from './library-grid-items';

const bookmark: BookmarkResponseDto = {
  id: 'same-id',
  ownerId: 'owner',
  title: 'Reference',
  url: 'https://example.com',
  note: null,
  previewAssetId: null,
  rating: null,
  libraryScope: LibraryScope.Design,
  createdAt: '2026-10-28T00:00:00Z',
  updatedAt: '2026-10-28T00:00:00Z',
  updateId: 'update',
  deletedAt: null,
  isArchived: false,
  isLocked: false,
};

describe('mixed library grid identities', () => {
  it('keeps links as bookmarks and separates identical UUIDs across kinds', () => {
    const asset = assetFactory.build({ id: bookmark.id });
    const entries = libraryGridEntries([
      { kind: LibraryAssetItemKind.Asset, asset },
      { kind: LibraryBookmarkItemKind.Bookmark, bookmark },
    ]);
    expect(entries.map((entry) => entry.key)).toEqual(['same-id', 'bookmark:same-id']);
    expect(entries[0]).toMatchObject({ kind: 'asset', asset: { id: 'same-id' } });
    expect(entries[1]).toEqual({ kind: 'bookmark', key: 'bookmark:same-id', bookmark });
    expect(entries[1]).not.toHaveProperty('asset');
  });
});
