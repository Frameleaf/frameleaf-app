import {
  cancelCloudLink,
  checkInCloud,
  getCloudLink,
  getCloudStatus,
  startCloudLink,
  unlinkCloud,
  updateCloudPermissions,
  type CloudPermissionsUpdateDto,
  type CloudStatusResponseDto,
} from '@immich/sdk';
import { eventManager } from '$lib/managers/event-manager.svelte';

/**
 * The Frameleaf Cloud link as administrators see it (FL-155). Admin-only: pages that are not an
 * administrator's never call `listen`. The status reloads when the server says the link changed
 * (`on_frameleaf_cloud`), after a settings save, and, while a code waits for approval, on the
 * interval the cloud set; the server itself decides when to ask the cloud.
 */
export class CloudManager {
  #status = $state<CloudStatusResponseDto | null>(null);
  #error = $state<unknown>(null);
  #loading = $state(false);
  #listeners = 0;
  #poll?: ReturnType<typeof setTimeout>;

  get status() {
    return this.#status;
  }

  get error() {
    return this.#error;
  }

  get loading() {
    return this.#loading;
  }

  constructor() {
    eventManager.on({
      FrameleafCloudUpdate: ({ topic }) => {
        if (topic === 'link' && this.#listeners > 0) {
          void this.refresh();
        }
      },
      SystemConfigUpdate: () => {
        if (this.#listeners > 0) {
          void this.refresh();
        }
      },
    });
  }

  /** Start keeping the status current; call the returned function to stop. */
  listen() {
    this.#listeners++;
    void this.refresh();
    return () => {
      this.#listeners = Math.max(0, this.#listeners - 1);
      if (this.#listeners === 0) {
        this.#stopPolling();
      }
    };
  }

  async refresh() {
    this.#loading = true;
    try {
      this.#apply(await getCloudStatus());
    } catch (error) {
      this.#error = error;
    } finally {
      this.#loading = false;
    }
  }

  startLink = () => this.#run(() => startCloudLink());
  cancelLink = () => this.#run(() => cancelCloudLink());
  unlink = () => this.#run(() => unlinkCloud());
  checkIn = () => this.#run(() => checkInCloud());
  setPermissions = (dto: CloudPermissionsUpdateDto) =>
    this.#run(() => updateCloudPermissions({ cloudPermissionsUpdateDto: dto }));

  async #run(call: () => Promise<CloudStatusResponseDto>) {
    const status = await call();
    this.#apply(status);
    return status;
  }

  #apply(status: CloudStatusResponseDto) {
    this.#status = status;
    this.#error = null;
    this.#stopPolling();
    if (status.state === 'pending' && status.pending && this.#listeners > 0) {
      const seconds = Math.max(1, status.pending.intervalSeconds);
      this.#poll = setTimeout(() => void this.#pollOnce(), seconds * 1000);
    }
  }

  async #pollOnce() {
    try {
      this.#apply(await getCloudLink());
    } catch (error) {
      this.#error = error;
    }
  }

  #stopPolling() {
    if (!this.#poll) {
      return;
    }
    clearTimeout(this.#poll);
    this.#poll = undefined;
  }
}

export const cloudManager = new CloudManager();
