import { AssetTypeEnum, SearchFacetField, type AssetResponseDto } from '@immich/sdk';
import { fireEvent, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { emptyDiscoveryQuery, type DiscoveryQuery } from '$lib/components/discovery/query';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { searchStore } from '$lib/stores/search.svelte';
import { renderWithTooltips } from '$tests/helpers';
import SearchPalette from './SearchPalette.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { smartSearch: true, search: true } },
}));

const JAMIE = '00000000-0000-4000-8000-000000000001';
const UNNAMED = '00000000-0000-4000-8000-000000000003';
const ALBUM = '00000000-0000-4000-8000-000000000020';

const person = (id: string, name: string) =>
  ({
    id,
    name,
    thumbnailPath: '/thumb',
    updatedAt: '2026-01-01T00:00:00.000Z',
    isHidden: false,
    assetCount: 1,
    lastSeenAt: null,
  }) as never;

const asset = (id: string, name: string) =>
  ({
    id,
    originalFileName: name,
    type: AssetTypeEnum.Image,
    thumbhash: null,
    localDateTime: '2026-08-12T10:00:00.000Z',
    exifInfo: { city: 'Banff' },
  }) as unknown as AssetResponseDto;

const searchResponse = (items: AssetResponseDto[]) => ({
  albums: { total: 0, count: 0, items: [], facets: [] },
  assets: { total: items.length, count: items.length, items, facets: [], nextPage: null, nextCursor: null },
});

describe('SearchPalette', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
    Element.prototype.scrollIntoView ??= () => {};
    // The Advanced view's pickers position their lists against the visual viewport
    vi.stubGlobal('visualViewport', null);
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(goto).mockResolvedValue();
    searchStore.recentSearches = [];
    localStorage.clear();
    sdkMock.getAllPeople.mockResolvedValue({
      people: [person(JAMIE, 'Jamie'), person(UNNAMED, '')],
      total: 2,
      hidden: 0,
      hasNextPage: false,
    });
    sdkMock.getAllPets.mockResolvedValue([]);
    sdkMock.getAllTags.mockResolvedValue([]);
    sdkMock.getAllAlbums.mockResolvedValue([{ id: ALBUM, albumName: 'Summer trip' }] as never);
    sdkMock.getSearchSuggestions.mockImplementation(({ $type }) =>
      Promise.resolve($type === 'city' ? ['Banff'] : $type === 'camera-make' ? ['Sony'] : []),
    );
    sdkMock.searchFacets.mockResolvedValue({
      total: 42,
      facets: [
        { fieldName: SearchFacetField.People, counts: [{ value: JAMIE, label: 'Jamie', count: 12 }] },
        { fieldName: SearchFacetField.City, counts: [{ value: 'Banff', count: 30 }] },
        {
          fieldName: SearchFacetField.Type,
          counts: [
            { value: 'IMAGE', count: 40 },
            { value: 'VIDEO', count: 2 },
          ],
        },
      ],
    });
    sdkMock.searchHistogram.mockResolvedValue({
      granularity: 'month' as never,
      total: 42,
      buckets: [
        { date: '2026-06-01', count: 10 },
        { date: '2026-08-01', count: 32 },
      ],
    });
    sdkMock.searchAssetStatistics.mockResolvedValue({ total: 42 });
    sdkMock.searchSmartStatistics.mockResolvedValue({ total: 1000, capped: true });
    sdkMock.searchAssets.mockResolvedValue(searchResponse([asset('a1', 'IMG_0001.jpg')]) as never);
    sdkMock.searchSmart.mockResolvedValue(searchResponse([asset('a2', 'IMG_0002.jpg')]) as never);
    sdkMock.getMyPreferences.mockResolvedValue({ savedSearches: [], revision: 'r1' } as never);
    sdkMock.updateMyPreferences.mockImplementation(({ userPreferencesUpdateDto }) =>
      Promise.resolve({ savedSearches: userPreferencesUpdateDto.savedSearches, revision: 'r2' } as never),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = (query: DiscoveryQuery = emptyDiscoveryQuery(), props: Record<string, unknown> = {}) => {
    const onClose = vi.fn();
    const onOpenPalette = vi.fn();
    renderWithTooltips(SearchPalette, { query, onClose, onOpenPalette, ...props });
    return { onClose, onOpenPalette, input: screen.getByRole('combobox', { name: 'Search query' }) };
  };

  const type = (input: HTMLElement, value: string) => fireEvent.input(input, { target: { value } });

  it('turns a completed operator into a removable chip and searches with the structured filter', async () => {
    const { input } = setup();
    await waitFor(() => expect(sdkMock.getAllPeople).toHaveBeenCalled());
    await waitFor(() => expect(sdkMock.searchFacets).toHaveBeenCalled());

    await type(input, 'person:Jamie ');
    expect(await screen.findByRole('button', { name: 'Remove Jamie' })).toBeInTheDocument();
    expect(input).toHaveValue('');

    await waitFor(() =>
      expect(sdkMock.searchAssets).toHaveBeenCalledWith(
        {
          metadataSearchDto: expect.objectContaining({
            filter: expect.objectContaining({ personIds: { all: [JAMIE] } }),
            size: 12,
          }),
        },
        expect.anything(),
      ),
    );
    expect(await screen.findByRole('option', { name: 'IMG_0001.jpg' })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Remove Jamie' }));
    expect(screen.queryByRole('button', { name: 'Remove Jamie' })).not.toBeInTheDocument();
  });

  it('suggests named people with counts and completes the first suggestion with Tab', async () => {
    const { input } = setup();
    await waitFor(() => expect(sdkMock.searchFacets).toHaveBeenCalledTimes(2));
    await type(input, 'person:');
    const list = screen.getByRole('listbox', { name: 'Search results' });
    const option = await within(list).findByRole('option', { name: /Jamie/ });
    expect(option).toHaveTextContent('12');
    // Unnamed people have no name to type
    expect(
      within(list)
        .getAllByRole('option')
        .filter((item) => item.textContent?.includes('person:')),
    ).toHaveLength(1);

    await fireEvent.keyDown(input, { key: 'Tab' });
    expect(await screen.findByRole('button', { name: 'Remove Jamie' })).toBeInTheDocument();
  });

  it('shows scope counts for the collection and the entire library, capped for smart search', async () => {
    const query: DiscoveryQuery = { ...emptyDiscoveryQuery(), filter: { albumIds: { any: [ALBUM] } } };
    const { input } = setup(query);
    const scopes = screen.getByRole('radiogroup', { name: 'Search scope' });
    expect(await within(scopes).findByRole('radio', { name: /Summer trip/ })).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(within(scopes).getByRole('radio', { name: /Summer trip/ })).toHaveTextContent('42'));

    await type(input, 'dogs');
    await waitFor(() =>
      expect(within(scopes).getByRole('radio', { name: /Entire library/ })).toHaveTextContent('1,000+'),
    );
    const libraryCall = sdkMock.searchSmartStatistics.mock.calls.find(
      ([{ smartSearchDto }]) => !smartSearchDto.filter?.albumIds,
    );
    expect(libraryCall?.[0].smartSearchDto.query).toBe('dogs');

    await fireEvent.click(within(scopes).getByRole('radio', { name: /Entire library/ }));
    expect(within(scopes).getByRole('radio', { name: /Entire library/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('narrows to a histogram bar by adding after/before chips', async () => {
    setup();
    const bar = await screen.findByRole('button', { name: /Aug 2026, 32 matches/ });
    await fireEvent.click(bar);
    expect(await screen.findByRole('button', { name: 'Remove After 2026-07-31' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Before 2026-09-01' })).toBeInTheDocument();
    // The empty month between the buckets reads as a gap
    expect(screen.getByRole('button', { name: /Jul 2026, 0 matches/ })).toBeDisabled();
  });

  it('replaces a typed chip when the Advanced view picks the same field, and remembers the view', async () => {
    const { input } = setup();
    await type(input, 'type:video ');
    expect(await screen.findByRole('button', { name: 'Remove Videos' })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Advanced filters' }));
    expect(localStorage.getItem('frameleaf.search.advanced')).toBe('1');
    const panel = screen.getByRole('complementary', { name: 'Library filters' });
    await fireEvent.click(within(panel).getByRole('button', { name: /^Photos/ }));

    expect(screen.queryByRole('button', { name: 'Remove Videos' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(sdkMock.searchAssetStatistics).toHaveBeenLastCalledWith(
        {
          statisticsSearchDto: expect.objectContaining({ filter: expect.objectContaining({ type: { eq: 'IMAGE' } }) }),
        },
        expect.anything(),
      ),
    );
  });

  it('hands a leading ">" to the command palette', async () => {
    const { input, onOpenPalette } = setup();
    await type(input, '>theme');
    expect(onOpenPalette).toHaveBeenCalledWith('>theme');
  });

  it('shows all results on Enter and remembers the search with its chips', async () => {
    const { input, onClose } = setup();
    await waitFor(() => expect(sdkMock.getAllPeople).toHaveBeenCalled());
    await type(input, 'person:Jamie ');
    await type(input, 'beach');
    await fireEvent.keyDown(input, { key: 'Enter' });

    expect(goto).toHaveBeenCalledTimes(1);
    const url = new URL(vi.mocked(goto).mock.calls[0][0] as string, 'http://localhost');
    expect(url.pathname).toBe('/search');
    const query = JSON.parse(url.searchParams.get('dq')!) as DiscoveryQuery;
    expect(query).toMatchObject({ mode: 'smart', text: 'beach', filter: { personIds: { all: [JAMIE] } } });
    expect(searchStore.recentSearches[0]).toMatchObject({ input: 'person:Jamie beach', mode: 'smart' });
    expect(onClose).toHaveBeenCalled();
  });

  it('drops every count and asks again when the session is locked', async () => {
    setup();
    await waitFor(() => expect(sdkMock.searchAssetStatistics).toHaveBeenCalled());
    const before = sdkMock.getAllPeople.mock.calls.length;
    sdkMock.searchAssetStatistics.mockResolvedValue({ total: 7 });
    eventManager.emit('SessionLocked');
    await waitFor(() => expect(sdkMock.getAllPeople.mock.calls.length).toBeGreaterThan(before));
    const scopes = screen.getByRole('radiogroup', { name: 'Search scope' });
    await waitFor(() => expect(within(scopes).getByRole('radio', { name: /Library/ })).toHaveTextContent('7'));
  });

  it('saves a search to the account preferences', async () => {
    const { input } = setup();
    await waitFor(() => expect(sdkMock.getMyPreferences).toHaveBeenCalled());
    await type(input, 'sunset');
    await fireEvent.click(screen.getByRole('button', { name: 'Save search' }));
    const name = screen.getByRole('textbox', { name: 'Name' });
    await fireEvent.input(name, { target: { value: 'Sunsets' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(sdkMock.updateMyPreferences).toHaveBeenCalledWith({
        userPreferencesUpdateDto: {
          expectedRevision: 'r1',
          savedSearches: [
            expect.objectContaining({
              name: 'Sunsets',
              query: expect.objectContaining({ palette: { input: 'sunset', mode: 'smart' } }),
            }),
          ],
        },
      }),
    );
  });
});
