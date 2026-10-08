import { getQueues, type QueueResponseDto } from '@frameleaf/sdk';
import { DateTime } from 'luxon';
import { eventManager } from '$lib/managers/event-manager.svelte';
import type { QueueSnapshot } from '$lib/types';

export class QueueManager {
  #snapshots = $state<QueueSnapshot[]>([]);
  // The last list the server gave. A poll that fails, or a tick nobody is listening to, records a
  // gap in the history but leaves this alone, so the page keeps what it showed instead of emptying.
  #queues = $state<QueueResponseDto[]>([]);

  #interval?: ReturnType<typeof setInterval>;
  #listenerCount = 0;

  get snapshots() {
    return this.#snapshots;
  }

  get queues() {
    return this.#queues;
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

    return () => this.#listenerCount--;
  }

  async refresh(tick = false) {
    const snapshot = this.#listenerCount > 0 || !tick ? await getQueues().catch(() => undefined) : undefined;
    if (snapshot) {
      this.#queues = snapshot;
    }
    this.#snapshots.push({ timestamp: DateTime.now().toMillis(), snapshot });
    this.#snapshots = this.#snapshots.slice(-30);
  }
}

export const queueManager = new QueueManager();
