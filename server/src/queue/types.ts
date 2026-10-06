import type { Transaction } from 'kysely';
import type { JobItem } from 'src/types.js';
import { readQueueDeadlineProfiles } from 'src/queue/configuration.js';

export const QUEUE_TIMING = {
  heartbeat: 15_000,
  lease: 60_000,
  sweep: 30_000,
  scan: 5000,
  ...readQueueDeadlineProfiles(),
  retryDelay: 30_000,
} as const;
export const QUEUE_BATCH = 250;
export const QUEUE_HIGH_WATER = 1000;
export const QUEUE_LOW_WATER = 500;
export type QueueState =
  'pending' | 'waiting' | 'active' | 'completed' | 'failed' | 'needs_attention' | 'cancelled' | 'blocked';
export const TERMINAL_QUEUE_STATES: QueueState[] = ['completed', 'failed', 'needs_attention', 'cancelled', 'blocked'];
export type QueueOptions = {
  jobId?: string;
  delay?: number;
  deduplication?: { id: string; keepLastIfActive?: boolean };
};
export type QueueIntent = {
  queue: string;
  name: string;
  data: Record<string, unknown>;
  options?: QueueOptions;
  safeToRetry: boolean;
  sensitive: boolean;
  deadlineMs: number;
  runId?: string;
  itemKey?: string;
  rootItemKey?: string | null;
  parentId?: string;
  /** Internal accounting identities sharing this one accepted execution, including deferred latest requests. */
  memberships?: Array<{ runId: string; itemKey: string; rootItemKey: string | null }>;
};
export type JobDependencyReason =
  | 'workload-disabled'
  | 'destination-unavailable'
  | 'destination-configuration'
  | 'destination-consent'
  | 'destination-budget'
  | 'source-unavailable'
  | 'local-capacity';
export type QueueClaim = {
  id: string;
  queue: string;
  name: string;
  data: Record<string, unknown>;
  token: string;
  workerId: string;
  attempt: number;
  runId: string | null;
  itemKey: string | null;
  rootItemKey?: string | null;
  deadlineMs: number;
  startedAt: Date;
  safeToRetry?: boolean;
};
export type QueueExecution = {
  claim: QueueClaim;
  signal: AbortSignal;
  /** A handler must report actual new bytes/frames/items, never a timer tick. */
  progress: (units: number) => void;
  followups: QueueIntent[];
  adoptions: Array<(tx: Transaction<any>) => Promise<void>>;
  failureDiagnostics?: Array<(tx: Transaction<any>) => Promise<void>>;
  /** Database-only owner settlement, accepted with a failed claim only after confirmed executor stop. */
  failureSettlements?: Array<(tx: Transaction<any>, reason: string, cancelled: boolean) => Promise<void>>;
  afterCommit?: Array<() => Promise<void>>;
  buffering: boolean;
  progressUnits: number;
  outcome?: 'completed' | 'failed';
  dependencyReason?: JobDependencyReason;
};
export type QueueDispatch = { type: 'execute'; claim: QueueClaim } | { type: 'cancel'; id: string };
export type QueueWorkerMessage =
  { type: 'settled'; id: string } | { type: 'progress'; id: string; units: number } | { type: 'stop' };
export const toJobItem = (claim: QueueClaim) => ({ name: claim.name, data: claim.data }) as JobItem;
