import type { AssetResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { confirmFrameleaf } from '$lib/frameleaf/confirm';
import { buildLandmarkCards } from '$lib/frameleaf/landmarks';
import { namedPlaces } from '$lib/frameleaf/named-places.svelte';
import { PlacesGroupBy, placesViewSettings } from '$lib/stores/preferences.store';
import en from '../../../../../i18n/en.json';
import PlacesPanel from './PlacesPanel.svelte';

vi.mock('$lib/frameleaf/confirm', () => ({ confirmFrameleaf: vi.fn() }));

const place = (id: string, city: string, state: string | null, country: string | null) =>
  ({
    id,
    exifInfo: { city, state, country, latitude: 10, longitude: 20 },
  }) as unknown as AssetResponseDto;

const places = [
  place('a', 'Lisbon', 'Lisboa', 'Portugal'),
  place('b', 'Sintra', 'Lisboa', 'Portugal'),
  place('c', 'Kyoto', null, 'Japan'),
];
const counts = new Map([
  ['Lisbon', 12],
  ['Sintra', 5],
  ['Kyoto', 30],
]);

const landmarks = buildLandmarkCards([
  {
    id: 'Q173882',
    name: 'Belém Tower',
    kind: 'tower',
    latitude: 38.6916,
    longitude: -9.216,
    radiusM: 100,
    assetCount: 7,
    firstTakenAt: '2026-05-01T10:00:00.000Z',
    lastTakenAt: '2026-05-01T12:00:00.000Z',
    coverAssetId: 'tower-cover',
    city: 'Lisbon',
    state: 'Lisboa',
    country: 'Portugal',
  },
]);

describe('PlacesPanel (FL-51)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    placesViewSettings.set({ groupBy: PlacesGroupBy.CountryState, collapsedGroups: {} });
    sdkMock.getUserPlaces.mockResolvedValue([]);
    sdkMock.searchAssetStatistics.mockResolvedValue({ total: 3 } as never);
    namedPlaces.reset();
  });

  it('summarises the places and groups them by country and state with their counts', () => {
    render(PlacesPanel, { places, counts, unplaced: 4 });
    expect(screen.getByText('3 places · 47 items with a location · 4 without a location')).toBeInTheDocument();

    const portugal = screen.getByRole('region', { name: 'Portugal' });
    expect(within(portugal).getByRole('button', { name: /Portugal/ })).toHaveAttribute('aria-expanded', 'true');
    expect(within(portugal).getByRole('link', { name: 'Lisboa, 17 items. View all' })).toHaveAttribute(
      'href',
      expect.stringContaining('/search'),
    );
    expect(within(portugal).getByRole('link', { name: 'Lisbon, 12 items' })).toBeInTheDocument();
    expect(within(portugal).getByRole('link', { name: 'Show Lisbon on the map' })).toHaveAttribute(
      'href',
      expect.stringContaining('/map'),
    );
    expect(screen.getByRole('region', { name: 'Japan' })).toBeInTheDocument();
  });

  it('lists a visited landmark under the region its photos were taken in (FL-354)', () => {
    render(PlacesPanel, { places, counts, landmarks, unplaced: null });

    const portugal = within(screen.getByRole('region', { name: 'Portugal' }));
    const card = portugal.getByRole('link', { name: 'Belém Tower, Tower, 7 items' });
    expect(card).toHaveAttribute('href', expect.stringContaining('landmarkIds'));
    expect(portugal.getByRole('link', { name: 'Show Belém Tower on the map' })).toHaveAttribute(
      'href',
      expect.stringContaining('/map#14/38.6916/-9.216'),
    );
    expect(within(screen.getByRole('region', { name: 'Japan' })).queryByText('Landmarks & attractions')).toBeNull();
  });

  it('finds a landmark by name, keeping its region open though none of its towns match', async () => {
    render(PlacesPanel, { places, counts, landmarks, unplaced: null });
    await fireEvent.input(screen.getByRole('searchbox', { name: 'Find a place' }), { target: { value: 'belem' } });

    const portugal = within(screen.getByRole('region', { name: 'Portugal' }));
    expect(portugal.getByRole('link', { name: 'Belém Tower, Tower, 7 items' })).toBeInTheDocument();
    expect(portugal.queryByRole('link', { name: 'Lisbon, 12 items' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Japan' })).toBeNull();
  });

  it('lists landmarks after the towns when places are not grouped', () => {
    placesViewSettings.set({ groupBy: PlacesGroupBy.None, collapsedGroups: {} });
    render(PlacesPanel, { places, counts, landmarks, unplaced: null });

    const section = within(screen.getByRole('region', { name: 'Landmarks & attractions' }));
    expect(section.getByRole('link', { name: 'Belém Tower, Tower, 7 items' })).toBeInTheDocument();
  });

  it('finds a place and says when nothing matches', async () => {
    render(PlacesPanel, { places, counts, unplaced: null });
    const search = screen.getByRole('searchbox', { name: 'Find a place' });

    await fireEvent.input(search, { target: { value: 'kyo' } });
    expect(screen.queryByRole('region', { name: 'Portugal' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Kyoto, 30 items' })).toBeInTheDocument();

    await fireEvent.input(search, { target: { value: 'nowhere' } });
    expect(screen.getByText('No places match “nowhere”')).toBeInTheDocument();
  });

  it('collapses a country and shows every place in one grid when not grouped', async () => {
    render(PlacesPanel, { places, counts, unplaced: null });
    await fireEvent.click(screen.getByRole('button', { name: /^Portugal/ }));
    expect(screen.queryByRole('link', { name: 'Lisbon, 12 items' })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Group by country' }));
    const all = screen.getByRole('region', { name: 'All places' });
    expect(
      within(all)
        .getAllByRole('link', { name: /items$/ })
        .map((link) => link.getAttribute('aria-label')),
    ).toEqual(['Kyoto, 30 items', 'Lisbon, 12 items', 'Sintra, 5 items']);
  });

  // FL-1412 (M13): the one empty-page pattern, the icon above the words, and nothing to find or group.
  it('has an empty state for a library without places, and no controls', () => {
    render(PlacesPanel, { places: [], counts: new Map(), unplaced: 0 });
    const empty = screen.getByTestId('frameleaf-empty-state');
    expect(within(empty).getByRole('heading', { name: 'No places yet' })).toBeInTheDocument();
    expect(empty).toHaveTextContent('Photos that know where they were taken are grouped here by country and region.');
    expect(empty.firstElementChild).toHaveClass('icon', 'framed');
    expect(empty.querySelector('button, a')).toBeNull();
    expect(screen.getByText('Where your photos and videos were taken')).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Group by country' })).toBeNull();
  });

  describe('Your places (FL-1019)', () => {
    const home = {
      id: 'b0000000-0000-4000-8000-000000000001',
      name: 'Home',
      latitude: 10,
      longitude: 20,
      radiusMeters: 1500,
      createdAt: '2026-11-22T00:00:00.000Z',
      updatedAt: '2026-11-22T00:00:00.000Z',
    };

    it('lists a place with where it is, its reach, its count and its actions', async () => {
      sdkMock.getUserPlaces.mockResolvedValue([home]);
      render(PlacesPanel, { places, counts, unplaced: 0 });

      const section = await screen.findByRole('region', { name: 'Your places' });
      expect(await within(section).findByText('Home')).toBeInTheDocument();
      expect(within(section).getByText('Only you see these names.')).toBeInTheDocument();
      expect(within(section).getByText(/reaches 1\.5 km/)).toBeInTheDocument();
      expect(await within(section).findByText('3 items')).toBeInTheDocument();
      expect(sdkMock.searchAssetStatistics).toHaveBeenCalledWith({
        statisticsSearchDto: { filter: { namedPlaceIds: { any: [home.id] } } },
      });
      expect(within(section).getByRole('link', { name: 'Show Home on the map' })).toHaveAttribute(
        'href',
        '/map#14/10/20',
      );
      expect(within(section).getByRole('button', { name: 'Change Home' })).toBeInTheDocument();
    });

    it('says when nothing is named yet, and offers the map', async () => {
      render(PlacesPanel, { places, counts, unplaced: 0 });

      expect(await screen.findByText('No named places yet')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Name a place' })).toHaveAttribute('href', '/map?naming=1');
    });

    it('deletes a place only once confirmed', async () => {
      sdkMock.getUserPlaces.mockResolvedValue([home]);
      sdkMock.deleteUserPlace.mockResolvedValue(undefined as never);
      vi.mocked(confirmFrameleaf).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      render(PlacesPanel, { places, counts, unplaced: 0 });

      const remove = await screen.findByRole('button', { name: 'Delete Home' });
      await fireEvent.click(remove);
      await vi.waitFor(() => expect(confirmFrameleaf).toHaveBeenCalledTimes(1));
      expect(sdkMock.deleteUserPlace).not.toHaveBeenCalled();

      await fireEvent.click(remove);
      await vi.waitFor(() => expect(sdkMock.deleteUserPlace).toHaveBeenCalledWith({ id: home.id }));
      expect(await screen.findByText('“Home” deleted. Its photos keep their location.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Delete Home' })).toBeNull();
    });
  });
});
