import type { ColumnType, Generated } from 'kysely';
import type { QueueIntent, QueueState } from 'src/queue/types.js';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
export interface JobQueueTable {
  name: string;
  paused: Generated<boolean>;
  concurrency: Generated<number>;
}
export interface JobWorkerTable {
  id: string;
  startedAt: Generated<Timestamp>;
  heartbeatAt: Generated<Timestamp>;
  state: Generated<'running' | 'stopping' | 'lost'>;
}
export interface JobRunTable {
  id: string;
  kind: string;
  selection: Record<string, unknown>;
  enumerationDone: Generated<boolean>;
  createdAt: Generated<Timestamp>;
  finishedAt: Timestamp | null;
}
export interface JobRunItemTable {
  runId: string;
  itemKey: string;
  rootItemKey: string | null;
  stage: string;
  queue: string;
  selection: Record<string, unknown>;
  state: Generated<QueueState>;
  jobId: string | null;
  selectionVersion: Generated<number>;
}
export interface JobTable {
  id: string;
  queue: string;
  name: string;
  data: Record<string, unknown>;
  state: Generated<QueueState>;
  dedupKey: string | null;
  externalId: string | null;
  latestPending: QueueIntent | null;
  safeToRetry: boolean;
  sensitive: Generated<boolean>;
  deadlineMs: number;
  attempt: Generated<number>;
  retryBaseAttempt: Generated<number>;
  runId: string | null;
  itemKey: string | null;
  rootItemKey: string | null;
  parentId: string | null;
  token: string | null;
  workerId: string | null;
  availableAt: Generated<Timestamp>;
  createdAt: Generated<Timestamp>;
  startedAt: Timestamp | null;
  finishedAt: Timestamp | null;
  leaseExpiresAt: Timestamp | null;
  progressAt: Timestamp | null;
  progressUnits: Generated<string>;
  cancelRequestedAt: Timestamp | null;
  cancelReason: 'deadline' | 'request' | null;
  dependencyReason: string | null;
  error: string | null;
}
export interface JobAttemptTable {
  jobId: string;
  attempt: number;
  token: string;
  workerId: string;
  startedAt: Generated<Timestamp>;
  finishedAt: Timestamp | null;
  outcome: string | null;
  error: string | null;
}
export interface QueueDatabase {
  job: JobTable;
  job_attempt: JobAttemptTable;
  job_queue: JobQueueTable;
  job_worker: JobWorkerTable;
  job_run: JobRunTable;
  job_run_item: JobRunItemTable;
  job_selection_run: {
    runId: string;
    selectionId: string;
    copyAfter: string | null;
    lineageAfter: Generated<string>;
    copyComplete: Generated<boolean>;
  };
  job_selection_lineage: {
    id: Generated<string>;
    selectionId: string;
    runId: string;
    itemKey: string;
    stage: string;
    superseded: Generated<boolean>;
  };
}
