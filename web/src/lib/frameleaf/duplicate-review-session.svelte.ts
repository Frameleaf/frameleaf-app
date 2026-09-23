import {
  createBulkMediaOperation,
  getDuplicateDecisions,
  getDuplicateReview,
  getMediaOperation,
  MediaOperationBulkAction,
  type DuplicateDecisionBatchDto,
  type DuplicateDecisionHistoryDto,
  type MediaOperationDetailDto,
  type MediaOperationDto,
  type MediaOperationDuplicateGroupDto,
} from '@immich/sdk';
import { SvelteMap } from 'svelte/reactivity';
import {
  decisionAssetIds,
  decisionParts,
  groupProgressFrom,
  isFinishedOperation,
  undoableBatches,
  undoGroupsFor,
  type GroupProgress,
  type ReviewGroup,
} from '$lib/frameleaf/duplicate-review';

/**
 * The live state of the duplicate review page (FL-61): the groups, the decisions it can undo, and
 * the jobs working on them.
 *
 * Every decision is a durable bulk job on the server. The page never changes a photo itself: it
 * submits the job, puts a loader on each group the job holds, follows the job, and when the job has
 * finished reads the review again, so what it shows is always the server's answer. A reload loses
 * nothing: running jobs and undoable decisions both come back from `getDuplicateDecisions`.
 */

export type DuplicateReviewGateway = {
  getReview: () => Promise<ReviewGroup[]>;
  getHistory: () => Promise<DuplicateDecisionHistoryDto>;
  submit: (
    action: MediaOperationBulkAction,
    groups: MediaOperationDuplicateGroupDto[],
    requestId?: string,
  ) => Promise<MediaOperationDto>;
  getOperation: (id: string) => Promise<MediaOperationDetailDto>;
};

export const duplicateReviewGateway: DuplicateReviewGateway = {
  getReview: () => getDuplicateReview(),
  getHistory: () => getDuplicateDecisions(),
  submit: (action, groups, requestId) =>
    createBulkMediaOperation({
      mediaOperationBulkCreateDto: {
        action,
        assetIds: decisionAssetIds(groups),
        payload: { duplicateGroups: groups },
        ...(requestId && { requestId }),
        submittedTotal: groups.length,
      },
    }),
  getOperation: (id) => getMediaOperation({ id }),
};

/** How often a running decision job is asked where it is. Matches the library's tile loaders. */
export const DUPLICATE_REVIEW_POLL_MS = 2500;

export type TrackedJob = {
  action: MediaOperationBulkAction;
  groups: Pick<MediaOperationDuplicateGroupDto, 'duplicateId' | 'memberIds'>[];
};

/**
 * A v4 idempotency key. `randomUUID` needs a secure context, which a server reached over plain HTTP on
 * a home network is not; `getRandomValues` works everywhere. Without either the job is sent without a
 * key, as the library's bulk actions do.
 */
export const newRequestId = (): string | undefined => {
  const api = crypto;
  if (typeof api?.randomUUID === 'function') {
    return api.randomUUID();
  }
  if (typeof api?.getRandomValues !== 'function') {
    return undefined;
  }
  const bytes = api.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export class DuplicateReviewSession {
  groups = $state<ReviewGroup[]>([]);
  history = $state<DuplicateDecisionHistoryDto>({ recent: [], active: [] });
  /** Per group, by duplicate id. Reactive: a queue row re-renders when its entry changes. */
  readonly progress = new SvelteMap<string, GroupProgress>();
  /**
   * Groups decided in this visit, as they were when they left the review. The server no longer lists
   * them, so this is what keeps the "reviewed" count and the "All results" filter honest after a
   * refresh. A group that comes back (an undo) leaves it again.
   */
  readonly reviewed = new SvelteMap<string, ReviewGroup>();
  /** True while an undo job this page submitted is running. */
  undoing = $state(false);
  loading = $state(false);

  #jobs = new Map<string, TrackedJob>();

  /** Whether a tracked job is running `action`. */
  #hasJob(action: MediaOperationBulkAction) {
    for (const job of this.#jobs.values()) {
      if (job.action === action) {
        return true;
      }
    }
    return false;
  }
  #timer: ReturnType<typeof setTimeout> | null = null;
  #polling: Promise<void> | null = null;
  #gateway: DuplicateReviewGateway;
  #pollMs: number;
  #onSettled?: (outcome: { action: MediaOperationBulkAction; failed: number }) => void;
  /** Set once the page is gone: an answer still in flight must not start following again. */
  #destroyed = false;

  constructor(
    initial: { groups: ReviewGroup[]; history: DuplicateDecisionHistoryDto },
    {
      gateway = duplicateReviewGateway,
      pollMs = DUPLICATE_REVIEW_POLL_MS,
      onSettled,
    }: {
      gateway?: DuplicateReviewGateway;
      pollMs?: number;
      onSettled?: (outcome: { action: MediaOperationBulkAction; failed: number }) => void;
    } = {},
  ) {
    this.groups = initial.groups;
    this.history = initial.history;
    this.#gateway = gateway;
    this.#pollMs = pollMs;
    this.#onSettled = onSettled;
    this.#resumeActive();
  }

  /** The decision jobs an undo can reach, newest first. */
  get undoable(): DuplicateDecisionBatchDto[] {
    return undoableBatches(this.history.recent);
  }

  /** The server's groups, then the ones decided in this visit that it no longer lists. */
  get allGroups(): ReviewGroup[] {
    const present = new Set(this.groups.map((group) => group.duplicateId));
    return [...this.groups, ...[...this.reviewed.values()].filter((group) => !present.has(group.duplicateId))];
  }

  /** How many jobs this page is following. */
  get tracking(): number {
    return this.#jobs.size;
  }

  /**
   * Submit decisions. Loaders go on at once, before the server answers, so a person moving straight
   * on sees the group they left is being worked on. A very large selection becomes several jobs.
   */
  async decide(groups: MediaOperationDuplicateGroupDto[]): Promise<MediaOperationDto[]> {
    for (const group of groups) {
      this.progress.set(group.duplicateId, { state: 'pending' });
    }
    try {
      return await this.#submit(MediaOperationBulkAction.ResolveDuplicates, groups);
    } catch (error) {
      for (const group of groups) {
        this.progress.delete(group.duplicateId);
      }
      throw error;
    }
  }

  /** Undo the newest undoable decision job, or `batch` when given. Returns false when nothing can be undone. */
  async undo(batch: DuplicateDecisionBatchDto | undefined = this.undoable[0]): Promise<boolean> {
    const groups = batch ? undoGroupsFor(batch) : [];
    if (groups.length === 0 || this.undoing) {
      return false;
    }
    this.undoing = true;
    try {
      await this.#submit(MediaOperationBulkAction.UndoDuplicates, groups);
      // the batch is no longer offered while its undo runs
      this.history = {
        ...this.history,
        recent: this.history.recent.map((entry) =>
          entry.operationId === batch?.operationId ? { ...entry, undoable: false } : entry,
        ),
      };
      return true;
    } catch (error) {
      this.undoing = false;
      throw error;
    }
  }

  /** Read the review and its history again from the server. */
  async refresh(): Promise<void> {
    if (this.#destroyed) {
      return;
    }
    this.loading = true;
    try {
      const [groups, history] = await Promise.all([this.#gateway.getReview(), this.#gateway.getHistory()]);
      if (this.#destroyed) {
        return;
      }
      this.groups = groups;
      for (const group of groups) {
        this.reviewed.delete(group.duplicateId);
      }
      this.history = history;
      // a finished group has left the review; anything still running keeps its loader
      const present = new Set(groups.map((group) => group.duplicateId));
      for (const [duplicateId, progress] of this.progress) {
        if ((progress.state === 'done' || !present.has(duplicateId)) && progress.state !== 'pending') {
          this.progress.delete(duplicateId);
        }
      }
      this.#resumeActive();
    } finally {
      this.loading = false;
    }
  }

  /** Ask every followed job where it is, once. Concurrent calls share one round. */
  poll(): Promise<void> {
    this.#polling ??= this.#pollAll().finally(() => {
      this.#polling = null;
    });
    return this.#polling;
  }

  /** Stop following. For leaving the page and for tests. */
  destroy() {
    this.#destroyed = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#jobs.clear();
  }

  async #submit(action: MediaOperationBulkAction, groups: MediaOperationDuplicateGroupDto[]) {
    const created: MediaOperationDto[] = [];
    for (const part of decisionParts(groups)) {
      const operation = await this.#gateway.submit(action, part, newRequestId());
      created.push(operation);
      this.#jobs.set(operation.id, {
        action,
        groups: part.map(({ duplicateId, memberIds }) => ({ duplicateId, memberIds })),
      });
    }
    this.#schedule();
    return created;
  }

  /** Follow the jobs the server says are still running, so their groups keep their loaders. */
  #resumeActive() {
    if (this.#destroyed) {
      return;
    }
    for (const operation of this.history.active) {
      if (this.#jobs.has(operation.operationId)) {
        continue;
      }
      this.#jobs.set(operation.operationId, { action: operation.action, groups: operation.groups });
      if (operation.action === MediaOperationBulkAction.UndoDuplicates) {
        this.undoing = true;
        continue;
      }
      for (const group of operation.groups) {
        if (!this.progress.has(group.duplicateId)) {
          this.progress.set(group.duplicateId, { state: 'pending' });
        }
      }
    }
    this.#schedule();
  }

  async #pollAll() {
    let finished = false;
    for (const [operationId, job] of this.#jobs) {
      if (this.#destroyed) {
        return;
      }
      let detail: MediaOperationDetailDto;
      try {
        detail = await this.#gateway.getOperation(operationId);
      } catch {
        // unreachable for now: the loaders stay and the next round asks again
        continue;
      }
      if (this.apply(operationId, job, detail)) {
        finished = true;
      }
    }
    if (finished) {
      if (!this.#hasJob(MediaOperationBulkAction.UndoDuplicates)) {
        this.undoing = false;
      }
      try {
        await this.refresh();
      } catch {
        // the tiles already show the outcome; the next finished job reads the review again
      }
    }
  }

  /** Fold one answer from the server into the groups. Returns true when the job has finished. */
  apply(operationId: string, job: TrackedJob, detail: MediaOperationDetailDto): boolean {
    if (this.#destroyed) {
      return false;
    }
    if (job.action === MediaOperationBulkAction.ResolveDuplicates) {
      for (const [duplicateId, progress] of groupProgressFrom(job.groups, detail)) {
        if (progress?.state === 'done') {
          const group = this.groups.find((candidate) => candidate.duplicateId === duplicateId);
          if (group) {
            this.reviewed.set(duplicateId, group);
          }
        }
        if (progress) {
          this.progress.set(duplicateId, progress);
        } else {
          this.progress.delete(duplicateId);
        }
      }
    }

    if (!isFinishedOperation(detail)) {
      return false;
    }
    this.#jobs.delete(operationId);
    this.#onSettled?.({
      action: job.action,
      failed: [...groupProgressFrom(job.groups, detail).values()].filter((entry) => entry?.state === 'failed').length,
    });
    return true;
  }

  #schedule() {
    if (this.#destroyed || this.#timer !== null || this.#jobs.size === 0) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.poll().then(() => this.#schedule());
    }, this.#pollMs);
  }
}
