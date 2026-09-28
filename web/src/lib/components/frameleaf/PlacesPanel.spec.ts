import type { AssetResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { PlacesGroupBy, placesViewSettings } from '$lib/stores/preferences.store';
import en from '../../../../../i18n/en.json';
import PlacesPanel from './PlacesPanel.svelte';

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

describe('PlacesPanel (FL-51)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => placesViewSettings.set({ groupBy: PlacesGroupBy.CountryState, collapsedGroups: {} }));

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

  it('has an empty state for a library without places', () => {
    render(PlacesPanel, { places: [], counts: new Map(), unplaced: 0 });
    expect(screen.getByText('No places yet')).toBeInTheDocument();
    expect(screen.getByText('Where your photos and videos were taken')).toBeInTheDocument();
  });
});
