import { getAssetInfo } from '@frameleaf/sdk';
import { throttle } from 'lodash-es';
import type { Unsubscriber } from 'svelte/store';
import { authManager } from '$lib/managers/auth-manager.svelte';
import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import type { PendingChange, TimelineAsset } from '$lib/managers/timeline-manager/types';
import { websocketEvents } from '$lib/stores/websocket';
import { toTimelineAsset } from '$lib/utils/timeline-util';

/** A restore of more items than this reloads the timeline instead of fetching each one (FL-47). */
export const RESTORE_FETCH_LIMIT = 25;

export class WebsocketSupport {
  #pendingChanges = new Map<string, { generation: number; change: PendingChange }>();
  #assetGenerations = new Map<string, number>();
  #connectionGeneration = 0;
  #unsubscribers: Unsubscriber[] = [];
  #timelineManager: TimelineManager;

  #processPendingChanges = throttle(() => {
    const { add, update, remove } = this.#getPendingChangeBatches();
    if (add.length > 0) {
      this.#timelineManager.upsertAssetsFromLiveEvent(add);
    }
    if (update.length > 0) {
      this.#timelineManager.upsertAssetsFromLiveEvent(update);
    }
    if (remove.length > 0) {
      this.#timelineManager.removeAssets(remove);
    }
    this.#pendingChanges.clear();
  }, 2500);

  constructor(timeineManager: TimelineManager) {
    this.#timelineManager = timeineManager;
  }

  connectWebsocketEvents() {
    this.#unsubscribers.push(
      websocketEvents.on('on_upload_success', (asset) =>
        this.#addPendingChanges({ type: 'add', values: [toTimelineAsset(asset)] }),
      ),
      websocketEvents.on('on_asset_trash', (ids) => this.#addPendingChanges({ type: 'trash', values: ids })),
      websocketEvents.on('on_asset_update', (asset) =>
        this.#addPendingChanges({ type: 'update', values: [toTimelineAsset(asset)] }),
      ),
      websocketEvents.on('on_asset_delete', (id: string) => this.#addPendingChanges({ type: 'delete', values: [id] })),
      websocketEvents.on('on_asset_restore', (ids) => void this.#restore(ids)),
    );
  }

  /**
   * FL-47: items restored from the trash elsewhere (another tab or device) come back into this
   * timeline. Each is read again, so what this session may not see (Locked media without an unlocked
   * session) is never fetched into view; the timeline's own filters decide where it belongs. A large
   * restore reloads the timeline instead.
   */
  async #restore(ids: string[]) {
    if (ids.length === 0) {
      return;
    }
    if (ids.length > RESTORE_FETCH_LIMIT) {
      for (const id of ids) this.#nextGeneration(id);
      await this.#timelineManager.refresh();
      return;
    }
    const connection = this.#connectionGeneration;
    const requests = ids.map((id) => ({ id, generation: this.#nextGeneration(id) }));
    await Promise.all(requests.map(async ({ id, generation }) => {
      const asset = await getAssetInfo({ ...authManager.params, id }).catch(() => undefined);
      if (connection !== this.#connectionGeneration || this.#assetGenerations.get(id) !== generation) return;
      if (asset && !asset.isTrashed) {
        this.#pendingChanges.set(id, { generation, change: { type: 'add', values: [toTimelineAsset(asset)] } });
        this.#processPendingChanges();
      }
    }));
  }

  disconnectWebsocketEvents() {
    for (const unsubscribe of this.#unsubscribers) {
      unsubscribe();
    }
    this.#unsubscribers = [];
    this.#connectionGeneration++;
    this.#processPendingChanges.cancel();
    this.#pendingChanges.clear();
    this.#assetGenerations.clear();
  }

  #nextGeneration(id: string) {
    this.#timelineManager.invalidateLiveProjection();
    const generation = (this.#assetGenerations.get(id) ?? 0) + 1;
    this.#assetGenerations.set(id, generation);
    this.#pendingChanges.delete(id);
    return generation;
  }

  #addPendingChanges(...changes: PendingChange[]) {
    for (const change of changes) {
      if (change.type === 'add' || change.type === 'update') {
        for (const asset of change.values) {
          const generation = this.#nextGeneration(asset.id);
          this.#pendingChanges.set(asset.id, { generation, change: { type: change.type, values: [asset] } });
        }
      } else {
        for (const id of change.values) {
          const generation = this.#nextGeneration(id);
          this.#pendingChanges.set(id, { generation, change: { type: change.type, values: [id] } });
        }
      }
    }
    this.#processPendingChanges();
  }

  #getPendingChangeBatches() {
    const batch: {
      add: TimelineAsset[];
      update: TimelineAsset[];
      remove: string[];
    } = {
      add: [],
      update: [],
      remove: [],
    };
    for (const [id, { generation, change }] of this.#pendingChanges) {
      if (this.#assetGenerations.get(id) !== generation) continue;
      const { type, values } = change;
      switch (type) {
        case 'add': {
          batch.add.push(...values);
          break;
        }
        case 'update': {
          batch.update.push(...values);
          break;
        }
        case 'delete':
        case 'trash': {
          batch.remove.push(...values);
          break;
        }
      }
    }
    return batch;
  }
}
