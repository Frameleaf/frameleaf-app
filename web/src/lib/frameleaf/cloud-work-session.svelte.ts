import { getCloudBackupStatus, type CloudBackupStatusResponseDto } from '@frameleaf/sdk';
import { cloudWorkRows } from '$lib/frameleaf/cloud-backup';
import { isPushConnected, isTabHidden } from '$lib/frameleaf/quiet-poll';
import { eventManager } from '$lib/managers/event-manager.svelte';

/** How often the status is read again while a backup or restore runs, and while none does and the socket is down. */
export const CLOUD_WORK_ACTIVE_POLL_MS = 5000;
export const CLOUD_WORK_IDLE_POLL_MS = 30_000;

/**
 * FL-164: the server's cloud backup operation and restore in progress, which an administrator sees as
 * background work. Activity and the top-bar indicator read this one copy, so both count the same
 * runs, including a scheduled backup another administrator owns. Watch it only as an administrator.
 *
 * FL-1800: with nothing running and the socket connected it asks nothing: a job change the server
 * announces, the socket reconnecting or the tab being shown reads the status again. A hidden tab asks nothing.
 * FL-1794: a backup another administrator started changes none of this account's jobs, so while the
 * server says its queues are moving (`on_queue_progress`) the idle look is kept, at its 30 seconds.
 */
export class CloudWorkSession {
  /** The server's last answer; null until the first. A server without cloud backup answers too. */
  status = $state<CloudBackupStatusResponseDto | null>(null);
  /** The last read failed. The status stays, stale rather than gone, so a running backup is not dropped. */
  unreachable = $state(false);
  rows = $derived(cloudWorkRows(this.status));

  #subscribers = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #inFlight: Promise<void> | null = null;
  #again = false;
  #unlisten: (() => void) | null = null;

  /**
   * Ask the server now. A call while a request is out asks once more after it, since that request may
   * have left before the change the caller saw; every caller waits for the answer it needs.
   */
  refresh(): Promise<void> {
    if (this.#inFlight) {
      this.#again = true;
      return this.#inFlight;
    }
    this.#inFlight = (async () => {
      do {
        this.#again = false;
        try {
          this.status = await getCloudBackupStatus();
          this.unreachable = false;
        } catch {
          this.unreachable = true;
        }
      } while (this.#again);
      // Cleared here, not in a later `finally`, so a call arriving after the last check starts a new request.
      this.#inFlight = null;
    })();
    return this.#inFlight;
  }

  /** Start watching; returns the stop function. */
  watch(): () => void {
    this.#subscribers++;
    if (this.#subscribers === 1) {
      this.#listen();
    }
    // A new viewer gets a current answer; the one timer then keeps the pace for everyone.
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

  #listen() {
    const again = () => {
      if (!isTabHidden()) {
        void this.refresh().then(() => this.#schedule());
      }
    };
    const unsubscribe = eventManager.on({
      WebsocketConnect: again,
      // a backup or restore is one of the account's jobs; `refresh` folds a burst into one more read
      MediaOperationUpdate: again,
      WebsocketDisconnect: () => this.#schedule(),
      QueueProgress: () => this.#lookLater(),
    });
    if (typeof document === 'undefined') {
      this.#unlisten = unsubscribe;
      return;
    }
    const onVisibility = () => (isTabHidden() ? this.#stop() : again());
    document.addEventListener('visibilitychange', onVisibility);
    this.#unlisten = () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }

  /** The server is working on something: look once more at the idle pace, unless a look is already due. */
  #lookLater() {
    if (this.#timer === null && this.#subscribers > 0 && !isTabHidden()) {
      this.#timer = setTimeout(() => void this.refresh().then(() => this.#schedule()), CLOUD_WORK_IDLE_POLL_MS);
    }
  }

  #stop() {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #schedule() {
    this.#stop();
    const idle = this.rows.length === 0;
    if (this.#subscribers <= 0 || isTabHidden() || (idle && isPushConnected())) {
      return;
    }
    this.#timer = setTimeout(
      () => void this.refresh().then(() => this.#schedule()),
      idle ? CLOUD_WORK_IDLE_POLL_MS : CLOUD_WORK_ACTIVE_POLL_MS,
    );
  }
}

export const cloudWorkSession = new CloudWorkSession();
