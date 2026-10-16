import { QueueName, type DurableJobRun, type DurableQueueRun, type DurableRunningJobs } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { buildBackgroundWorkCards } from '$lib/frameleaf/background-work';

const queue = (name: QueueName, patch: Partial<DurableQueueRun> = {}): DurableQueueRun => ({
  name,
  isPaused: false,
  canPause: true,
  active: 0,
  waiting: 0,
  processed: 0,
  total: 0,
  startedAt: null,
  ...patch,
});

const counts = { active: 0, blocked: 0, cancelled: 0, completed: 0, delayed: 0, failed: 0 };
const run = (kind: QueueName, patch: Partial<DurableJobRun> = {}): DurableJobRun => ({
  id: `run-${kind}`,
  kind,
  createdAt: '2026-10-16T06:18:27.069Z',
  finishedAt: null,
  enumerationDone: true,
  total: 104,
  ...counts,
  completed: 84,
  needsAttention: 0,
  paused: 20,
  retrying: 0,
  waiting: 0,
  stageTotals: { ...counts, completed: 460, needsAttention: 0, paused: 77, retrying: 0, total: 537, waiting: 0 },
  state: 'paused',
  lastProgressAt: null,
  lastStage: 'SmartSearch',
  reasons: ['dependency_unavailable', 'queue_paused'],
  noDispatchBacklog: false,
  ...patch,
});

const summary = (patch: Partial<DurableRunningJobs>): DurableRunningJobs => ({
  operations: [],
  memoryExports: [],
  queues: [],
  canManageQueues: true,
  canReadJobRuns: true,
  durableRuns: [],
  ...patch,
});

describe('buildBackgroundWorkCards (SHARING-P1)', () => {
  it('makes one card per busy kind of work, in the Background work order, and none for idle ones', () => {
    const cards = buildBackgroundWorkCards(
      summary({
        queues: [
          queue(QueueName.SmartSearch, { isPaused: true, waiting: 52, total: 52 }),
          queue(QueueName.ThumbnailGeneration, { active: 2, waiting: 18, processed: 30, total: 50 }),
          queue(QueueName.Ocr),
        ],
      }),
    );

    expect(
      cards.map(({ queueName, stage, waiting, running, progress }) => [queueName, stage, waiting, running, progress]),
    ).toEqual([
      [QueueName.ThumbnailGeneration, 'running', 18, 2, 60],
      [QueueName.SmartSearch, 'paused', 52, 0, null],
    ]);
  });

  it('counts an unfinished run once, only for a kind whose queue is idle, without its stages', () => {
    const cards = buildBackgroundWorkCards(
      summary({
        queues: [queue(QueueName.FaceDetection, { isPaused: true, waiting: 52, total: 52 })],
        durableRuns: [run(QueueName.MetadataExtraction), run(QueueName.FaceDetection, { id: 'other' })],
      }),
    );

    expect(cards).toHaveLength(2);
    expect(cards[0]).toEqual({
      id: 'run:run-metadataExtraction',
      queueName: QueueName.MetadataExtraction,
      stage: 'paused',
      waiting: 20,
      running: 0,
      progress: null,
    });
    // The face detection queue speaks for its kind; the run of the same kind adds nothing.
    expect(cards[1]).toMatchObject({ queueName: QueueName.FaceDetection, waiting: 52 });
  });

  it('shows nothing to somebody the server sends no queues or runs to', () => {
    expect(
      buildBackgroundWorkCards(
        summary({
          canManageQueues: false,
          canReadJobRuns: false,
          queues: [queue(QueueName.ThumbnailGeneration, { active: 1 })],
          durableRuns: [run(QueueName.MetadataExtraction)],
        }),
      ),
    ).toEqual([]);
  });
});
