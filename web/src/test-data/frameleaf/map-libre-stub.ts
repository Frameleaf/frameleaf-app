/**
 * FL-193: lets a spec reach the `onerror`/`onload` callbacks a `<MapLibre>` consumer passed in,
 * without a real WebGL map. `MapLibreStub.svelte` records the latest props here as soon as it is
 * instantiated — before any style has "loaded" — so a spec can fire `onerror` the way maplibre-gl
 * would for a startup failure, and confirm the handler was attached in time to see it.
 */
export interface MapLibreStubProps {
  onload?: (map: unknown) => void;
  onerror?: (event: { error?: unknown; sourceId?: string }) => void;
  onmoveend?: (event: unknown) => void;
}

let latest: MapLibreStubProps | undefined;
let stubMap: unknown;

/** FL-51: the map instance the stub binds to its consumer's `bind:map`, for specs that move the view. */
export const setMapLibreStubMap = (map: unknown) => {
  stubMap = map;
};

export const getMapLibreStubMap = () => stubMap;

export const setMapLibreStubProps = (props: MapLibreStubProps) => {
  latest = props;
};

export const getMapLibreStubProps = (): MapLibreStubProps => {
  if (!latest) {
    throw new Error('MapLibreStub has not been mounted yet');
  }
  return latest;
};

export const resetMapLibreStub = () => {
  latest = undefined;
  stubMap = undefined;
};
