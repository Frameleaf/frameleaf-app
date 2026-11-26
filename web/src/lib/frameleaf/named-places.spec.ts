import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { formatRadius, isPlaceNameTaken, placeAtPoint, radiusAt, radiusStep } from '$lib/frameleaf/named-places';
import { namedPlaces } from '$lib/frameleaf/named-places.svelte';
import { loadFilterPanelOptions } from '$lib/frameleaf/search-options';
import { emptyPaletteCatalog, parseSearchInput, suggestSearchTokens } from '$lib/frameleaf/search-palette';
import { authManager } from '$lib/managers/auth-manager.svelte';

vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { isSharedLink: false, authenticated: true, captureSession: () => () => true },
}));

const shared = (value: boolean) => ((authManager as { isSharedLink: boolean }).isSharedLink = value);

describe('named places (FL-1019)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shared(false);
    namedPlaces.reset();
    sdkMock.getUserPlaces.mockResolvedValue([]);
  });

  it('never asks for the list on a shared link', async () => {
    shared(true);
    sdkMock.getAllPeople.mockResolvedValue({ people: [], hasNextPage: false } as never);
    sdkMock.getAllPets.mockResolvedValue([]);
    sdkMock.getAllTags.mockResolvedValue([]);
    sdkMock.getAllAlbums.mockResolvedValue([]);
    sdkMock.getSearchSuggestions.mockResolvedValue([]);
    sdkMock.getVisitedLandmarks.mockResolvedValue([]);
    await namedPlaces.load();
    const options = await loadFilterPanelOptions();

    expect(sdkMock.getUserPlaces).not.toHaveBeenCalled();
    expect(options.namedPlaces).toEqual([]);
  });

  it('moves the slider through its stops from 25 m to 5 km', () => {
    expect(radiusAt(-1)).toBe(25);
    expect(radiusAt(99)).toBe(5000);
    expect(radiusStep(260)).toBe(radiusStep(250));
    expect(formatRadius(500, 'en')).toBe('500 m');
    expect(formatRadius(1500, 'en')).toBe('1.5 km');
  });

  it('finds the nearest circle holding a point, and compares names ignoring capitals', () => {
    const near = { id: 'a', name: 'Garden', latitude: 10, longitude: 20, radiusMeters: 100 };
    const far = { id: 'b', name: 'Home', latitude: 10.001, longitude: 20, radiusMeters: 1000 };

    expect(placeAtPoint([far, near], { latitude: 10, longitude: 20 }, 16)?.id).toBe('a');
    expect(placeAtPoint([near], { latitude: 11, longitude: 20 }, 16)).toBeUndefined();
    expect(isPlaceNameTaken([near], ' garden ')).toBe(true);
    expect(isPlaceNameTaken([near], 'garden', 'a')).toBe(false);
  });

  it('offers named places first for place:, and filters by their id', () => {
    const catalog = {
      ...emptyPaletteCatalog(),
      places: [{ value: 'Grenoble', count: 50 }],
      namedPlaces: [{ id: 'p1', name: "Grandma's cabin" }],
    };

    const [first, second] = suggestSearchTokens('place:gr', catalog);
    expect(first).toMatchObject({ label: "Grandma's cabin", yourPlace: true });
    expect(second).toMatchObject({ label: 'Grenoble' });
    expect(parseSearchInput('place:"Grandma\'s cabin"', catalog).filter).toEqual({ namedPlaceIds: { any: ['p1'] } });
    expect(parseSearchInput('-place:"Grandma\'s cabin"', catalog).filter).toEqual({ namedPlaceIds: { none: ['p1'] } });
  });
});
