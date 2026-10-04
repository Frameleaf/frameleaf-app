import * as Oazapfts from "@oazapfts/runtime";
import {
  defaults,
  type QueueRunDto,
  type RunningJobsResponseDto,
} from "./fetch-client.js";

/** Temporary adapter for hosted OpenAPI generation; generated source is never edited here. */
export type DurableJobOutcome =
  | "completed"
  | "failed"
  | "needsAttention"
  | "cancelled"
  | "active"
  | "retrying"
  | "delayed"
  | "paused"
  | "waiting"
  | "blocked";
export type DurableJobState =
  | "running"
  | "retrying"
  | "delayed"
  | "paused"
  | "waiting"
  | "blocked"
  | "unavailable"
  | "needs_attention"
  | "completed"
  | "completed_with_errors"
  | "cancelled";
export type DurableJobReason =
  | "worker_unavailable"
  | "no_dispatch_backlog"
  | "dependency_wait"
  | "dependency_failed"
  | "retry_backoff"
  | "scheduled_delay"
  | "queue_paused"
  | "needs_attention"
  | "stage_failed"
  | "enumerating";
export type DurableJobCounts = Record<DurableJobOutcome, number> & {
  total: number;
};
export type DurableJobProgress = {
  stageTotals: DurableJobCounts;
  lastProgressAt: string | null;
  lastStage: string | null;
  reasons: DurableJobReason[];
};
export type DurableJobRun = DurableJobCounts &
  DurableJobProgress & {
    id: string;
    kind: string;
    createdAt: string;
    finishedAt: string | null;
    enumerationDone: boolean;
    state: DurableJobState;
    noDispatchBacklog: boolean;
  };
export type DurableJobItem = DurableJobProgress & {
  id: string;
  outcome: DurableJobOutcome;
};
export type DurableJobPage<T> = { items: T[]; hasNextPage: boolean };
export type DurableQueueRun = QueueRunDto & {
  unavailable?: boolean;
  state?: DurableJobState;
  noDispatchBacklog?: boolean;
  lastProgressAt?: string | null;
};
export type DurableRunningJobs = Omit<RunningJobsResponseDto, "queues"> & {
  queues: DurableQueueRun[];
  durableRuns?: DurableJobRun[];
  canReadJobRuns?: boolean;
  durableRunsUnavailable?: boolean;
};
const client = Oazapfts.runtime(defaults);
const pageQuery = ({ take = 25, skip = 0 }: { take?: number; skip?: number }) =>
  `take=${take}&skip=${skip}`;
export const listDurableJobRuns = (
  page: { take?: number; skip?: number } = {},
  opts?: Oazapfts.RequestOpts,
) =>
  client.ok(
    client.fetchJson<{ status: 200; data: DurableJobPage<DurableJobRun> }>(
      `/jobs/runs?${pageQuery(page)}`,
      { ...opts },
    ),
  );
export const listDurableJobRunItems = (
  { id, ...page }: { id: string; take?: number; skip?: number },
  opts?: Oazapfts.RequestOpts,
) =>
  client.ok(
    client.fetchJson<{ status: 200; data: DurableJobPage<DurableJobItem> }>(
      `/jobs/runs/${encodeURIComponent(id)}/items?${pageQuery(page)}`,
      { ...opts },
    ),
  );
