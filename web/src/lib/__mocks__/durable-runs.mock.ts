import { type DurableJobRun, type JobRunResponseDto, QueueName } from '@frameleaf/sdk';

export const durableRun = (overrides: Partial<DurableJobRun> = {}): JobRunResponseDto => {
  const run: DurableJobRun = {
    id: '0195e2a0-0000-7000-8000-000000000001',
    kind: QueueName.ThumbnailGeneration,
    createdAt: '2026-10-04T10:00:00.000Z',
    finishedAt: null,
    enumerationDone: true,
    total: 15_000,
    completed: 14_990,
    failed: 1,
    needsAttention: 1,
    cancelled: 0,
    active: 8,
    retrying: 0,
    delayed: 0,
    paused: 0,
    waiting: 0,
    blocked: 0,
    stageTotals: {
      total: 75_000,
      completed: 74_950,
      failed: 5,
      needsAttention: 5,
      cancelled: 0,
      active: 40,
      retrying: 0,
      delayed: 0,
      paused: 0,
      waiting: 0,
      blocked: 0,
    },
    state: 'running',
    lastProgressAt: '2026-10-04T10:01:00.000Z',
    lastStage: 'AssetThumbnailGeneration',
    reasons: ['stage_failed'],
    noDispatchBacklog: false,
    ...overrides,
  };
  // The convenience literals come directly from these generated string enums.
  return {
    ...run,
    state: run.state as JobRunResponseDto['state'],
    reasons: run.reasons as JobRunResponseDto['reasons'],
  };
};
