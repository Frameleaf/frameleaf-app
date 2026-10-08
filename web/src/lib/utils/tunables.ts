import { browser } from '$app/environment';
import { DURATION } from '$lib/frameleaf/tokens';

function getBoolean(string: string | null, fallback: boolean) {
  if (string === null) {
    return fallback;
  }
  return 'true' === string;
}
function getNumber(string: string | null, fallback: number) {
  if (string === null) {
    return fallback;
  }
  return Number.parseInt(string);
}
const storage = browser
  ? localStorage
  : {
      getItem: () => null,
    };
export const TUNABLES = {
  LAYOUT: {
    WASM: getBoolean(storage.getItem('LAYOUT.WASM'), true),
  },
  TIMELINE: {
    INTERSECTION_EXPAND_TOP: getNumber(storage.getItem('TIMELINE_INTERSECTION_EXPAND_TOP'), 500),
    INTERSECTION_EXPAND_BOTTOM: getNumber(storage.getItem('TIMELINE_INTERSECTION_EXPAND_BOTTOM'), 500),
  },
  ASSET_GRID: {
    NAVIGATE_ON_ASSET_IN_VIEW: getBoolean(storage.getItem('ASSET_GRID.NAVIGATE_ON_ASSET_IN_VIEW'), false),
  },
  IMAGE_THUMBNAIL: {
    // The brand's base duration (--fl-motion): a placeholder gives way to its photo like any other reveal.
    THUMBHASH_FADE_DURATION: getNumber(storage.getItem('THUMBHASH_FADE_DURATION'), DURATION.base),
  },
  IMAGE_RASTER: {
    MAX_PIXELS: getNumber(storage.getItem('IMAGE_RASTER.MAX_PIXELS'), 0),
  },
};
