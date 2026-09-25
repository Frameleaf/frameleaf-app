import type { ExpressionSpecification, LayerSpecification, Map as MapLibreMap } from 'maplibre-gl';

/**
 * Cluster bubbles and place labels from the prototype's map (`MapView.jsx:104-105, 230-240`,
 * FL-147).
 *
 * A bubble's radius grows with its count and stops growing at 40 items; a single photo is a 21px
 * bubble. Place names start just past their dot and, where a bubble sits over the place, past the
 * bubble's edge, so a name is never drawn underneath a cluster.
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
  },
  paint: { 'icon-opacity': 0 },
});

const SETTLEMENT = /\b(city|town|village)\b|_(city|town|village)/i;
const REGION = /country|state|continent|province/i;

/**
 * The base map's settlement names (OpenMapTiles `place` source layer: city, town and village layers,
 * by id or by their `class` filter). The prototype only moves the names of places, which sit where
 * photos cluster; country, state and continent names are left where the style puts them.
 */
export const isPlaceLabelLayer = (layer: LayerSpecification) =>
  layer.type === 'symbol' &&
  'source-layer' in layer &&
  layer['source-layer'] === 'place' &&
  !!layer.layout?.['text-field'] &&
  !REGION.test(layer.id) &&
  SETTLEMENT.test(`${layer.id} ${JSON.stringify(layer.filter ?? [])}`);

/**
 * Place names start past their dot and may move to another side of it when a bubble is in the way
 * (MapLibre's variable anchors). The offset is in ems: 7px at the style's text size.
 */
export const placeLabelLayout = (textSize = 12) => ({
  'text-variable-anchor': ['left', 'right', 'top', 'bottom'] as Array<'left' | 'right' | 'top' | 'bottom'>,
  'text-radial-offset': Number((PLACE_LABEL_OFFSET_PX / textSize).toFixed(2)),
  'text-justify': 'auto' as const,
});

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
  }
  map.addLayer(clusterObstacleLayer(source));
  for (const layer of style.layers) {
    if (!isPlaceLabelLayer(layer)) {
      continue;
    }
    const size = layer.type === 'symbol' ? layer.layout?.['text-size'] : undefined;
    const layout = placeLabelLayout(typeof size === 'number' ? size : undefined);
    if (map.getLayoutProperty(layer.id, 'text-radial-offset') === layout['text-radial-offset']) {
      continue;
    }
    map.setLayoutProperty(layer.id, 'text-variable-anchor', layout['text-variable-anchor']);
    map.setLayoutProperty(layer.id, 'text-radial-offset', layout['text-radial-offset']);
    map.setLayoutProperty(layer.id, 'text-justify', layout['text-justify']);
  }
};
