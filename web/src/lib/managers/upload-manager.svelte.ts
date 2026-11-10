import { getSupportedMediaTypes, type ServerMediaTypesResponseDto } from '@frameleaf/sdk';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { uploadAssetsStore } from '$lib/stores/upload';
import { cancelUploadRequests } from '$lib/utils';

class UploadManager {
  mediaTypes = $state<ServerMediaTypesResponseDto>({ image: [], sidecar: [], video: [], font: [] });

  constructor() {
    eventManager.on({
      AppInit: () => this.#loadExtensions(),
      AuthLogout: () => this.reset(),
    });
  }

  reset() {
    cancelUploadRequests();
    uploadAssetsStore.reset();
  }

  async #loadExtensions() {
    try {
      this.mediaTypes = await getSupportedMediaTypes();
    } catch {
      console.error('Failed to load supported media types');
    }
  }

  getExtensions() {
    return [...this.mediaTypes.image, ...this.mediaTypes.video];
  }

  /** FL-1359: Boards also takes fonts. An older server lists none. */
  getBoardsExtensions() {
    return [...this.getExtensions(), ...(this.mediaTypes.font ?? [])];
  }
}

export const uploadManager = new UploadManager();
