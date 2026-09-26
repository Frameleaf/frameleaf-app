import type { ServerConfigDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import MapScreen from '$lib/components/frameleaf/MapScreen.svelte';
import { getMapLibreStubProps, resetMapLibreStub } from '@test-data/frameleaf/map-libre-stub';
import en from '../../../../../i18n/en.json';

/**
 * FL-193: the map's offline/unavailable state must appear even when the style or its tiles fail
 * before the map ever finishes its first load — not only once loaded once. `<MapLibre>` is mocked
 * out (`MapLibreStub`) so this can fire the same `error` event maplibre-gl fires for an unreachable
 * style host, and confirm the fix (attaching `onerror` when the map is created, not inside `onload`)
 * actually catches it.
 */

vi.mock('maplibre-gl', () => ({
  addProtocol: vi.fn(),
  setWorkerUrl: vi.fn(),
  LngLatBounds: class {
    extend() {
      return this;
    }
  },
}));
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: 'blob:mock-worker' }));
vi.mock('pmtiles', () => ({
  Protocol: class {
    tile = () => {};
  },
}));
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
vi.mock('@immich/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@immich/ui')>();
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
});
