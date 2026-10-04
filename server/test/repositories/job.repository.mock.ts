import { Mocked, vitest } from 'vitest';
import type { RepositoryInterface } from 'src/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';

export const newJobRepositoryMock = (): Mocked<RepositoryInterface<JobRepository>> => {
  return {
    setup: vitest.fn(),
    pinDestination: vitest.fn().mockImplementation(async (_workload, destinationId) => destinationId),
    collectFollowups: vitest.fn().mockImplementation((action) => action()),
    createRun: vitest.fn().mockImplementation(async (_kind, _selection, enqueue) => {
      await enqueue();
      return 'test-run';
    }),
    listRuns: vitest.fn().mockResolvedValue([]),
    dispatchImportedWork: vitest.fn().mockResolvedValue(0),
    startWorkers: vitest.fn(),
    stopWorkers: vitest.fn().mockResolvedValue(undefined),
    watchWorkers: vitest.fn(),
    teardown: vitest.fn(),
    run: vitest.fn(),
    setConcurrency: vitest.fn(),
    empty: vitest.fn(),
    pause: vitest.fn(),
    resume: vitest.fn(),
    searchJobs: vitest.fn(),
    queue: vitest.fn().mockImplementation(() => Promise.resolve()),
    queueSelection: vitest.fn().mockResolvedValue(undefined),
    queueAll: vitest.fn().mockImplementation(() => Promise.resolve()),
    isActive: vitest.fn(),
    isPaused: vitest.fn(),
    getJobCounts: vitest.fn(),
    observeQueueRun: vitest.fn().mockResolvedValue({ active: 0, waiting: 0, processed: 0, startedAt: null }),
    hasDedupJob: vitest.fn(),
    getRollingAvgMs: vitest.fn().mockReturnValue(null),
    clear: vitest.fn(),
    retryFailed: vitest.fn(),
    waitForQueueCompletion: vitest.fn(),
    removeJob: vitest.fn(),
  };
};
