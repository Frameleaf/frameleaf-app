import type { DurableJobRun, DurableQueueRun, DurableRunningJobs, QueueName } from '@frameleaf/sdk';
import { isRunSettled, settledItems } from '$lib/frameleaf/durable-runs';
import { JOB_QUEUES } from '$lib/frameleaf/job-queues';

/**
 * Activity's "Background work" cards (SHARING-P1; prototype Activity.jsx `BackgroundRow` and
 * activity-feed.mjs `summariseBackgroundQueues`).
 *
 * One card per kind of work the server is busy with: Thumbnails, Metadata, Face detection, Search
 * indexing… Each says only what a household needs: whether it is waiting, running or paused, how many
 * items are waiting and running, and how far the running work has got. Stage totals, prerequisites,
 * destinations and run ids stay on the Background work settings page, which every card opens.
 *
 * The server sends queues and durable runs to administrators only, so everybody else gets no cards.
 * A queue and an unfinished durable run of the same kind make one card. Idle kinds make none.
 */

export type BackgroundWorkStage = 'queued' | 'running' | 'paused';

export type BackgroundWorkCard = {
  id: string;
  queueName: QueueName;
  stage: BackgroundWorkStage;
  /** Items waiting their turn, including paused and scheduled ones. */
  waiting: number;
  /** Items being worked on now. */
  running: number;
  /** 0–100 while running, when the server counts a total; otherwise null. */
  progress: number | null;
};

const percent = (done: number, total: number) =>
  total > 0 ? Math.min(100, Math.max(0, Math.floor((done / total) * 100))) : null;

const fromQueue = (queue: DurableQueueRun): BackgroundWorkCard | null => {
  const running = queue.active;
  const waiting = queue.waiting;
  if (running + waiting <= 0) {
    return null;
  }
  const paused = queue.isPaused || queue.state === 'paused';
  const stage: BackgroundWorkStage = paused ? 'paused' : running > 0 ? 'running' : 'queued';
  const total = Math.max(queue.total, queue.processed + running + waiting);
  return {
    id: `queue:${queue.name}`,
    queueName: queue.name,
    stage,
    waiting,
    running,
    progress: stage === 'running' && !queue.unavailable ? percent(Math.min(queue.processed, total), total) : null,
  };
};

const fromRun = (run: DurableJobRun): BackgroundWorkCard | null => {
  if (isRunSettled(run)) {
    return null;
  }
  const running = run.active;
  const waiting = run.waiting + run.delayed + run.paused + run.blocked + run.retrying;
  if (running + waiting <= 0) {
    return null;
  }
  const stage: BackgroundWorkStage =
    run.state === 'paused' ? 'paused' : running > 0 || run.state === 'running' ? 'running' : 'queued';
  return {
    id: `run:${run.id}`,
    queueName: run.kind as QueueName,
    stage,
    waiting,
    running,
    progress: stage === 'running' && run.enumerationDone ? percent(settledItems(run), run.total) : null,
  };
};

const order = (name: QueueName) => {
  const index = JOB_QUEUES.findIndex((queue) => queue.name === name);
  return index === -1 ? JOB_QUEUES.length : index;
};

/**
 * The cards, in the Background work page's order of kinds. A busy queue speaks for its kind; a run
 * only adds a card for a kind whose queue is idle, so the same items are never counted twice.
 */
export const buildBackgroundWorkCards = (summary: DurableRunningJobs | null | undefined): BackgroundWorkCard[] => {
  if (!summary) {
    return [];
  }
  const queues = summary.canManageQueues ? summary.queues.map((queue) => fromQueue(queue)) : [];
  const runs = summary.canReadJobRuns ? (summary.durableRuns ?? []).map((run) => fromRun(run)) : [];

  const byKind = new Map<QueueName, BackgroundWorkCard>();
  for (const card of queues) {
    if (card) {
      byKind.set(card.queueName, card);
    }
  }
  for (const card of runs) {
    if (!card) {
      continue;
    }
    const existing = byKind.get(card.queueName);
    if (!existing) {
      byKind.set(card.queueName, card);
    } else if (existing.id.startsWith('run:')) {
      // Two unfinished runs of one kind: one card with both runs' items.
      const stage = existing.stage === 'running' || card.stage === 'running' ? 'running' : existing.stage;
      byKind.set(card.queueName, {
        ...existing,
        stage,
        waiting: existing.waiting + card.waiting,
        running: existing.running + card.running,
        progress: stage === 'running' ? (existing.progress ?? card.progress) : null,
      });
    }
  }
  return [...byKind.values()].sort((a, b) => order(a.queueName) - order(b.queueName));
};
