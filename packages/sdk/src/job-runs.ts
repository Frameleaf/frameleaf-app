import type { RequestOpts } from "@oazapfts/runtime";
import {
  getJobRunItems,
  getJobRuns,
  type JobRunItemResponseDto,
  type JobRunPageDto,
  type JobRunResponseDto,
  type QueueRunDto,
  type RunningJobsResponseDto,
} from "./fetch-client.js";

/** UI conveniences derive their fields and enum values from the generated API contract. */
export type DurableJobOutcome = `${JobRunItemResponseDto["outcome"]}`;
export type DurableJobState = `${JobRunResponseDto["state"]}`;
export type DurableJobReason = `${JobRunResponseDto["reasons"][number]}`;
export type DurableJobCounts = JobRunResponseDto["stageTotals"];
export type DurableJobProgress = Pick<
  JobRunResponseDto,
  "stageTotals" | "lastProgressAt" | "lastStage"
> & { reasons: DurableJobReason[] };
export type DurableJobRun = Omit<JobRunResponseDto, "state" | "reasons"> & {
  state: DurableJobState;
  reasons: DurableJobReason[];
};
export type DurableJobItem = Omit<
  JobRunItemResponseDto,
  "outcome" | "reasons"
> & {
  outcome: DurableJobOutcome;
  reasons: DurableJobReason[];
};
export type DurableJobPage<T> = Omit<JobRunPageDto, "items"> & { items: T[] };
export type DurableQueueRun = Omit<QueueRunDto, "state"> & {
  state?: DurableJobState;
};
export type DurableRunningJobs = Omit<
  RunningJobsResponseDto,
  "queues" | "durableRuns"
> & {
  queues: DurableQueueRun[];
  durableRuns?: DurableJobRun[];
};

export const listDurableJobRuns = (
  { take = 25, skip = 0 }: Parameters<typeof getJobRuns>[0] = {},
  opts?: RequestOpts,
): Promise<DurableJobPage<DurableJobRun>> => getJobRuns({ take, skip }, opts);

export const listDurableJobRunItems = (
  { id, take = 25, skip = 0 }: Parameters<typeof getJobRunItems>[0],
  opts?: RequestOpts,
): Promise<DurableJobPage<DurableJobItem>> =>
  getJobRunItems({ id, take, skip }, opts);
