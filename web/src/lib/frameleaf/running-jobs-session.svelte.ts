import {
  getRunningJobs,
  pauseMediaOperation,
  resumeMediaOperation,
  updateQueue,
  type QueueName,
  type DurableRunningJobs,
} from '@frameleaf/sdk';
import { isPushConnected, isTabHidden } from '$lib/frameleaf/quiet-poll';
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
 * - every 2.5 s while the panel is open, because the person is watching the bars move;
 * - every 2.5 s while anything is running and the server is not saying so itself;
 * - every 30 s when nothing is running, or everything is paused, in case something new starts;
 * - not at all while the tab is hidden: the tab asks again the moment it is shown.
 *
 * FL-1794: for an administrator with the socket connected the server says when the queues move
 * (`on_queue_progress`) and when one of the account's own jobs changes (`on_media_operation_update`).
 * Each asks the summary again, at most once per fast interval, so running work costs no more
 * requests than the poll did and an idle server costs one every five minutes as a safeguard.
 *
 * Polling stops entirely when nothing is subscribed.
 */

/** While the panel is open or something is running. */
export const RUNNING_POLL_MS = 2500;
/** When everything has settled and the panel is closed. */
export const IDLE_POLL_MS = 30_000;
/** With the server announcing queue changes: the safeguard against an announcement that never arrived. */
export const PUSHED_POLL_MS = 300_000;

const EMPTY: DurableRunningJobs = { operations: [], memoryExports: [], queues: [], canManageQueues: false };

export class RunningJobsSession {
  summary = $state<DurableRunningJobs>(EMPTY);
  /** True until the first answer, so the panel can say it is loading instead of "nothing". */
  loading = $state(true);
  /** The last request failed. The rows stay; they are stale, not gone. */
  unreachable = $state(false);
  /** The panel is open: poll at the fast pace even when nothing is running. */
  panelOpen = $state(false);

  rows: RunningJobRow[] = $derived(buildRunningJobRows(this.summary));
  /** Rows actually doing something; paused work does not count. What the bell's badge shows. */
  activeCount = $derived(countActiveRunningJobs(this.rows));

  #epoch = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #subscribers = 0;
  #inFlight: Promise<void> | null = null;
  #unlisten: (() => void) | null = null;
  #nudge: ReturnType<typeof setTimeout> | null = null;
  #lastAsked = 0;

  /** Ask the server now. Concurrent callers share the one request. */
  refresh(): Promise<void> {
    this.#lastAsked = Date.now();
    this.#inFlight ??= this.#load().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #load(): Promise<void> {
    const epoch = this.#epoch;
    try {
      const next = ((await getRunningJobs()) ?? EMPTY) as DurableRunningJobs;
      if (epoch !== this.#epoch) {
        return;
      }
      this.summary = {
        ...next,
        queues: next.queues.map((queue) => {
          const previous = this.summary.queues.find((row) => row.name === queue.name);
          return queue.unavailable && previous
            ? {
                ...queue,
                active: previous.active,
                waiting: previous.waiting,
                processed: previous.processed,
                total: previous.total,
                startedAt: previous.startedAt,
              }
            : queue;
        }),
        durableRuns: next.canReadJobRuns && next.durableRunsUnavailable ? this.summary.durableRuns : next.durableRuns,
      };
      this.unreachable = !!next.durableRunsUnavailable || next.queues.some((queue) => queue.unavailable);
    } catch {
      // Keep the last answer on screen: the jobs are unaffected by this tab losing the server.
      if (epoch === this.#epoch) {
        this.unreachable = true;
      }
    } finally {
      if (epoch === this.#epoch) {
        this.loading = false;
      }
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
    if (isTabHidden()) {
      return null;
    }
    if (this.panelOpen) {
      return RUNNING_POLL_MS;
    }
    // Queue announcements go to administrators only; everyone else's running work is still polled.
    if (isPushConnected() && this.summary.canManageQueues) {
      return PUSHED_POLL_MS;
    }
    return this.activeCount > 0 ? RUNNING_POLL_MS : IDLE_POLL_MS;
  }

  /** The server said something changed: ask again, but never more often than the fast poll would. */
  #onPush() {
    if (this.#nudge !== null || isTabHidden()) {
      return;
    }
    this.#nudge = setTimeout(
      () => {
        this.#nudge = null;
        void this.refresh().then(() => this.#schedule());
      },
      Math.max(0, this.#lastAsked + RUNNING_POLL_MS - Date.now()),
    );
  }

  #stopNudge() {
    if (this.#nudge !== null) {
      clearTimeout(this.#nudge);
      this.#nudge = null;
    }
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
    const offEvents = eventManager.on({
      AuthLogout: () => {
        this.#epoch++;
        this.unreachable = false;
        this.summary = EMPTY;
        this.loading = true;
      },
      QueueProgress: () => this.#onPush(),
      MediaOperationUpdate: () => this.#onPush(),
      // announcements stop or start with the socket, and so does the pace
      WebsocketConnect: () => this.#onPush(),
      WebsocketDisconnect: () => this.#schedule(),
    });
    const offAuth = () => {
      offEvents();
      this.#stopNudge();
    };

    if (typeof document === 'undefined') {
      this.#unlisten = offAuth;
      return;
    }

    const onVisibility = () => {
      if (isTabHidden()) {
        this.#stop();
        this.#stopNudge();
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

  #applyOperation(updated: DurableRunningJobs['operations'][number]) {
    this.summary = {
      ...this.summary,
      operations: this.summary.operations.map((operation) => (operation.id === updated.id ? updated : operation)),
    };
  }
}

export const runningJobsSession = new RunningJobsSession();
