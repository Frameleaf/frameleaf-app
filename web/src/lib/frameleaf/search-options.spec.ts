import { LibraryViewScope, SearchSuggestionType } from '@frameleaf/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { loadFilterPanelOptions, loadPaletteCount, sharedSearchSuggestions } from '$lib/frameleaf/search-options';
import { invalidateTags } from '$lib/frameleaf/tag-store';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { albumFactory } from '@test-data/factories/album-factory';

beforeEach(() => {
  // nothing kept from the test before
  eventManager.emit('AuthLogout');
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
  expect(sdkMock.getAllAlbums).toHaveBeenCalledWith({ libraryScope: LibraryViewScope.Design });
  expect(result.albums[1]).toEqual({ value: 'child', label: 'Brand / Packaging' });
});

/** FL-1802 */
describe('filter panel vocabularies kept for the session', () => {
  const requests = () =>
    [
      sdkMock.getAllPeople,
      sdkMock.getAllPets,
      sdkMock.getAllTags,
      sdkMock.getAllAlbums,
      sdkMock.getSearchSuggestions,
      sdkMock.getVisitedLandmarks,
      sdkMock.getUserPlaces,
    ].reduce((sum, mock) => sum + mock.mock.calls.length, 0);

  it('asks nothing the second time the panel opens', async () => {
    sdkMock.getAllTags.mockResolvedValue([{ id: 't1', value: 'Travel' }] as never);
    const first = await loadFilterPanelOptions();
    const asked = requests();
    expect(asked).toBeGreaterThan(0);

    const second = await loadFilterPanelOptions();
    expect(requests()).toBe(asked);
    expect(second).toEqual(first);
    expect(second.tags).toEqual([{ value: 't1', label: 'Travel' }]);
  });

  it('keeps each workspace its own albums', async () => {
    await loadFilterPanelOptions();
    await loadFilterPanelOptions(undefined, LibraryViewScope.Design);
    await loadFilterPanelOptions(undefined, LibraryViewScope.Design);
    expect(sdkMock.getAllAlbums.mock.calls).toEqual([[{}], [{ libraryScope: LibraryViewScope.Design }]]);
  });

  it('reads the tags again after a tag changes, and nothing else', async () => {
    await loadFilterPanelOptions();
    sdkMock.getAllTags.mockResolvedValue([{ id: 't2', value: 'Family' }] as never);
    invalidateTags();
    const options = await loadFilterPanelOptions();
    expect(options.tags).toEqual([{ value: 't2', label: 'Family' }]);
    expect(sdkMock.getAllTags).toHaveBeenCalledTimes(2);
    expect(sdkMock.getAllPeople).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an album is created', () => eventManager.emit('AlbumCreate', albumFactory.build()), 2, 1],
    ['an album is renamed', () => eventManager.emit('AlbumUpdate', albumFactory.build()), 2, 1],
    ['a person is renamed', () => eventManager.emit('PersonUpdate', { id: 'p1' } as never), 1, 2],
    ['the session is locked', () => eventManager.emit('SessionLocked'), 2, 2],
  ])('reads what changed again after %s', async (_name, change, albums, people) => {
    await loadFilterPanelOptions();
    change();
    await loadFilterPanelOptions();
    expect(sdkMock.getAllAlbums).toHaveBeenCalledTimes(albums);
    expect(sdkMock.getAllPeople).toHaveBeenCalledTimes(people);
  });

  it('shows what could be read when one vocabulary fails, asks for that one again and keeps the rest', async () => {
    sdkMock.getAllPets.mockRejectedValueOnce(new Error('unavailable'));
    sdkMock.getAllAlbums.mockResolvedValue([albumFactory.build({ id: 'a', albumName: 'Trips' })]);
    const first = await loadFilterPanelOptions();
    expect(first.pets).toEqual([]);
    expect(first.albums).toEqual([{ value: 'a', label: 'Trips' }]);

    await loadFilterPanelOptions();
    expect(sdkMock.getAllPets).toHaveBeenCalledTimes(2);
    expect(sdkMock.getAllAlbums).toHaveBeenCalledTimes(1);
  });

  it('gives a caller that has gone its abort, and keeps the answer for the next one', async () => {
    const controller = new AbortController();
    const waiting = loadFilterPanelOptions(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBeDefined();
    await loadFilterPanelOptions();
    expect(sdkMock.getAllPeople).toHaveBeenCalledTimes(1);
  });

  it('asks for the pages of people after the first together', async () => {
    const page = (names: string[], hasNextPage: boolean) => ({
      people: names.map((name) => ({ id: name, name })),
      hasNextPage,
      hidden: 0,
      total: 5,
    });
    let open = 0;
    let most = 0;
    sdkMock.getAllPeople.mockImplementation((({ page: number }: { page: number }) => {
      open++;
      most = Math.max(most, open);
      return new Promise((resolve) =>
        setTimeout(() => {
          open--;
          resolve([page(['a', 'b'], true), page(['c', 'd'], true), page(['e'], false)][number - 1]);
        }, 5),
      );
    }) as never);

    const options = await loadFilterPanelOptions();
    expect(options.people.map(({ id }) => id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(sdkMock.getAllPeople).toHaveBeenCalledTimes(3);
    expect(most).toBe(2);
  });
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

  it('lets an aborted caller go at once and keeps the answer for the next caller', async () => {
    const answer = pending();
    const controller = new AbortController();
    const waiting = sharedSearchSuggestions(SearchSuggestionType.City, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBeDefined();
    answer(['Paris']);
    await expect(sharedSearchSuggestions(SearchSuggestionType.City)).resolves.toEqual(['Paris']);
    expect(sdkMock.getSearchSuggestions).toHaveBeenCalledOnce();
  });

  it('asks once more after a failed read', async () => {
    sdkMock.getSearchSuggestions.mockRejectedValueOnce(new Error('offline'));
    await expect(sharedSearchSuggestions(SearchSuggestionType.City)).rejects.toThrow('offline');
    sdkMock.getSearchSuggestions.mockResolvedValue(['Paris']);
    await expect(sharedSearchSuggestions(SearchSuggestionType.City)).resolves.toEqual(['Paris']);
  });

  it('never hands a request started before sign-out to the next account', () => {
    pending();
    sharedSearchSuggestions(SearchSuggestionType.Country).catch(() => {});
    eventManager.emit('AuthLogout');
    sharedSearchSuggestions(SearchSuggestionType.Country).catch(() => {});
    expect(sdkMock.getSearchSuggestions).toHaveBeenCalledTimes(2);
  });
});
