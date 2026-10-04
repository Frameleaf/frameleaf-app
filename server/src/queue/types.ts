import type { Transaction } from 'kysely';
import type { JobItem } from 'src/types.js';

export const QUEUE_TIMING = {
  heartbeat: 15_000,
  lease: 60_000,
  sweep: 30_000,
  scan: 5000,
  opaqueDeadline: 10 * 60_000,
  mlDeadline: 30 * 60_000,
  noProgressDeadline: 10 * 60_000,
  cancelGrace: 10_000,
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
  parentId?: string;
};
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
  deadlineMs: number;
  startedAt: Date;
};
export type QueueExecution = {
  claim: QueueClaim;
  signal: AbortSignal;
  /** A handler must report actual new bytes/frames/items, never a timer tick. */
  progress: (units: number) => void;
  followups: QueueIntent[];
  adoptions: Array<(tx: Transaction<any>) => Promise<void>>;
  buffering: boolean;
  progressUnits: number;
  outcome?: 'completed' | 'failed';
};
export type QueueDispatch = { type: 'execute'; claim: QueueClaim } | { type: 'cancel'; id: string };
export type QueueWorkerMessage =
  { type: 'settled'; id: string } | { type: 'progress'; id: string; units: number } | { type: 'stop' };
export const toJobItem = (claim: QueueClaim) => ({ name: claim.name, data: claim.data }) as JobItem;
