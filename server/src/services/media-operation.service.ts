import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
import {
  MediaOperationBulkCreateDto,
  MediaOperationDetailDto,
  MediaOperationDto,
  MediaOperationListResponseDto,
  MediaOperationSearchDto,
  MediaOperationStatisticsDto,
} from 'src/dtos/media-operation.dto.js';
import {
  JobName,
  MediaOperationBulkAction,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  Permission,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ArchiveOperationRepository } from 'src/repositories/archive-operation.repository.js';
import { AssetDevelopRepository } from 'src/repositories/asset-develop.repository.js';
import { ICloudSyncRepository } from 'src/repositories/icloud-sync.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MediaOperation,
  MediaOperationCheckpoint,
  MediaOperationRepository,
} from 'src/repositories/media-operation.repository.js';
import { PreservationRepository } from 'src/repositories/preservation.repository.js';
import { isGranted, requireAccess } from 'src/utils/access.js';
import {
  BULK_ACTION_PERMISSIONS,
  type BulkOperationSnapshot,
  bulkOperationLabel,
  bulkPayloadProblem,
  bulkResumeIds,
  bulkRetryPending,
  carriedShiftOrigins,
  emptyBulkResult,
  isBulkAction,
  isMediaHealthBulkAction,
  parseBulkResult,
  parseBulkSnapshot,
} from 'src/utils/bulk-operation.js';
import {
  EditOperationEdit,
  JOB_QUEUE_CLAIMANT,
  canCancelEdit,
  canRetryEdit,
  editOperationEdit,
  editOperationJobItem,
} from 'src/utils/edit-operation.js';
import {
  enrichmentPlanLabel,
  enrichmentResumeIds,
  enrichmentRetryRecord,
  parseEnrichmentPlanResult,
  parseEnrichmentPlanSnapshot,
} from 'src/utils/enrichment-plan.js';
import { getLockedOwnerId } from 'src/utils/locked-visibility.js';
import {
  ACTIVE_MEDIA_OPERATION_STATUSES,
  PAUSABLE_MEDIA_OPERATION_KINDS,
  canDismissMediaOperation,
  canPauseMediaOperation,
  canResumeMediaOperation,
  canRetryMediaOperation,
  isActiveMediaOperation,
  isPausableMediaOperationKind,
} from 'src/utils/media-operation.js';
import { PreservationPackageError, isPreservationKind, parsePreservationSnapshot } from 'src/utils/preservation.js';

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

/**
 * A bulk job's running totals, read leniently.
 *
 * The list query trims the asset ids out of the snapshot, so this must not need them: the action
 * and the truncation flag come from the snapshot, everything else from the accumulated result.
 */
const mapBulkSummary = (operation: MediaOperation): MediaOperationDto['bulk'] => {
  if (operation.kind !== MediaOperationKind.Bulk) {
    return null;
  }

  const snapshot = asObject(operation.snapshot);
  if (!isBulkAction(snapshot.action)) {
    return null;
  }

  const requested = Number(operation.totalUnits ?? 0);
  const result = parseBulkResult(operation.result, requested);

  return {
    action: snapshot.action,
    requested: result.requested,
    succeeded: result.succeeded,
    failed: result.failed,
    skipped: result.skipped,
    snapshotTruncated: snapshot.truncated === true,
    itemsTruncated: result.itemsTruncated,
    retried: result.retry?.total ?? 0,
  };
};

/**
 * The detail view's snapshot. A bulk job's frozen id list can run to fifty thousand entries; the
 * count is what a person auditing the job needs, and the ids themselves stay on the row.
 */
const mapSnapshot = (operation: MediaOperation): Record<string, unknown> => {
  const snapshot = asObject(operation.snapshot);
  if (operation.kind === MediaOperationKind.EnrichmentPlan) {
    // FL-59: the per-asset view is the enrichment plan endpoint's, which withholds Locked ids.
    const { assetIds, requestKey: _requestKey, ...rest } = snapshot;
    return { ...rest, assetCount: Array.isArray(assetIds) ? assetIds.length : 0 };
  }
  if (operation.kind === MediaOperationKind.PhysicalDeduplication) {
    // FL-73: the frozen plan names other accounts' copies, Locked ones included; the detail view
    // carries the plan's name and how many copies and groups it covers
    const { items, retained, excludedRetainedAssetIds, reviewToken: _reviewToken, ...rest } = snapshot;
    return {
      ...rest,
      copyCount: Array.isArray(items) ? items.length : 0,
      retainedCount: Array.isArray(retained) ? retained.length : 0,
      excludedCount: Array.isArray(excludedRetainedAssetIds) ? excludedRetainedAssetIds.length : 0,
    };
  }
  if (operation.kind === MediaOperationKind.MediaHealth) {
    // FL-69: a search names its findings; the detail view carries how many.
    const { findingIds, ...rest } = snapshot;
    return Array.isArray(findingIds) ? { ...rest, findingCount: findingIds.length } : rest;
  }
  if (operation.kind !== MediaOperationKind.Bulk) {
    return snapshot;
  }

  const { assetIds, apiKeyId: _apiKeyId, ...rest } = snapshot;
  const mapped: Record<string, unknown> = { ...rest, assetCount: Array.isArray(assetIds) ? assetIds.length : 0 };

  // FL-61: a duplicate decision job's groups name every photo of every group, Locked ones included
  // once they are locked; the detail view carries only how many groups there are, like the ids above
  const payload = asObject(rest.payload);
  if ('duplicateGroups' in payload) {
    const { duplicateGroups, ...payloadRest } = payload;
    mapped.payload = { ...payloadRest, groupCount: Array.isArray(duplicateGroups) ? duplicateGroups.length : 0 };
  }
  // FL-69: a Library Care job's entries name items that may be locked since, or another account's;
  // the detail view carries only how many findings it covers
  if ('mediaHealth' in payload) {
    const { mediaHealth, ...payloadRest } = payload;
    mapped.payload = { ...payloadRest, findingCount: Array.isArray(mediaHealth) ? mediaHealth.length : 0 };
  }
  return mapped;
};

const bulkItems = (operation: MediaOperation) =>
  operation.kind === MediaOperationKind.Bulk
    ? parseBulkResult(operation.result, Number(operation.totalUnits ?? 0)).items
    : [];

/** `hidden`: the caller's Locked media, never named to a session that has not unlocked it (FL-34). */
const mapBulkItems = (operation: MediaOperation, hidden: ReadonlySet<string> = new Set()) =>
  bulkItems(operation)
    .filter((item) => !hidden.has(item.id))
    .map((item) => ({
      id: item.id,
      status: item.status,
      reasonKey: item.reasonKey ?? null,
      message: item.message ?? null,
    }));

/** The items a bulk job's automatic retry pass has not reached yet. */
const mapBulkRetryPending = (operation: MediaOperation, hidden: ReadonlySet<string> = new Set()): string[] => {
  if (operation.kind !== MediaOperationKind.Bulk) {
    return [];
  }

  const pending = bulkRetryPending(parseBulkResult(operation.result, Number(operation.totalUnits ?? 0)));
  return pending.filter((id) => !hidden.has(id));
};

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

const unlessHidden = (id: string | null, hidden: ReadonlySet<string>) => (id && hidden.has(id) ? null : id);

/**
 * Whether a job is about one of the caller's Locked items that this session may not see (FL-43,
 * FL-34). Its label is that item's file name and its snapshot names the item, so both are withheld;
 * the row itself stays, so the owner still sees that something is running and can stop it.
 *
 * The published result counts too: a job whose output was moved to Locked after it finished — or
 * whose source was deleted, leaving only the result — would otherwise still name it.
 */
const isWithheld = (operation: Pick<MediaOperation, 'assetId' | 'resultAssetId'>, hidden: ReadonlySet<string>) =>
  (!!operation.assetId && hidden.has(operation.assetId)) ||
  (!!operation.resultAssetId && hidden.has(operation.resultAssetId));

/** `hidden`: the caller's Locked media, never named to a session that has not unlocked it (FL-34). */
export const mapOperation = (
  operation: MediaOperation,
  hidden: ReadonlySet<string> = new Set(),
): MediaOperationDto => ({
  id: operation.id,
  kind: operation.kind as MediaOperationKind,
  status: operation.status as MediaOperationStatus,
  destination: operation.destination as MediaOperationDestination,
  destinationDetail: operation.destinationDetail,
  label: isWithheld(operation, hidden) ? '' : operation.label,
  withheld: isWithheld(operation, hidden),
  assetId: unlessHidden(operation.assetId, hidden),
  resultAssetId: unlessHidden(operation.resultAssetId, hidden),
  retryOfId: operation.retryOfId,
  projectId: operation.projectId,
  revisionId: operation.revisionId,
  settings: asObject(operation.settings),
  estimate: mapEstimate(operation.estimate),
  bulk: mapBulkSummary(operation),
  progress: operation.progress,
  processedUnits: String(operation.processedUnits ?? 0),
  totalUnits: operation.totalUnits === null || operation.totalUnits === undefined ? null : String(operation.totalUnits),
  attempt: operation.attempt,
  maxAttempts: operation.maxAttempts,
  autoRetries: operation.autoRetries ?? 0,
  retryAt: asIso(operation.retryAt),
  error: operation.error,
  errorCode: operation.errorCode,
  cancelRequestedAt: asIso(operation.cancelRequestedAt),
  cancelAcknowledgedAt: asIso(operation.cancelAcknowledgedAt),
  pausable: isPausableMediaOperationKind(operation.kind as MediaOperationKind),
  pauseRequestedAt: asIso(operation.pauseRequestedAt),
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
    private access: AccessRepository,
    private icloud: ICloudSyncRepository,
    private jobs: JobRepository,
    private preservation: PreservationRepository,
    private archiveOperations: ArchiveOperationRepository,
    private develop: AssetDevelopRepository,
  ) {
    this.logger.setContext(MediaOperationService.name);
  }

  async search(auth: AuthDto, dto: MediaOperationSearchDto): Promise<MediaOperationListResponseDto> {
    const { items, total } = await this.repository.list({
      ownerId: auth.user.id,
      kind: dto.kind,
      statuses: dto.status ? [dto.status] : undefined,
      includeDismissed: dto.includeDismissed ?? false,
      // FL-43: a reload shows every job still running, however many finished since it started.
      unfinishedFirst: true,
      take: dto.take ?? DEFAULT_TAKE,
      skip: dto.skip ?? 0,
    });

    const hidden = await this.hiddenLockedIds(auth, items);
    return { items: items.map((item) => mapOperation(item, hidden)), total };
  }

  /**
   * The account's unfinished jobs, paused ones included, for the notifications panel's running-jobs
   * summary (FL-104). Read exactly as `search` reads them, Locked ids withheld from a session that
   * has not unlocked them (FL-34).
   */
  async listUnfinished(auth: AuthDto, take: number): Promise<MediaOperationDto[]> {
    const { items } = await this.repository.list({
      ownerId: auth.user.id,
      statuses: ACTIVE_MEDIA_OPERATION_STATUSES,
      includeDismissed: false,
      take,
      skip: 0,
    });

    const hidden = await this.hiddenLockedIds(auth, items);
    return items.map((item) => mapOperation(item, hidden));
  }

  async get(auth: AuthDto, id: string): Promise<MediaOperationDetailDto> {
    const operation = await this.findOwned(auth, id);
    const checkpoints = await this.repository.getCheckpoints(operation.id);
    const hidden = await this.hiddenLockedIds(auth, [operation]);

    return {
      ...mapOperation(operation, hidden),
      // A job about a Locked item names it throughout its snapshot; a locked session sees none of it.
      snapshot: isWithheld(operation, hidden) ? {} : mapSnapshot(operation),
      checkpoints: checkpoints.map((checkpoint) => mapCheckpoint(checkpoint)),
      bulkItems: mapBulkItems(operation, hidden),
      bulkRetryPending: mapBulkRetryPending(operation, hidden),
    };
  }

  /**
   * Queue a bulk operation over a frozen set of assets (FL-32).
   *
   * What this checks now, so the person hears about it while they are still looking:
   *
   * - A scoped API key must grant everything the action does. The worker acts as the account, so
   *   without this a read-only key could queue a delete.
   * - The action's payload is complete and well formed.
   * - The album or tags the action writes to are ones this account may write to.
   * - A job that reaches Locked items comes from an unlocked session, because the worker that runs
   *   it can reach them and must not become a way round the PIN.
   *
   * What it deliberately does not check is access to each asset. That is the worker's job, item by
   * item, at the moment it applies the change — access can be revoked between now and then, and a
   * check made here would be stale by the time it mattered.
   *
   * Duplicate ids are removed and order is kept; the order is the resume cursor.
   */
  async createBulk(
    auth: AuthDto,
    dto: MediaOperationBulkCreateDto,
    options: { libraryCare?: boolean; archiveOperationId?: string } = {},
  ): Promise<MediaOperationDto> {
    if (auth.sharedLink) {
      throw new ForbiddenException('Bulk operations are not available on a shared link');
    }

    // FL-69: Library Care's relink, recovery and trash jobs carry gates this endpoint cannot see — the
    // reviewer's consent, a typed confirmation, fresh evidence — so they are only queued by Library Care.
    if (isMediaHealthBulkAction(dto.action) && !options.libraryCare) {
      throw new BadRequestException('Submit this action from Library Care');
    }

    const requested = BULK_ACTION_PERMISSIONS[dto.action];
    if (auth.apiKey && !isGranted({ requested: [...requested], current: auth.apiKey.permissions })) {
      throw new ForbiddenException(`Missing required permission: ${requested.join(', ')}`);
    }

    if (dto.requestId) {
      const existing = await this.repository.getBulkByRequestId(auth.user.id, dto.requestId);
      if (existing) {
        // FL-32: a key answers with its first job only when it asks for the same thing. A transactional
        // archive's job answers only for its own operation and direction; anything else is a conflict.
        const earlier = asObject(existing.snapshot);
        const earlierOperationId = asObject(earlier.payload).archiveOperationId;
        if (
          (options.archiveOperationId || earlierOperationId) &&
          (earlierOperationId !== options.archiveOperationId || earlier.action !== dto.action)
        ) {
          throw new ConflictException('This request key already belongs to a different job');
        }
        return this.present(auth, existing);
      }
    }

    const assetIds = [...new Set(dto.assetIds)];
    // FL-32: only the archive operation service links a job to its operation; a client payload never can
    const payload: BulkOperationSnapshot['payload'] = {
      ...dto.payload,
      archiveOperationId: options.archiveOperationId,
    };
    if (!payload.archiveOperationId) {
      delete payload.archiveOperationId;
    }
    const problem = bulkPayloadProblem(dto.action, payload, assetIds);
    if (problem) {
      throw new BadRequestException(problem);
    }

    await this.requireTargetAccess(auth, dto.action, payload);
    await this.requireUnlockedFor(auth, assetIds);

    const snapshot: BulkOperationSnapshot = {
      action: dto.action,
      assetIds,
      payload,
      submittedTotal: dto.submittedTotal ?? null,
      truncated: dto.truncated ?? false,
      scope: dto.scope,
      requestId: dto.requestId ?? null,
      apiKeyId: auth.apiKey?.id ?? null,
      elevated: auth.session?.hasElevatedPermission === true,
    };

    const created = await this.repository.create({
      ownerId: auth.user.id,
      kind: MediaOperationKind.Bulk,
      // Bulk work runs on this server's own workers; there is no remote to choose.
      destination: MediaOperationDestination.Local,
      destinationDetail: null,
      label: bulkOperationLabel(dto.action, assetIds.length),
      assetId: null,
      resultAssetId: null,
      retryOfId: null,
      projectId: null,
      revisionId: null,
      snapshot: snapshot as unknown as Record<string, unknown>,
      settings: {},
      estimate: null,
      result: emptyBulkResult(assetIds.length) as unknown as Record<string, unknown>,
      totalUnits: String(assetIds.length),
    });

    this.logger.log(`Bulk ${dto.action} queued as media operation ${created.id} (${assetIds.length} items)`);
    return this.present(auth, created);
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

    // FL-43: an edit is cancelled only where its render can stop without leaving the saved edit half
    // shown: a photo version. A photo edit's previews and a video edit's master finish.
    const edit = editOperationEdit(operation);
    if (edit && !canCancelEdit(edit)) {
      throw new BadRequestException('This edit finishes once it has started and cannot be cancelled');
    }

    const cancelled = await this.repository.requestCancel(id, auth.user.id);
    if (!cancelled) {
      // It finished between the read and the write. Report the settled state, not an error.
      return this.present(auth, await this.findOwned(auth, id));
    }

    // An iCloud sync cancelled before a worker had it closes its run record here; the worker closes
    // it for one it was running when it acknowledges the cancel (FL-68).
    const connectionId = asObject(cancelled.snapshot).connectionId;
    if (
      cancelled.kind === MediaOperationKind.ICloudSync &&
      cancelled.status === MediaOperationStatus.Cancelled &&
      typeof connectionId === 'string'
    ) {
      await this.icloud.endRun(connectionId, 'cancelled');
    }

    this.logger.log(`Cancellation requested for media operation ${id} (${cancelled.status})`);
    return this.present(auth, cancelled);
  }

  /**
   * Pause a job (FL-104, owner request September 23, 2026).
   *
   * Only kinds that record where they have got to can pause: a bulk job, a Studio export and a
   * restoration. A queued one is held at once; a running one is asked to stop at its next checkpoint
   * and reports its current status, with `pauseRequestedAt` set, until its worker gets there. The
   * answer is always what the row says, never what the caller hoped for.
   */
  async pause(auth: AuthDto, id: string): Promise<MediaOperationDto> {
    const operation = await this.findOwned(auth, id);
    const kind = operation.kind as MediaOperationKind;

    if (!isPausableMediaOperationKind(kind)) {
      throw new BadRequestException('This kind of job cannot be paused');
    }

    if (operation.status === MediaOperationStatus.Paused) {
      return this.present(auth, operation);
    }

    if (!canPauseMediaOperation(operation)) {
      throw new BadRequestException('Only a queued or running job can be paused');
    }

    const paused = await this.repository.requestPause(id, auth.user.id, PAUSABLE_MEDIA_OPERATION_KINDS);
    if (!paused) {
      // It moved on between the read and the write: finished, validating or cancelled.
      return this.present(auth, await this.findOwned(auth, id));
    }

    this.logger.log(`Pause requested for media operation ${id} (${paused.status})`);
    return this.present(auth, paused);
  }

  /**
   * Resume a paused job, or withdraw a pause its worker has not reached yet.
   *
   * A resumed job joins the queue again and carries on from what it recorded; nothing it already did
   * is done twice. Resuming a job that is not paused and has no pause pending is refused.
   */
  async resume(auth: AuthDto, id: string): Promise<MediaOperationDto> {
    const operation = await this.findOwned(auth, id);

    if (!canResumeMediaOperation(operation)) {
      throw new BadRequestException('This job is not paused');
    }

    const resumed = await this.repository.resume(id, auth.user.id);
    if (!resumed) {
      return this.present(auth, await this.findOwned(auth, id));
    }

    this.logger.log(`Media operation ${id} resumed (${resumed.status})`);
    return this.present(auth, resumed);
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

    if (operation.kind === MediaOperationKind.Bulk) {
      return this.retryBulk(auth, operation);
    }

    if (operation.kind === MediaOperationKind.EnrichmentPlan) {
      return this.retryEnrichmentPlan(auth, operation);
    }

    // FL-69: a scan or search is started again from Library Care, which admits one at a time and
    // opens fresh runs; copying the old row would reopen finished runs beside a running job.
    if (operation.kind === MediaOperationKind.MediaHealth) {
      throw new BadRequestException('Start the scan or search again from Library Care');
    }

    // FL-73: a deduplication plan is applied only after a fresh review, the typed confirmation and
    // the one-plan-at-a-time check; copying the old row would skip all of them.
    if (operation.kind === MediaOperationKind.PhysicalDeduplication) {
      throw new BadRequestException('Apply a new reviewed plan from the Physical deduplication page');
    }

    // FL-78: a library scan reads the library's folders afresh and admits one scan per library; it is
    // started again from Libraries, where the folders and the owner are checked first.
    if (operation.kind === MediaOperationKind.LibraryScan) {
      throw new BadRequestException('Scan the library again from Libraries');
    }

    // FL-160: a backup run is started again with "Back up now", which checks the claim and the key
    // first; only new or changed files upload, so nothing is lost by not copying the old run.
    if (operation.kind === MediaOperationKind.CloudBackup) {
      throw new BadRequestException('Back up again from Settings › Frameleaf Cloud › Cloud backup');
    }

    // FL-163: a Frameleaf Cloud description batch spends the AI Wallet, which only an administrator may
    // do, and only after a fresh estimate; a photo owner retrying it here would queue that spend again.
    if (operation.kind === MediaOperationKind.CloudDescriptionBatch) {
      throw new BadRequestException(
        'An administrator describes these photos again from Frameleaf Cloud processing, where the estimate comes first',
      );
    }

    if (operation.kind === MediaOperationKind.ICloudSync) {
      return this.retryICloudSync(auth, operation);
    }

    if (isPreservationKind(operation.kind)) {
      return this.retryPreservation(auth, operation);
    }

    const edit = editOperationEdit(operation);
    if (edit) {
      return this.retryEdit(auth, operation, edit);
    }

    // FL-106: a Studio export is a version of its project. Its render and its publication each had
    // their automatic retry; exporting again makes a new version against the project as it is now,
    // with its sources re-checked, rather than a copy of a job whose version already ended.
    if (
      operation.kind === MediaOperationKind.StudioExport ||
      operation.kind === MediaOperationKind.StudioExportPublish
    ) {
      throw new BadRequestException('Export the project again from Studio');
    }

    if (!canRetryMediaOperation(operation.status as MediaOperationStatus)) {
      throw new BadRequestException('Only a failed or cancelled job can be retried');
    }

    // Asking twice answers with the retry already waiting (FL-43; FL-65 for Google Photos import
    // steps, which resume from their import's rows): a double click, a second tab or a resent
    // request never queues the same work twice.
    const active = await this.repository.getActiveRetry(operation.id, auth.user.id);
    if (active) {
      return this.present(auth, active);
    }

    // A retry is a new submission and is checked like one (FL-43): access to the item may have
    // changed since the job was first queued, and a job over an item that is Locked now needs the
    // unlocked session, exactly as queueing it afresh would.
    if (operation.assetId) {
      await this.requireUnlockedFor(auth, [operation.assetId]);
    }

    const { operation: retried } = await this.repository.createRetry({
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
    return this.present(auth, retried);
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

  /**
   * Retry a bulk operation: resume it, not repeat it.
   *
   * The new job covers exactly the items the old one did not finish — those that failed, those it
   * never reached (a batch interrupted mid-flight included) and those still waiting for their
   * automatic retry — and nothing it already applied or refused for lack of access. A completed
   * job with failures inside it can be retried too, because "completed" there means the worker got
   * to the end, not that every item worked. This manual retry is a new job and gets its own one
   * automatic retry (owner decision, September 22, 2026).
   *
   * Asking twice while a retry is still running answers with that retry.
   */
  private async retryBulk(auth: AuthDto, operation: MediaOperation): Promise<MediaOperationDto> {
    const status = operation.status as MediaOperationStatus;
    if (isActiveMediaOperation(status)) {
      throw new BadRequestException('This job is still running');
    }

    const active = await this.repository.getActiveRetry(operation.id, auth.user.id);
    if (active) {
      return this.present(auth, active);
    }

    const snapshot = parseBulkSnapshot(operation.snapshot);
    // FL-69: a relink, recovery or trash is reviewed again in Library Care, where its consent, typed
    // confirmation, PIN and evidence freshness are checked; a copied retry would skip them.
    if (isMediaHealthBulkAction(snapshot.action)) {
      throw new BadRequestException('Review these items again in Library Care');
    }
    const result = parseBulkResult(operation.result, snapshot.assetIds.length);
    const remaining = bulkResumeIds(snapshot, result, Number(operation.processedUnits ?? 0));
    if (remaining.length === 0) {
      throw new BadRequestException('Nothing in this job is left to retry');
    }

    // The submitting key may since have been narrowed; a retry is a new submission.
    const requested = BULK_ACTION_PERMISSIONS[snapshot.action];
    if (auth.apiKey && !isGranted({ requested: [...requested], current: auth.apiKey.permissions })) {
      throw new ForbiddenException(`Missing required permission: ${requested.join(', ')}`);
    }

    await this.requireTargetAccess(auth, snapshot.action, snapshot.payload);
    await this.requireUnlockedFor(auth, remaining);

    const retrySnapshot: BulkOperationSnapshot = {
      ...snapshot,
      assetIds: remaining,
      // The idempotency key belongs to the original submission, not to this retry.
      requestId: null,
      apiKeyId: auth.apiKey?.id ?? null,
      // The retry acts with the retrying session's PIN, which was just checked above.
      elevated: auth.session?.hasElevatedPermission === true,
    };

    const { operation: retried } = await this.repository.createRetry({
      ownerId: operation.ownerId,
      kind: MediaOperationKind.Bulk,
      destination: operation.destination,
      destinationDetail: operation.destinationDetail,
      label: bulkOperationLabel(snapshot.action, remaining.length),
      assetId: null,
      resultAssetId: null,
      retryOfId: operation.id,
      projectId: null,
      revisionId: null,
      snapshot: retrySnapshot as unknown as Record<string, unknown>,
      settings: operation.settings,
      estimate: null,
      // A relative date shift carries the starting dates it recorded: an item it may have reached
      // must be shifted from where it started, not from where it is now.
      result: {
        ...emptyBulkResult(remaining.length),
        shiftFrom: carriedShiftOrigins(result, remaining),
      } as unknown as Record<string, unknown>,
      totalUnits: String(remaining.length),
      maxAttempts: operation.maxAttempts,
    });

    // FL-32: a transactional archive or undo follows its retry, so the retry may publish and the
    // operation reports the job that is actually running.
    const archiveOperationId = snapshot.payload.archiveOperationId;
    if (archiveOperationId) {
      await this.archiveOperations.relinkJob(archiveOperationId, operation.id, retried.id);
    }

    this.logger.log(`Bulk media operation ${operation.id} retried as ${retried.id} (${remaining.length} items)`);
    return this.present(auth, retried);
  }

  /**
   * Retry an enrichment plan (FL-59): resume it, not repeat it. The new plan keeps the pinned
   * stages, destinations and configuration and covers exactly the assets that did not finish —
   * failed, never reached, or still waiting for their automatic retry. Each carries the stage
   * outcomes it already has, so only the stages that failed run again. Like any resubmission, it
   * needs the unlocked session if it reaches Locked items. Asking twice answers with the first retry.
   */
  private async retryEnrichmentPlan(auth: AuthDto, operation: MediaOperation): Promise<MediaOperationDto> {
    if (isActiveMediaOperation(operation.status as MediaOperationStatus)) {
      throw new BadRequestException('This job is still running');
    }

    const active = await this.repository.getActiveRetry(operation.id, auth.user.id);
    if (active) {
      return this.present(auth, active);
    }

    const snapshot = parseEnrichmentPlanSnapshot(operation.snapshot);
    const result = parseEnrichmentPlanResult(operation.result);
    const remaining = enrichmentResumeIds(snapshot, result, Number(operation.processedUnits ?? 0));
    if (remaining.length === 0) {
      throw new BadRequestException('Nothing in this job is left to retry');
    }

    await this.requireUnlockedFor(auth, remaining);

    const record = enrichmentRetryRecord(snapshot, result, remaining);
    // The retry acts with the retrying session's PIN, which was just checked above.
    const retrySnapshot = { ...record.snapshot, elevated: auth.session?.hasElevatedPermission === true };
    const { operation: retried } = await this.repository.createRetry({
      ownerId: operation.ownerId,
      kind: MediaOperationKind.EnrichmentPlan,
      destination: operation.destination,
      destinationDetail: operation.destinationDetail,
      label: enrichmentPlanLabel(remaining.length),
      assetId: remaining.length === 1 ? remaining[0] : null,
      resultAssetId: null,
      retryOfId: operation.id,
      projectId: null,
      revisionId: null,
      snapshot: retrySnapshot as unknown as Record<string, unknown>,
      settings: operation.settings,
      estimate: null,
      result: record.result as unknown as Record<string, unknown>,
      totalUnits: String(remaining.length),
      maxAttempts: operation.maxAttempts,
    });

    this.logger.log(`Enrichment plan ${operation.id} retried as ${retried.id} (${remaining.length} items)`);
    return this.present(auth, retried);
  }

  /**
   * Retry an iCloud sync run (FL-68): a new run of the same connection, through the connection's own
   * locked path, so Activity can never start a second run beside one that is still going. The failed
   * items' back-off is cleared first. When a run is already unfinished, that run is the answer.
   */
  private async retryICloudSync(auth: AuthDto, operation: MediaOperation): Promise<MediaOperationDto> {
    if (!canRetryMediaOperation(operation.status as MediaOperationStatus)) {
      throw new BadRequestException('Only a failed or cancelled job can be retried');
    }

    const connectionId = asObject(operation.snapshot).connectionId;
    if (typeof connectionId !== 'string') {
      throw new BadRequestException('This job cannot be retried');
    }

    const queued = await this.icloud.queueOperation(connectionId, auth.user.id, {
      trigger: 'retry',
      retryOfId: operation.id,
    });
    switch (queued.outcome) {
      case 'created':
      case 'existing':
      case 'busy': {
        this.logger.log(`iCloud sync run ${operation.id} retried as ${queued.operation.id} (${queued.outcome})`);
        // Wake the worker now instead of at its next tick; losing the nudge only costs that delay.
        void this.jobs.queue({ name: JobName.ICloudSync, data: { id: connectionId } }).catch(() => {});
        return this.present(auth, queued.operation);
      }
      case 'not-ready': {
        throw new BadRequestException('Sign in to this iCloud connection again before retrying');
      }
      default: {
        throw new BadRequestException('This iCloud connection is no longer connected');
      }
    }
  }

  /**
   * Retry an edit render (FL-43). The new row copies the snapshot and goes straight to the job queue
   * with its job: a photo edit renders the saved edit again, a photo version renders its revision
   * again (queued afresh, as the editor's Render does), a video edit the requested version and a
   * video export its version. Like any resubmission, an edit of an item that is Locked now needs the
   * unlocked session. Asking twice answers with the retry already queued.
   */
  private async retryEdit(
    auth: AuthDto,
    operation: MediaOperation,
    edit: EditOperationEdit,
  ): Promise<MediaOperationDto> {
    if (!canRetryEdit(edit, operation.status as MediaOperationStatus)) {
      throw new BadRequestException('Only a failed edit can be retried');
    }

    const active = await this.repository.getActiveRetry(operation.id, auth.user.id);
    if (active) {
      return this.present(auth, active);
    }

    if (operation.assetId) {
      await this.requireUnlockedFor(auth, [operation.assetId]);
    } else {
      throw new BadRequestException('The edited item is no longer in this library');
    }

    if (edit === EditOperationEdit.PhotoVersion) {
      const revision = operation.revisionId ? await this.develop.get(operation.revisionId) : undefined;
      if (!revision || revision.ownerId !== auth.user.id || revision.assetId !== operation.assetId) {
        throw new BadRequestException('This version no longer exists');
      }
      if (
        revision.status === AssetDevelopRevisionStatus.Queued ||
        revision.status === AssetDevelopRevisionStatus.Rendering
      ) {
        throw new BadRequestException('This version is already being rendered');
      }
      await this.develop.update(revision.id, {
        status: AssetDevelopRevisionStatus.Queued,
        progress: 0,
        error: null,
        cancelRequested: false,
        attempts: 0,
      });
    }

    const { operation: retried, created } = await this.repository.createRetry({
      ownerId: operation.ownerId,
      kind: operation.kind,
      destination: operation.destination,
      destinationDetail: operation.destinationDetail,
      label: operation.label,
      assetId: operation.assetId,
      resultAssetId: null,
      retryOfId: operation.id,
      projectId: null,
      revisionId: operation.revisionId,
      snapshot: operation.snapshot,
      settings: operation.settings,
      estimate: null,
      maxAttempts: operation.maxAttempts,
      claimedBy: JOB_QUEUE_CLAIMANT,
    });

    if (created) {
      const item = editOperationJobItem(retried.id, retried.snapshot);
      if (item) {
        // Losing this only delays the retry: recovery dispatches a queued edit that has no job.
        await this.jobs.queue(item).catch((error) => {
          this.logger.warn(`Edit retry ${retried.id} will be dispatched by recovery: ${error}`);
        });
      }
      this.logger.log(`Edit ${operation.id} retried as ${retried.id}`);
    }
    return this.present(auth, retried);
  }

  /**
   * The Locked folder's PIN, enforced at submit.
   *
   * The worker is a system actor that can reach the owner's Locked items (owner decision,
   * September 22, 2026). That is only safe if nobody can hand it Locked items without having
   * unlocked the folder first — otherwise this endpoint would be a way round the PIN. So a job that
   * touches any Locked item must come from an elevated session, exactly as a direct change would.
   * API keys and ordinary sessions can still queue jobs over everything else.
   */
  /**
   * The caller's own Locked media among these operations' asset ids. An operation keeps the ids it was
   * given; a session that has not unlocked the Locked folder is never told which of them are Locked
   * now, so those ids are left out of what it reads (FL-34).
   */
  private async hiddenLockedIds(auth: AuthDto, operations: MediaOperation[]): Promise<Set<string>> {
    if (getLockedOwnerId(auth)) {
      return new Set();
    }

    const ids = new Set<string>();
    for (const operation of operations) {
      const candidates = [operation.assetId, operation.resultAssetId, ...bulkItems(operation).map(({ id }) => id)];
      for (const id of candidates) {
        // stored results are data, not a contract: only well-formed ids reach the uuid lookup
        if (id && UUID_PATTERN.test(id)) {
          ids.add(id);
        }
      }
    }

    return ids.size > 0 ? this.repository.getLockedAssetIds(auth.user.id, [...ids]) : new Set();
  }

  private async present(auth: AuthDto, operation: MediaOperation): Promise<MediaOperationDto> {
    return mapOperation(operation, await this.hiddenLockedIds(auth, [operation]));
  }

  private async requireUnlockedFor(auth: AuthDto, assetIds: string[]): Promise<void> {
    if (auth.session?.hasElevatedPermission) {
      return;
    }

    const locked = await this.repository.countLockedAssets(auth.user.id, assetIds);
    if (locked > 0) {
      throw new ForbiddenException('Unlock the Locked folder to include Locked items in this job');
    }
  }

  /**
   * The album or tags a bulk action writes to must be writable by this account now. Assets are
   * checked later, one at a time, by the worker.
   */
  private async requireTargetAccess(
    auth: AuthDto,
    action: MediaOperationBulkAction,
    payload: BulkOperationSnapshot['payload'],
  ): Promise<void> {
    switch (action) {
      case MediaOperationBulkAction.AddToAlbum: {
        await requireAccess(this.access, {
          auth,
          permission: Permission.AlbumAssetCreate,
          ids: [payload.albumId as string],
        });
        break;
      }
      case MediaOperationBulkAction.RemoveFromAlbum: {
        await requireAccess(this.access, {
          auth,
          permission: Permission.AlbumAssetDelete,
          ids: [payload.albumId as string],
        });
        break;
      }
      case MediaOperationBulkAction.Tag:
      case MediaOperationBulkAction.Untag: {
        await requireAccess(this.access, { auth, permission: Permission.TagAsset, ids: payload.tagIds ?? [] });
        break;
      }
      case MediaOperationBulkAction.Unstack: {
        await requireAccess(this.access, { auth, permission: Permission.StackDelete, ids: payload.stackIds ?? [] });
        break;
      }
      default: {
        break;
      }
    }
  }

  /**
   * Retry a preservation job (FL-74) from Activity the way the preservation page does: it carries on
   * from its package's or restoration's own rows. One job per package or restoration (asking while
   * one runs answers with it), failed items get their automatic retry back, and an export holding
   * Locked items is retried only from an unlocked session, as it could only be asked for from one.
   */
  private async retryPreservation(auth: AuthDto, operation: MediaOperation): Promise<MediaOperationDto> {
    if (!canRetryMediaOperation(operation.status as MediaOperationStatus)) {
      throw new BadRequestException('Only a failed or cancelled job can be retried');
    }

    let snapshot: ReturnType<typeof parsePreservationSnapshot>;
    try {
      snapshot = parsePreservationSnapshot(operation.kind, operation.snapshot);
    } catch (error) {
      if (error instanceof PreservationPackageError) {
        throw new BadRequestException('This job can no longer be retried');
      }
      throw error;
    }
    const restoreId = 'restoreId' in snapshot ? snapshot.restoreId : null;
    const active = restoreId
      ? await this.preservation.activeOperation(auth.user.id, 'restoreId', restoreId)
      : await this.preservation.activeOperation(auth.user.id, 'packageId', snapshot.packageId);
    if (active) {
      return this.present(auth, active);
    }

    const found = await this.preservation.getPackage(snapshot.packageId, auth.user.id);
    if (!found || found.removedAt) {
      throw new BadRequestException('The package this job worked on has been removed');
    }
    if (restoreId) {
      const restore = await this.preservation.getRestore(restoreId, auth.user.id);
      if (!restore) {
        throw new BadRequestException('The restoration this job worked on is gone');
      }
      if (operation.kind === MediaOperationKind.PreservationRestore) {
        if (!['ready', 'restoring', 'completed'].includes(restore.status)) {
          throw new BadRequestException('Review the package before restoring it');
        }
        await this.preservation.resetFailedRestoreItems(restore.id);
      }
    } else if (operation.kind === MediaOperationKind.PreservationExport) {
      if (found.includeLocked && !getLockedOwnerId(auth)) {
        throw new ForbiddenException('Unlock the Locked view to retry a package that includes Locked items');
      }
      await this.preservation.resetFailedItems(found.id);
    }

    // Two requests racing past the check above meet at the one-active-retry index (FL-43): one
    // inserts, the other is answered with the winner instead of a unique violation.
    const { operation: retried, created } = await this.repository.createRetry({
      ownerId: operation.ownerId,
      kind: operation.kind,
      destination: operation.destination,
      destinationDetail: operation.destinationDetail,
      label: operation.label,
      assetId: null,
      resultAssetId: null,
      retryOfId: operation.id,
      projectId: null,
      revisionId: null,
      snapshot: { ...(operation.snapshot as Record<string, unknown>), requestKey: null },
      settings: operation.settings,
      estimate: null,
      maxAttempts: operation.maxAttempts,
    });
    if (created) {
      this.logger.log(`Preservation job ${operation.id} retried as ${retried.id}`);
    }
    return this.present(auth, retried);
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
