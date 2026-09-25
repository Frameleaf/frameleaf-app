import type { JobRepository } from 'src/repositories/job.repository.js';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import type { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { JobStatus, MediaOperationStatus } from 'src/enum.js';
import {
  EDIT_OPERATION_LEASE_MS,
  EDIT_OPERATION_REDISPATCH_MS,
  type EditOperationInput,
  editOperationCreate,
  editOperationJobItem,
  editOperationOutcome,
} from 'src/utils/edit-operation.js';

type Operations = Pick<
  MediaOperationRepository,
  | 'create'
  | 'getForWorker'
  | 'beginJobQueueRun'
  | 'heartbeat'
  | 'reportProgress'
  | 'beginValidation'
  | 'complete'
  | 'fail'
  | 'requeue'
  | 'requestCancel'
  | 'acknowledgeCancel'
  | 'claimJobQueueDispatch'
  | 'releaseJobQueueDispatch'
  | 'listActiveEditsOfRevision'
>;

type Jobs = Pick<JobRepository, 'queue' | 'queueAll'>;
type Logger = Pick<LoggingRepository, 'log' | 'warn' | 'error'>;

/** The failure a run reports when its executor gave no reason of its own. */
export const EDIT_RENDER_FAILED = { errorCode: 'edit_render_failed', error: 'The edit could not be rendered' } as const;

/** The result an edit row completes with when there was nothing to publish (FL-43). */
export const EDIT_NOTHING_PUBLISHED = { outcome: 'nothing_published' } as const;

type RunState = 'working' | 'validating' | 'settled' | 'lost';

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

/**
 * One run of a job-queue edit under its row's claim (FL-43).
 *
 * Every write carries the claim token, like any worker's, so a run whose claim lapsed and was
 * recovered can no longer move, validate or complete the row, and an executor that asks
 * `validate()` before publishing learns that it must not publish.
 */
export class EditOperationRun {
  private state: RunState = 'working';
  private timer?: ReturnType<typeof setInterval>;
  private errorNote?: { error: string; errorCode: string };

  constructor(
    private operations: Operations,
    private logger: Logger,
    readonly operation: MediaOperation,
    readonly claimToken: string,
    leaseMs = EDIT_OPERATION_LEASE_MS,
  ) {
    this.timer = setInterval(() => void this.heartbeat(leaseMs), Math.max(1000, Math.floor(leaseMs / 3)));
    this.timer.unref?.();
  }

  get id() {
    return this.operation.id;
  }

  /** Settled or lost: nothing this run writes changes the row any more. */
  get done() {
    return this.state === 'settled' || this.state === 'lost';
  }

  /** The reason the executor gives for a failure it reports as `JobStatus.Failed`. */
  noteError(error: unknown, errorCode: string = EDIT_RENDER_FAILED.errorCode) {
    this.errorNote = { error: messageOf(error), errorCode };
  }

  /** The render itself started. */
  async rendering(): Promise<boolean> {
    return this.progress(0);
  }

  /**
   * Real progress, as a percentage of the executor's own stages. False when the claim no longer
   * allows it: the owner asked to cancel, or the claim was lost.
   */
  async progress(percent: number): Promise<boolean> {
    if (this.state !== 'working') {
      return false;
    }
    const value = Math.min(100, Math.max(0, Math.round(percent)));
    const ok = await this.operations.reportProgress(this.id, this.claimToken, {
      status: MediaOperationStatus.Rendering,
      processedUnits: value,
      totalUnits: 100,
      progress: value,
    });
    if (!ok && !(await this.cancelRequested())) {
      this.state = 'lost';
    }
    return ok;
  }

  /** Whether the owner asked to cancel; a run of a cancellable edit stops at its next stage. */
  async cancelRequested(): Promise<boolean> {
    const row = await this.operations.getForWorker(this.id);
    return !!row?.cancelRequestedAt && row.claimToken === this.claimToken;
  }

  /**
   * The last gate before an executor publishes. True only while this run holds the claim and the
   * row has moved to `validating`; a cancel that arrived first is acknowledged here, so the executor
   * stops without publishing and the previous output stays.
   */
  async validate(): Promise<boolean> {
    if (this.state === 'validating') {
      return true;
    }
    if (this.state !== 'working') {
      return false;
    }
    if (await this.operations.beginValidation(this.id, this.claimToken)) {
      this.state = 'validating';
      return true;
    }
    if (await this.cancelRequested()) {
      await this.cancelled();
      return false;
    }
    this.state = 'lost';
    this.logger.warn(`Edit operation ${this.id} lost its claim before publishing; nothing was published`);
    return false;
  }

  /**
   * The executor published (`resultAssetId`) or had nothing to publish. The result must be a live
   * asset of the owner's, or the row fails instead: lineage never names media the owner cannot see.
   */
  async complete(resultAssetId: string | null): Promise<boolean> {
    if (!(await this.validate())) {
      return false;
    }
    const completed = await this.operations.complete(this.id, this.claimToken, {
      resultAssetId,
      ...(resultAssetId === null && { result: EDIT_NOTHING_PUBLISHED }),
    });
    if (completed) {
      this.settle();
      return true;
    }
    if (resultAssetId === null) {
      this.state = 'lost';
    } else {
      await this.fail('The edited item is no longer in this library', 'result_not_owned', { retry: false });
    }
    return false;
  }

  /** Report a failure. It gets the row's one automatic retry unless `retry` is false. */
  async fail(error: unknown, errorCode: string, options: { retry?: boolean } = {}) {
    if (this.done) {
      return false;
    }
    const outcome = await this.operations.fail(
      this.id,
      this.claimToken,
      { error: messageOf(error), errorCode },
      { retry: options.retry ?? true },
    );
    this.settle();
    return outcome;
  }

  /** The executor stopped for a cancel: settle the row as cancelled under this claim. */
  async cancelled(): Promise<boolean> {
    if (this.done) {
      return false;
    }
    await this.operations.requestCancel(this.id, this.operation.ownerId, this.claimToken);
    const acknowledged = await this.operations.acknowledgeCancel(this.id, this.claimToken, { released: true });
    this.settle();
    return acknowledged;
  }

  /**
   * Hand the row back to the queue without using an attempt: the executor could not start yet (a
   * photo version still held by another render). It is dispatched again after `delayMs`.
   */
  async release(delayMs: number): Promise<boolean> {
    if (this.done) {
      return false;
    }
    const released = await this.operations.requeue(this.id, this.claimToken, { delayMs, returnAttempt: true });
    this.settle();
    return released;
  }

  /** Settle the row from what the executor returned, unless it already settled it itself. */
  async finish(status: JobStatus): Promise<void> {
    if (this.done) {
      return;
    }
    switch (editOperationOutcome(status)) {
      case 'published': {
        await this.complete(this.operation.assetId);
        break;
      }
      case 'nothing': {
        await this.complete(null);
        break;
      }
      case 'failed': {
        const note = this.errorNote ?? EDIT_RENDER_FAILED;
        await this.fail(note.error, note.errorCode);
        break;
      }
    }
  }

  stop() {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  private settle() {
    this.state = 'settled';
    this.stop();
  }

  private async heartbeat(leaseMs: number) {
    if (this.done) {
      this.stop();
      return;
    }
    try {
      if (!(await this.operations.heartbeat(this.id, this.claimToken, leaseMs))) {
        this.state = 'lost';
        this.stop();
      }
    } catch (error) {
      this.logger.warn(`Edit operation ${this.id} heartbeat failed: ${messageOf(error)}`);
    }
  }
}

/**
 * Records edits in the durable job contract and runs them under their rows (FL-43). The executors
 * stay where they were; this only gives each render a row, a claim and a settled outcome.
 */
export class EditOperationTracker {
  constructor(
    private operations: Operations,
    private jobs: Jobs,
    private logger: Logger,
    private leaseMs = EDIT_OPERATION_LEASE_MS,
  ) {}

  /**
   * Record an edit and queue its job with the row's id. The edit itself was already saved, so a row
   * that cannot be written never stops the render: the job is queued without one, as before.
   */
  async queue(input: EditOperationInput): Promise<string | undefined> {
    let operationId: string | undefined;
    try {
      operationId = (await this.operations.create(editOperationCreate(input))).id;
    } catch (error) {
      this.logger.warn(`Could not record the ${input.edit} of asset ${input.assetId} as a job: ${messageOf(error)}`);
    }
    await this.jobs.queue({
      ...input.job,
      data: { ...input.job.data, ...(operationId && { operationId }) },
    } as never);
    return operationId;
  }

  /**
   * Claim the row for this delivery of its job. `cancelled` when the owner cancelled it while it was
   * queued; `unavailable` when another delivery holds it or it has finished — a tracked job only
   * runs under its row's claim, so a duplicate or stale delivery does nothing.
   */
  async begin(operationId: string): Promise<EditOperationRun | 'cancelled' | 'unavailable'> {
    const claimed = await this.operations.beginJobQueueRun(operationId, this.leaseMs);
    if (claimed) {
      return new EditOperationRun(this.operations, this.logger, claimed.operation, claimed.claimToken, this.leaseMs);
    }
    const row = await this.operations.getForWorker(operationId);
    if (row?.cancelRequestedAt) {
      return 'cancelled';
    }
    return 'unavailable';
  }

  /**
   * Run an executor under the row its job names. Without a row (a maintenance rebuild of edited
   * previews, or a job queued before this existed) the executor runs exactly as it always did.
   */
  async execute(
    operationId: string | undefined,
    work: (run?: EditOperationRun) => Promise<JobStatus>,
    options: { onCancelled?: () => Promise<void> } = {},
  ): Promise<JobStatus> {
    if (!operationId) {
      return work();
    }

    const run = await this.begin(operationId);
    if (typeof run === 'string') {
      this.logger.log(`Edit operation ${operationId} not run: ${run}`);
      if (run === 'cancelled') {
        await options.onCancelled?.();
      }
      return JobStatus.Skipped;
    }

    try {
      await run.rendering();
      const status = await work(run);
      await run.finish(status);
      return status;
    } catch (error) {
      await run.fail(error, EDIT_RENDER_FAILED.errorCode);
      throw error;
    } finally {
      run.stop();
    }
  }

  /**
   * Put edit rows that have no job back on the job queue: an automatic retry, a recovered lapsed
   * claim, a manual retry, or a job the queue lost. Returns how many were queued.
   */
  async dispatch(limit = 100): Promise<number> {
    const rows = await this.operations.claimJobQueueDispatch({ limit, staleMs: EDIT_OPERATION_REDISPATCH_MS });
    if (rows.length === 0) {
      return 0;
    }

    const items = [];
    for (const row of rows) {
      const item = editOperationJobItem(row.id, row.snapshot);
      if (item) {
        items.push(item);
      } else {
        // Not an edit job this server can run: stop it rather than dispatching it forever.
        this.logger.warn(`Edit operation ${row.id} names no job that can run it; cancelling it`);
        await this.operations.requestCancel(row.id, row.ownerId);
      }
    }

    try {
      await this.jobs.queueAll(items);
    } catch (error) {
      await this.operations.releaseJobQueueDispatch(rows.map(({ id }) => id));
      throw error;
    }
    return items.length;
  }

  /** The owner cancelled a photo version from the editor: its row is cancelled with it. */
  async cancelRevision(ownerId: string, revisionId: string): Promise<void> {
    for (const row of await this.operations.listActiveEditsOfRevision(ownerId, revisionId)) {
      await this.operations.requestCancel(row.id, ownerId);
    }
  }
}
