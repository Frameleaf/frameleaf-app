import { getServerFeatures, type ServerFeaturesDto } from '@frameleaf/sdk';
import { eventManager } from '$lib/managers/event-manager.svelte';

class FeatureFlagsManager {
  #value?: ServerFeaturesDto = $state();
  #loads = 0;
  /** The newest load whose answer is in `#value`. */
  #applied = 0;
  /** Sign-in's answer, not yet used by an `init`: that one `init` needs no request of its own. */
  #fromSignIn = false;

  constructor() {
    eventManager.on({
      SystemConfigUpdate: () => void this.#loadFeatureFlags(),
      // FL-156: the Frameleaf Cloud link and licence decide the cloud flags
      FrameleafCloudUpdate: () => void this.#loadFeatureFlags(),
      // Sign-in reads the flags for the supporter badge; app start uses that answer instead of asking again.
      // It only fills in flags not read yet: a refresh asked for since is newer than that answer.
      ServerFeaturesLoaded: (features) => {
        if (!this.#value && this.#loads === 0) {
          this.#value = features;
          this.#fromSignIn = true;
        }
      },
    });
  }

  async init() {
    if (this.#fromSignIn) {
      this.#fromSignIn = false;
      return;
    }
    await this.#loadFeatureFlags();
  }

  get value() {
    if (!this.#value) {
      throw new Error('Feature flags manager must be initialized first');
    }

    return this.#value;
  }

  async #loadFeatureFlags() {
    const load = ++this.#loads;
    const value = await getServerFeatures();
    // an older answer that arrives late never replaces a newer one, but stands in for a newer one that failed
    if (load > this.#applied) {
      this.#applied = load;
      this.#value = value;
    }
  }
}

export const featureFlagsManager = new FeatureFlagsManager();
