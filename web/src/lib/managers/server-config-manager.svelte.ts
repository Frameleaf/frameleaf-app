import { getServerConfig, type ServerConfigDto } from '@frameleaf/sdk';
import { eventManager } from '$lib/managers/event-manager.svelte';

class ServerConfigManager {
  #value?: ServerConfigDto = $state();

  constructor() {
    eventManager.on({
      SystemConfigUpdate: () => this.loadServerConfig(),
    });
  }

  #loading?: Promise<void>;

  async init() {
    this.#loading ??= this.loadServerConfig().finally(() => (this.#loading = undefined));
    await this.#loading;
  }

  /**
   * The server config, loaded once if nothing has loaded it yet: a page's loader can run before the
   * root layout's has, and must not skip the decisions (like the setup redirect) that read it.
   */
  async ready(): Promise<ServerConfigDto> {
    if (!this.#value) {
      this.#loading ??= this.loadServerConfig().finally(() => (this.#loading = undefined));
      await this.#loading;
    }
    return this.value;
  }

  get value() {
    if (!this.#value) {
      throw new Error('Server config manager must be initialized first');
    }

    return this.#value;
  }

  async loadServerConfig() {
    this.#value = await getServerConfig();
  }
}

export const serverConfigManager = new ServerConfigManager();
