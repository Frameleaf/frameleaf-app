import { LibraryViewScope } from '@frameleaf/sdk';
import { beforeEach, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { loadFilterPanelOptions, loadPaletteCount } from '$lib/frameleaf/search-options';
import { albumFactory } from '@test-data/factories/album-factory';

beforeEach(() => {
  vi.resetAllMocks();
  sdkMock.getAllPeople.mockResolvedValue({ people: [], hasNextPage: false, hidden: 0, total: 0 });
  sdkMock.getAllPets.mockResolvedValue([]);
  sdkMock.getAllTags.mockResolvedValue([]);
  sdkMock.getAllAlbums.mockResolvedValue([]);
  sdkMock.getSearchSuggestions.mockResolvedValue([]);
  sdkMock.getVisitedLandmarks.mockResolvedValue([]);
});
it('loads album vocabulary for the selected workspace with nested names', async () => {
  sdkMock.getAllAlbums.mockResolvedValue([
    albumFactory.build({ id: 'root', albumName: 'Brand' }),
    albumFactory.build({ id: 'child', albumName: 'Packaging', parentId: 'root' }),
  ]);
  const result = await loadFilterPanelOptions(undefined, LibraryViewScope.Design);
  expect(sdkMock.getAllAlbums).toHaveBeenCalledWith({ libraryScope: LibraryViewScope.Design }, { signal: undefined });
  expect(result.albums[1]).toEqual({ value: 'child', label: 'Brand / Packaging' });
});

it('counts mixed Design matches through the shared library endpoint, including bookmark-only results', async () => {
  sdkMock.searchLibraryItems.mockResolvedValue({ count: 3, countCapped: false, items: [], nextCursor: null });
  expect(
    await loadPaletteCount(
      { filter: { libraryScope: LibraryViewScope.Design, text: { contains: 'packaging' } } },
      false,
    ),
  ).toEqual({ total: 3, capped: false });
  expect(sdkMock.searchLibraryItems).toHaveBeenCalledWith(
    {
      libraryItemSearchDto: {
        filter: { libraryScope: LibraryViewScope.Design, text: { contains: 'packaging' } },
        mode: 'text',
        limit: 1,
      },
    },
    { signal: undefined },
  );
  expect(sdkMock.searchAssetStatistics).not.toHaveBeenCalled();
});
