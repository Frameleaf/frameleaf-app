import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { OnEvent } from 'src/decorators.js';
import {
  ArchiveOperationCreateDto,
  ArchiveOperationPrepareDto,
  ArchiveOperationResponseDto,
  ArchiveOperationScope,
} from 'src/dtos/archive-operation.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { MediaOperationBulkAction, MediaOperationStatus } from 'src/enum.js';
import { ArchiveOperationRepository, ArchiveOperationSummary } from 'src/repositories/archive-operation.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationService } from 'src/services/media-operation.service.js';
import { isActiveMediaOperation } from 'src/utils/media-operation.js';

/** How long a finished archive operation, and so its Undo, is kept. */
export const ARCHIVE_OPERATION_RETENTION_DAYS = 30;

const toIso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString());

/**
 * Whether Undo is offered: the archive was confirmed and handed to its job, nothing has undone it
 * yet, and there is something it archived or may still archive. An archive that is still running
 * can be undone; the undo stops it first (see `ArchiveOperationRepository.restore`).
 */
export const isArchiveUndoable = (operation: ArchiveOperationSummary) =>
  !operation.prepared &&
  !!operation.archiveJobId &&
  !operation.undoJobId &&
  (operation.archived > 0 ||
    (operation.pending > 0 &&
      !!operation.archiveJobStatus &&
      isActiveMediaOperation(operation.archiveJobStatus as MediaOperationStatus)));

export const mapArchiveOperation = (operation: ArchiveOperationSummary): ArchiveOperationResponseDto => ({
  id: operation.id,
  scope: operation.scope,
  requestKey: operation.requestKey,
  count: operation.count,
  prepared: operation.prepared,
  expiresAt: operation.prepared ? toIso(operation.expiresAt) : null,
  createdAt: toIso(operation.createdAt) as string,
  archiveJobId: operation.archiveJobId,
  undoJobId: operation.undoJobId,
  pending: operation.pending,
  archived: operation.archived,
  skipped: operation.skipped,
  undone: operation.undone,
  conflict: operation.conflict,
  undoable: isArchiveUndoable(operation),
});

/**
 * Transactional archive (FL-32, ported from PR #133 and folded into the durable bulk jobs).
 *
 * PR #133 ran its own outbox drain over `archive_operation_item`. Here the frozen set is handed to
 * the existing durable bulk job (`media_operation`, kind `bulk`), so a transactional archive is
 * followed, cancelled, paused and retried in Activity like every other background action; the
 * operation adds only what the job alone cannot give: a server-counted matching set confirmed before
 * anything changes, and a per-item record of what the archive published, so Undo survives a reload
 * and never overwrites a newer change.
 */
@Injectable()
export class ArchiveOperationService {
  constructor(
    private logger: LoggingRepository,
    private repository: ArchiveOperationRepository,
    private mediaOperations: MediaOperationService,
  ) {
    this.logger.setContext(ArchiveOperationService.name);
  }

  /**
   * Part of the nightly database cleanup (`QueueService.handleNightlyJobs`, when database cleanup is
   * on): operations older than `ARCHIVE_OPERATION_RETENTION_DAYS` whose jobs are no longer running,
   * and unconfirmed selections that expired, are forgotten. Their jobs stay in Activity.
   */
  @OnEvent({ name: 'NightlyDatabaseCleanup' })
  async onNightlyDatabaseCleanup() {
    try {
      const pruned = await this.repository.prune(ARCHIVE_OPERATION_RETENTION_DAYS);
      if (pruned > 0) {
        this.logger.log(`Removed ${pruned} archive operations nobody can act on any more`);
      }
    } catch (error) {
      // during a database handoff the rows wait for the next night
      this.logger.warn(`Archive operation cleanup deferred: ${error}`);
    }
  }

  private requireSession(auth: AuthDto) {
    if (!auth.session || auth.apiKey || auth.sharedLink) {
      throw new BadRequestException('A signed-in session is required');
    }
  }

  private async summary(auth: AuthDto, id: string) {
    const operation = await this.repository.get(auth.user.id, id);
    if (!operation) {
      throw new NotFoundException();
    }
    return operation;
  }

  /** Freeze an explicit selection and hand it to a durable archive job at once. */
  async create(auth: AuthDto, dto: ArchiveOperationCreateDto): Promise<ArchiveOperationResponseDto> {
    this.requireSession(auth);
    const id = await this.repository.createSelected(auth, dto.requestKey, dto.assetIds);
    return this.startArchive(auth, id);
  }

  /** Count and freeze every matching asset of the owner's Timeline; nothing changes until `confirm`. */
  async prepare(auth: AuthDto, dto: ArchiveOperationPrepareDto): Promise<ArchiveOperationResponseDto> {
    this.requireSession(auth);
    const id = await this.repository.prepareMatching(auth, dto.requestKey);
    return mapArchiveOperation(await this.summary(auth, id));
  }

  /** Confirm the exact prepared count and hand it to a durable archive job. */
  async confirm(auth: AuthDto, id: string, requestKey: string): Promise<ArchiveOperationResponseDto> {
    this.requireSession(auth);
    await this.repository.confirm(auth, id, requestKey);
    return this.startArchive(auth, id);
  }

  async list(auth: AuthDto): Promise<ArchiveOperationResponseDto[]> {
    const operations = await this.repository.list(auth.user.id);
    return operations.map((operation) => mapArchiveOperation(operation));
  }

  async get(auth: AuthDto, id: string): Promise<ArchiveOperationResponseDto> {
    return mapArchiveOperation(await this.summary(auth, id));
  }

  /**
   * Undo a confirmed archive as a durable job of its own. A still-running archive is asked to stop
   * first; whatever it had not reached is never archived afterwards, and whatever changed since it
   * was archived is left as it is.
   */
  async undo(auth: AuthDto, id: string, requestKey: string): Promise<ArchiveOperationResponseDto> {
    this.requireSession(auth);
    const operation = await this.summary(auth, id);
    if (operation.undoJobId) {
      return mapArchiveOperation(operation);
    }
    if (requestKey === operation.requestKey) {
      throw new ConflictException('Undo needs a request key of its own');
    }
    if (!isArchiveUndoable(operation)) {
      throw new ConflictException('This archive has nothing left to undo');
    }

    if (
      operation.archiveJobId &&
      operation.archiveJobStatus &&
      isActiveMediaOperation(operation.archiveJobStatus as MediaOperationStatus)
    ) {
      try {
        await this.mediaOperations.cancel(auth, operation.archiveJobId);
      } catch (error) {
        // It finished in the meantime; the undo below covers whatever it archived.
        this.logger.debug(`Archive job ${operation.archiveJobId} was not cancelled before undo: ${error}`);
      }
    }

    const assetIds = await this.repository.orderedAssetIds(id);
    const job = await this.mediaOperations.createBulk(
      auth,
      {
        action: MediaOperationBulkAction.Unarchive,
        assetIds,
        requestId: requestKey,
        submittedTotal: assetIds.length,
        truncated: false,
        scope: { archiveOperationId: id, undo: true },
      },
      { archiveOperationId: id },
    );
    if (!(await this.repository.linkUndoJob(id, job.id))) {
      throw new ConflictException('Another undo already started for this archive');
    }
    return mapArchiveOperation(await this.summary(auth, id));
  }

  /** Hand a confirmed operation to its durable job, once; a repeat answers with the same job. */
  private async startArchive(auth: AuthDto, id: string): Promise<ArchiveOperationResponseDto> {
    const operation = await this.summary(auth, id);
    if (operation.archiveJobId) {
      return mapArchiveOperation(operation);
    }
    // FL-34: an item Locked since the selection was frozen is left out (skipped) for a session
    // without the PIN, rather than refusing the whole archive; it is never archived or named.
    if (!auth.session?.hasElevatedPermission) {
      await this.repository.skipLocked(auth.user.id, id);
    }
    const assetIds = await this.repository.pendingAssetIds(id);
    if (assetIds.length === 0) {
      // nothing matched, or nothing is left: the operation stays as the record of the selection
      return mapArchiveOperation(await this.summary(auth, id));
    }
    const job = await this.mediaOperations.createBulk(
      auth,
      {
        action: MediaOperationBulkAction.Archive,
        assetIds,
        // the request key is the job's idempotency key, so a retried confirmation finds the same job
        requestId: operation.requestKey,
        submittedTotal: assetIds.length,
        truncated: false,
        scope: {
          archiveOperationId: id,
          kind: operation.scope === ArchiveOperationScope.MatchingOwnedTimeline ? 'matching' : 'selected',
        },
      },
      { archiveOperationId: id },
    );
    await this.repository.linkArchiveJob(id, job.id);
    this.logger.log(`Archive operation ${id} handed to bulk job ${job.id} (${assetIds.length} items)`);
    return mapArchiveOperation(await this.summary(auth, id));
  }
}
