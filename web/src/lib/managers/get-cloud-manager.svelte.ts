import type { CloudFeature } from '$lib/frameleaf/cloud-rules';

export type GetCloudRequest = { feature: CloudFeature | null; onDone?: () => void };

/**
 * FL-544: the one "Get Frameleaf Cloud" sheet, opened from any gate. `GetCloudHost` (mounted once in
 * the signed-in layout) renders the sheet while a request is open; a gate calls
 * `getCloudManager.open('remote', { onDone })` and gets `onDone` back once Frameleaf Cloud is on the
 * server and the person pressed the feature's own button.
 */
export class GetCloudManager {
  #request = $state<GetCloudRequest | null>(null);

  get request() {
    return this.#request;
  }

  open(feature: CloudFeature | null = null, options: { onDone?: () => void } = {}) {
    this.#request = { feature, onDone: options.onDone };
  }

  close() {
    this.#request = null;
  }
}

export const getCloudManager = new GetCloudManager();
