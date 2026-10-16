import { render } from '@testing-library/svelte';
import type { Feature, Point } from 'geojson';
import { tick } from 'svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { deferredPromise } from '@test-data/deferred';
import { setMapLibreStubMap } from '@test-data/frameleaf/map-libre-stub';
import MapComponent from './Map.svelte';

const layers = vi.hoisted(() => ({
  cluster: undefined as ((event: unknown) => void) | undefined,
  asset: undefined as ((event: unknown) => void) | undefined,
}));
vi.mock('$app/navigation', () => ({ afterNavigate: vi.fn() }));
vi.mock('maplibre-gl', () => ({
  setWorkerUrl: vi.fn(),
  LngLatBounds: class {
    extend() {
      return this;
    }
  },
}));
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: 'mock-worker' }));
vi.mock('svelte-maplibre', async () => {
  const empty = (await import('@test-data/frameleaf/EmptyStub.svelte')).default;
  return {
    MapLibre: (await import('@test-data/frameleaf/EmbeddedMapFixture.svelte')).default,
    GeoJSON: (await import('@test-data/mocks/UserPageLayout.mock.svelte')).default,
    MarkerLayer: (_anchor: unknown, props: { applyToClusters: boolean; onclick: (event: unknown) => void }) => {
      if (props.applyToClusters) {
        layers.cluster = props.onclick;
      } else {
        layers.asset = props.onclick;
      }
    },
    AttributionControl: empty,
    Control: empty,
    ControlButton: empty,
    ControlGroup: empty,
    GeolocateControl: empty,
    NavigationControl: empty,
    Popup: empty,
    ScaleControl: empty,
  };
});
vi.mock('$lib/managers/server-config-manager.svelte', () => ({
  serverConfigManager: { value: { mapLightStyleUrl: 'style', mapDarkStyleUrl: 'dark' } },
}));
class FakeMap {
  source = { getClusterLeaves: vi.fn() };
  getSource() {
    return this.source;
  }
  setStyle = vi.fn();
}
const event = (id: string | number) => ({ feature: { properties: { id, cluster_id: id } } });
const leaf = (id: string): Feature<Point> => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [0, 0] },
  properties: { id },
});
beforeEach(() => {
  layers.cluster = undefined;
  layers.asset = undefined;
  authManager.reset();
});

it('selects current cluster leaves with the existing limit', async () => {
  const map = new FakeMap();
  map.source.getClusterLeaves.mockResolvedValue([leaf('a'), leaf('b')]);
  setMapLibreStubMap(map);
  const onSelect = vi.fn();
  render(MapComponent, { onSelect });
  layers.cluster!(event(1));
  await tick();
  expect(map.source.getClusterLeaves).toHaveBeenCalledWith(1, 10_000, 0);
  expect(onSelect).toHaveBeenCalledWith(['a', 'b']);
});

it.each(['close', 'session', 'new cluster', 'single asset', 'markers', 'source'] as const)(
  'ignores a cluster reply after %s',
  async (change) => {
    const pending = deferredPromise<Feature<Point>[]>();
    const map = new FakeMap();
    map.source.getClusterLeaves.mockReturnValueOnce(pending.promise).mockResolvedValueOnce([leaf('new')]);
    setMapLibreStubMap(map);
    const onSelect = vi.fn();
    const view = render(MapComponent, { onSelect });
    layers.cluster!(event(1));
    switch (change) {
      case 'close': {
        view.unmount();
        break;
      }
      case 'session': {
        authManager.reset();
        break;
      }
      case 'new cluster': {
        layers.cluster!(event(2));
        break;
      }
      case 'single asset': {
        layers.asset!(event('single'));
        break;
      }
      case 'source': {
        map.source = { getClusterLeaves: vi.fn() };
        break;
      }
      default: {
        await view.rerender({
          onSelect,
          mapMarkers: [{ id: 'replacement', lat: 1, lon: 2, city: null, state: null, country: null }],
        });
      }
    }
    await tick();
    pending.resolve([leaf('old')]);
    await pending.promise;
    await tick();
    expect(onSelect).not.toHaveBeenCalledWith(['old']);
    if (change === 'new cluster') {
      expect(onSelect).toHaveBeenCalledWith(['new']);
    } else if (change === 'single asset') {
      expect(onSelect).toHaveBeenCalledWith(['single']);
    }
  },
);
