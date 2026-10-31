import {
  emptyQueue,
  getQueue,
  QueueCommand,
  runQueueCommandLegacy,
  updateQueue,
  type QueueResponseDto,
  retryFailedQueueJobs,
} from '@frameleaf/sdk';
import { eventManager } from '$lib/managers/event-manager.svelte';

/*
 * Queue commands (FL-71). The Job manager (`JobsManager.svelte`) sends every one of them through
 * its review, including from the command palette; these only talk to the server and announce the
 * queue's new state.
 */

export const handlePauseQueue = async (queue: Pick<QueueResponseDto, 'name'>) => {
  const response = await updateQueue({ name: queue.name, queueUpdateDto: { isPaused: true } });
  eventManager.emit('QueueUpdate', response);
};

export const handleResumeQueue = async (queue: Pick<QueueResponseDto, 'name'>) => {
  const response = await updateQueue({ name: queue.name, queueUpdateDto: { isPaused: false } });
  eventManager.emit('QueueUpdate', response);
};

/** Removes the queue's waiting jobs; active, delayed and failed jobs remain. */
export const handleClearWaitingJobs = async (queue: Pick<QueueResponseDto, 'name'>) => {
  await emptyQueue({ name: queue.name, queueDeleteDto: { failed: false } });
  eventManager.emit('QueueUpdate', await getQueue({ name: queue.name }));
};

/**
 * Removes the queue's failed job records (at most 1,000 per request); waiting, delayed and active
 * jobs remain. Only the queue command clears failed jobs alone: `emptyQueue` with `failed` also
 * drains the waiting jobs.
 */
export const handleClearFailedJobs = async (queue: Pick<QueueResponseDto, 'name'>) => {
  await runQueueCommandLegacy({
    name: queue.name,
    queueCommandDto: { command: QueueCommand.ClearFailed, force: false },
  });
  eventManager.emit('QueueUpdate', await getQueue({ name: queue.name }));
};

/** FL-71 "Retry failed" (`JobsManager.jsx` 715-727): every failed job goes back in the queue. */
export const handleRetryFailedJobs = async (queue: Pick<QueueResponseDto, 'name'>) => {
  await retryFailedQueueJobs({ name: queue.name });
  eventManager.emit('QueueUpdate', await getQueue({ name: queue.name }));
};
