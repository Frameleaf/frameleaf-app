import { getMediaOperation, MediaOperationStatus, type MediaOperationDetailDto } from '@immich/sdk';
import type { Translations } from 'svelte-i18n';
import { SvelteMap } from 'svelte/reactivity';
import type { BulkActionId } from '$lib/frameleaf/bulk-actions';
import {
  durableItemStates,
  removesFromView,
  type BulkView,
  type DurableItemState,
} from '$lib/frameleaf/bulk-operations';

/**
 * Durable bulk jobs on the page they were started from (FL-32, owner decision September 22, 2026).
 *
 * A large delete, trash or any other durable action leaves its items where they are while the
 * server works, and each affected tile shows a small loader until the job has answered for it. Then:
 *
 * - an item that is done leaves the view if the action takes it out of the view (a delete, a
 *   restore from the trash, a removal from the album), without reloading the page;
 * - an item that failed loses the loader and shows a failure mark;
 * - anything else — cancelled before it was reached, already there — simply loses the loader.
 *
 * The state comes from the job itself: this polls the job's detail while it runs and reads each
 * item's state with `durableItemStates`, scoped to the ids this tab submitted. Nothing here decides
 * that an item is done; the server's cursor and refusal list do.
 *
 * One tracker serves every view. Tiles read `items`; a mounted view subscribes with `onRemoved` to
 * drop finished items from its own timeline, so a job started on one page and finished after the
 * person moved to another still reconciles whichever view is showing.
 */

/** What a tile shows for an item of a durable job. Absent means nothing. */
export type DurableTileState = { state: 'pending' } | { state: 'failed'; reasonKey: Translations };

type TrackedJob = {
  operationId: string;
  action: BulkActionId;
  /** The job's frozen set, in the server's order. */
  ids: string[];
  /** Items already settled, so a later poll never flips them back. */
  settled: Set<string>;
  /** The view the job was submitted from, for what leaves it (FL-34). */
  view?: BulkView;
};

type Fetch = (operationId: string) => Promise<MediaOperationDetailDto>;

const FINISHED: ReadonlySet<MediaOperationStatus> = new Set([
  MediaOperationStatus.Completed,
  MediaOperationStatus.Cancelled,
  MediaOperationStatus.Failed,
]);

/** How often a running job is asked where it is. Matches the pace of Activity's own poll. */
export const DURABLE_TRACK_POLL_MS = 2500;

export class DurableBulkTracker {
  /** Per-asset state for tiles. Reactive: a tile re-renders when its entry changes. */
  readonly items = new SvelteMap<string, DurableTileState>();

  #jobs = new Map<string, TrackedJob>();
  #listeners = new Set<(removedIds: string[]) => void>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #polling: Promise<void> | null = null;
  #fetch: Fetch;
  #pollMs: number;

  constructor({
    fetch = (id) => getMediaOperation({ id }),
    pollMs = DURABLE_TRACK_POLL_MS,
  }: { fetch?: Fetch; pollMs?: number } = {}) {
    this.#fetch = fetch;
    this.#pollMs = pollMs;
  }

  /** The tile state for one asset, or undefined when there is nothing to show. */
  stateOf(assetId: string): DurableTileState | undefined {
    return this.items.get(assetId);
  }

  /** How many jobs are still being followed. */
  get tracking(): number {
    return this.#jobs.size;
  }

  /**
   * Follow a job this tab just submitted. `ids` must be the part of the frozen set that job holds,
   * in order — `durableBulkParts` gives exactly that.
   */
  track(action: BulkActionId, operationId: string, ids: readonly string[], view?: BulkView) {
    if (ids.length === 0) {
      return;
    }

    this.#jobs.set(operationId, { operationId, action, ids: [...ids], settled: new Set(), view });
    for (const id of ids) {
      this.items.set(id, { state: 'pending' });
    }
    this.#schedule();
  }

  /**
   * Hear about items that finished and left the view. Returns the unsubscribe function, so a
   * component can hand it straight to `onMount` or `$effect`.
   */
  onRemoved(listener: (removedIds: string[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Ask every followed job where it is, once. Concurrent calls share one round. */
  poll(): Promise<void> {
    this.#polling ??= this.#pollAll().finally(() => {
      this.#polling = null;
    });
    return this.#polling;
  }

  /** Stop following everything and clear every mark. For sign-out and tests. */
  reset() {
    this.#stop();
    this.#jobs.clear();
    this.items.clear();
  }

  async #pollAll() {
    for (const job of this.#jobs.values()) {
      let detail: MediaOperationDetailDto;
      try {
        detail = await this.#fetch(job.operationId);
      } catch {
        // Unreachable for now: the loaders stay, and the next poll asks again. The job itself is
        // unaffected by this tab's connection.
        continue;
      }
      this.apply(job.operationId, detail);
    }
  }

  /** Fold one answer from the server into the tiles. Exposed for tests. */
  apply(operationId: string, detail: MediaOperationDetailDto) {
    const job = this.#jobs.get(operationId);
    if (!job) {
      return;
    }

    const states = durableItemStates(job.ids, detail);
    const removed: string[] = [];

    for (const id of job.ids) {
      if (job.settled.has(id)) {
        continue;
      }

      const item: DurableItemState = states.get(id) ?? { state: 'unchanged' };
      switch (item.state) {
        case 'pending': {
          break;
        }
        case 'done': {
          job.settled.add(id);
          this.items.delete(id);
          if (removesFromView(job.action, job.view)) {
            removed.push(id);
          }
          break;
        }
        case 'failed': {
          job.settled.add(id);
          this.items.set(id, { state: 'failed', reasonKey: item.reasonKey });
          break;
        }
        default: {
          job.settled.add(id);
          this.items.delete(id);
          break;
        }
      }
    }

    if (removed.length > 0) {
      for (const listener of this.#listeners) {
        listener(removed);
      }
    }

    if (FINISHED.has(detail.status)) {
      this.#jobs.delete(operationId);
    }
  }

  #schedule() {
    if (this.#timer !== null || this.#jobs.size === 0) {
      return;
    }

    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.poll().then(() => this.#schedule());
    }, this.#pollMs);
  }

  #stop() {
    if (this.#timer === null) {
      return;
    }

    clearTimeout(this.#timer);
    this.#timer = null;
  }
}

export const durableBulkTracker = new DurableBulkTracker();
