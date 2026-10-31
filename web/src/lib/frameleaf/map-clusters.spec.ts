import type { LayerSpecification, Map as MapLibreMap } from 'maplibre-gl';
import { describe, expect, it, vi } from 'vitest';
import {
  applyClusterLabelLayout,
  BUBBLE_NAME_LAYER,
  CLUSTER_OBSTACLE_IMAGE,
  CLUSTER_OBSTACLE_LAYER,
  clusterRadius,
  isPlaceLabelLayer,
  MAP_CLUSTER_DISTANCE,
  placeLabelLayout,
  updateBubbleNames,
} from '$lib/frameleaf/map-clusters';

describe('map clusters (MapView.jsx clusterRadius, FL-147)', () => {
  it('draws a single photo as a 21px bubble', () => {
    expect(clusterRadius(1)).toBe(21);
  });

  it('grows a cluster with its count and stops at 40 items', () => {
    expect(clusterRadius(2)).toBeCloseTo(18.9);
    expect(clusterRadius(10)).toBeCloseTo(22.5);
    expect(clusterRadius(40)).toBeCloseTo(36);
    expect(clusterRadius(500)).toBeCloseTo(36);
  });

  it('groups markers within the prototype distance', () => {
    expect(MAP_CLUSTER_DISTANCE).toBe(46);
  });

  it('starts a place name 7px past its dot, in ems of its text size', () => {
    expect(placeLabelLayout(14)['text-radial-offset']).toBe(0.5);
    expect(placeLabelLayout()['text-variable-anchor'][0]).toBe('left');
  });

  const countryLayer = {
    id: 'place_country',
    type: 'symbol',
    source: 'vector',
    'source-layer': 'place',
    layout: { 'text-field': '{name}' },
  } as LayerSpecification;
  const townLayer = {
    id: 'settlements',
    type: 'symbol',
    source: 'vector',
    'source-layer': 'place',
    filter: ['==', ['get', 'class'], 'town'],
    layout: { 'text-field': '{name}' },
  } as LayerSpecification;
  const placeLayer = {
    id: 'place_city',
    type: 'symbol',
    source: 'vector',
    'source-layer': 'place',
    layout: { 'text-field': '{name}', 'text-size': 14 },
  } as LayerSpecification;
  const roadLayer = {
    id: 'road_label',
    type: 'symbol',
    source: 'vector',
    'source-layer': 'transportation_name',
    layout: { 'text-field': '{name}' },
  } as LayerSpecification;

  // The hosted Frameleaf style (Protomaps): one layer for every settlement, which already moves its
  // names around their dot below zoom 8 and centres them from there.
  const hostedLayer = {
    id: 'places_locality',
    type: 'symbol',
    source: 'protomaps',
    'source-layer': 'places',
    filter: ['==', 'kind', 'locality'],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Medium'],
      'text-variable-anchor': [
        'step',
        ['zoom'],
        ['literal', ['bottom', 'left', 'right', 'top']],
        8,
        ['literal', ['center']],
      ],
      'text-radial-offset': 0.3,
    },
    paint: { 'text-color': '#5c5c5c' },
  } as LayerSpecification;

  it('recognises the settlement names of the hosted style, and not its regions, countries or neighbourhoods', () => {
    expect(isPlaceLabelLayer(hostedLayer)).toBe(true);
    for (const [id, kind] of [
      ['places_region', 'region'],
      ['places_country', 'country'],
      ['places_subplace', 'neighbourhood'],
    ]) {
      expect(isPlaceLabelLayer({ ...hostedLayer, id, filter: ['==', 'kind', kind] } as LayerSpecification)).toBe(false);
    }
  });

  it('recognises only the base map city, town and village names', () => {
    expect(isPlaceLabelLayer(placeLayer)).toBe(true);
    expect(isPlaceLabelLayer(townLayer)).toBe(true);
    expect(isPlaceLabelLayer(countryLayer)).toBe(false);
    expect(isPlaceLabelLayer({ ...countryLayer, id: 'place_state' } as LayerSpecification)).toBe(false);
    expect(isPlaceLabelLayer({ ...countryLayer, id: 'place_continent' } as LayerSpecification)).toBe(false);
    expect(isPlaceLabelLayer(roadLayer)).toBe(false);
    expect(isPlaceLabelLayer({ id: 'bg', type: 'background' } as LayerSpecification)).toBe(false);
  });

  const fakeMap = (styleLayers = [placeLayer, countryLayer, roadLayer]) => {
    const layout = new Map<string, unknown>();
    const layers = new Set<string>();
    const images = new Set<string>();
    const sources = new Set(['geojson']);
    const map = {
      getStyle: vi.fn(() => ({ layers: styleLayers })),
      getSource: (id: string) => (sources.has(id) ? {} : undefined),
      addSource: vi.fn((id: string) => sources.add(id)),
      hasImage: (id: string) => images.has(id),
      addImage: vi.fn((id: string) => images.add(id)),
      getLayer: (id: string) => (layers.has(id) ? {} : undefined),
      addLayer: vi.fn((layer: LayerSpecification, _?: string) => layers.add(layer.id)),
      getLayoutProperty: (id: string, property: string) => layout.get(`${id}.${property}`),
      setLayoutProperty: vi.fn((id: string, property: string, value: unknown) =>
        layout.set(`${id}.${property}`, value),
      ),
    };
    return { map, layout, layers };
  };

  it('adds the bubble obstacles once and moves place names clear of them', () => {
    const { map, layout } = fakeMap();
    applyClusterLabelLayout(map as unknown as MapLibreMap, 'geojson');
    applyClusterLabelLayout(map as unknown as MapLibreMap, 'geojson');

    expect(map.addImage).toHaveBeenCalledOnce();
    expect(map.addImage.mock.calls[0][0]).toBe(CLUSTER_OBSTACLE_IMAGE);
    expect(map.addLayer).toHaveBeenCalledTimes(2);
    expect(map.addLayer.mock.calls[0][0]).toMatchObject({ id: CLUSTER_OBSTACLE_LAYER, source: 'geojson' });
    expect(layout.get('place_city.text-radial-offset')).toBe(0.5);
    expect(layout.get('road_label.text-radial-offset')).toBeUndefined();
    expect(layout.get('place_country.text-radial-offset')).toBeUndefined();
    expect(map.setLayoutProperty).toHaveBeenCalledTimes(3);
    // once applied, later style and source events return before reading the style
    expect(map.getStyle).toHaveBeenCalledOnce();
  });

  it('applies again when a new style has dropped the obstacle layer', () => {
    const { map, layers } = fakeMap();
    applyClusterLabelLayout(map as unknown as MapLibreMap, 'geojson');
    layers.clear();
    applyClusterLabelLayout(map as unknown as MapLibreMap, 'geojson');
    expect(map.addLayer).toHaveBeenCalledTimes(4);
  });

  it('adds the bubble names under the obstacles, in the wording and colours of the topmost place layer', () => {
    const { map } = fakeMap([roadLayer, townLayer, placeLayer, countryLayer]);
    applyClusterLabelLayout(map as unknown as MapLibreMap, 'geojson');

    expect(map.addSource).toHaveBeenCalledExactlyOnceWith(
      BUBBLE_NAME_LAYER,
      expect.objectContaining({ type: 'geojson' }),
    );
    const [names, before] = map.addLayer.mock.calls[1];
    expect(before).toBe(CLUSTER_OBSTACLE_LAYER);
    expect(names).toMatchObject({
      id: BUBBLE_NAME_LAYER,
      source: BUBBLE_NAME_LAYER,
      layout: { 'text-field': '{name}', 'text-size': 12, 'text-variable-anchor': ['left', 'right'] },
    });
  });

  it('leaves the names alone on a style that already moves them around their dot (the hosted one)', () => {
    const { map } = fakeMap([hostedLayer]);
    applyClusterLabelLayout(map as unknown as MapLibreMap, 'geojson');

    expect(map.setLayoutProperty).not.toHaveBeenCalled();
    expect(map.addLayer.mock.calls[1][0]).toMatchObject({
      id: BUBBLE_NAME_LAYER,
      layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Medium'] },
      paint: { 'text-color': '#5c5c5c' },
    });
  });

  it('adds no bubble names where the style has no place names to take them from', () => {
    const { map } = fakeMap([roadLayer, countryLayer]);
    applyClusterLabelLayout(map as unknown as MapLibreMap, 'geojson');
    expect(map.addLayer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: CLUSTER_OBSTACLE_LAYER }));
    expect(map.addSource).not.toHaveBeenCalled();
  });

  it('adds the obstacle layer once when adding its image re-enters from a style event (FL-51)', () => {
    const { map, layers } = fakeMap();
    // MapLibre fires "styledata" synchronously from addImage, and the screen calls this again from it
    map.addImage.mockImplementationOnce((id: string) => {
      map.hasImage = (image: string) => image === id;
      applyClusterLabelLayout(map as unknown as MapLibreMap, 'geojson');
      return new Set([id]);
    });
    // like MapLibre, a second add of the same layer is an error event
    map.addLayer.mockImplementation((layer: LayerSpecification) => {
      if (layers.has(layer.id)) {
        throw new Error(`Layer "${layer.id}" already exists on this map.`);
      }
      return layers.add(layer.id);
    });

    expect(() => applyClusterLabelLayout(map as unknown as MapLibreMap, 'geojson')).not.toThrow();
    expect(map.addLayer.mock.calls.map(([layer]) => layer.id)).toEqual([CLUSTER_OBSTACLE_LAYER, BUBBLE_NAME_LAYER]);
  });

  it('waits for the markers source', () => {
    const { map } = fakeMap();
    applyClusterLabelLayout(map as unknown as MapLibreMap, 'missing');
    expect(map.addLayer).not.toHaveBeenCalled();
  });

  describe('bubble names (MapView.jsx:230-240)', () => {
    type Spot = { geometry: { type: 'Point'; coordinates: [number, number] }; properties: Record<string, unknown> };
    const place = (name: string, x: number, y: number): Spot => ({
      geometry: { type: 'Point', coordinates: [x, y] },
      properties: { name, kind: 'locality' },
    });
    const bubble = (id: number, count: number, x: number, y: number): Spot => ({
      geometry: { type: 'Point', coordinates: [x, y] },
      properties: count > 1 ? { cluster_id: id, point_count: count } : { id: `asset-${id}` },
    });
    // coordinates are screen pixels here
    const namesMap = (state: { bubbles: Spot[]; places: Spot[]; shown: string[] }) => {
      const setData = vi.fn();
      const map = {
        getSource: (id: string) => (id === BUBBLE_NAME_LAYER ? { setData } : {}),
        getStyle: () => ({ layers: [hostedLayer] }),
        getLayer: () => ({}),
        getZoom: () => 6,
        getContainer: () => ({ clientWidth: 1000, clientHeight: 800 }),
        project: ([x, y]: [number, number]) => ({ x, y }),
        queryRenderedFeatures: () =>
          state.places.filter(({ properties }) => state.shown.includes(properties.name as string)),
        querySourceFeatures: vi.fn((id: string) => (id === 'geojson' ? state.bubbles : state.places)),
      };
      const drawn = () =>
        (setData.mock.lastCall![0].features as Spot[]).map(({ geometry, properties }) => ({
          name: properties.name,
          at: geometry.coordinates,
          offset: properties.flOffset,
        }));
      return { map: map as unknown as MapLibreMap, setData, drawn, querySourceFeatures: map.querySourceFeatures };
    };

    it('names a bubble after the nearest place the base map is not showing, starting past its edge', () => {
      const state = {
        // 10 items: a 22.5px bubble, which reaches 24px past its edge
        bubbles: [bubble(1, 10, 100, 100), bubble(1, 10, 100, 100)],
        places: [
          place('Banff', 105, 100),
          place('Calgary', 110, 100),
          place('Airdrie', 130, 100),
          place('Brooks', 147, 100),
        ],
        shown: ['Banff'],
      };
      const { map, drawn } = namesMap(state);
      updateBubbleNames(map, 'geojson');

      // Banff is nearer and already on the map; Brooks is 47px away, out of reach
      expect(drawn()).toEqual([{ name: 'Calgary', at: [100, 100], offset: (22.5 + 6 + 1) / 12 }]);
    });

    it('names nothing when no hidden place is within reach of a bubble', () => {
      const { map, setData } = namesMap({
        bubbles: [bubble(1, 1, 100, 100)],
        places: [place('Brooks', 146, 100)],
        shown: [],
      });
      updateBubbleNames(map, 'geojson');
      expect(setData).not.toHaveBeenCalled();
    });

    it('takes no name from beyond the screen, where the base map shows none either way', () => {
      const { map, setData } = namesMap({
        bubbles: [bubble(1, 10, 10, 100)],
        places: [place('Banff', -5, 100)],
        shown: [],
      });
      updateBubbleNames(map, 'geojson');
      expect(setData).not.toHaveBeenCalled();
    });

    it('gives a place to one bubble only', () => {
      const { map, drawn } = namesMap({
        bubbles: [bubble(1, 10, 100, 100), bubble(2, 10, 140, 100)],
        places: [place('Calgary', 120, 100)],
        shown: [],
      });
      updateBubbleNames(map, 'geojson');
      expect(drawn()).toHaveLength(1);
    });

    it('keeps a bubble on its name, and draws nothing again, while that place is still hidden in reach', () => {
      const state = { bubbles: [bubble(1, 10, 100, 100)], places: [place('Calgary', 120, 100)], shown: [] as string[] };
      const { map, setData, drawn } = namesMap(state);
      updateBubbleNames(map, 'geojson');
      // its own name now hides a nearer place: the bubble does not change its name for it
      state.places.push(place('Airdrie', 104, 100));
      updateBubbleNames(map, 'geojson');
      expect(setData).toHaveBeenCalledOnce();
      expect(drawn()[0].name).toBe('Calgary');

      // the base map shows Calgary again (the bubble has moved off it): the next hidden place is named
      state.shown = ['Calgary'];
      updateBubbleNames(map, 'geojson');
      expect(drawn()[0].name).toBe('Airdrie');
    });

    it('drops a name with its bubble while the map moves, and adds none until it is at rest', () => {
      const state = { bubbles: [bubble(1, 10, 100, 100)], places: [place('Calgary', 110, 100)], shown: [] as string[] };
      const { map, setData, drawn, querySourceFeatures } = namesMap(state);
      updateBubbleNames(map, 'geojson', false);
      expect(querySourceFeatures).not.toHaveBeenCalled();

      updateBubbleNames(map, 'geojson');
      expect(drawn()).toHaveLength(1);

      // zooming in splits the bubble in two
      state.bubbles = [bubble(2, 6, 90, 100), bubble(3, 4, 112, 100)];
      updateBubbleNames(map, 'geojson', false);
      expect(drawn()).toEqual([]);
      expect(setData).toHaveBeenCalledTimes(2);

      updateBubbleNames(map, 'geojson');
      expect(drawn()).toEqual([expect.objectContaining({ name: 'Calgary', at: [112, 100] })]);
    });
  });
});
