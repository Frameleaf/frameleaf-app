import {
  getRunningJobs,
  pauseMediaOperation,
  resumeMediaOperation,
  updateQueue,
  type QueueName,
  type RunningJobsResponseDto,
} from '@immich/sdk';
import { buildRunningJobRows, countActiveRunningJobs, type RunningJobRow } from '$lib/frameleaf/running-jobs';
import { eventManager } from '$lib/managers/event-manager.svelte';

/**
 * The live view behind the notifications panel's running-jobs section (FL-104, owner request
 * September 23, 2026; FL-72 for the server queues).
 *
 * Like Activity's session, nothing here is where a job's state lives: every field is the server's
 * last answer, and the poll only asks again. It asks one route for everything — the viewer's own
 * jobs and, for an administrator, the server queues — so a panel that is open on every page costs
 * one request per tick, not one per source.
 *
 * The pace follows what is worth watching:
 *
 * - every 2.5 s while the panel is open or anything is running, because totals grow while a queue
 *   runs and the bar is only honest if it keeps up;
 * - every 30 s when nothing is running, or everything is paused, in case something new starts;
 * - not at all while the tab is hidden: the tab asks again the moment it is shown.
 *
 * Polling stops entirely when nothing is subscribed.
 */

/** While the panel is open or something is running. */
export const RUNNING_POLL_MS = 2500;
/** When everything has settled and the panel is closed. */
export const IDLE_POLL_MS = 30_000;

const EMPTY: RunningJobsResponseDto = { operations: [], memoryExports: [], queues: [], canManageQueues: false };

const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

export class RunningJobsSession {
  summary = $state<RunningJobsResponseDto>(EMPTY);
  /** True until the first answer, so the panel can say it is loading instead of "nothing". */
  loading = $state(true);
  /** The last request failed. The rows stay; they are stale, not gone. */
  unreachable = $state(false);
  /** The panel is open: poll at the fast pace even when nothing is running. */
  panelOpen = $state(false);

  rows: RunningJobRow[] = $derived(buildRunningJobRows(this.summary));
  /** Rows actually doing something; paused work does not count. What the bell's badge shows. */
  activeCount = $derived(countActiveRunningJobs(this.rows));

  #timer: ReturnType<typeof setTimeout> | null = null;
  #subscribers = 0;
  #inFlight: Promise<void> | null = null;
  #unlisten: (() => void) | null = null;

  /** Ask the server now. Concurrent callers share the one request. */
  refresh(): Promise<void> {
    this.#inFlight ??= this.#load().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #load(): Promise<void> {
    try {
      this.summary = (await getRunningJobs()) ?? EMPTY;
      this.unreachable = false;
    } catch {
      // Keep the last answer on screen: the jobs are unaffected by this tab losing the server.
      this.unreachable = true;
    } finally {
      this.loading = false;
    }
  }

  /** Start watching; returns the stop function, ready for `onMount`. */
  watch(): () => void {
    this.#subscribers++;
    if (this.#subscribers === 1) {
      this.#listen();
    }
    void this.refresh().then(() => this.#schedule());

    return () => {
      this.#subscribers = Math.max(0, this.#subscribers - 1);
      if (this.#subscribers === 0) {
        this.#stop();
        this.#unlisten?.();
        this.#unlisten = null;
      }
    };
  }

  /** The panel opened or closed. Opening asks at once, so the numbers are current when seen. */
  setPanelOpen(open: boolean) {
    if (this.panelOpen === open) {
      return;
    }
    this.panelOpen = open;
    if (open) {
      void this.refresh().then(() => this.#schedule());
    } else {
      this.#schedule();
    }
  }

  /** How long until the next look, or null for "not until the tab is shown again". */
  nextDelay(): number | null {
    if (isHidden()) {
      return null;
    }
    return this.panelOpen || this.activeCount > 0 ? RUNNING_POLL_MS : IDLE_POLL_MS;
  }

  #schedule() {
    this.#stop();
    if (this.#subscribers <= 0) {
      return;
    }
    const delay = this.nextDelay();
    if (delay === null) {
      return;
    }
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

  #listen() {
    const offAuth = eventManager.on({
      AuthLogout: () => {
        this.summary = EMPTY;
        this.loading = true;
      },
    });

    if (typeof document === 'undefined') {
      this.#unlisten = offAuth;
      return;
    }

    const onVisibility = () => {
      if (isHidden()) {
        this.#stop();
      } else {
        void this.refresh().then(() => this.#schedule());
      }
    };
    // Back online: ask at once, so the panel shows where every job got to meanwhile (FL-43).
    const onOnline = () => void this.refresh().then(() => this.#schedule());
    document.addEventListener('visibilitychange', onVisibility);
    addEventListener('online', onOnline);
    this.#unlisten = () => {
      offAuth();
      document.removeEventListener('visibilitychange', onVisibility);
      removeEventListener('online', onOnline);
    };
  }

  /* ------------------------------------------------------------------ */
  /* Actions. Each answers with the server's word, then looks again.     */
  /* ------------------------------------------------------------------ */

  /** Pause one of the viewer's own jobs (FL-104). A running one pauses at its next checkpoint. */
  async pauseOperation(id: string) {
    const updated = await pauseMediaOperation({ id });
    this.#applyOperation(updated);
    await this.refresh();
    this.#schedule();
    return updated;
  }

  /** Resume a paused job, or withdraw a pause not yet reached (FL-104). */
  async resumeOperation(id: string) {
    const updated = await resumeMediaOperation({ id });
    this.#applyOperation(updated);
    await this.refresh();
    this.#schedule();
    return updated;
  }

  /** Pause or resume a server queue. Administrators only; the server enforces it (FL-72). */
  async setQueuePaused(name: QueueName, isPaused: boolean) {
    const updated = await updateQueue({ name, queueUpdateDto: { isPaused } });
    this.summary = {
      ...this.summary,
      queues: this.summary.queues.map((queue) =>
        queue.name === name ? { ...queue, isPaused: updated.isPaused } : queue,
      ),
    };
    await this.refresh();
    this.#schedule();
    return updated;
  }

  #applyOperation(updated: RunningJobsResponseDto['operations'][number]) {
    this.summary = {
      ...this.summary,
      operations: this.summary.operations.map((operation) => (operation.id === updated.id ? updated : operation)),
    };
  }
}

export const runningJobsSession = new RunningJobsSession();
