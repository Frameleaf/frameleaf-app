import { getPrivateBrowserStateGeneration } from '$lib/frameleaf/private-browser-state';
import type { LatLng } from '$lib/types';

class GeolocationManager {
  #lastPoint = $state<{ point: LatLng; generation: number }>();

  get lastPoint() {
    if (this.#lastPoint?.generation === getPrivateBrowserStateGeneration()) {
      return this.#lastPoint.point;
    }
    return undefined;
  }

  onSelected(point: LatLng, generation: number) {
    if (generation === getPrivateBrowserStateGeneration()) {
      this.#lastPoint = { point, generation };
    }
  }
}

export const geolocationManager = new GeolocationManager();
