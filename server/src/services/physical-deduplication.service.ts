import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { join, parse } from 'node:path';
import type { JobOf, PhysicalDeduplicationMigrationState } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnJob } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  PHYSICAL_DEDUPLICATION_PREVIEW_LIMIT,
  PhysicalDeduplicationCopyState,
  PhysicalDeduplicationPlanDto,
  PhysicalDeduplicationPreviewRequestDto,
  PhysicalDeduplicationPreviewResponseDto,
  PhysicalDeduplicationRetainedState,
  PhysicalDeduplicationReviewRequestDto,
  PhysicalDeduplicationVerificationDto,
  PhysicalDeduplicationVerificationItem,
} from 'src/dtos/physical-deduplication.dto.js';
import {
  AssetFileType,
  AssetType,
  DatabaseLock,
  JobName,
  JobStatus,
  Permission,
  PhysicalDeduplicationDecision,
  PhysicalDeduplicationPlanMode,
  PhysicalDeduplicationSkipReason,
  PhysicalFileType,
  QueueName,
  StorageFolder,
  SystemMetadataKey,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { getLockedOwnerId } from 'src/utils/locked-visibility.js';
import {
  PhysicalDeduplicationApplySnapshot,
  PhysicalDeduplicationEvidenceRow,
  PhysicalDeduplicationItemOutcome,
  PhysicalDeduplicationItemReason,
  PhysicalDeduplicationPlanItem,
  PhysicalDeduplicationPlanRetained,
  copyEvidenceProblem,
  currentReferences,
  normalizeExcluded,
  physicalDeduplicationByteAccounting,
  physicalDeduplicationConfirmation,
  physicalDeduplicationFingerprint,
  physicalDeduplicationPlanId,
  physicalDeduplicationPlanItems,
  physicalDeduplicationReviewToken,
  retainedEvidenceProblem,
} from 'src/utils/physical-deduplication-plan.js';

type MigrationSummary = PhysicalDeduplicationMigrationState;

const generatedFileTypes = new Set([
  AssetFileType.Thumbnail,
  AssetFileType.Preview,
  AssetFileType.FullSize,
  AssetFileType.EncodedVideo,
]);

const asAssetType = (type: string): AssetType =>
  Object.values(AssetType).includes(type as AssetType) ? (type as AssetType) : AssetType.Other;

/** Dimensions and length for the preview's detail line (FL-73); null when the asset has none recorded. */
const mediaDetailOf = (row: { width?: number | null; height?: number | null; duration?: number | null }) => ({
  width: row.width ?? null,
  height: row.height ?? null,
  duration: row.duration ?? null,
});

/** What a copy of a reviewed plan came to, before the worker stamps it with the id and time. */
export type PhysicalDeduplicationItemResult = Omit<PhysicalDeduplicationItemOutcome, 'id' | 'at'>;

/** A file checked against the evidence it was reviewed with. */
type DiskEvidence = 'match' | 'missing' | 'mismatch';

/** Retained originals one apply run has already hashed, so a group's copies do not hash it again. */
export type PhysicalDeduplicationVerified = Map<string, DiskEvidence>;

/**
 * A reviewed plan checked against the library again (FL-73): what review hands back and what apply
 * freezes into the durable job.
 */
export type PreparedPhysicalDeduplicationPlan = {
  planId: string;
  fingerprint: string;
  reviewToken: string;
  confirmation: string;
  masterUserId: string;
  scopeUserId: string | null;
  ranAt: string;
  excludedRetainedAssetIds: string[];
  items: PhysicalDeduplicationPlanItem[];
  retained: PhysicalDeduplicationPlanRetained[];
  estimatedBytes: number;
  /** Copies in the plan that are Locked media the requester may not be shown. Counted, never named. */
  hiddenCopies: number;
};

/** Whether a copy's asset still resolves to the retained original's shared physical file. */
const isLinkedToRetained = (
  row: PhysicalDeduplicationEvidenceRow | undefined,
  retainedRow: PhysicalDeduplicationEvidenceRow | undefined,
) =>
  !!row &&
  !row.deletedAt &&
  !!retainedRow &&
  !!row.physicalOriginalFileId &&
  row.physicalOriginalFileId === retainedRow.physicalOriginalFileId &&
  row.originalPath === retainedRow.originalPath;

const skipped = (reasonKey: PhysicalDeduplicationItemReason): PhysicalDeduplicationItemResult => ({
  state: 'skipped',
  reasonKey,
  message: null,
  reclaimedBytes: 0,
});

/**
 * Physical deduplication (FL-71, FL-73).
 *
 * The dry run is a preview: it may retain originals in an account chosen on the page and may
 * review a single account's copies. It never changes files.
 *
 * Applying is never a generic queue button (FL-73). An administrator reviews one specific plan —
 * the evidence is checked against the library again, and the per-group decisions are bound to it by
 * a review token — then applies exactly that set as a durable `physical_deduplication` job, typed
 * confirmation and all. Applying always uses the saved `physicalDeduplication.masterUserId` and
 * requires the feature to be enabled. Each copy is checked once more before its file is touched:
 * the retained original must still hash to the reviewed checksum on disk, the copy must still be
 * the reviewed bytes, and a copy whose evidence changed is left alone. Asset rows are never removed
 * or merged, so albums, faces, stacks, shared links and lock records keep pointing at the same
 * assets; only the copy's original path moves to the retained file. Originals are never written
 * to, and a retained original is never deleted: the only file removed is the reviewed copy, and only
 * while nothing references it.
 */
@Injectable()
export class PhysicalDeduplicationService extends BaseService {
  /**
   * Keys review tokens (FL-73), so a token can only come from a review this server made. Kept in
   * memory like the Studio grant secret: a restart only means reviewing the plan again.
   */
  #reviewSecret: string | null = null;

  private get reviewSecret(): string {
    this.#reviewSecret ??= this.cryptoRepository.randomBytesAsText(32);
    return this.#reviewSecret;
  }

  @OnJob({ name: JobName.PhysicalDeduplicationMigrationDryRun, queue: QueueName.StorageTemplateMigration })
  async handleDryRun(job: JobOf<JobName.PhysicalDeduplicationMigrationDryRun>): Promise<JobStatus> {
    const state = await this.forkSchemaRepository.getState();
    if (state.phase === 'inactive' || state.phase === 'failed') {
      this.logger.warn(`Physical deduplication skipped in fork-schema ${state.phase} phase`);
      return JobStatus.Skipped;
    }

    const { physicalDeduplication } = await this.getConfig({ withCache: true });
    const masterUserId = job?.masterUserId ?? physicalDeduplication.masterUserId;
    if (!masterUserId) {
      this.logger.warn('Physical deduplication dry run skipped: no retained account was chosen or saved');
      return JobStatus.Skipped;
    }

    if (!(await this.isActiveUser(masterUserId))) {
      this.logger.warn('Physical deduplication dry run skipped: the retained account does not exist or is deleted');
      return JobStatus.Skipped;
    }

    const scopeUserId = job?.scopeUserId ?? null;
    if (scopeUserId && !(await this.isActiveUser(scopeUserId))) {
      this.logger.warn('Physical deduplication dry run skipped: the scoped account does not exist or is deleted');
      return JobStatus.Skipped;
    }

    await this.databaseRepository.withLock(DatabaseLock.StorageTemplateMigration, async () => {
      const summary = await this.runMigration(masterUserId, scopeUserId);
      await this.systemMetadataRepository.set(SystemMetadataKey.PhysicalDeduplicationMigration, summary);
    });

    return JobStatus.Success;
  }

  /**
   * The old whole-server apply job (FL-71). Applying now needs a reviewed plan (FL-73), so a job
   * still queued from before, or through the retired manual job, changes nothing.
   */
  @OnJob({ name: JobName.PhysicalDeduplicationMigrationApply, queue: QueueName.StorageTemplateMigration })
  handleApply(_: JobOf<JobName.PhysicalDeduplicationMigrationApply>): Promise<JobStatus> {
    this.logger.warn(
      'Physical deduplication apply skipped: apply a reviewed plan from the Physical deduplication page instead',
    );
    return Promise.resolve(JobStatus.Skipped);
  }

  /** Queue a preview. Validation happens here so the page gets an immediate answer; the job re-checks. */
  async requestPreview(dto: PhysicalDeduplicationPreviewRequestDto): Promise<void> {
    const { physicalDeduplication } = await this.getConfig({ withCache: false });
    // The page's configuration error (FL-73, prototype physical-dedup-data.mjs:76-86): file reuse
    // must be on before a plan is prepared. The queued job itself stays lenient for old queues.
    if (!physicalDeduplication.enabled) {
      throw new BadRequestException('Enable file reuse before preparing a plan.');
    }
    const masterUserId = dto.masterUserId ?? physicalDeduplication.masterUserId;
    if (!masterUserId) {
      throw new BadRequestException('Choose an account to retain originals in before preparing a preview');
    }

    if (!(await this.isActiveUser(masterUserId))) {
      throw new BadRequestException('The retained account does not exist');
    }

    if (dto.scopeUserId && !(await this.isActiveUser(dto.scopeUserId))) {
      throw new BadRequestException('The scoped account does not exist');
    }

    if (dto.scopeUserId === masterUserId) {
      throw new BadRequestException('The scoped account cannot be the retained account');
    }

    await this.jobRepository.queue({
      name: JobName.PhysicalDeduplicationMigrationDryRun,
      data: { masterUserId, scopeUserId: dto.scopeUserId },
    });
  }

  /**
   * The latest plan for the requesting administrator. Owner names come from the user table;
   * `canView` is the requester's own `AssetRead` access, re-evaluated on every read, so the
   * response never widens what the administrator may already open.
   */
  async getPreview(auth: AuthDto): Promise<PhysicalDeduplicationPreviewResponseDto> {
    const { physicalDeduplication } = await this.getConfig({ withCache: false });
    const counts = await this.jobRepository.getJobCounts(QueueName.StorageTemplateMigration);
    const running = counts.active + counts.waiting + counts.delayed + counts.paused > 0;
    const state = await this.systemMetadataRepository.get(SystemMetadataKey.PhysicalDeduplicationMigration);

    // `applying` and `applies` come from the durable jobs, which PhysicalDeduplicationPlanService adds.
    const response: PhysicalDeduplicationPreviewResponseDto = {
      plan: null,
      savedMasterUserId: physicalDeduplication.masterUserId ?? null,
      enabled: physicalDeduplication.enabled,
      running,
      applying: false,
      applies: [],
    };

    if (!state) {
      return response;
    }

    // The plan was recorded by a background run, which sees Locked media. Its per-asset rows name ids,
    // file names and paths, so a Locked asset's row reaches only its owner's elevated session (FL-34);
    // the plan's totals stay whole. A copy is the same bytes as its retained original, so the copies
    // of a hidden retained original are hidden with it (FL-73): their checksum, name and link would
    // otherwise describe the Locked original.
    const { retained, copies } = await this.visibleRows(auth, state);
    // Per group, the copies it would share that are not listed, so the page can count a group it
    // leaves out exactly (FL-73).
    const shown = new Set(copies.map((item) => item.assetId));
    const hiddenShares = new Map<string, number>();
    for (const item of physicalDeduplicationPlanItems(state, []).items) {
      if (!shown.has(item.assetId)) {
        hiddenShares.set(item.retainedAssetId, (hiddenShares.get(item.retainedAssetId) ?? 0) + 1);
      }
    }
    const users = await this.userRepository.getList({ withDeleted: true });
    const nameOf = (userId: string) => users.find((user) => user.id === userId)?.name ?? userId;
    const viewable = await this.checkAccess({
      auth,
      permission: Permission.AssetRead,
      ids: [...retained.map((item) => item.assetId), ...copies.map((item) => item.assetId)],
    });

    // FL-71 UT-24: whether each retained original is still on disk, read now rather than trusted from
    // the stored preview, so the page can mark an original that went missing since.
    const available = await Promise.all(
      retained.map(async (item) => {
        try {
          return await this.storageRepository.checkFileExists(item.originalPath);
        } catch {
          return false;
        }
      }),
    );

    const fingerprint = physicalDeduplicationFingerprint(state);
    const bytes = physicalDeduplicationByteAccounting(state.retained ?? []);
    const plan: PhysicalDeduplicationPlanDto = {
      mode: state.mode === 'apply' ? PhysicalDeduplicationPlanMode.Apply : PhysicalDeduplicationPlanMode.DryRun,
      ranAt: state.ranAt,
      masterUserId: state.masterUserId,
      masterUserName: nameOf(state.masterUserId),
      scopeUserId: state.scopeUserId ?? null,
      scopeUserName: state.scopeUserId ? nameOf(state.scopeUserId) : null,
      eligibleAssets: state.eligibleAssets,
      linkedAssets: state.linkedAssets,
      skippedExternal: state.skippedExternal,
      skippedMissingMaster: state.skippedMissingMaster,
      reclaimableBytes: state.reclaimableBytes,
      deletedBytes: state.deletedBytes,
      logicalBytes: bytes.logicalBytes,
      sharedOriginalBytes: bytes.sharedOriginalBytes,
      retained: retained.map((item, index) => ({
        ...item,
        ...mediaDetailOf(item),
        ownerName: nameOf(item.ownerId),
        canView: viewable.has(item.assetId),
        fileAvailable: available[index],
        hiddenCopies: hiddenShares.get(item.assetId) ?? 0,
      })),
      copies: copies.map((item) => ({
        ...item,
        ...mediaDetailOf(item),
        ownerName: nameOf(item.ownerId),
        canView: viewable.has(item.assetId),
      })),
      copiesTruncated: state.copiesTruncated ?? false,
      planId: physicalDeduplicationPlanId(fingerprint),
      fingerprint,
      applicableCopies: physicalDeduplicationPlanItems(state, []).items.length,
      hiddenCopies: (state.copies ?? []).length - copies.length,
    };

    return { ...response, plan };
  }

  /** The rows of a stored plan the requester may be shown; see `getPreview`. */
  private async visibleRows(auth: AuthDto, state: MigrationSummary) {
    const lockedIds = await this.assetRepository.getLockedAssetIds([
      ...(state.retained ?? []).map((item) => item.assetId),
      ...(state.copies ?? []).map((item) => item.assetId),
    ]);
    const lockedOwnerId = getLockedOwnerId(auth);
    const isShown = (item: { assetId: string; ownerId: string }) =>
      !lockedIds.has(item.assetId) || item.ownerId === lockedOwnerId;
    const retained = (state.retained ?? []).filter((item) => isShown(item));
    const hiddenRetained = new Set((state.retained ?? []).filter((item) => !isShown(item)).map((item) => item.assetId));
    const copies = (state.copies ?? []).filter(
      (item) => isShown(item) && !(item.retainedAssetId && hiddenRetained.has(item.retainedAssetId)),
    );
    return { retained, copies };
  }

  /* ------------------------------------------------------------------ */
  /* Reviewed plans (FL-73)                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Check the plan on screen against the library again and bind the administrator's per-group
   * decisions to it.
   *
   * Refused with 409 when the plan on screen is not the stored one (a newer preview replaced it, or
   * it was applied), and when any evidence of a copy it would share changed since the preview: the
   * copy or its retained original was removed, trashed, moved to another account, changed checksum,
   * size or path, or the retained original gained or lost references. Nothing is written.
   */
  async preparePlan(
    auth: AuthDto,
    dto: PhysicalDeduplicationReviewRequestDto,
  ): Promise<PreparedPhysicalDeduplicationPlan> {
    await this.requireStorageHandoffAllowsDeduplication();

    const state = await this.systemMetadataRepository.get(SystemMetadataKey.PhysicalDeduplicationMigration);
    if (!state) {
      throw new ConflictException('Prepare a plan before reviewing file changes.');
    }

    const fingerprint = physicalDeduplicationFingerprint(state);
    if (dto.fingerprint !== fingerprint) {
      throw new ConflictException('A newer preview replaced this plan. Review the latest plan.');
    }
    if (state.mode !== 'dry-run') {
      throw new ConflictException('This plan has already been applied.');
    }

    // Only groups of this plan can be left out; any other id is ignored rather than answered, so
    // the endpoint never tells which ids are retained originals (FL-73).
    const retainedIds = new Set((state.retained ?? []).map((item) => item.assetId));
    const excluded = normalizeExcluded(dto.excludedRetainedAssetIds).filter((id) => retainedIds.has(id));

    const { items, retained } = physicalDeduplicationPlanItems(state, excluded);
    if (items.length === 0) {
      throw new BadRequestException('This plan has no exact copies to share.');
    }

    if (await this.hasChangedEvidence(state.masterUserId, items, retained)) {
      throw new ConflictException('File or reference evidence changed. Prepare a new plan.');
    }

    const { copies } = await this.visibleRows(auth, state);
    const shown = new Set(copies.map((item) => item.assetId));
    const planId = physicalDeduplicationPlanId(fingerprint);

    return {
      planId,
      fingerprint,
      reviewToken: physicalDeduplicationReviewToken(this.reviewSecret, fingerprint, excluded),
      confirmation: physicalDeduplicationConfirmation(planId),
      masterUserId: state.masterUserId,
      scopeUserId: state.scopeUserId ?? null,
      ranAt: state.ranAt,
      excludedRetainedAssetIds: excluded,
      items,
      retained,
      estimatedBytes: items.reduce((total, item) => total + item.sizeInBytes, 0),
      hiddenCopies: items.filter((item) => !shown.has(item.assetId)).length,
    };
  }

  /**
   * What applying a reviewed plan requires beyond the review itself: the feature enabled, a saved
   * retained account, and that account being the one the plan retains originals in. A saved account
   * that changed since the review is a change like any other (409).
   */
  async requireApplyAllowed(plan: Pick<PreparedPhysicalDeduplicationPlan, 'masterUserId'>): Promise<void> {
    const { physicalDeduplication } = await this.getConfig({ withCache: false });
    if (!physicalDeduplication.enabled) {
      throw new BadRequestException('Enable file reuse before applying a plan.');
    }
    if (!physicalDeduplication.masterUserId) {
      throw new BadRequestException('Save the retained account in Storage settings before applying a plan.');
    }
    if (physicalDeduplication.masterUserId !== plan.masterUserId) {
      throw new ConflictException('The retained account changed. Prepare a new plan before continuing.');
    }
    if (!(await this.isActiveUser(plan.masterUserId))) {
      throw new ConflictException('The retained account no longer exists. Prepare a new plan.');
    }
  }

  /**
   * Record on the stored plan that a job has started changing files for it (FL-73), so the page and
   * the review report it as applied, or partly applied while its job has not completed, instead of
   * as a preview whose evidence merely changed. Only the plan the job was reviewed from is marked; a
   * newer preview is left alone. Taken under the storage migration lock, like the preview's write.
   */
  async recordPlanApplied(fingerprint: string, counts: { linkedAssets: number; deletedBytes: number }) {
    await this.databaseRepository.withLock(DatabaseLock.StorageTemplateMigration, async () => {
      const state = await this.systemMetadataRepository.get(SystemMetadataKey.PhysicalDeduplicationMigration);
      if (!state || physicalDeduplicationFingerprint(state) !== fingerprint) {
        return;
      }
      await this.systemMetadataRepository.set(SystemMetadataKey.PhysicalDeduplicationMigration, {
        ...state,
        mode: 'apply',
        linkedAssets: counts.linkedAssets,
        deletedBytes: counts.deletedBytes,
      });
    });
  }

  /** Whether the storage handoff lets physical files be shared at all right now. */
  async canApplyPlans(): Promise<boolean> {
    const state = await this.forkSchemaRepository.getState();
    return state.phase !== 'inactive' && state.phase !== 'failed';
  }

  private async requireStorageHandoffAllowsDeduplication() {
    if (!(await this.canApplyPlans())) {
      throw new BadRequestException('Physical deduplication is unavailable while the storage handoff is not active.');
    }
  }

  /**
   * The evidence check `preparePlan` runs: every copy and retained original read again in one query,
   * and every retained original's reference count counted again.
   */
  private async hasChangedEvidence(
    masterUserId: string,
    items: PhysicalDeduplicationPlanItem[],
    retained: PhysicalDeduplicationPlanRetained[],
  ): Promise<boolean> {
    const rows = await this.physicalFileRepository.getPlanEvidence([
      ...items.map((item) => item.assetId),
      ...retained.map((item) => item.assetId),
    ]);
    const byId = new Map(rows.map((row) => [row.id, row]));

    for (const original of retained) {
      if (retainedEvidenceProblem(original, byId.get(original.assetId), masterUserId)) {
        return true;
      }
    }

    for (const item of items) {
      const { reason, alreadyShared } = copyEvidenceProblem(
        item,
        byId.get(item.assetId),
        byId.get(item.retainedAssetId),
      );
      if (reason || alreadyShared) {
        return true;
      }
    }

    const counts = await this.physicalFileRepository.countOriginalReferencesFor(
      retained.map((item) => byId.get(item.assetId)?.physicalOriginalFileId).filter((id): id is string => !!id),
    );
    return retained.some((item) => currentReferences(byId.get(item.assetId)!, counts) !== item.referencesBefore);
  }

  /**
   * Apply one copy of a reviewed plan (FL-73). Called by the durable job's worker, one copy at a
   * time, under the storage migration lock so a preview or a storage template run cannot move files
   * underneath it. Safe to call again for a copy an earlier attempt reached: every step either
   * checks first or is idempotent, so nothing is applied twice.
   *
   * 1. The copy and its retained original are read again. Anything different from the reviewed
   *    evidence leaves the copy alone (`skipped`, with the reason).
   * 2. The retained original gets its shared physical file, and its bytes on disk must still hash to
   *    the reviewed checksum and size. Without that the copy is never removed.
   * 3. The copy's bytes on disk must still be the reviewed checksum and size.
   * 4. The copy's sidecar moves to its own upload folder, the copy's asset points at the retained
   *    file, and only then is the copy's old file removed, and only while nothing references it.
   *    Its generated files are shared the same way.
   *
   * A copy an earlier attempt already linked finishes its removals and reads `already-applied`.
   * `verified` remembers the retained originals this run has already hashed.
   */
  applyPlanItem(
    snapshot: PhysicalDeduplicationApplySnapshot,
    item: PhysicalDeduplicationPlanItem,
    verified: PhysicalDeduplicationVerified = new Map(),
  ): Promise<PhysicalDeduplicationItemResult> {
    return this.databaseRepository.withLock(DatabaseLock.StorageTemplateMigration, () =>
      this.applyPlanItemLocked(snapshot, item, verified),
    );
  }

  private async applyPlanItemLocked(
    snapshot: PhysicalDeduplicationApplySnapshot,
    item: PhysicalDeduplicationPlanItem,
    verified: PhysicalDeduplicationVerified,
  ): Promise<PhysicalDeduplicationItemResult> {
    const original = snapshot.retained.find((entry) => entry.assetId === item.retainedAssetId);
    if (!original) {
      return skipped('retained-changed');
    }

    const rows = await this.physicalFileRepository.getPlanEvidence([item.assetId, item.retainedAssetId]);
    const copyRow = rows.find((row) => row.id === item.assetId);
    const retainedRow = rows.find((row) => row.id === item.retainedAssetId);

    const retainedProblem = retainedEvidenceProblem(original, retainedRow, snapshot.masterUserId);
    if (retainedProblem) {
      return skipped(retainedProblem);
    }

    const copy = copyEvidenceProblem(item, copyRow, retainedRow);
    if (copy.reason) {
      return skipped(copy.reason);
    }

    const physicalFile = await this.physicalFileRepository.ensureOriginalPhysicalFile(item.retainedAssetId);
    if (!physicalFile) {
      return skipped('retained-changed');
    }

    const cacheKey = `${physicalFile.path}:${original.checksum}`;
    let retainedOnDisk = verified.get(cacheKey);
    if (!retainedOnDisk) {
      retainedOnDisk = await this.checkOnDisk(physicalFile.path, original.checksum, original.sizeInBytes);
      verified.set(cacheKey, retainedOnDisk);
    }
    if (retainedOnDisk !== 'match') {
      this.logger.warn(
        `Physical deduplication: retained original ${original.assetId} is ${retainedOnDisk} on disk; copy ${item.assetId} left as it is`,
      );
      return skipped(retainedOnDisk === 'missing' ? 'retained-missing' : 'retained-mismatch');
    }

    if (copy.alreadyShared) {
      // An earlier attempt linked this copy and stopped before its old file was removed.
      const reclaimed = await this.removeReviewedCopy(item, physicalFile.path, false);
      const generated = await this.shareGeneratedFiles(item.assetId, item.retainedAssetId);
      return { state: 'already-applied', reasonKey: null, message: null, reclaimedBytes: reclaimed + generated };
    }

    if (item.originalPath !== physicalFile.path) {
      const copyOnDisk = await this.checkOnDisk(item.originalPath, item.checksum, item.sizeInBytes);
      if (copyOnDisk !== 'match') {
        return skipped(copyOnDisk === 'missing' ? 'copy-missing' : 'copy-mismatch');
      }
    }

    await this.migrateSidecarFile(item.assetId, item.ownerId, item.originalPath);
    await this.physicalFileRepository.linkAssetToOriginalPhysicalFile(item.assetId, physicalFile);
    const reclaimed = await this.removeReviewedCopy(item, physicalFile.path, true);
    const generated = await this.shareGeneratedFiles(item.assetId, item.retainedAssetId);
    return { state: 'applied', reasonKey: null, message: null, reclaimedBytes: reclaimed + generated };
  }

  /* ------------------------------------------------------------------ */
  /* Verification and rollback of an applied plan (FL-73)                */
  /* ------------------------------------------------------------------ */

  /**
   * Verify the copies an applied plan changed: every retained original they share is hashed again
   * against its reviewed checksum and size, and every copy is checked to still resolve to it. For
   * each copy the report also says what is at its own former path, because that decides what can
   * be undone: a copy whose own file was removed cannot go back (the bytes are gone; the retained
   * original is the only copy), while a copy whose own file is still there can.
   *
   * Nothing is written. Rows of another account's Locked media are counted, never listed (FL-34).
   */
  async verifyAppliedCopies(
    auth: AuthDto,
    snapshot: PhysicalDeduplicationApplySnapshot,
    appliedIds: readonly string[],
  ): Promise<Omit<PhysicalDeduplicationVerificationDto, 'operationId' | 'planId' | 'verifiedAt'>> {
    const applied = new Set(appliedIds);
    const items = snapshot.items.filter((item) => applied.has(item.assetId));
    const retainedIds = [...new Set(items.map((item) => item.retainedAssetId))];
    const rows = await this.physicalFileRepository.getPlanEvidence([
      ...items.map((item) => item.assetId),
      ...retainedIds,
    ]);
    const byId = new Map(rows.map((row) => [row.id, row]));

    const retainedFiles = new Map<string, PhysicalDeduplicationVerificationItem['retainedFile']>();
    for (const retainedId of retainedIds) {
      const original = snapshot.retained.find((entry) => entry.assetId === retainedId);
      if (!original) {
        retainedFiles.set(retainedId, 'changed');
        continue;
      }
      const path = byId.get(retainedId)?.originalPath ?? original.originalPath;
      const disk = await this.checkOnDisk(path, original.checksum, original.sizeInBytes);
      retainedFiles.set(retainedId, disk === 'match' ? 'intact' : disk === 'missing' ? 'missing' : 'changed');
    }

    const isShown = await this.verificationVisibility(auth, snapshot, items);
    const shownItems = items.filter((item) => isShown(item));
    const users = shownItems.length > 0 ? await this.userRepository.getList({ withDeleted: true }) : [];
    const viewable =
      shownItems.length > 0
        ? await this.checkAccess({
            auth,
            permission: Permission.AssetRead,
            ids: shownItems.map((item) => item.assetId),
          })
        : new Set<string>();

    const retainedStates = retainedFiles.values().toArray();
    const report = {
      copies: items.length,
      verified: 0,
      retainedOriginals: retainedIds.length,
      retainedIntact: retainedStates.filter((state) => state === 'intact').length,
      retainedMissing: retainedStates.filter((state) => state === 'missing').length,
      retainedChanged: retainedStates.filter((state) => state === 'changed').length,
      notLinked: 0,
      restored: 0,
      restorable: 0,
      removed: 0,
      hiddenCopies: items.length - shownItems.length,
      items: [] as PhysicalDeduplicationVerificationItem[],
    };

    for (const item of items) {
      const row = byId.get(item.assetId);
      const retainedFile = retainedFiles.get(item.retainedAssetId) ?? 'changed';
      const linked = isLinkedToRetained(row, byId.get(item.retainedAssetId));
      const restored = !!row && !row.deletedAt && !linked && row.originalPath === item.originalPath;
      const copyFile = await this.copyFileState(item);
      const restorable = linked && copyFile === 'present';

      report.verified += linked && retainedFile === 'intact' ? 1 : 0;
      report.notLinked += linked || restored ? 0 : 1;
      report.restored += restored ? 1 : 0;
      report.restorable += restorable ? 1 : 0;
      report.removed += copyFile === 'removed' ? 1 : 0;

      if (isShown(item)) {
        report.items.push({
          assetId: item.assetId,
          ownerName: users.find((user) => user.id === item.ownerId)?.name ?? '',
          originalFileName: row?.originalFileName ?? '',
          type: asAssetType(row?.type ?? AssetType.Other),
          canView: viewable.has(item.assetId),
          retainedFile,
          linked,
          copyFile,
          restored,
          restorable,
        });
      }
    }

    report.items.sort((a, b) => a.originalFileName.localeCompare(b.originalFileName));
    return report;
  }

  /**
   * Put one copy of an applied plan back on its own file (FL-73), where the source guarantees it:
   * the copy must still share the retained original, and its own former file must still be on disk
   * holding exactly the reviewed bytes. Only the asset's record changes; no file is written or
   * removed. Its generated files keep using the retained original's, which show the same bytes.
   */
  async restoreAppliedCopy(
    auth: AuthDto,
    snapshot: PhysicalDeduplicationApplySnapshot,
    appliedIds: readonly string[],
    assetId: string,
  ): Promise<void> {
    const item = appliedIds.includes(assetId) ? snapshot.items.find((entry) => entry.assetId === assetId) : undefined;
    // Not listed and not restorable are one answer, so the endpoint never tells which ids are Locked.
    const notRestorable = () => new BadRequestException('This copy is not one this plan changed.');
    if (!item) {
      throw notRestorable();
    }
    const isShown = await this.verificationVisibility(auth, snapshot, [item]);
    if (!isShown(item)) {
      throw notRestorable();
    }

    await this.databaseRepository.withLock(DatabaseLock.StorageTemplateMigration, async () => {
      const rows = await this.physicalFileRepository.getPlanEvidence([item.assetId, item.retainedAssetId]);
      const row = rows.find((entry) => entry.id === item.assetId);
      const retainedRow = rows.find((entry) => entry.id === item.retainedAssetId);
      if (!isLinkedToRetained(row, retainedRow)) {
        throw new ConflictException('This copy no longer uses the retained original. Verify the plan again.');
      }
      if ((await this.copyFileState(item)) !== 'present') {
        throw new ConflictException("This copy's own file is no longer on disk, so it can't go back to it.");
      }

      await this.physicalFileRepository.restoreOriginalPhysicalFile(item.assetId, {
        path: item.originalPath,
        checksum: Buffer.from(item.checksum, 'hex'),
        sizeInBytes: item.sizeInBytes,
      });
      this.logger.log(`Physical deduplication: copy ${item.assetId} is back on its own file`);
    });
  }

  /** What is at a copy's own former path now. A copy that never had its own path has nothing to restore. */
  private async copyFileState(
    item: PhysicalDeduplicationPlanItem,
  ): Promise<PhysicalDeduplicationVerificationItem['copyFile']> {
    if (item.originalPath === item.retainedPath) {
      return 'removed';
    }
    const disk = await this.checkOnDisk(item.originalPath, item.checksum, item.sizeInBytes);
    return disk === 'match' ? 'present' : disk === 'missing' ? 'removed' : 'changed';
  }

  /**
   * Which copies of an applied plan the requester may be shown, by the rule `visibleRows` uses for
   * a preview: a Locked copy of another account is hidden, and so is every copy of a Locked
   * retained original of another account.
   */
  private async verificationVisibility(
    auth: AuthDto,
    snapshot: PhysicalDeduplicationApplySnapshot,
    items: readonly PhysicalDeduplicationPlanItem[],
  ) {
    const lockedIds = await this.assetRepository.getLockedAssetIds([
      ...items.map((item) => item.assetId),
      ...items.map((item) => item.retainedAssetId),
    ]);
    const lockedOwnerId = getLockedOwnerId(auth);
    return (item: PhysicalDeduplicationPlanItem) =>
      (!lockedIds.has(item.assetId) || item.ownerId === lockedOwnerId) &&
      (!lockedIds.has(item.retainedAssetId) || snapshot.masterUserId === lockedOwnerId);
  }

  /** A file on disk against the checksum and size it was reviewed with. */
  private async checkOnDisk(path: string, checksum: string, sizeInBytes: number): Promise<DiskEvidence> {
    if (!(await this.storageRepository.checkFileExists(path))) {
      return 'missing';
    }

    if ((await this.getFileSize(path)) !== sizeInBytes) {
      return 'mismatch';
    }

    const reference = Buffer.from(checksum, 'hex');
    const digest = await this.cryptoRepository.hashFileMatching(path, reference);
    return digest.equals(reference) ? 'match' : 'mismatch';
  }

  /**
   * Remove the reviewed copy's old file: never the retained original's path, never a file that no
   * longer holds the reviewed bytes, and never while any asset or generated file still names it.
   * Returns the bytes actually removed.
   */
  private async removeReviewedCopy(
    item: PhysicalDeduplicationPlanItem,
    retainedPath: string,
    verified: boolean,
  ): Promise<number> {
    if (item.originalPath === retainedPath) {
      return 0;
    }

    if (!verified && (await this.checkOnDisk(item.originalPath, item.checksum, item.sizeInBytes)) !== 'match') {
      // Removed already by the earlier attempt, or something else now sits at the path: leave it.
      return 0;
    }

    const { deleted, references } = await this.physicalFileRepository.deleteUnreferencedPath(item.originalPath, () =>
      this.storageRepository.unlink(item.originalPath),
    );
    if (!deleted) {
      this.logger.log(`Physical deduplication: kept ${item.originalPath}; ${references} reference(s) still name it`);
      return 0;
    }

    return item.sizeInBytes;
  }

  /**
   * Point the copy's generated files (thumbnail, preview, full size, encoded video) at the retained
   * original's, then remove the copy's own while nothing references them. Generated files can be
   * made again, but a master that is not on disk is never relied on. Returns the bytes removed.
   */
  private async shareGeneratedFiles(duplicateAssetId: string, masterAssetId: string): Promise<number> {
    let reclaimed = 0;

    for (const duplicateFile of await this.physicalFileRepository.getGeneratedFiles(duplicateAssetId)) {
      if (!generatedFileTypes.has(duplicateFile.type)) {
        continue;
      }

      const masterFile = await this.physicalFileRepository.getGeneratedFile(masterAssetId, duplicateFile.type);
      if (!masterFile || masterFile.path === duplicateFile.path) {
        continue;
      }

      const masterPhysicalFile = await this.ensureGeneratedPhysicalFile(
        masterAssetId,
        masterFile.type,
        masterFile.path,
      );
      if (!masterPhysicalFile || !(await this.storageRepository.checkFileExists(masterPhysicalFile.path))) {
        continue;
      }

      const size = await this.getFileSize(duplicateFile.path);
      await this.physicalFileRepository.linkGeneratedFile(
        duplicateAssetId,
        duplicateFile.type,
        masterPhysicalFile.id,
        masterPhysicalFile.path,
      );
      const { deleted } = await this.physicalFileRepository.deleteUnreferencedPath(duplicateFile.path, () =>
        this.storageRepository.unlink(duplicateFile.path),
      );
      if (deleted) {
        reclaimed += size;
      }
    }

    return reclaimed;
  }

  private async isActiveUser(userId: string) {
    const user = await this.userRepository.get(userId, {});
    return !!user && !user.deletedAt;
  }

  /**
   * The preview (dry run). It reads and measures and never changes a file: applying is a reviewed
   * plan's durable job (FL-73), which works from what this records.
   */
  private async runMigration(masterUserId: string, scopeUserId: string | null): Promise<MigrationSummary> {
    const summary: MigrationSummary = {
      mode: 'dry-run',
      ranAt: new Date().toISOString(),
      masterUserId,
      scopeUserId,
      eligibleAssets: 0,
      linkedAssets: 0,
      skippedExternal: 0,
      skippedMissingMaster: 0,
      reclaimableBytes: 0,
      deletedBytes: 0,
      samples: [],
      retained: [],
      copies: [],
      copiesTruncated: false,
    };
    const retainedById = new Map<string, PhysicalDeduplicationRetainedState>();
    const sharesByRetained = new Map<string, number>();

    for await (const candidate of this.physicalFileRepository.getMigrationCandidates(masterUserId)) {
      if (scopeUserId && candidate.ownerId !== scopeUserId) {
        continue;
      }

      const copy: PhysicalDeduplicationCopyState = {
        assetId: candidate.id,
        ownerId: candidate.ownerId,
        originalFileName: candidate.originalFileName,
        originalPath: candidate.originalPath,
        type: asAssetType(candidate.type),
        sizeInBytes: Number(candidate.sizeInBytes ?? 0),
        checksum: candidate.checksum.toString('hex'),
        retainedAssetId: null,
        checksumMatch: false,
        decision: PhysicalDeduplicationDecision.Skip,
        reason: null,
        ...mediaDetailOf(candidate),
      };

      if (candidate.isExternal || candidate.libraryId || candidate.isOffline) {
        summary.skippedExternal++;
        this.addCopy(summary, { ...copy, reason: PhysicalDeduplicationSkipReason.ExternalLibrary });
        continue;
      }

      if (!candidate.sizeInBytes) {
        summary.skippedMissingMaster++;
        this.addCopy(summary, { ...copy, reason: PhysicalDeduplicationSkipReason.MissingSize });
        continue;
      }

      const master = await this.physicalFileRepository.getMasterOriginalCandidate(
        masterUserId,
        candidate.checksum,
        Number(candidate.sizeInBytes),
      );
      if (!master) {
        summary.skippedMissingMaster++;
        this.addCopy(summary, { ...copy, reason: PhysicalDeduplicationSkipReason.NoRetainedMatch });
        continue;
      }

      copy.retainedAssetId = master.id;
      copy.checksumMatch = true;

      let retained = retainedById.get(master.id);
      if (!retained) {
        const referencesBefore = master.physicalOriginalFileId
          ? await this.physicalFileRepository.countOriginalReferences(master.physicalOriginalFileId)
          : 1;
        retained = {
          assetId: master.id,
          ownerId: masterUserId,
          originalFileName: master.originalFileName,
          originalPath: master.originalPath,
          type: asAssetType(master.type),
          sizeInBytes: Number(master.sizeInBytes ?? 0),
          checksum: master.checksum.toString('hex'),
          referencesBefore: Math.max(referencesBefore, 1),
          referencesAfter: Math.max(referencesBefore, 1),
          // Checked once per retained original (FL-73): a copy is never shared onto a file that is
          // not there, and the page says which retained originals are unavailable.
          fileAvailable: await this.storageRepository.checkFileExists(master.originalPath),
          ...mediaDetailOf(master),
        };
        retainedById.set(master.id, retained);
      }

      // A copy that already points at the retained original has nothing left to reclaim.
      if (candidate.physicalOriginalFileId && candidate.physicalOriginalFileId === master.physicalOriginalFileId) {
        this.addCopy(summary, { ...copy, reason: PhysicalDeduplicationSkipReason.AlreadyShared });
        continue;
      }

      if (!retained.fileAvailable) {
        summary.skippedMissingMaster++;
        this.addCopy(summary, { ...copy, reason: PhysicalDeduplicationSkipReason.RetainedFileMissing });
        continue;
      }

      summary.eligibleAssets++;
      summary.reclaimableBytes += Number(candidate.sizeInBytes);
      this.addSample(summary, candidate.originalPath);
      sharesByRetained.set(master.id, (sharesByRetained.get(master.id) ?? 0) + 1);
      this.addCopy(summary, { ...copy, decision: PhysicalDeduplicationDecision.Share });

      summary.reclaimableBytes += await this.measureGeneratedFiles(candidate.id, master.id);
    }

    for (const retained of retainedById.values()) {
      retained.referencesAfter = retained.referencesBefore + (sharesByRetained.get(retained.assetId) ?? 0);
    }
    summary.retained = retainedById.values().toArray();

    this.logger.log(
      `Physical deduplication preview complete: ${summary.eligibleAssets} eligible, ${summary.reclaimableBytes} reclaimable bytes`,
    );
    return summary;
  }

  private addCopy(summary: MigrationSummary, copy: PhysicalDeduplicationCopyState) {
    if (summary.copies!.length < PHYSICAL_DEDUPLICATION_PREVIEW_LIMIT) {
      summary.copies!.push(copy);
    } else {
      summary.copiesTruncated = true;
    }
  }

  /** Bytes of a copy's generated files that sharing the retained original's would free. */
  private async measureGeneratedFiles(duplicateAssetId: string, masterAssetId: string): Promise<number> {
    let bytes = 0;
    for (const duplicateFile of await this.physicalFileRepository.getGeneratedFiles(duplicateAssetId)) {
      if (!generatedFileTypes.has(duplicateFile.type)) {
        continue;
      }

      const masterFile = await this.physicalFileRepository.getGeneratedFile(masterAssetId, duplicateFile.type);
      if (!masterFile || masterFile.path === duplicateFile.path) {
        continue;
      }

      bytes += await this.getFileSize(duplicateFile.path);
    }
    return bytes;
  }

  /**
   * Move a copy's sidecar out from beside the file it is about to stop using. The copy's own record
   * points at the new place before the old file is queued for removal, so the removal (which skips
   * anything still referenced) can actually happen.
   */
  private async migrateSidecarFile(assetId: string, ownerId: string, originalPath: string) {
    const sidecarPath = await this.findExistingSidecarPath(originalPath);
    if (!sidecarPath) {
      return;
    }

    const targetPath = StorageCore.getNestedPath(StorageFolder.Upload, ownerId, `${assetId}.xmp`);
    const copied = sidecarPath !== targetPath && !(await this.storageRepository.checkFileExists(targetPath));
    if (copied) {
      this.storageCore.ensureFolders(targetPath);
      await this.storageRepository.copyFile(sidecarPath, targetPath);
    }

    await this.assetRepository.upsertFile({ assetId, type: AssetFileType.Sidecar, path: targetPath });

    if (copied) {
      await this.queueDelete(sidecarPath);
    }
  }

  private async findExistingSidecarPath(originalPath: string) {
    for (const candidate of this.getSidecarCandidates(originalPath)) {
      if (await this.storageRepository.checkFileExists(candidate)) {
        return candidate;
      }
    }
  }

  private getSidecarCandidates(originalPath: string) {
    const assetPath = parse(originalPath);
    return [`${originalPath}.xmp`, `${join(assetPath.dir, assetPath.name)}.xmp`];
  }

  private async ensureGeneratedPhysicalFile(assetId: string, type: AssetFileType, path: string) {
    const existing = await this.physicalFileRepository.getCanonicalGeneratedFile(assetId, type);
    if (existing) {
      return existing;
    }

    const sizeInBytes = await this.getFileSize(path);
    if (sizeInBytes === 0) {
      return;
    }

    return this.physicalFileRepository.upsertPhysicalFile({
      canonicalAssetId: assetId,
      checksum: await this.cryptoRepository.hashFile(path),
      path,
      sizeInBytes,
      type: this.toPhysicalFileType(type),
    });
  }

  private async getFileSize(path: string) {
    try {
      const stats = await this.storageRepository.stat(path);
      return stats.size;
    } catch {
      return 0;
    }
  }

  private async queueDelete(path?: string) {
    if (path) {
      await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [path] } });
    }
  }

  private addSample(summary: MigrationSummary, path: string) {
    if (summary.samples.length < 10) {
      summary.samples.push(path);
    }
  }

  private toPhysicalFileType(type: AssetFileType) {
    switch (type) {
      case AssetFileType.Thumbnail: {
        return PhysicalFileType.Thumbnail;
      }
      case AssetFileType.Preview: {
        return PhysicalFileType.Preview;
      }
      case AssetFileType.FullSize: {
        return PhysicalFileType.FullSize;
      }
      case AssetFileType.EncodedVideo: {
        return PhysicalFileType.EncodedVideo;
      }
      default: {
        throw new Error(`Unsupported physical generated file type: ${type}`);
      }
    }
  }
}
