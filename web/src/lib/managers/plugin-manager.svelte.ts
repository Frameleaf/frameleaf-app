import {
  getWorkflowDiscovery,
  getWorkflowTriggers,
  isHttpError,
  searchPluginMethods,
  searchPluginTemplates,
  WorkflowTrigger,
  type PluginMethodResponseDto,
  type PluginTemplateResponseDto,
  type WorkflowEventTriggerResponseDto,
  type WorkflowTriggerResponseDto,
} from '@frameleaf/sdk';
import { t } from 'svelte-i18n';
import { SvelteMap } from 'svelte/reactivity';
import { get } from 'svelte/store';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';

class PluginManager {
  #loading: Promise<void> | undefined;
  #generation = 0;
  #methodMap = new SvelteMap<string, PluginMethodResponseDto>();
  #methods = $state<PluginMethodResponseDto[]>([]);
  #triggers = $state<WorkflowTriggerResponseDto[]>([]);
  #templates = $state<PluginTemplateResponseDto[]>([]);
  /** FL-819: Frameleaf events a workflow can start on; the server lists them to administrators only. */
  #eventTriggers = $state<WorkflowEventTriggerResponseDto[]>([]);

  constructor() {
    eventManager.on({
      AuthLogout: () => this.clearCache(),
      // The event bus does not await listeners; pages call ready() to surface discovery errors.
      AuthUserLoaded: () => void this.initialize().catch(() => {}),
    });

    // loaded event might have already happened
    if (authManager.authenticated) {
      void this.initialize().catch(() => {});
    }
  }

  get methods() {
    return this.#methods;
  }

  get triggers() {
    return this.#triggers;
  }

  get templates() {
    return this.#templates;
  }

  get eventTriggers() {
    return this.#eventTriggers;
  }

  ready() {
    return this.initialize();
  }

  getMethod(key: string) {
    return this.#methodMap.get(key);
  }

  getMethodLabel(key: string) {
    const method = this.getMethod(key);
    return method?.title ?? get(t)('unknown');
  }

  getTrigger(trigger: WorkflowTrigger) {
    const result = this.#triggers.find((t) => t.trigger === trigger);

    if (!result) {
      throw new Error(`Unknown trigger type: ${trigger}`);
    }

    return result;
  }

  private clearCache() {
    this.#generation++;
    this.#loading = undefined;
    this.#methodMap = new SvelteMap();
    this.#methods = [];
    this.#triggers = [];
    this.#templates = [];
    this.#eventTriggers = [];
  }

  private initialize() {
    if (!this.#loading) {
      const generation = this.#generation;
      this.#loading = this.load().catch((error: unknown) => {
        if (generation === this.#generation) {
          this.#loading = undefined;
        }
        throw error;
      });
    }

    return this.#loading;
  }

  private async load() {
    const generation = this.#generation;
    const [methods, discovery] = await Promise.all([
      searchPluginMethods({}),
      getWorkflowDiscovery().catch(async (error: unknown) => {
        if (!isHttpError(error) || ![404, 405].includes(error.status)) {
          throw error;
        }
        const [triggers, templates] = await Promise.all([getWorkflowTriggers(), searchPluginTemplates()]);
        return {
          triggers: triggers.map((entry) => ({ ...entry, trigger: WorkflowTrigger[entry.trigger] })),
          templates: templates.map((entry) => ({ ...entry, trigger: WorkflowTrigger[entry.trigger] })),
          eventTriggers: [],
        };
      }),
    ]);
    if (generation !== this.#generation) {
      return;
    }

    this.#methods = methods;
    for (const method of this.#methods) {
      this.#methodMap.set(method.key, method);
    }

    this.#triggers = discovery.triggers;
    this.#templates = discovery.templates;
    // a server from before FL-819 does not list events
    this.#eventTriggers = discovery.eventTriggers ?? [];
  }
}

export const pluginManager = new PluginManager();
