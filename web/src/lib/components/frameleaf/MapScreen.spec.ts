import type { ServerConfigDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import MapScreen from '$lib/components/frameleaf/MapScreen.svelte';
import { mapSettings } from '$lib/stores/preferences.store';
import { getMapLibreStubProps, resetMapLibreStub, setMapLibreStubMap } from '@test-data/frameleaf/map-libre-stub';
import en from '../../../../../i18n/en.json';

/**
 * FL-193: the map's offline/unavailable state must appear even when the style or its tiles fail
 * before the map ever finishes its first load — not only once loaded once. `<MapLibre>` is mocked
 * out (`MapLibreStub`) so this can fire the same `error` event maplibre-gl fires for an unreachable
 * style host, and confirm the fix (attaching `onerror` when the map is created, not inside `onload`)
 * actually catches it.
 */

vi.mock('maplibre-gl', () => ({
  setWorkerUrl: vi.fn(),
  LngLatBounds: class {
    extend() {
      return this;
    }
  },
}));
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: 'blob:mock-worker' }));
vi.mock('svelte-maplibre', async () => ({
  MapLibre: (await import('@test-data/frameleaf/MapLibreStub.svelte')).default,
  AttributionControl: (await import('@test-data/frameleaf/MapLibreChildStub.svelte')).default,
  GeoJSON: (await import('@test-data/frameleaf/MapLibreChildStub.svelte')).default,
  MarkerLayer: (await import('@test-data/frameleaf/MapLibreChildStub.svelte')).default,
}));
vi.mock('$lib/managers/server-config-manager.svelte', () => ({
  serverConfigManager: {
    value: {
      mapLightStyleUrl: 'https://tiles.frameleaf.cloud/v1/style/light.json',
      mapDarkStyleUrl: 'https://tiles.frameleaf.cloud/v1/style/dark.json',
    } as ServerConfigDto,
  },
}));
vi.mock('@frameleaf/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@frameleaf/ui')>();
  return { ...actual, themeManager: { value: actual.Theme.Light } };
});

beforeEach(() => {
  vi.clearAllMocks();
  resetMapLibreStub();
  addMessages('dev', en);
  sdkMock.getMapMarkers.mockResolvedValue([]);
  sdkMock.getMapStatistics.mockResolvedValue({ archived: 0, partner: 0, unlocated: 0 });
});

describe('MapScreen (FL-193)', () => {
  it('shows the offline state when the style fails before the map ever loads', async () => {
    render(MapScreen, { title: 'Map', onOpenAsset: vi.fn() });

    expect(screen.queryByText(en.frameleaf_map_tiles_failed_title)).not.toBeInTheDocument();

    // The map's `load` event never fires for a style that failed outright, so this simulates the
    // startup failure the way maplibre-gl reports it: an `error` with no prior `load`.
    const { onerror } = getMapLibreStubProps();
    onerror?.({ error: new Error('style fetch failed') });

    await waitFor(() => expect(screen.getByText(en.frameleaf_map_tiles_failed_title)).toBeInTheDocument());
    expect(screen.getByText(en.frameleaf_map_tiles_failed_help)).toBeInTheDocument();
  });

  it('ignores a geojson source error, which is not a style or tile failure', async () => {
    render(MapScreen, { title: 'Map', onOpenAsset: vi.fn() });

    const { onerror } = getMapLibreStubProps();
    onerror?.({ error: new Error('boom'), sourceId: 'geojson' });

    await Promise.resolve();
    expect(screen.queryByText(en.frameleaf_map_tiles_failed_title)).not.toBeInTheDocument();
  });

  it('recovers once "Try again" is used after a failure', async () => {
    render(MapScreen, { title: 'Map', onOpenAsset: vi.fn() });

    const { onerror } = getMapLibreStubProps();
    onerror?.({ error: new Error('style fetch failed') });
    await waitFor(() => expect(screen.getByText(en.frameleaf_map_tiles_failed_title)).toBeInTheDocument());

    await fireEvent.click(screen.getByText(en.frameleaf_map_try_again));

    await waitFor(() => expect(screen.queryByText(en.frameleaf_map_tiles_failed_title)).not.toBeInTheDocument());
  });

  it('says the located items could not be loaded, with a retry, instead of an empty map', async () => {
    sdkMock.getMapMarkers.mockRejectedValueOnce(new Error('offline'));
    render(MapScreen, { title: 'Map', onOpenAsset: vi.fn() });

    // No "0 in view" before there is an answer
    expect(screen.getByText(en.frameleaf_map_finding)).toBeInTheDocument();
    expect(await screen.findByText(en.frameleaf_map_load_failed_title)).toBeInTheDocument();
    expect(screen.queryByText(en.frameleaf_map_empty_title)).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_map_try_again }));
    await waitFor(() => expect(screen.queryByText(en.frameleaf_map_load_failed_title)).not.toBeInTheDocument());
    expect(sdkMock.getMapMarkers).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(en.frameleaf_map_empty_title)).toBeInTheDocument();
  });

  it('keeps the In view list in step with the view when the style never loads (FL-51)', async () => {
    sdkMock.getMapMarkers.mockResolvedValue([
      { id: 'a0000000-0000-4000-8000-000000000001', lat: 10, lon: 50, city: 'Here', state: null, country: null },
    ]);
    let [west, east] = [-10, 10];
    setMapLibreStubMap({
      getBounds: () => ({
        getWest: () => west,
        getEast: () => east,
        contains: ([lon]: [number, number]) => lon >= west && lon <= east,
      }),
      getZoom: () => 3,
      fitBounds: vi.fn(),
      setStyle: vi.fn(),
    });
    render(MapScreen, { title: 'Map', onOpenAsset: vi.fn() });
    await waitFor(() => expect(screen.getByText('0 items in view')).toBeInTheDocument());

    // the style failed, so `load` never fires; a move must still re-count what is in view
    const { onerror, onmoveend } = getMapLibreStubProps();
    onerror?.({ error: new Error('style fetch failed') });
    [west, east] = [40, 60];
    onmoveend?.({});

    await waitFor(() => expect(screen.getByText('1 item in view')).toBeInTheDocument());
  });

  it('draws the In view list a page at a time for a large library (FL-139)', async () => {
    let reachEnd: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      vi.fn(function (callback: typeof reachEnd) {
        reachEnd = callback;
        return { observe: vi.fn(), disconnect: vi.fn(), unobserve: vi.fn(), takeRecords: vi.fn() };
      }),
    );
    sdkMock.getMapMarkers.mockResolvedValue(
      Array.from({ length: 300 }, (_, index) => ({
        id: `a0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        lat: 10,
        lon: 0,
        city: 'Here',
        state: null,
        country: null,
      })),
    );
    setMapLibreStubMap({
      getBounds: () => ({ getWest: () => -10, getEast: () => 10, contains: () => true }),
      getZoom: () => 3,
      fitBounds: vi.fn(),
      setStyle: vi.fn(),
    });
    mapSettings.update((settings) => ({ ...settings, showAssetPanel: true }));
    const { container } = render(MapScreen, { title: 'Map', onOpenAsset: vi.fn() });
    getMapLibreStubProps().onmoveend?.({});
    const rows = () => container.querySelectorAll('button.row').length;

    await waitFor(() => expect(screen.getByText('300 items in view')).toBeInTheDocument());
    expect(rows()).toBe(120);

    reachEnd?.([{ isIntersecting: true }]);
    await waitFor(() => expect(rows()).toBe(240));
    vi.unstubAllGlobals();
    mapSettings.update((settings) => ({ ...settings, showAssetPanel: false }));
  });
});
