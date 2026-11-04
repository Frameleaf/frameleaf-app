import { getCloudBackupStatus, type CloudBackupStatusResponseDto } from '@frameleaf/sdk';
import { cloudWorkRows } from '$lib/frameleaf/cloud-backup';

/** How often the status is read again while a backup or restore runs, and while none does. */
export const CLOUD_WORK_ACTIVE_POLL_MS = 5000;
export const CLOUD_WORK_IDLE_POLL_MS = 30_000;

/**
 * FL-164: the server's cloud backup operation and restore in progress, which an administrator sees as
 * background work. Activity and the top-bar indicator read this one copy, so both count the same
 * runs, including a scheduled backup another administrator owns. Watch it only as an administrator.
 */
export class CloudWorkSession {
  /** Null while unread, not set up or unreachable: nothing is shown as cloud work then. */
  status = $state<CloudBackupStatusResponseDto | null>(null);
  rows = $derived(cloudWorkRows(this.status));

  #subscribers = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #inFlight: Promise<void> | null = null;

  /** Ask the server now. Concurrent callers share the one request. */
  refresh(): Promise<void> {
    this.#inFlight ??= (async () => {
      try {
        this.status = await getCloudBackupStatus();
      } catch {
        this.status = null;
      }
    })().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  /** Start watching; returns the stop function. */
  watch(): () => void {
    this.#subscribers++;
    // A new viewer gets a current answer; the one timer then keeps the pace for everyone.
    void this.refresh().then(() => this.#schedule());
    return () => {
      this.#subscribers = Math.max(0, this.#subscribers - 1);
      if (this.#subscribers === 0 && this.#timer !== null) {
        clearTimeout(this.#timer);
        this.#timer = null;
      }
    };
  }

  #schedule() {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
    }
    this.#timer =
      this.#subscribers > 0
        ? setTimeout(
            () => void this.refresh().then(() => this.#schedule()),
            this.rows.length > 0 ? CLOUD_WORK_ACTIVE_POLL_MS : CLOUD_WORK_IDLE_POLL_MS,
          )
        : null;
  }
}

export const cloudWorkSession = new CloudWorkSession();
