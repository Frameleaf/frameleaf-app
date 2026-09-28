import { Mocked, vitest } from 'vitest';
import type { RepositoryInterface } from 'src/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';

export const newJobRepositoryMock = (): Mocked<RepositoryInterface<JobRepository>> => {
  return {
    setup: vitest.fn(),
    startWorkers: vitest.fn(),
    watchWorkers: vitest.fn(),
    teardown: vitest.fn(),
    run: vitest.fn(),
    setConcurrency: vitest.fn(),
    empty: vitest.fn(),
    pause: vitest.fn(),
    resume: vitest.fn(),
    searchJobs: vitest.fn(),
    queue: vitest.fn().mockImplementation(() => Promise.resolve()),
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
