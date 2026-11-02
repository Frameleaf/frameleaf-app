import { LibraryViewScope, SearchSuggestionType } from '@frameleaf/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { loadFilterPanelOptions, loadPaletteCount, sharedSearchSuggestions } from '$lib/frameleaf/search-options';
import { eventManager } from '$lib/managers/event-manager.svelte';
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

describe('sharedSearchSuggestions', () => {
  const pending = () => {
    let resolve!: (value: string[]) => void;
    sdkMock.getSearchSuggestions.mockImplementation(() => new Promise<string[]>((done) => (resolve = done)) as never);
    return (value: string[]) => resolve(value);
  };

  it('asks once for callers that overlap', async () => {
    const answer = pending();
    const first = sharedSearchSuggestions(SearchSuggestionType.City);
    const second = sharedSearchSuggestions(SearchSuggestionType.City);
    answer(['Paris']);
    await expect(Promise.all([first, second])).resolves.toEqual([['Paris'], ['Paris']]);
    expect(sdkMock.getSearchSuggestions).toHaveBeenCalledOnce();
  });

  it('lets an aborted caller go at once and aborts the request when no caller is left', async () => {
    pending();
    const controller = new AbortController();
    const waiting = sharedSearchSuggestions(SearchSuggestionType.City, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBeDefined();
    const requestSignal = (sdkMock.getSearchSuggestions.mock.calls[0][1] as { signal: AbortSignal }).signal;
    expect(requestSignal.aborted).toBe(true);
    // a later caller starts a fresh request instead of joining the stalled one
    sharedSearchSuggestions(SearchSuggestionType.City).catch(() => {});
    expect(sdkMock.getSearchSuggestions).toHaveBeenCalledTimes(2);
  });

  it('never hands a request started before sign-out to the next account', () => {
    pending();
    sharedSearchSuggestions(SearchSuggestionType.Country).catch(() => {});
    eventManager.emit('AuthLogout');
    sharedSearchSuggestions(SearchSuggestionType.Country).catch(() => {});
    expect(sdkMock.getSearchSuggestions).toHaveBeenCalledTimes(2);
  });
});
