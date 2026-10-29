import { getServerFeatures, type ServerFeaturesDto } from '@frameleaf/sdk';
import { eventManager } from '$lib/managers/event-manager.svelte';

class FeatureFlagsManager {
  #value?: ServerFeaturesDto = $state();

  constructor() {
    eventManager.on({
      SystemConfigUpdate: () => void this.#loadFeatureFlags(),
      // FL-156: the Frameleaf Cloud link and licence decide the cloud flags
      FrameleafCloudUpdate: () => void this.#loadFeatureFlags(),
      // Sign-in reads the flags for the supporter badge; app start uses that answer instead of asking again.
      ServerFeaturesLoaded: (features) => (this.#value = features),
    });
  }

  async init() {
    if (!this.#value) {
      await this.#loadFeatureFlags();
    }
  }

  get value() {
    if (!this.#value) {
      throw new Error('Feature flags manager must be initialized first');
    }

    return this.#value;
  }

  async #loadFeatureFlags() {
    this.#value = await getServerFeatures();
  }
}

export const featureFlagsManager = new FeatureFlagsManager();
