import type { CloudConsentFeature, CloudFeature } from '$lib/frameleaf/cloud-rules';

export type GetCloudOptions = {
  onDone?: () => void;
  topUpUrl?: string | null;
  /** How much AI credit the job needs held, when a refusal said so. Then a smaller balance isn't enough. */
  creditNeeded?: number | null;
  /** The consent the work needs on top of the terms (search and faces); the terms step asks for it. */
  consentFeature?: CloudConsentFeature;
};
export type GetCloudRequest = { feature: CloudFeature | null } & GetCloudOptions;

/**
 * FL-544: the one "Get Frameleaf Cloud" sheet, opened from any gate. `GetCloudHost` (mounted once in
 * the signed-in layout) renders the sheet while a request is open; a gate calls
 * `getCloudManager.open('remote', { onDone })` and gets `onDone` back once Frameleaf Cloud is on the
 * server and the person pressed the feature's own button.
 */
export class GetCloudManager {
  #request = $state<GetCloudRequest | null>(null);
  #setups = $state(0);

  get request() {
    return this.#request;
  }

  /** Goes up each time the sheet finishes setting Cloud up, so what shows Cloud's state reads it again. */
  get setups() {
    return this.#setups;
  }

  open(feature: CloudFeature | null = null, options: GetCloudOptions = {}) {
    this.#request = {
      feature,
      onDone: options.onDone,
      topUpUrl: options.topUpUrl ?? null,
      ...(options.creditNeeded && { creditNeeded: options.creditNeeded }),
      ...(options.consentFeature && { consentFeature: options.consentFeature }),
    };
  }

  /** The sheet set Cloud up: everything that read Cloud's state before it did should read it again. */
  setUp() {
    this.#setups++;
  }

  close() {
    this.#request = null;
  }
}

export const getCloudManager = new GetCloudManager();
