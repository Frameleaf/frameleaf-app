import type { LayerSpecification, Map as MapLibreMap } from 'maplibre-gl';
import { describe, expect, it, vi } from 'vitest';
import {
  applyClusterLabelLayout,
  CLUSTER_OBSTACLE_IMAGE,
  CLUSTER_OBSTACLE_LAYER,
  clusterRadius,
  isPlaceLabelLayer,
  MAP_CLUSTER_DISTANCE,
  placeLabelLayout,
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

  it('recognises only the base map place-name layers', () => {
    expect(isPlaceLabelLayer(placeLayer)).toBe(true);
    expect(isPlaceLabelLayer(roadLayer)).toBe(false);
    expect(isPlaceLabelLayer({ id: 'bg', type: 'background' } as LayerSpecification)).toBe(false);
  });

  const fakeMap = () => {
    const layout = new Map<string, unknown>();
    const layers = new Set<string>();
    const images = new Set<string>();
    const map = {
      getStyle: () => ({ layers: [placeLayer, roadLayer] }),
      getSource: (id: string) => (id === 'geojson' ? {} : undefined),
      hasImage: (id: string) => images.has(id),
      addImage: vi.fn((id: string) => images.add(id)),
      getLayer: (id: string) => (layers.has(id) ? {} : undefined),
      addLayer: vi.fn((layer: LayerSpecification) => layers.add(layer.id)),
      getLayoutProperty: (id: string, property: string) => layout.get(`${id}.${property}`),
      setLayoutProperty: vi.fn((id: string, property: string, value: unknown) =>
        layout.set(`${id}.${property}`, value),
      ),
    };
    return { map, layout };
  };

  it('adds the bubble obstacles once and moves place names clear of them', () => {
    const { map, layout } = fakeMap();
    applyClusterLabelLayout(map as unknown as MapLibreMap, 'geojson');
    applyClusterLabelLayout(map as unknown as MapLibreMap, 'geojson');

    expect(map.addImage).toHaveBeenCalledOnce();
    expect(map.addImage.mock.calls[0][0]).toBe(CLUSTER_OBSTACLE_IMAGE);
    expect(map.addLayer).toHaveBeenCalledOnce();
    expect(map.addLayer.mock.calls[0][0]).toMatchObject({ id: CLUSTER_OBSTACLE_LAYER, source: 'geojson' });
    expect(layout.get('place_city.text-radial-offset')).toBe(0.5);
    expect(layout.get('road_label.text-radial-offset')).toBeUndefined();
    expect(map.setLayoutProperty).toHaveBeenCalledTimes(3);
  });

  it('waits for the markers source', () => {
    const { map } = fakeMap();
    applyClusterLabelLayout(map as unknown as MapLibreMap, 'missing');
    expect(map.addLayer).not.toHaveBeenCalled();
  });
});
