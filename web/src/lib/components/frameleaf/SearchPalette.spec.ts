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

const statisticsDto = (value: unknown) => JSON.stringify(value);

const deferredPeople = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

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
    // Recents keep the compiled query (ids, not names)
    expect(searchStore.recentSearches[0].query).toMatchObject({
      mode: 'smart',
      text: 'beach',
      filter: { personIds: { all: [JAMIE] } },
    });
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

  it('never lets a late count for an older search overwrite the newer one (FL-31)', async () => {
    let answerOld!: (value: { total: number; capped: boolean }) => void;
    sdkMock.searchSmartStatistics.mockImplementation(({ smartSearchDto }) =>
      smartSearchDto.query === 'dogs'
        ? (new Promise((resolve) => (answerOld = resolve)) as never)
        : (Promise.resolve({ total: 3, capped: false }) as never),
    );
    const { input } = setup();
    await type(input, 'dogs');
    await waitFor(() =>
      expect(sdkMock.searchSmartStatistics).toHaveBeenCalledWith(
        expect.objectContaining({ smartSearchDto: expect.objectContaining({ query: 'dogs' }) }),
        expect.anything(),
      ),
    );
    await type(input, 'cats');
    const scopes = screen.getByRole('radiogroup', { name: 'Search scope' });
    await waitFor(() => expect(within(scopes).getByRole('radio', { name: /Library/ })).toHaveTextContent('3'));

    // the aborted request for "dogs" answers last; its count is dropped
    answerOld({ total: 999, capped: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(within(scopes).getByRole('radio', { name: /Library/ })).not.toHaveTextContent('999');
    expect(within(scopes).getByRole('radio', { name: /Library/ })).toHaveTextContent('3');
  });

  it('saves the compiled search, with ids and no typed names, to the account preferences', async () => {
    const { input } = setup();
    await waitFor(() => expect(sdkMock.getMyPreferences).toHaveBeenCalled());
    await waitFor(() => expect(sdkMock.getAllPeople).toHaveBeenCalled());
    await type(input, 'person:Jamie ');
    await type(input, 'sunset');
    await fireEvent.click(screen.getByRole('button', { name: 'Save search' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save this collection' });
    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    expect(name).toHaveValue('person:Jamie sunset');
    await fireEvent.input(name, { target: { value: 'Sunsets' } });
    await fireEvent.click(within(dialog).getByRole('button', { name: /Saved search/ }));

    await waitFor(() => expect(sdkMock.updateMyPreferences).toHaveBeenCalled());
    const [{ userPreferencesUpdateDto }] = sdkMock.updateMyPreferences.mock.calls[0];
    expect(userPreferencesUpdateDto.expectedRevision).toBe('r1');
    const [saved] = userPreferencesUpdateDto.savedSearches!;
    expect(saved.name).toBe('Sunsets');
    expect(saved.query).toMatchObject({ mode: 'smart', text: 'sunset', filter: { personIds: { all: [JAMIE] } } });
    expect(JSON.stringify(saved.query)).not.toContain('Jamie');
  });

  it('opens a saved search with its chips rebuilt from the ids, and deletes one from its own button', async () => {
    sdkMock.getMyPreferences.mockResolvedValue({
      savedSearches: [
        {
          name: 'Jamie hikes',
          query: { ...emptyDiscoveryQuery(), mode: 'smart', text: 'hike', filter: { personIds: { all: [JAMIE] } } },
        },
      ],
      revision: 'r1',
    } as never);
    const { input } = setup();
    const option = await screen.findByRole('option', { name: /Jamie hikes/ });
    expect(within(option).queryByRole('button')).not.toBeInTheDocument();
    await fireEvent.click(option);
    expect(await screen.findByRole('button', { name: 'Remove Jamie' })).toBeInTheDocument();
    expect(input).toHaveValue('hike');

    await fireEvent.click(screen.getByRole('button', { name: 'Remove Jamie' }));
    await fireEvent.input(input, { target: { value: '' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Delete saved search Jamie hikes' }));
    await waitFor(() =>
      expect(sdkMock.updateMyPreferences).toHaveBeenCalledWith({
        userPreferencesUpdateDto: { savedSearches: [], expectedRevision: 'r1' },
      }),
    );
  });

  it('reads a URL search back as typed chips and keeps a legacy search unchanged until edited', async () => {
    const query: DiscoveryQuery = {
      ...emptyDiscoveryQuery(),
      text: 'IMG',
      filter: { personIds: { all: [JAMIE] }, city: { eq: 'Banff' } },
    };
    const { input, onClose } = setup(query, { unsupported: ['withDeleted'] });
    expect(await screen.findByRole('button', { name: 'Remove Jamie' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Banff' })).toBeInTheDocument();
    // The page's own text mode is kept, not replaced by smart search
    expect(screen.getByRole('button', { name: 'Search mode: Filename' })).toBeInTheDocument();
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(goto).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps arrows and Enter out of the hidden results in the Advanced view', async () => {
    const { input } = setup();
    await type(input, 'IMG');
    await screen.findByRole('option', { name: 'IMG_0002.jpg' });
    await fireEvent.click(screen.getByRole('button', { name: 'Advanced filters' }));
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).not.toHaveAttribute('aria-activedescendant');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(vi.mocked(goto).mock.calls[0][0]).toMatch(/^\/search\?dq=/);
  });

  it('removes the chip that was clicked, never a neighbour, and ignores a repeated token', async () => {
    const { input } = setup();
    await waitFor(() => expect(sdkMock.getAllPeople).toHaveBeenCalled());
    await type(input, 'place:Banff person:Jamie place:Banff ');
    expect(screen.getAllByRole('button', { name: 'Remove Banff' })).toHaveLength(1);
    await fireEvent.click(screen.getByRole('button', { name: 'Remove Banff' }));
    expect(screen.getByRole('button', { name: 'Remove Jamie' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Banff' })).not.toBeInTheDocument();
  });
  it('drops a person chip that stops resolving after a lock, without ever showing the name', async () => {
    const { input } = setup();
    await waitFor(() => expect(sdkMock.getAllPeople).toHaveBeenCalled());
    await type(input, 'person:Jamie place:Banff ');
    expect(await screen.findByRole('button', { name: 'Remove Jamie' })).toBeInTheDocument();
    const people = deferredPeople();
    sdkMock.getAllPeople.mockReturnValue(people.promise as never);
    sdkMock.searchAssetStatistics.mockClear();
    eventManager.emit('SessionLocked');
    // Held back at once: no Jamie chip, greyed or not, while the vocabulary reloads
    await waitFor(() => expect(screen.queryByText(/Jamie/)).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Remove Banff' })).toBeInTheDocument();
    people.resolve({ people: [], total: 0, hidden: 0, hasNextPage: false });
    expect(await screen.findByText("A filter that's no longer available was removed.")).toBeInTheDocument();
    expect(screen.queryByText(/Jamie/)).not.toBeInTheDocument();
    await waitFor(() => expect(sdkMock.searchAssetStatistics).toHaveBeenCalled());
    const bodies = sdkMock.searchAssetStatistics.mock.calls.map(([{ statisticsSearchDto }]) =>
      statisticsDto(statisticsSearchDto),
    );
    expect(bodies.every((body) => !body.includes(JAMIE) && !body.includes('person:Jamie'))).toBe(true);
  });

  it('brings a person chip back after an unlock when the person still resolves', async () => {
    const { input } = setup();
    await waitFor(() => expect(sdkMock.getAllPeople).toHaveBeenCalled());
    await type(input, 'person:Jamie ');
    expect(await screen.findByRole('button', { name: 'Remove Jamie' })).toBeInTheDocument();
    const calls = sdkMock.getAllPeople.mock.calls.length;
    eventManager.emit('SessionAccessChanged', { isElevated: true });
    await waitFor(() => expect(sdkMock.getAllPeople.mock.calls.length).toBeGreaterThan(calls));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Jamie' })).toBeInTheDocument());
    expect(screen.queryByText(/no longer available/)).not.toBeInTheDocument();
  });
});
