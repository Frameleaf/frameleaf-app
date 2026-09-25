import {
  cancelMediaOperation,
  dismissMediaOperation,
  pauseMediaOperation,
  resumeMediaOperation,
  retryMediaOperation,
  searchMediaOperations,
} from '@immich/sdk';
import type { MediaOperationDto } from '@immich/sdk';
import { eventManager } from '$lib/managers/event-manager.svelte';

/**
 * The live view of the durable job feed (FL-104).
 *
 * The important thing this class is *not*: it is not where a job's state lives. Every field here
 * is the last answer the server gave. The poll below refreshes that answer; it never advances a
 * job, and stopping it leaves every render running exactly as before. That is the whole point of
 * the story — the prototype's one-second timer that moved jobs along has no counterpart here.
 *
 * Polling only runs while something is actually in flight, and only while a subscriber wants it,
 * so an idle Activity page and an idle top bar make no requests at all.
 */

/** How often to ask the server for fresh state while something is running. */
const ACTIVE_POLL_MS = 3000;
/** How often to look again once everything has settled, in case something new was submitted. */
const IDLE_POLL_MS = 30_000;
/**
 * The page shows the recent history, not the whole archive. The server lists unfinished jobs first
 * (FL-43), so every job still running is on this page however many have finished since.
 */
const PAGE_SIZE = 100;
/** Job updates arrive in bursts (a stage, then its progress); one read answers a burst. */
const UPDATE_COALESCE_MS = 250;

const isRunning = (operation: MediaOperationDto) =>
  ['queued', 'preparing', 'rendering', 'validating', 'cancelling'].includes(operation.status);

/** Not finished: running, or held by its owner (FL-104). A paused job cannot be cleared. */
const isUnfinished = (operation: MediaOperationDto) => isRunning(operation) || operation.status === 'paused';

export class ActivitySession {
  operations = $state<MediaOperationDto[]>([]);
  /** True only for the first load, so the page can show a skeleton without flashing on refresh. */
  loading = $state(true);
  /** The last load failed. The list stays on screen; it is stale, not gone. */
  unreachable = $state(false);
  /** Jobs the server is still working on. What the top-bar indicator counts. */
  runningCount = $derived(this.operations.filter((operation) => isRunning(operation)).length);

  #timer: ReturnType<typeof setTimeout> | null = null;
  #subscribers = 0;
  #inFlight: Promise<void> | null = null;
  #unlisten: (() => void) | null = null;
  #nudge: ReturnType<typeof setTimeout> | null = null;

  /**
   * Ask the server for the current state.
   *
   * Concurrent calls share one request: the indicator and the page both want the same answer and
   * there is no reason to ask twice.
   */
  refresh(): Promise<void> {
    this.#inFlight ??= this.#load().finally(() => {
      this.#inFlight = null;
    });

    return this.#inFlight;
  }

  async #load(): Promise<void> {
    try {
      const { items } = await searchMediaOperations({ take: PAGE_SIZE });
      this.operations = items;
      this.unreachable = false;
    } catch {
      // Keep the last known list. A lost connection makes the page stale, not empty, and the
      // jobs themselves are unaffected by this browser's ability to reach the server.
      this.unreachable = true;
    } finally {
      this.loading = false;
    }
  }

  /**
   * Start watching. Returns the stop function, so a component can hand it straight to `onMount`.
   *
   * The interval follows the work: fast while something is running, slow once it has all settled.
   */
  watch(): () => void {
    this.#subscribers++;
    if (this.#subscribers === 1) {
      this.#listen();
    }
    void this.refresh().then(() => this.#schedule());

    return () => {
      this.#subscribers--;
      if (this.#subscribers <= 0) {
        this.#subscribers = 0;
        this.#stop();
        this.#unlisten?.();
        this.#unlisten = null;
      }
    };
  }

  /**
   * Reconnect recovers the exact jobs (FL-43): the moment the browser is back online, the tab is
   * shown again or the server's socket connects again, the list is asked for afresh instead of
   * waiting out the idle interval. The rows are the server's, so what comes back is exactly where
   * every job got to while this tab was away.
   *
   * While connected, the server says when one of this account's jobs changed
   * (`on_media_operation_update`, the job's id and nothing else), and the list is read again then.
   */
  #listen() {
    const again = () => void this.refresh().then(() => this.#schedule());
    const soon = () => {
      if (this.#nudge !== null) {
        return;
      }
      this.#nudge = setTimeout(() => {
        this.#nudge = null;
        again();
      }, UPDATE_COALESCE_MS);
    };
    const unsubscribe = eventManager.on({ WebsocketConnect: again, MediaOperationUpdate: soon });
    const stopNudge = () => {
      if (this.#nudge === null) {
        return;
      }
      clearTimeout(this.#nudge);
      this.#nudge = null;
    };

    if (typeof document === 'undefined') {
      this.#unlisten = () => {
        unsubscribe();
        stopNudge();
      };
      return;
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        again();
      }
    };
    addEventListener('online', again);
    document.addEventListener('visibilitychange', onVisibility);
    this.#unlisten = () => {
      unsubscribe();
      stopNudge();
      removeEventListener('online', again);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }

  #schedule() {
    this.#stop();
    if (this.#subscribers <= 0) {
      return;
    }

    const delay = this.runningCount > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS;
    this.#timer = setTimeout(() => {
      void this.refresh().then(() => this.#schedule());
    }, delay);
  }

  #stop() {
    if (this.#timer === null) {
      return;
    }

    clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Replace one job with the server's answer, so an action's result shows without a full reload. */
  #apply(updated: MediaOperationDto) {
    const index = this.operations.findIndex((operation) => operation.id === updated.id);
    this.operations =
      index === -1
        ? [updated, ...this.operations]
        : this.operations.map((operation) => (operation.id === updated.id ? updated : operation));
  }

  /**
   * Ask the server to stop a job.
   *
   * The answer is authoritative: a claimed job comes back `cancelling`, not `cancelled`, and the
   * row keeps saying so until the worker acknowledges. The client never decides a job has stopped.
   */
  async cancel(id: string): Promise<void> {
    this.#apply(await cancelMediaOperation({ id }));
    this.#schedule();
  }

  /**
   * Ask the server to pause a job (FL-104). A running one answers with its current status and
   * `pauseRequestedAt` set until its worker reaches a checkpoint; the row says "Pausing" meanwhile.
   */
  async pause(id: string): Promise<MediaOperationDto> {
    const updated = await pauseMediaOperation({ id });
    this.#apply(updated);
    this.#schedule();
    return updated;
  }

  /** Resume a paused job, or withdraw a pause its worker has not reached yet (FL-104). */
  async resume(id: string): Promise<MediaOperationDto> {
    const updated = await resumeMediaOperation({ id });
    this.#apply(updated);
    this.#schedule();
    return updated;
  }

  /** Queue a fresh job from a failed or cancelled one. The server owns the lineage. */
  async retry(id: string): Promise<MediaOperationDto> {
    const created = await retryMediaOperation({ id });
    this.#apply(created);
    this.#schedule();
    return created;
  }

  /** Clear a finished job from this account's list. The record survives on the server. */
  async dismiss(id: string): Promise<void> {
    await dismissMediaOperation({ id });
    this.operations = this.operations.filter((operation) => operation.id !== id);
  }

  /** Clear every finished job that is on screen. */
  async dismissFinished(): Promise<void> {
    const finished = this.operations.filter((operation) => !isUnfinished(operation));
    await Promise.all(finished.map((operation) => dismissMediaOperation({ id: operation.id })));
    this.operations = this.operations.filter((operation) => isUnfinished(operation));
  }
}

export const activitySession = new ActivitySession();
