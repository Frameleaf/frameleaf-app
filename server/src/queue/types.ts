import type { Transaction } from 'kysely';
import type { JobItem } from 'src/types.js';
import type { AssetSourceSnapshot } from 'src/utils/asset-source-authority.js';
import { automaticJobCapacity, readJobCapacity, readQueueDeadlineProfiles } from 'src/queue/configuration.js';

export const QUEUE_TIMING = {
  heartbeat: 15_000,
  lease: 60_000,
  sweep: 30_000,
  /** how long one sweep keeps pruning full pages of finished jobs (FL-1213) */
  pruneBudget: 5000,
  scan: 5000,
  ...readQueueDeadlineProfiles(),
  retryDelay: 30_000,
} as const;
export const QUEUE_BATCH = 250;
/** Jobs run at once across all queues at startup; Settings can change it live (`JobRepository.setExecutionCapacity`). */
export const QUEUE_EXECUTION_CAPACITY: number = readJobCapacity() ?? automaticJobCapacity();
/** FL-1265: why a run's stage is held. A held job is pending with `availableAt = 'infinity'`. */
export type RunHoldReason = 'setup' | 'paused' | 'parked';
/** `job_run.selection.holds`, keyed by job name. */
export type RunHolds = Partial<Record<string, RunHoldReason>>;
export type LibrarySourceIdentity = { operationId: string; libraryId: string };
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
  /** FL-1479: runs ahead of the backlog, as an arrival does (the next step of work that was itself at the front). */
  front?: boolean;
};
export type JobDependencyReason =
  | 'workload-disabled'
  | 'destination-unavailable'
  | 'destination-capacity'
  | 'destination-configuration'
  | 'destination-consent'
  | 'destination-budget'
  | 'source-unavailable'
  | 'local-capacity'
  /**
   * FL-721: the job reads an encrypted Locked file and no key that opens it is loaded (or the RAM-backed
   * temporary folder is unusable). Internal only: run reasons show it as `dependency_unavailable`.
   */
  | 'locked-key-unavailable';
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
  sourceAuthorities?: Map<
    string,
    { ownerId: string; snapshot: AssetSourceSnapshot; assertCurrent: (tx?: Transaction<any>) => Promise<void> }
  >;
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
  followupCollection?: { active: number; buffering: boolean };
  progressUnits: number;
  outcome?: 'completed' | 'failed';
  dependencyReason?: JobDependencyReason;
  /** FL-1337: this attempt handed its photo to Library care. It ends with the attempt; no other attempt sees it. */
  handedToCare?: true;
  /** FL-1482: the last warning or error the handler logged; why it failed, when it returns Failed without throwing. */
  lastProblem?: string;
};
export type QueueDispatch =
  | { type: 'execute'; claim: QueueClaim }
  | { type: 'cancel'; id: string }
  /** Run holds failed to reach their jobs this many times in a row (`code` is the database error code, if any). */
  | { type: 'holdsFailing'; failures: number; code?: string };
export type QueueWorkerMessage =
  | { type: 'settled'; id: string }
  | { type: 'progress'; id: string; units: number }
  | { type: 'capacity'; value: number }
  | { type: 'stop' };
export const toJobItem = (claim: QueueClaim) => ({ name: claim.name, data: claim.data }) as JobItem;

/**
 * FL-1459: what brought a run's photos in (`job_run.origin`). A plain string in the API, never an enum, so more can
 * come without breaking strict clients.
 */
export type RunOrigin = 'phone' | 'computer' | 'client' | 'link' | 'library' | 'import';
/** The run uploads from one device or app share (`JobRepository.queueUpload`). */
export const UPLOAD_RUN_KIND = 'upload';
