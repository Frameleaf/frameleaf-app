import type { Feature, Point } from 'geojson';
import type {
  ExpressionSpecification,
  GeoJSONSource,
  LayerSpecification,
  Map as MapLibreMap,
  SymbolLayerSpecification,
} from 'maplibre-gl';

/**
 * Cluster bubbles and place labels from the prototype's map (`MapView.jsx:104-105, 230-240`,
 * FL-147).
 *
 * A bubble's radius grows with its count and stops growing at 40 items; a single photo is a 21px
 * bubble. Place names start just past their dot and, where a bubble sits over the place, past the
 * bubble's edge, so a name is never drawn underneath a cluster.
 *
 * The base map draws its own names and the bubbles are HTML over it, so this takes three parts: an
 * invisible obstacle per bubble, which hides the base map's names underneath it; the nearest hidden
 * name drawn again at the bubble's edge; and, on styles that leave it to us, the 7px offset.
 */

/** Grouping distance in screen pixels (`clusterAssets(..., { radius: 46 })` on the interactive map). */
export const MAP_CLUSTER_DISTANCE = 46;

const SINGLE_RADIUS = 21;
const BASE_RADIUS = 18;
const PER_ITEM = 0.45;
const COUNT_CAP = 40;
/** A name starts this far past a bubble's edge (`bubble.x + clusterRadius(bubble) + 6`). */
const LABEL_GAP = 6;
/** …and this far past its own place dot when no bubble is in the way (`p.x + 7`). */
export const PLACE_LABEL_OFFSET_PX = 7;
/** A place this close to a bubble's edge is named at the bubble (`clusterRadius(c) + 24`). */
const BUBBLE_NAME_REACH = 24;
/** `.map-labels text` in map-view.css is 11px, and 12px for the largest places. */
const BUBBLE_NAME_SIZE = 12;

/** A bubble's radius in pixels for `count` items (`MapView.jsx` `clusterRadius`). */
export const clusterRadius = (count: number) =>
  count <= 1 ? SINGLE_RADIUS : BASE_RADIUS + Math.min(count, COUNT_CAP) * PER_ITEM;

/** The obstacle layer that keeps place names clear of the (HTML) bubbles drawn over them. */
export const CLUSTER_OBSTACLE_LAYER = 'fl-cluster-obstacles';
export const CLUSTER_OBSTACLE_IMAGE = 'fl-cluster-obstacle';
/** The obstacle image is a transparent square of this many pixels, scaled per bubble. */
export const CLUSTER_OBSTACLE_IMAGE_SIZE = 64;

/** `clusterRadius` as a style expression over the clustered source's `point_count`. */
const radiusExpression: ExpressionSpecification = [
  'case',
  ['has', 'point_count'],
  ['+', BASE_RADIUS, ['*', PER_ITEM, ['min', ['get', 'point_count'], COUNT_CAP]]],
  SINGLE_RADIUS,
];

/**
 * An invisible icon the size of each bubble plus the label gap, placed at the bubble. It takes part
 * in symbol collision (and is drawn above the base map's labels, so it is placed first), which moves
 * a place name to another side of its dot, or hides it, rather than letting it run under a bubble.
 */
export const clusterObstacleLayer = (source: string): LayerSpecification => ({
  id: CLUSTER_OBSTACLE_LAYER,
  type: 'symbol',
  source,
  layout: {
    'icon-image': CLUSTER_OBSTACLE_IMAGE,
    'icon-size': ['/', ['*', 2, ['+', LABEL_GAP, radiusExpression]], CLUSTER_OBSTACLE_IMAGE_SIZE],
    'icon-allow-overlap': true,
    'icon-ignore-placement': false,
    // the image is the whole obstacle: MapLibre's default 2px around it would hold the bubble's own
    // name off as well
    'icon-padding': 0,
  },
  paint: { 'icon-opacity': 0 },
});

/** The layer and the source of the names drawn at a bubble's edge. */
export const BUBBLE_NAME_LAYER = 'fl-bubble-names';

const SETTLEMENT = /\b(city|town|village|locality)\b|_(city|town|village|locality)/i;
const REGION = /country|state|continent|province|region/i;
const PLACE_SOURCE_LAYERS = new Set(['place', 'places']);

/**
 * The base map's settlement names: the city, town and village layers of an OpenMapTiles `place`
 * source layer, by id or by their `class` filter, and the `locality` layer of a Protomaps `places`
 * one (the hosted Frameleaf style). The prototype only moves the names of places, which sit where
 * photos cluster; country, state and continent names are left where the style puts them.
 */
export const isPlaceLabelLayer = (layer: LayerSpecification): layer is SymbolLayerSpecification =>
  layer.type === 'symbol' &&
  PLACE_SOURCE_LAYERS.has(layer['source-layer'] ?? '') &&
  !!layer.layout?.['text-field'] &&
  !REGION.test(layer.id) &&
  SETTLEMENT.test(`${layer.id} ${JSON.stringify(layer.filter ?? [])}`);

/**
 * A style that already moves its place names around their point (the hosted one does, and drops the
 * dot from zoom 8) keeps its own placement: MapLibre holds a name on the side it was first drawn, so
 * offsets set after the first frame would leave names on mixed sides.
 */
const placesItsOwnLabels = (layer: SymbolLayerSpecification) =>
  layer.layout?.['text-variable-anchor'] !== undefined || layer.layout?.['text-variable-anchor-offset'] !== undefined;

/**
 * The name of the place under a bubble, in the base map's own wording, font and colours, starting
 * past the bubble's edge and, where another bubble is in the way there, ending before its other
 * edge. Drawn under the obstacles so that it gives way to every other bubble.
 */
export const bubbleNameLayer = (place: SymbolLayerSpecification): LayerSpecification => ({
  id: BUBBLE_NAME_LAYER,
  type: 'symbol',
  source: BUBBLE_NAME_LAYER,
  layout: {
    'text-field': place.layout?.['text-field'],
    ...(place.layout?.['text-font'] && { 'text-font': place.layout['text-font'] }),
    'text-size': BUBBLE_NAME_SIZE,
    'text-variable-anchor': ['left', 'right'],
    'text-radial-offset': ['get', 'flOffset'],
    'text-justify': 'auto',
    'text-padding': 0,
  },
  ...(place.paint && { paint: place.paint }),
});

/**
 * Place names start past their dot and may move to another side of it when a bubble is in the way
 * (MapLibre's variable anchors). The offset is in ems: 7px at the style's text size.
 */
export const placeLabelLayout = (textSize = 12) => ({
  'text-variable-anchor': ['left', 'right', 'top', 'bottom'] as Array<'left' | 'right' | 'top' | 'bottom'>,
  'text-radial-offset': Number((PLACE_LABEL_OFFSET_PX / textSize).toFixed(2)),
  'text-justify': 'auto' as const,
});

/** The names `updateBubbleNames` last drew on a map; each remembers its bubble as `flBubble`. */
const named = new WeakMap<MapLibreMap, Feature[]>();

/**
 * Applies the prototype's label offsets and the bubble obstacles to the current style. It is called
 * on style and source events, so it returns at once while the obstacle layer is in place: a new
 * style (a theme change) drops that layer and the label changes with it, and only then is the style
 * read and changed again.
 */
export const applyClusterLabelLayout = (map: MapLibreMap, source: string) => {
  if (map.getLayer(CLUSTER_OBSTACLE_LAYER) || !map.getSource(source)) {
    return;
  }
  const style = map.getStyle();
  if (!style) {
    return;
  }
  if (!map.hasImage(CLUSTER_OBSTACLE_IMAGE)) {
    const size = CLUSTER_OBSTACLE_IMAGE_SIZE;
    map.addImage(CLUSTER_OBSTACLE_IMAGE, { width: size, height: size, data: new Uint8Array(size * size * 4) });
    // FL-51: addImage fires "styledata" synchronously, which calls this again and may already have
    // applied everything; adding the layer twice is a map error the screen would read as failed tiles.
    if (map.getLayer(CLUSTER_OBSTACLE_LAYER)) {
      return;
    }
  }
  map.addLayer(clusterObstacleLayer(source));
  const places = style.layers.filter((layer) => isPlaceLabelLayer(layer));
  if (places.length > 0 && !map.getLayer(BUBBLE_NAME_LAYER)) {
    if (!map.getSource(BUBBLE_NAME_LAYER)) {
      map.addSource(BUBBLE_NAME_LAYER, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    named.delete(map);
    // ponytail: one layer, in the wording and colours of the style's topmost place layer (its
    // cities); one per place layer if a style ever names its cities and villages from different fields.
    map.addLayer(bubbleNameLayer(places.at(-1)!), CLUSTER_OBSTACLE_LAYER);
  }
  for (const layer of places) {
    if (placesItsOwnLabels(layer)) {
      continue;
    }
    const size = layer.layout?.['text-size'];
    const layout = placeLabelLayout(typeof size === 'number' ? size : undefined);
    if (map.getLayoutProperty(layer.id, 'text-radial-offset') === layout['text-radial-offset']) {
      continue;
    }
    map.setLayoutProperty(layer.id, 'text-variable-anchor', layout['text-variable-anchor']);
    map.setLayoutProperty(layer.id, 'text-radial-offset', layout['text-radial-offset']);
    map.setLayoutProperty(layer.id, 'text-justify', layout['text-justify']);
  }
};

/**
 * Names each bubble after the nearest place the base map could not name beside it (in the
 * prototype a place within `clusterRadius + 24` of a bubble starts its name at the bubble's edge).
 * Only names the base map is not showing are drawn, so no name appears twice, and a bubble keeps
 * its name while that still holds, so two places under one bubble do not take turns.
 *
 * Called when the map comes to rest ("idle"), where what the base map shows has settled; it changes
 * the names only when they differ, so the redraw that follows comes to rest again. While the map
 * moves (`atRest` false) the bubbles regroup before the base map has settled: a name whose bubble
 * is gone goes with it, and new names wait for rest.
 */
export const updateBubbleNames = (map: MapLibreMap, source: string, atRest = true) => {
  const names = map.getSource<GeoJSONSource>(BUBBLE_NAME_LAYER);
  const style = names && map.getStyle();
  if (!names || !style || !map.getSource(source)) {
    return;
  }
  const previous = named.get(map) ?? [];
  if (!atRest && previous.length === 0) {
    return;
  }
  const draw = (features: Feature[]) => {
    if (JSON.stringify(features) === JSON.stringify(previous)) {
      return;
    }
    named.set(map, features);
    void names.setData({ type: 'FeatureCollection', features });
  };
  // a bubble near a tile's edge is in both tiles; its count and place are part of what it is
  const bubbles = new Map(
    map
      .querySourceFeatures(source)
      .filter((bubble) => bubble.geometry.type === 'Point')
      .map((bubble) => {
        const { cluster_id: cluster, id, point_count: count = 1 } = bubble.properties;
        const coordinates = (bubble.geometry as Point).coordinates as [number, number];
        return [`${cluster ?? id}:${count}:${coordinates.join(',')}`, { coordinates, count: count as number }];
      }),
  );
  if (!atRest) {
    draw(previous.filter((feature) => bubbles.has(feature.properties?.flBubble)));
    return;
  }

  const zoom = map.getZoom();
  const layers = style.layers
    .filter((layer) => isPlaceLabelLayer(layer))
    .filter((layer) => zoom >= (layer.minzoom ?? 0) && zoom < (layer.maxzoom ?? 25) && map.getLayer(layer.id));
  const nameOf = (place: { properties: Record<string, unknown> | null }) => place.properties?.name as string;
  const shown = new Set(
    map.queryRenderedFeatures({ layers: layers.map(({ id }) => id) }).map((place) => nameOf(place)),
  );
  // …of the places on screen: beyond it the base map shows nothing, hidden or not
  const { clientWidth, clientHeight } = map.getContainer();
  const hidden = new Map<string, { x: number; y: number; properties: Record<string, unknown> }>();
  for (const layer of layers) {
    const filter = layer.filter;
    for (const place of map.querySourceFeatures(layer.source, { sourceLayer: layer['source-layer'], filter })) {
      const name = nameOf(place);
      if (name && !shown.has(name) && !hidden.has(name) && place.geometry.type === 'Point') {
        const { x, y } = map.project(place.geometry.coordinates as [number, number]);
        if (x >= 0 && y >= 0 && x <= clientWidth && y <= clientHeight) {
          hidden.set(name, { x, y, properties: place.properties });
        }
      }
    }
  }

  // A place is its nearest bubble's, and a bubble is named after the nearest of its places, unless
  // it already carries the name of one of them.
  const kept = new Map(previous.map((feature) => [feature.properties?.flBubble as string, nameOf(feature)]));
  const spots = [...bubbles].map(([key, { coordinates, count }]) => {
    const { x, y } = map.project(coordinates);
    return { key, coordinates, x, y, radius: clusterRadius(count) };
  });
  const naming = new Map<string, { name: string; distance: number }>();
  for (const [name, place] of hidden) {
    let owner: (typeof spots)[number] | undefined;
    let distance = Infinity;
    for (const spot of spots) {
      const away = Math.hypot(place.x - spot.x, place.y - spot.y);
      if (away < spot.radius + BUBBLE_NAME_REACH && away < distance) {
        owner = spot;
        distance = away;
      }
    }
    if (!owner) {
      continue;
    }
    distance = kept.get(owner.key) === name ? -1 : distance;
    if (distance < (naming.get(owner.key)?.distance ?? Infinity)) {
      naming.set(owner.key, { name, distance });
    }
  }
  const features = spots
    .filter(({ key }) => naming.has(key))
    .map(({ key, coordinates, radius }): Feature => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates },
      // the place's own properties, for the base map's text-field; one pixel clear of the obstacle
      properties: {
        ...hidden.get(naming.get(key)!.name)!.properties,
        flBubble: key,
        flOffset: (radius + LABEL_GAP + 1) / BUBBLE_NAME_SIZE,
      },
    }));
  draw(features);
};
