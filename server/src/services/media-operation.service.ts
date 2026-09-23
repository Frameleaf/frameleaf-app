import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  MediaOperationDetailDto,
  MediaOperationDto,
  MediaOperationListResponseDto,
  MediaOperationSearchDto,
  MediaOperationStatisticsDto,
} from 'src/dtos/media-operation.dto.js';
import { MediaOperationDestination, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MediaOperation,
  MediaOperationCheckpoint,
  MediaOperationRepository,
} from 'src/repositories/media-operation.repository.js';
import { canDismissMediaOperation, canRetryMediaOperation, isActiveMediaOperation } from 'src/utils/media-operation.js';

const DEFAULT_TAKE = 100;

const asIso = (value: Date | string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

const asRequiredIso = (value: Date | string): string => asIso(value) as string;

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * Estimates come from measured throughput upstream and are stored as they were given. This only
 * reshapes them; it never computes one, because an invented estimate is worse than none.
 */
const mapEstimate = (value: unknown) => {
  const estimate = asObject(value);
  if (Object.keys(estimate).length === 0) {
    return null;
  }

  return {
    seconds: typeof estimate.seconds === 'number' ? estimate.seconds : 0,
    sizeBytes: estimate.sizeBytes === undefined || estimate.sizeBytes === null ? null : String(estimate.sizeBytes),
    cloudCost: estimate.cloudCost === undefined ? null : (asObject(estimate.cloudCost) as Record<string, unknown>),
  };
};

const mapOperation = (operation: MediaOperation): MediaOperationDto => ({
  id: operation.id,
  kind: operation.kind as MediaOperationKind,
  status: operation.status as MediaOperationStatus,
  destination: operation.destination as MediaOperationDestination,
  destinationDetail: operation.destinationDetail,
  label: operation.label,
  assetId: operation.assetId,
  resultAssetId: operation.resultAssetId,
  retryOfId: operation.retryOfId,
  projectId: operation.projectId,
  revisionId: operation.revisionId,
  settings: asObject(operation.settings),
  estimate: mapEstimate(operation.estimate),
  progress: operation.progress,
  processedUnits: String(operation.processedUnits ?? 0),
  totalUnits: operation.totalUnits === null || operation.totalUnits === undefined ? null : String(operation.totalUnits),
  attempt: operation.attempt,
  maxAttempts: operation.maxAttempts,
  error: operation.error,
  errorCode: operation.errorCode,
  cancelRequestedAt: asIso(operation.cancelRequestedAt),
  cancelAcknowledgedAt: asIso(operation.cancelAcknowledgedAt),
  startedAt: asIso(operation.startedAt),
  finishedAt: asIso(operation.finishedAt),
  createdAt: asRequiredIso(operation.createdAt),
  updatedAt: asRequiredIso(operation.updatedAt),
});

const mapCheckpoint = (checkpoint: MediaOperationCheckpoint) => ({
  id: checkpoint.id,
  sequence: checkpoint.sequence,
  state: checkpoint.state,
  chunkKey: checkpoint.chunkKey,
  timebase: checkpoint.timebase,
  startTicks: String(checkpoint.startTicks),
  endTicks: String(checkpoint.endTicks),
  requiresSequentialContext: checkpoint.requiresSequentialContext,
  sizeInBytes:
    checkpoint.sizeInBytes === null || checkpoint.sizeInBytes === undefined ? null : String(checkpoint.sizeInBytes),
  completedAt: asIso(checkpoint.completedAt),
});

/**
 * The durable job surface behind Activity (FL-43, FL-104).
 *
 * Every read is owner-scoped in the query itself rather than filtered afterwards, so a job that
 * is not yours answers "not found" — the same answer as a job that does not exist, which is the
 * only honest answer to give about somebody else's media.
 *
 * The administrator's view is a separate method returning aggregates only. There is deliberately
 * no endpoint that lets an administrator read another account's jobs.
 */
@Injectable()
export class MediaOperationService {
  constructor(
    private logger: LoggingRepository,
    private repository: MediaOperationRepository,
  ) {
    this.logger.setContext(MediaOperationService.name);
  }

  async search(auth: AuthDto, dto: MediaOperationSearchDto): Promise<MediaOperationListResponseDto> {
    const { items, total } = await this.repository.list({
      ownerId: auth.user.id,
      kind: dto.kind,
      statuses: dto.status ? [dto.status] : undefined,
      includeDismissed: dto.includeDismissed ?? false,
      take: dto.take ?? DEFAULT_TAKE,
      skip: dto.skip ?? 0,
    });

    return { items: items.map((item) => mapOperation(item)), total };
  }

  async get(auth: AuthDto, id: string): Promise<MediaOperationDetailDto> {
    const operation = await this.findOwned(auth, id);
    const checkpoints = await this.repository.getCheckpoints(operation.id);

    return {
      ...mapOperation(operation),
      snapshot: asObject(operation.snapshot),
      checkpoints: checkpoints.map((checkpoint) => mapCheckpoint(checkpoint)),
    };
  }

  /**
   * Ask for a job to stop.
   *
   * The request is recorded before anything else happens, so a cancel survives the browser
   * closing and a server restart. A job with a worker on it goes to `cancelling` and only reaches
   * `cancelled` once the remote acknowledges; the caller is told which of the two happened rather
   * than being shown a finished job that is in fact still running somewhere.
   */
  async cancel(auth: AuthDto, id: string): Promise<MediaOperationDto> {
    const operation = await this.findOwned(auth, id);

    if (!isActiveMediaOperation(operation.status as MediaOperationStatus)) {
      throw new BadRequestException('This job has already finished');
    }

    const cancelled = await this.repository.requestCancel(id, auth.user.id);
    if (!cancelled) {
      // It finished between the read and the write. Report the settled state, not an error.
      return mapOperation(await this.findOwned(auth, id));
    }

    this.logger.log(`Cancellation requested for media operation ${id} (${cancelled.status})`);
    return mapOperation(cancelled);
  }

  /**
   * Retry a failed or cancelled job.
   *
   * The new row copies the immutable snapshot verbatim and points at the old one through
   * `retryOfId`. Nothing is edited in place: the failed attempt stays readable, and a retry can
   * never quietly become a render of different inputs or a different destination.
   */
  async retry(auth: AuthDto, id: string): Promise<MediaOperationDto> {
    const operation = await this.findOwned(auth, id);

    if (!canRetryMediaOperation(operation.status as MediaOperationStatus)) {
      throw new BadRequestException('Only a failed or cancelled job can be retried');
    }

    const retried = await this.repository.create({
      ownerId: operation.ownerId,
      kind: operation.kind,
      destination: operation.destination,
      destinationDetail: operation.destinationDetail,
      label: operation.label,
      assetId: operation.assetId,
      resultAssetId: null,
      retryOfId: operation.id,
      projectId: operation.projectId,
      revisionId: operation.revisionId,
      snapshot: operation.snapshot,
      settings: operation.settings,
      estimate: operation.estimate,
      maxAttempts: operation.maxAttempts,
    });

    this.logger.log(`Media operation ${id} retried as ${retried.id}`);
    return mapOperation(retried);
  }

  /** Clear a finished job from Activity. The row survives for lineage and remote cleanup. */
  async dismiss(auth: AuthDto, id: string): Promise<void> {
    const operation = await this.findOwned(auth, id);

    if (!canDismissMediaOperation(operation.status as MediaOperationStatus)) {
      throw new BadRequestException('A running job cannot be cleared; cancel it first');
    }

    await this.repository.dismiss(id, auth.user.id);
  }

  /**
   * Operational aggregates for an administrator.
   *
   * Counts only. `unreleasedRemote` is the number that actually matters operationally: remote
   * work we have stopped watching but whose cleanup the remote has not confirmed.
   */
  async getStatistics(): Promise<MediaOperationStatisticsDto> {
    const [rows, unreleased] = await Promise.all([
      this.repository.getAggregates(),
      this.repository.getUnreleasedRemoteOperations(1000),
    ]);

    const buckets = rows.map((row) => ({
      kind: row.kind,
      status: row.status,
      destination: row.destination as MediaOperationDestination,
      count: row.count,
      oldestCreatedAt: asIso(row.oldestQueuedAt),
    }));

    return {
      buckets,
      active: buckets
        .filter((bucket) => isActiveMediaOperation(bucket.status))
        .reduce((total, bucket) => total + bucket.count, 0),
      failed: buckets
        .filter((bucket) => bucket.status === MediaOperationStatus.Failed)
        .reduce((total, bucket) => total + bucket.count, 0),
      unreleasedRemote: unreleased.length,
    };
  }

  private async findOwned(auth: AuthDto, id: string): Promise<MediaOperation> {
    const operation = await this.repository.getForOwner(id, auth.user.id);
    if (!operation) {
      // Somebody else's job and a job that never existed give the same answer on purpose.
      throw new NotFoundException('Media operation not found');
    }

    return operation;
  }
}
