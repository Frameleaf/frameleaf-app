import type { PlacesResponseDto, SearchLandmarkResponseDto, UserPlaceResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import MapSearch from '$lib/components/frameleaf/MapSearch.svelte';
import { foldPlaceName, mapSearchRowArea, MAP_SEARCH_DEBOUNCE_MS, zoomForRadius } from '$lib/frameleaf/map-search';
import en from '../../../../../i18n/en.json';

const place = (id: string, name: string): UserPlaceResponseDto => ({
  id,
  name,
  latitude: 51.42,
  longitude: -116.18,
  radiusMeters: 500,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const landmark = (id: string, name: string, assetCount = 7) =>
  ({
    id,
    name,
    assetCount,
    kind: 'national_park',
    city: 'Banff',
    state: 'Alberta',
    country: 'Canada',
    latitude: 51.41,
    longitude: -116.21,
    radiusM: 2000,
  }) as SearchLandmarkResponseDto;

const city = (name: string, extra: Partial<PlacesResponseDto> = {}): PlacesResponseDto => ({
  name,
  admin1name: 'Alberta',
  latitude: 51.42,
  longitude: -116.17,
  ...extra,
});

const setup = (props: Partial<{ countIn: () => number | undefined }> = {}) => {
  const onFly = vi.fn();
  const onShowPhotos = vi.fn();
  const onNameNew = vi.fn();
  render(MapSearch, {
    places: [place('p1', 'The lookout'), place('p2', 'Home')],
    landmarks: [landmark('Q1', 'Lake Louise')],
    onFly,
    onShowPhotos,
    onNameNew,
    ...props,
  });
  return { onFly, onShowPhotos, onNameNew, box: screen.getByRole('combobox') as HTMLInputElement };
};

const type = async (box: HTMLInputElement, value: string) => {
  await fireEvent.focus(box);
  await fireEvent.input(box, { target: { value } });
  await vi.advanceTimersByTimeAsync(MAP_SEARCH_DEBOUNCE_MS);
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  addMessages('dev', en);
  sdkMock.searchPlaces.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MapSearch (FL-1027)', () => {
  it('lists the person’s places when focused and empty, without asking the server', async () => {
    const { box } = setup();
    await fireEvent.focus(box);

    expect(box).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('option').map((row) => within(row).getByText(/lookout|Home/).textContent)).toEqual([
      'The lookout',
      'Home',
    ]);
    expect(screen.getByText(en.frameleaf_map_search_hint)).toBeInTheDocument();
    expect(sdkMock.searchPlaces).not.toHaveBeenCalled();
  });

  it('waits 250 ms and sends only the last query', async () => {
    const { box } = setup();
    await fireEvent.input(box, { target: { value: 'l' } });
    await vi.advanceTimersByTimeAsync(MAP_SEARCH_DEBOUNCE_MS - 1);
    await fireEvent.input(box, { target: { value: 'lo' } });
    await vi.advanceTimersByTimeAsync(MAP_SEARCH_DEBOUNCE_MS - 1);
    expect(sdkMock.searchPlaces).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(sdkMock.searchPlaces).toHaveBeenCalledTimes(1);
    expect(sdkMock.searchPlaces).toHaveBeenCalledWith({ name: 'lo' }, expect.anything());
  });

  it('groups results with the person’s places first', async () => {
    sdkMock.searchPlaces.mockResolvedValue([city('Lake Louise')]);
    const { box } = setup();
    await type(box, 'lo');

    const groups = screen.getAllByRole('group');
    expect(groups.map((group) => within(group).getAllByRole('presentation')[0].textContent?.trim())).toEqual([
      en.frameleaf_named_places_yours,
      en.frameleaf_map_search_landmarks,
      en.frameleaf_map_search_cities,
    ]);
    expect(within(groups[0]).getByText('The lookout')).toBeInTheDocument();
    expect(within(groups[1]).getByText('Banff, Canada')).toBeInTheDocument();
    expect(within(groups[2]).getByText('Alberta')).toBeInTheDocument();
  });

  it('names a town in the person’s language when the server has it, and in English when not', async () => {
    sdkMock.searchPlaces.mockResolvedValue([
      city('Munich', {
        admin1name: 'Bavaria',
        placeNamesLocalized: { city: 'München', state: 'Bayern', country: 'Deutschland', lang: 'de' },
      }),
      city('Dachau', { admin1name: 'Bavaria' }),
    ]);
    const { box } = setup();
    await type(box, 'mun');

    expect(screen.getByText('München')).toBeInTheDocument();
    expect(screen.getByText('Bayern, Deutschland')).toBeInTheDocument();
    expect(screen.getByText('Dachau')).toBeInTheDocument();
    expect(screen.getByText('Bavaria')).toBeInTheDocument();
    expect(screen.getByText('Place names in Deutsch')).toBeInTheDocument();
  });

  it('moves with the arrow keys, wraps, and flies to the row on Enter', async () => {
    sdkMock.searchPlaces.mockResolvedValue([city('Lake Louise')]);
    const { box, onFly } = setup();
    await type(box, 'lo');
    const [first, second, third] = screen.getAllByRole('option');

    expect(box).toHaveAttribute('aria-activedescendant', first.id);
    await fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box).toHaveAttribute('aria-activedescendant', second.id);
    expect(second).toHaveAttribute('aria-selected', 'true');
    await fireEvent.keyDown(box, { key: 'ArrowUp' });
    await fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(box).toHaveAttribute('aria-activedescendant', third.id);
    await fireEvent.keyDown(box, { key: 'ArrowUp' });

    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(onFly).toHaveBeenCalledWith(expect.objectContaining({ group: 'landmarks', name: 'Lake Louise' }));
    expect(box.value).toBe('Lake Louise');
    expect(box).toHaveAttribute('aria-expanded', 'false');
  });

  it('offers the photos at the picked place through the area search', async () => {
    const { box, onShowPhotos } = setup();
    await type(box, 'lake');
    await fireEvent.click(screen.getByRole('option'));

    expect(screen.getByText('7 items here')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_map_search_show_photos }));
    expect(onShowPhotos).toHaveBeenCalledWith(
      expect.objectContaining({ west: expect.any(Number), south: expect.any(Number) }),
    );
  });

  it('switches "Show photos here" off where there are none', async () => {
    const { box } = setup({ countIn: () => 0 });
    await type(box, 'home');
    await fireEvent.click(screen.getByRole('option'));

    expect(screen.getByText(en.frameleaf_map_search_no_items)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.frameleaf_map_search_show_photos })).toBeDisabled();
  });

  it('keeps "Show photos here" on when the count is not known', async () => {
    const { box } = setup({ countIn: () => undefined });
    await type(box, 'home');
    await fireEvent.click(screen.getByRole('option'));

    expect(screen.getByRole('button', { name: en.frameleaf_map_search_show_photos })).toBeEnabled();
  });

  it('closes on Escape, then clears on the next', async () => {
    const { box } = setup();
    await type(box, 'lo');

    await fireEvent.keyDown(box, { key: 'Escape' });
    expect(box).toHaveAttribute('aria-expanded', 'false');
    expect(box.value).toBe('lo');

    await fireEvent.keyDown(box, { key: 'Escape' });
    expect(box.value).toBe('');
  });

  it('says when nothing matches, and offers to name the place', async () => {
    const { box, onNameNew } = setup();
    await type(box, 'Atlantis');

    expect(screen.getByText('No place matches “Atlantis”')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_named_places_name_this }));
    expect(onNameNew).toHaveBeenCalled();
  });

  it('does not call a failed search "no match", and can try again', async () => {
    sdkMock.searchPlaces.mockRejectedValueOnce(new Error('offline'));
    const { box } = setup();
    await type(box, 'Atlantis');

    expect(screen.getByRole('alert')).toHaveTextContent(en.frameleaf_map_search_failed);
    expect(screen.queryByText('No place matches “Atlantis”')).not.toBeInTheDocument();

    sdkMock.searchPlaces.mockResolvedValueOnce([city('Atlantis')]);
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_map_try_again }));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByRole('option')).toHaveTextContent('Atlantis');
  });

  it('ignores an answer to a query that has since changed', async () => {
    let answer: (places: PlacesResponseDto[]) => void = () => {};
    sdkMock.searchPlaces.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const { box } = setup();
    await type(box, 'old');
    await fireEvent.input(box, { target: { value: 'new' } });

    answer([city('Old town')]);
    await vi.advanceTimersByTimeAsync(MAP_SEARCH_DEBOUNCE_MS);
    expect(screen.queryByText('Old town')).not.toBeInTheDocument();
  });
});

describe('map search helpers (FL-1027)', () => {
  it('ignores case and accents but keeps kana marks', () => {
    expect(foldPlaceName(' München ')).toBe('munchen');
    expect(foldPlaceName('ガ')).not.toBe(foldPlaceName('カ'));
  });

  it('comes closer for a smaller place, within limits', () => {
    expect(zoomForRadius(51, 200)).toBeGreaterThan(zoomForRadius(51, 5000));
    expect(zoomForRadius(51, 1)).toBe(16);
    expect(zoomForRadius(51, 5_000_000)).toBe(9);
  });

  it('wraps an area across the date line', () => {
    const area = mapSearchRowArea({
      id: 'x',
      group: 'cities',
      name: 'Taveuni',
      latitude: -16.8,
      longitude: 179.99,
      zoom: 11,
      radiusMeters: 15_000,
    });
    expect(area.west).toBeGreaterThan(area.east);
    expect(area.east).toBeLessThan(-179);
  });
});
