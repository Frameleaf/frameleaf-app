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
import {
  ArchiveOperationReader,
  ArchiveOperationRepository,
  ArchiveOperationSummary,
  ENDED_UNFINISHED_JOB_STATUSES,
} from 'src/repositories/archive-operation.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationService } from 'src/services/media-operation.service.js';
import { isActiveMediaOperation } from 'src/utils/media-operation.js';

/** How long a finished archive operation, and so its Undo, is kept. */
export const ARCHIVE_OPERATION_RETENTION_DAYS = 30;

const toIso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString());

/** An undo can be started: none was, or the one that was ended cancelled or failed. */
const canStartUndo = (undoJobId: string | null, undoJobStatus: string | null) =>
  !undoJobId || (!!undoJobStatus && ENDED_UNFINISHED_JOB_STATUSES.includes(undoJobStatus));

/**
 * Whether Undo is offered: the archive was confirmed and handed to its job, no undo is running or
 * done (one that was cancelled or failed can be started again), and there is something it archived
 * or may still archive. An archive that is still running can be undone; the undo stops it first
 * (see `ArchiveOperationRepository.restore`).
 */
export const isArchiveUndoable = (operation: ArchiveOperationSummary) =>
  !operation.prepared &&
  !!operation.archiveJobId &&
  canStartUndo(operation.undoJobId, operation.undoJobStatus) &&
  (operation.archived > 0 ||
    (operation.pending > 0 &&
      !!operation.archiveJobStatus &&
      isActiveMediaOperation(operation.archiveJobStatus as MediaOperationStatus)));

export const mapArchiveOperation = (
  operation: ArchiveOperationSummary,
  currentSessionId?: string,
): ArchiveOperationResponseDto => ({
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
  currentSession: !!currentSessionId && operation.sessionId === currentSessionId,
});

const readerOf = (auth: AuthDto): ArchiveOperationReader => ({
  elevated: auth.session?.hasElevatedPermission === true,
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

  private present(auth: AuthDto, operation: ArchiveOperationSummary) {
    return mapArchiveOperation(operation, auth.session?.id);
  }

  private requireSession(auth: AuthDto) {
    if (!auth.session || auth.apiKey || auth.sharedLink) {
      throw new BadRequestException('A signed-in session is required');
    }
  }

  private async summary(auth: AuthDto, id: string) {
    const operation = await this.repository.get(auth.user.id, readerOf(auth), id);
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
    return this.present(auth, await this.summary(auth, id));
  }

  /** Confirm the exact prepared count and hand it to a durable archive job. */
  async confirm(auth: AuthDto, id: string, requestKey: string): Promise<ArchiveOperationResponseDto> {
    this.requireSession(auth);
    await this.repository.confirm(auth, id, requestKey);
    return this.startArchive(auth, id);
  }

  async list(auth: AuthDto): Promise<ArchiveOperationResponseDto[]> {
    const operations = await this.repository.list(auth.user.id, readerOf(auth));
    return operations.map((operation) => this.present(auth, operation));
  }

  async get(auth: AuthDto, id: string): Promise<ArchiveOperationResponseDto> {
    return this.present(auth, await this.summary(auth, id));
  }

  /**
   * Undo a confirmed archive as a durable job of its own. A still-running archive is asked to stop
   * first; whatever it had not reached is never archived afterwards, and whatever changed since it
   * was archived is left as it is.
   */
  async undo(auth: AuthDto, id: string, requestKey: string): Promise<ArchiveOperationResponseDto> {
    this.requireSession(auth);
    const operation = await this.summary(auth, id);
    if (!canStartUndo(operation.undoJobId, operation.undoJobStatus)) {
      return this.present(auth, operation);
    }
    if (requestKey === operation.requestKey) {
      throw new ConflictException('Undo needs a request key of its own');
    }
    if (!isArchiveUndoable(operation)) {
      throw new ConflictException('This archive has nothing left to undo');
    }

    // The operation stays locked from here until the undo job is linked: a second Undo at the same
    // moment waits, then finds this one.
    await this.repository.startJob(auth.user.id, id, 'undo', async (locked) => {
      if (!canStartUndo(locked.undoJobId, locked.jobStatus)) {
        return null;
      }
      const archive = await this.summary(auth, id);
      if (
        archive.archiveJobId &&
        archive.archiveJobStatus &&
        isActiveMediaOperation(archive.archiveJobStatus as MediaOperationStatus)
      ) {
        try {
          await this.mediaOperations.cancel(auth, archive.archiveJobId);
        } catch (error) {
          // It finished in the meantime; the undo below covers whatever it archived.
          this.logger.debug(`Archive job ${archive.archiveJobId} was not cancelled before undo: ${error}`);
        }
      }

      // FL-34: without the PIN, the undo leaves Locked items as they are and restores the rest.
      // Unreached Locked items are recorded as skipped; archived ones stay archived. None is named.
      const elevated = auth.session?.hasElevatedPermission === true;
      if (!elevated) {
        await this.repository.skipLocked(auth.user.id, id);
      }
      const assetIds = await this.repository.undoAssetIds(auth.user.id, id, elevated);
      if (assetIds.length === 0) {
        throw new ConflictException('This archive has nothing left that this session can undo');
      }
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
      if (job.id === locked.undoJobId) {
        // the key of the undo that ended: starting again needs a key of its own
        throw new ConflictException('Undo needs a request key of its own');
      }
      return job.id;
    });
    return this.present(auth, await this.summary(auth, id));
  }

  /**
   * Hand a confirmed operation to its durable job, once. The operation stays locked until the job is
   * linked, so a repeated or concurrent confirmation answers with the same job instead of a second.
   */
  private async startArchive(auth: AuthDto, id: string): Promise<ArchiveOperationResponseDto> {
    const jobId = await this.repository.startJob(auth.user.id, id, 'archive', async (locked) => {
      if (locked.archiveJobId || locked.prepared) {
        return null;
      }
      // FL-34: an item Locked since the selection was frozen is left out (skipped) for a session
      // without the PIN, rather than refusing the whole archive; it is never archived or named.
      if (!auth.session?.hasElevatedPermission) {
        await this.repository.skipLocked(auth.user.id, id);
      }
      const assetIds = await this.repository.pendingAssetIds(id);
      if (assetIds.length === 0) {
        // nothing matched, or nothing is left: the operation stays as the record of the selection
        return null;
      }
      const job = await this.mediaOperations.createBulk(
        auth,
        {
          action: MediaOperationBulkAction.Archive,
          assetIds,
          // the request key is the job's idempotency key; `createBulk` answers with an earlier job
          // only when it is this operation's archive
          requestId: locked.requestKey,
          submittedTotal: assetIds.length,
          truncated: false,
          scope: {
            archiveOperationId: id,
            kind: locked.scope === ArchiveOperationScope.MatchingOwnedTimeline ? 'matching' : 'selected',
          },
        },
        { archiveOperationId: id },
      );
      return job.id;
    });
    if (jobId) {
      this.logger.log(`Archive operation ${id} handed to bulk job ${jobId}`);
    }
    return this.present(auth, await this.summary(auth, id));
  }
}
