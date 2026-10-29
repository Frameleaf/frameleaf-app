import { getQueues, type QueueResponseDto } from '@frameleaf/sdk';
import { DateTime } from 'luxon';
import { eventManager } from '$lib/managers/event-manager.svelte';
import type { QueueSnapshot } from '$lib/types';

export class QueueManager {
  #snapshots = $state<QueueSnapshot[]>([]);
  /** The last answer the server gave: a failed or skipped poll keeps the page's queues on screen. */
  #queues: QueueResponseDto[] = $derived(this.#snapshots.findLast((entry) => entry.snapshot)?.snapshot ?? []);
  /** The newest poll failed; `queues` still holds the answer before it. */
  #failed = $derived(this.#snapshots.length > 0 && this.#snapshots.at(-1)?.snapshot === undefined);

  #interval?: ReturnType<typeof setInterval>;
  #listenerCount = 0;
  #refreshing = 0;
  /** Bumped when the last listener leaves: a refresh from before then no longer holds back the ticks. */
  #session = 0;

  get snapshots() {
    return this.#snapshots;
  }

  get queues() {
    return this.#queues;
  }

  get failed() {
    return this.#failed;
  }

  constructor() {
    eventManager.on({
      QueueUpdate: () => this.refresh(),
    });
  }

  listen() {
    if (!this.#interval) {
      this.#interval = setInterval(() => void this.refresh(true), 3000);
    }

    this.#listenerCount++;
    void this.refresh();

    let listening = true;
    return () => {
      if (!listening) {
        return;
      }
      listening = false;
      if (--this.#listenerCount === 0) {
        clearInterval(this.#interval);
        this.#interval = undefined;
        this.#session++;
        this.#refreshing = 0;
      }
    };
  }

  async refresh(tick = false) {
    // A timer tick skips a hidden tab and never stacks a request on one still waiting: on a busy
    // server every queue's counts can take longer than the poll interval.
    if (tick && (this.#refreshing > 0 || document.hidden)) {
      return;
    }
    // a count, not a flag: a direct refresh (a new listener, a queue update) may overlap another, and
    // the first to settle must not clear the guard while the other is still waiting
    const session = this.#session;
    this.#refreshing++;
    try {
      const snapshot = this.#listenerCount > 0 || !tick ? await getQueues().catch(() => undefined) : undefined;
      // an answer from before the last listener left is older than whatever a later listener has
      if (session !== this.#session) {
        return;
      }
      this.#snapshots.push({ timestamp: DateTime.now().toMillis(), snapshot });
      this.#snapshots = this.#snapshots.slice(-30);
    } finally {
      if (session === this.#session) {
        this.#refreshing--;
      }
    }
  }
}

export const queueManager = new QueueManager();
