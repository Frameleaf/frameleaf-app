import { BadRequestException, Injectable } from '@nestjs/common';
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

type MigrationSummary = PhysicalDeduplicationMigrationState;

const generatedFileTypes = new Set([
  AssetFileType.Thumbnail,
  AssetFileType.Preview,
  AssetFileType.FullSize,
  AssetFileType.EncodedVideo,
]);

const asAssetType = (type: string): AssetType =>
  Object.values(AssetType).includes(type as AssetType) ? (type as AssetType) : AssetType.Other;

/**
 * Physical deduplication (FL-71).
 *
 * The dry run is a preview: it may retain originals in an account chosen on the page and may
 * review a single account's copies. It never changes files. Applying always uses the saved
 * `physicalDeduplication.masterUserId`, requires the feature to be enabled, and refuses when the
 * last preview was produced for a different retained account.
 */
@Injectable()
export class PhysicalDeduplicationService extends BaseService {
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
      const summary = await this.runMigration('dry-run', masterUserId, scopeUserId);
      await this.systemMetadataRepository.set(SystemMetadataKey.PhysicalDeduplicationMigration, summary);
    });

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.PhysicalDeduplicationMigrationApply, queue: QueueName.StorageTemplateMigration })
  async handleApply(_: JobOf<JobName.PhysicalDeduplicationMigrationApply>): Promise<JobStatus> {
    const state = await this.forkSchemaRepository.getState();
    if (state.phase === 'inactive' || state.phase === 'failed') {
      this.logger.warn(`Physical deduplication skipped in fork-schema ${state.phase} phase`);
      return JobStatus.Skipped;
    }
    const { physicalDeduplication } = await this.getConfig({ withCache: true });
    if (!physicalDeduplication.enabled || !physicalDeduplication.masterUserId) {
      this.logger.warn('Physical deduplication apply skipped: feature is disabled or no master user is configured');
      return JobStatus.Skipped;
    }

    const lastRun = await this.systemMetadataRepository.get(SystemMetadataKey.PhysicalDeduplicationMigration);
    if (lastRun?.mode !== 'dry-run' || lastRun.masterUserId !== physicalDeduplication.masterUserId) {
      this.logger.warn(
        'Physical deduplication apply refused: it requires a preview prepared for the saved retained account',
      );
      return JobStatus.Failed;
    }

    // The applied run covers exactly what the reviewed preview covered.
    const scopeUserId = lastRun.scopeUserId ?? null;

    await this.databaseRepository.withLock(DatabaseLock.StorageTemplateMigration, async () => {
      const summary = await this.runMigration('apply', physicalDeduplication.masterUserId!, scopeUserId);
      await this.systemMetadataRepository.set(SystemMetadataKey.PhysicalDeduplicationMigration, summary);
    });

    return JobStatus.Success;
  }

  /** Queue a preview. Validation happens here so the page gets an immediate answer; the job re-checks. */
  async requestPreview(dto: PhysicalDeduplicationPreviewRequestDto): Promise<void> {
    const { physicalDeduplication } = await this.getConfig({ withCache: false });
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

    const response: PhysicalDeduplicationPreviewResponseDto = {
      plan: null,
      savedMasterUserId: physicalDeduplication.masterUserId ?? null,
      enabled: physicalDeduplication.enabled,
      running,
    };

    if (!state) {
      return response;
    }

    const retained = state.retained ?? [];
    const copies = state.copies ?? [];
    const users = await this.userRepository.getList({ withDeleted: true });
    const nameOf = (userId: string) => users.find((user) => user.id === userId)?.name ?? userId;
    const viewable = await this.checkAccess({
      auth,
      permission: Permission.AssetRead,
      ids: [...retained.map((item) => item.assetId), ...copies.map((item) => item.assetId)],
    });

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
      retained: retained.map((item) => ({
        ...item,
        ownerName: nameOf(item.ownerId),
        canView: viewable.has(item.assetId),
      })),
      copies: copies.map((item) => ({
        ...item,
        ownerName: nameOf(item.ownerId),
        canView: viewable.has(item.assetId),
      })),
      copiesTruncated: state.copiesTruncated ?? false,
    };

    return { ...response, plan };
  }

  private async isActiveUser(userId: string) {
    const user = await this.userRepository.get(userId, {});
    return !!user && !user.deletedAt;
  }

  private async runMigration(
    mode: MigrationSummary['mode'],
    masterUserId: string,
    scopeUserId: string | null,
  ): Promise<MigrationSummary> {
    const summary: MigrationSummary = {
      mode,
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

      if (!retainedById.has(master.id)) {
        const referencesBefore = master.physicalOriginalFileId
          ? await this.physicalFileRepository.countOriginalReferences(master.physicalOriginalFileId)
          : 1;
        retainedById.set(master.id, {
          assetId: master.id,
          ownerId: masterUserId,
          originalFileName: master.originalFileName,
          originalPath: master.originalPath,
          type: asAssetType(master.type),
          sizeInBytes: Number(master.sizeInBytes ?? 0),
          checksum: master.checksum.toString('hex'),
          referencesBefore: Math.max(referencesBefore, 1),
          referencesAfter: Math.max(referencesBefore, 1),
        });
      }

      // A copy that already points at the retained original has nothing left to reclaim.
      if (candidate.physicalOriginalFileId && candidate.physicalOriginalFileId === master.physicalOriginalFileId) {
        this.addCopy(summary, { ...copy, reason: PhysicalDeduplicationSkipReason.AlreadyShared });
        continue;
      }

      summary.eligibleAssets++;
      summary.reclaimableBytes += Number(candidate.sizeInBytes);
      this.addSample(summary, candidate.originalPath);
      sharesByRetained.set(master.id, (sharesByRetained.get(master.id) ?? 0) + 1);
      this.addCopy(summary, { ...copy, decision: PhysicalDeduplicationDecision.Share });

      if (mode === 'apply') {
        const physicalFile = await this.physicalFileRepository.ensureOriginalPhysicalFile(master.id);
        if (!physicalFile) {
          summary.skippedMissingMaster++;
          this.markSkipped(summary, copy.assetId, PhysicalDeduplicationSkipReason.RetainedFileMissing);
          continue;
        }

        // Refuse to unlink the duplicate's only on-disk copy if the master file
        // is not actually present on disk. (checksum, fileSize) matched in the
        // DB does not guarantee the master file still exists — e.g. a prior
        // dedup run failed half-way, or the master was moved by an admin.
        if (!(await this.storageRepository.checkFileExists(physicalFile.path))) {
          this.logger.warn(
            `Physical deduplication: master file missing on disk for ${physicalFile.path}; refusing to delete duplicate ${candidate.originalPath}`,
          );
          summary.skippedMissingMaster++;
          this.markSkipped(summary, copy.assetId, PhysicalDeduplicationSkipReason.RetainedFileMissing);
          continue;
        }

        if (candidate.physicalOriginalFileId !== physicalFile.id) {
          const pathToDelete = candidate.originalPath === physicalFile.path ? undefined : candidate.originalPath;
          await this.migrateSidecarFile(candidate.id, candidate.ownerId, candidate.originalPath);
          await this.physicalFileRepository.linkAssetToOriginalPhysicalFile(candidate.id, physicalFile);
          summary.linkedAssets++;
          await this.queueDelete(pathToDelete);
          summary.deletedBytes += pathToDelete ? Number(candidate.sizeInBytes) : 0;
        }
      }

      await this.migrateGeneratedFiles({
        mode,
        duplicateAssetId: candidate.id,
        masterAssetId: master.id,
        summary,
      });
    }

    for (const retained of retainedById.values()) {
      retained.referencesAfter = retained.referencesBefore + (sharesByRetained.get(retained.assetId) ?? 0);
    }
    summary.retained = [...retainedById.values()];

    this.logger.log(
      `Physical deduplication ${mode} complete: ${summary.eligibleAssets} eligible, ${summary.linkedAssets} linked, ${summary.reclaimableBytes} reclaimable bytes`,
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

  private markSkipped(summary: MigrationSummary, assetId: string, reason: PhysicalDeduplicationSkipReason) {
    const copy = summary.copies!.find((item) => item.assetId === assetId);
    if (copy) {
      copy.decision = PhysicalDeduplicationDecision.Skip;
      copy.reason = reason;
    }
  }

  private async migrateGeneratedFiles({
    mode,
    duplicateAssetId,
    masterAssetId,
    summary,
  }: {
    mode: MigrationSummary['mode'];
    duplicateAssetId: string;
    masterAssetId: string;
    summary: MigrationSummary;
  }) {
    const duplicateFiles = await this.physicalFileRepository.getGeneratedFiles(duplicateAssetId);

    for (const duplicateFile of duplicateFiles) {
      if (!generatedFileTypes.has(duplicateFile.type)) {
        continue;
      }

      const masterFile = await this.physicalFileRepository.getGeneratedFile(masterAssetId, duplicateFile.type);
      if (!masterFile || masterFile.path === duplicateFile.path) {
        continue;
      }

      const duplicateSize = await this.getFileSize(duplicateFile.path);
      summary.reclaimableBytes += duplicateSize;

      if (mode === 'dry-run') {
        continue;
      }

      const masterPhysicalFile = await this.ensureGeneratedPhysicalFile(
        masterAssetId,
        masterFile.type,
        masterFile.path,
      );
      if (!masterPhysicalFile) {
        continue;
      }

      // Same on-disk verification as for originals — refuse to unlink the
      // duplicate's generated file if the master generated file isn't actually
      // present. Generated files are regeneratable, but deleting both copies
      // and forcing a regeneration race is still worse than skipping.
      if (!(await this.storageRepository.checkFileExists(masterPhysicalFile.path))) {
        this.logger.warn(
          `Physical deduplication: master generated file missing on disk at ${masterPhysicalFile.path}; refusing to delete duplicate ${duplicateFile.path}`,
        );
        continue;
      }

      await this.physicalFileRepository.linkGeneratedFile(
        duplicateAssetId,
        duplicateFile.type,
        masterPhysicalFile.id,
        masterPhysicalFile.path,
      );
      await this.queueDelete(duplicateFile.path);
      summary.deletedBytes += duplicateSize;
    }
  }

  private async migrateSidecarFile(assetId: string, ownerId: string, originalPath: string) {
    const sidecarPath = await this.findExistingSidecarPath(originalPath);
    if (!sidecarPath) {
      return;
    }

    const targetPath = StorageCore.getNestedPath(StorageFolder.Upload, ownerId, `${assetId}.xmp`);
    if (sidecarPath !== targetPath && !(await this.storageRepository.checkFileExists(targetPath))) {
      this.storageCore.ensureFolders(targetPath);
      await this.storageRepository.copyFile(sidecarPath, targetPath);
      await this.queueDelete(sidecarPath);
    }

    await this.assetRepository.upsertFile({ assetId, type: AssetFileType.Sidecar, path: targetPath });
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
