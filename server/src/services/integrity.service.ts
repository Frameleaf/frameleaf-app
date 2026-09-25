import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type {
  IIntegrityDeleteReportTypeJob,
  IIntegrityDeleteReportsJob,
  IIntegrityJob,
  IIntegrityMissingFilesJob,
  IIntegrityPathWithChecksumJob,
  IIntegrityPathWithReportJob,
  IIntegrityUntrackedFilesJob,
} from 'src/types.js';
import { JOBS_LIBRARY_PAGINATION_SIZE } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  IntegrityCheckRunsResponseDto,
  IntegrityGetReportDto,
  IntegrityReportResponseDto,
  IntegrityReportSummaryResponseDto,
} from 'src/dtos/integrity.dto.js';
import {
  AssetStatus,
  CacheControl,
  ChecksumAlgorithm,
  DatabaseLock,
  ImmichWorker,
  IntegrityReport,
  JobName,
  JobStatus,
  QueueName,
  StorageFolder,
  SystemMetadataKey,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { batched, handlePromiseError } from 'src/utils/misc.js';

/**
 * Untracked Files:
 *   Files are detected in /data/encoded-video, /data/library, /data/upload
 *     Checked against the asset table
 *   Files are detected in /data/thumbs
 *     Checked against the asset_file table
 *
 *   * Can perform download or delete of files
 *
 * Missing Files:
 *   Paths are queried from asset(originalPath, encodedVideoPath), asset_file(path)
 *     Check whether files exist on disk
 *
 *   * Reports must include origin (asset or asset_file) & ID for further action
 *   * Can perform trash (asset) or delete (asset_file)
 *
 * Checksum Mismatch:
 *   Paths & checksums are queried from asset(originalPath, checksum)
 *     Check whether files match checksum, missing files ignored
 *
 *   * Reports must include origin (as above) for further action
 *   * Can perform download or trash (asset)
 */

@Injectable()
export class IntegrityService extends BaseService {
  private integrityLock = false;

  /**
   * Library care → "Audit database and file references" (FL-69, settings-catalog.mjs:926-931): the
   * scheduled missing-file and untracked-file checks are that audit. Each keeps its own switch and
   * schedule; turning the audit off stops both schedules without losing them. Asking for a check
   * from the job manager still runs it.
   */
  private static referenceAudit(enabled: boolean, config: ArgOf<'ConfigInit'>['newConfig']) {
    return enabled && config.libraryCare.integrityAudit;
  }

  @OnEvent({ name: 'ConfigInit', workers: [ImmichWorker.Microservices] })
  async onConfigInit({ newConfig }: ArgOf<'ConfigInit'>) {
    const {
      integrityChecks: { untrackedFiles, missingFiles, checksumFiles },
    } = newConfig;
    this.integrityLock = await this.databaseRepository.tryLock(DatabaseLock.IntegrityCheck);
    if (!this.integrityLock) {
      return;
    }

    this.cronRepository.create({
      name: 'integrityUntrackedFiles',
      expression: untrackedFiles.cronExpression,
      onTick: () =>
        handlePromiseError(
          this.jobRepository.queue({ name: JobName.IntegrityUntrackedFilesQueueAll, data: {} }),
          this.logger,
        ),
      start: IntegrityService.referenceAudit(untrackedFiles.enabled, newConfig),
    });

    this.cronRepository.create({
      name: 'integrityMissingFiles',
      expression: missingFiles.cronExpression,
      onTick: () =>
        handlePromiseError(
          this.jobRepository.queue({ name: JobName.IntegrityMissingFilesQueueAll, data: {} }),
          this.logger,
        ),
      start: IntegrityService.referenceAudit(missingFiles.enabled, newConfig),
    });

    this.cronRepository.create({
      name: 'integrityChecksumFiles',
      expression: checksumFiles.cronExpression,
      onTick: () =>
        handlePromiseError(this.jobRepository.queue({ name: JobName.IntegrityChecksumFiles, data: {} }), this.logger),
      start: checksumFiles.enabled,
    });
  }

  @OnEvent({ name: 'ConfigUpdate', server: true })
  onConfigUpdate({ newConfig }: ArgOf<'ConfigUpdate'>) {
    if (!this.integrityLock) {
      return;
    }
    const {
      integrityChecks: { untrackedFiles, missingFiles, checksumFiles },
    } = newConfig;

    this.cronRepository.update({
      name: 'integrityUntrackedFiles',
      expression: untrackedFiles.cronExpression,
      start: IntegrityService.referenceAudit(untrackedFiles.enabled, newConfig),
    });

    this.cronRepository.update({
      name: 'integrityMissingFiles',
      expression: missingFiles.cronExpression,
      start: IntegrityService.referenceAudit(missingFiles.enabled, newConfig),
    });

    this.cronRepository.update({
      name: 'integrityChecksumFiles',
      expression: checksumFiles.cronExpression,
      start: checksumFiles.enabled,
    });
  }

  getIntegrityReportSummary(): Promise<IntegrityReportSummaryResponseDto> {
    return this.integrityRepository.getIntegrityReportSummary();
  }

  /**
   * FL-81 (CC-21): when each check last completed a full run, for "Last run …" in Maintenance. The
   * untracked and missing checks complete when the last of their batches finishes; the checksum
   * check when a pass has covered every asset (a pass stopped by its time or percentage limit
   * continues from its checkpoint and is not a completed run yet).
   */
  async getIntegrityCheckRuns(): Promise<IntegrityCheckRunsResponseDto> {
    const runs = (await this.systemMetadataRepository.get(SystemMetadataKey.IntegrityCheckRuns)) ?? {};
    return {
      [IntegrityReport.ChecksumFail]: runs[IntegrityReport.ChecksumFail]?.lastRunAt ?? null,
      [IntegrityReport.MissingFile]: runs[IntegrityReport.MissingFile]?.lastRunAt ?? null,
      [IntegrityReport.UntrackedFile]: runs[IntegrityReport.UntrackedFile]?.lastRunAt ?? null,
    };
  }

  /** A full (not refresh-only) run of `type` begins; its batches carry the returned id. */
  private async startCheckRun(type: IntegrityReport): Promise<string> {
    const runId = this.cryptoRepository.randomUUID();
    await this.systemMetadataRepository.startIntegrityRun(type, {
      runId,
      startedAt: new Date().toISOString(),
      batches: null,
      done: 0,
    });
    return runId;
  }

  /**
   * Progress of a run: every batch queued (`batches`) or one batch finished. Whichever update sees
   * all batches finished completes the run, however the batches and the queueing interleave.
   */
  private async progressCheckRun(
    type: IntegrityReport,
    runId: string | undefined,
    progress: { batches?: number; finished?: number },
  ) {
    if (!runId) {
      return;
    }
    const run = await this.systemMetadataRepository.updateIntegrityRun(type, runId, progress);
    if (run && run.batches !== null && run.done >= run.batches) {
      await this.systemMetadataRepository.completeIntegrityRun(type, runId, new Date());
    }
  }

  getIntegrityReport(dto: IntegrityGetReportDto): Promise<IntegrityReportResponseDto> {
    return this.integrityRepository.getIntegrityReport({ cursor: dto.cursor, limit: dto.limit ?? 100 }, dto.type);
  }

  getIntegrityReportCsv(type: IntegrityReport): Readable {
    const items = this.integrityRepository.streamIntegrityReports(type);

    // very rudimentary csv serialiser
    async function* generator() {
      yield 'id,type,assetId,fileAssetId,path\n';

      for await (const item of items) {
        // no expectation of particularly bad filenames
        // but they could potentially have a newline or quote character
        yield `${item.id},${item.type},${item.assetId},${item.fileAssetId},"${item.path.replaceAll('"', '""')}"\n`;
      }
    }

    return Readable.from(generator());
  }

  async getIntegrityReportFile(id: string): Promise<ImmichFileResponse> {
    const { path } = await this.integrityRepository.getById(id);

    return new ImmichFileResponse({
      path,
      fileName: basename(path),
      contentType: 'application/octet-stream',
      cacheControl: CacheControl.PrivateWithoutCache,
    });
  }

  async deleteIntegrityReport(userId: string, id: string): Promise<void> {
    const { path, assetId, fileAssetId } = await this.integrityRepository.getById(id);

    if (assetId) {
      await this.assetRepository.updateAll([assetId], {
        deletedAt: new Date(),
        status: AssetStatus.Trashed,
      });

      await this.eventRepository.emit('AssetTrashAll', {
        assetIds: [assetId],
        userId,
      });

      await this.integrityRepository.deleteById(id);
    } else if (fileAssetId) {
      await this.assetRepository.deleteFiles([{ id: fileAssetId }]);
    } else {
      const trackedPaths = await this.integrityRepository.getTrackedPaths([path]);
      if (trackedPaths.length === 0) {
        await this.storageRepository.unlink(path);
      }
      await this.integrityRepository.deleteById(id);
    }
  }

  private async queueRefreshAllUntrackedFiles() {
    this.logger.log(`Checking for out of date untracked file reports...`);

    const reports = this.integrityRepository.streamIntegrityReportsWithAssetChecksum(IntegrityReport.UntrackedFile);

    let total = 0;
    for await (const batchReports of batched(reports, JOBS_LIBRARY_PAGINATION_SIZE)) {
      await this.jobRepository.queue({
        name: JobName.IntegrityUntrackedFilesRefresh,
        data: {
          items: batchReports,
        },
      });

      total += batchReports.length;
      this.logger.log(`Queued report check of ${batchReports.length} report(s) (${total} so far)`);
    }
  }

  @OnJob({ name: JobName.IntegrityUntrackedFilesQueueAll, queue: QueueName.IntegrityCheck })
  async handleUntrackedFilesQueueAll({ refreshOnly }: IIntegrityJob = {}): Promise<JobStatus> {
    await this.queueRefreshAllUntrackedFiles();

    if (refreshOnly) {
      this.logger.log('Refresh complete.');
      return JobStatus.Success;
    }

    this.logger.log(`Scanning for untracked files...`);
    const runId = await this.startCheckRun(IntegrityReport.UntrackedFile);

    const assetPaths = this.storageRepository.walk({
      pathsToCrawl: [StorageFolder.EncodedVideo, StorageFolder.Library, StorageFolder.Upload].map((folder) =>
        StorageCore.getBaseFolder(folder),
      ),
      includeHidden: false,
      take: JOBS_LIBRARY_PAGINATION_SIZE,
    });

    const assetFilePaths = this.storageRepository.walk({
      pathsToCrawl: [StorageCore.getBaseFolder(StorageFolder.Thumbnails)],
      includeHidden: false,
      take: JOBS_LIBRARY_PAGINATION_SIZE,
    });

    async function* paths() {
      for await (const batch of assetPaths) {
        yield ['asset', batch] as const;
      }

      for await (const batch of assetFilePaths) {
        yield ['asset_file', batch] as const;
      }
    }

    let total = 0;
    let batches = 0;
    for await (const [batchType, batchPaths] of paths()) {
      await this.jobRepository.queue({
        name: JobName.IntegrityUntrackedFiles,
        data: {
          type: batchType,
          paths: batchPaths,
          runId,
        },
      });

      const count = batchPaths.length;
      total += count;

      this.logger.log(`Queued untracked check of ${count} file(s) (${total} so far)`);
      batches++;
    }

    await this.progressCheckRun(IntegrityReport.UntrackedFile, runId, { batches });
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.IntegrityUntrackedFiles, queue: QueueName.IntegrityCheck })
  async handleUntrackedFiles({ runId, ...job }: IIntegrityUntrackedFilesJob): Promise<JobStatus> {
    const status = await this.checkUntrackedFiles(job);
    await this.progressCheckRun(IntegrityReport.UntrackedFile, runId, { finished: 1 });
    return status;
  }

  private async checkUntrackedFiles({ type, paths }: Omit<IIntegrityUntrackedFilesJob, 'runId'>): Promise<JobStatus> {
    this.logger.log(`Processing batch of ${paths.length} files to check if they are untracked.`);

    const untrackedFiles = new Set<string>(paths);
    if (type === 'asset') {
      const assets = await this.integrityRepository.getAssetPathsByPaths(paths);
      for (const { originalPath, encodedVideoPath } of assets) {
        untrackedFiles.delete(originalPath);

        if (encodedVideoPath) {
          untrackedFiles.delete(encodedVideoPath);
        }
      }
    }

    // Sidecar asset_file rows point into the upload folder (both uploaded
    // sidecars and the ones physical deduplication migrates), so the
    // asset-folder walk must be checked against asset_file too — not just
    // asset.originalPath — or every sidecar is reported as untracked.
    const assetFiles = await this.integrityRepository.getAssetFilePathsByPaths(paths);
    for (const { path } of assetFiles) {
      untrackedFiles.delete(path);
    }

    const personThumbnailPaths = await this.integrityRepository.getPersonThumbnailPathsByPaths(paths);
    for (const { thumbnailPath } of personThumbnailPaths) {
      untrackedFiles.delete(thumbnailPath);
    }

    // The enhanced video duplicate check stores sampled frames in the
    // thumbnails folder, tracked in asset_video_duplicate_frame rather than
    // asset_file, so the walk must exempt them explicitly.
    const framePaths = await this.integrityRepository.getVideoDuplicateFramePathsByPaths(paths);
    for (const { path } of framePaths) {
      untrackedFiles.delete(path);
    }

    // Develop versions (edited masters, previews, developed files brought back) are tracked by
    // their version row; they are a person's work, never an orphan to clean up (FL-64).
    const developPaths = await this.integrityRepository.getDevelopRevisionPathsByPaths(paths);
    for (const { path } of developPaths) {
      untrackedFiles.delete(path);
    }

    if (untrackedFiles.size > 0) {
      await this.integrityRepository.create(
        [...untrackedFiles].map((path) => ({
          type: IntegrityReport.UntrackedFile,
          path,
        })),
      );
    }

    this.logger.log(`Processed ${paths.length} and found ${untrackedFiles.size} untracked file(s).`);
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.IntegrityUntrackedFilesRefresh, queue: QueueName.IntegrityCheck })
  async handleUntrackedRefresh({ items }: IIntegrityPathWithReportJob): Promise<JobStatus> {
    this.logger.log(`Processing batch of ${items.length} reports to check if they are out of date.`);

    const tracked =
      items.length > 0 ? await this.integrityRepository.getTrackedPaths(items.map(({ path }) => path)) : [];
    const trackedPaths = new Set(tracked.map(({ path }) => path));

    const results = await Promise.all(
      items.map(async ({ reportId, path }) => {
        // The path was untracked when the report was written; an asset may reference it now.
        if (trackedPaths.has(path)) {
          return reportId;
        }

        try {
          await this.storageRepository.stat(path);
          return;
        } catch {
          return reportId;
        }
      }),
    );

    const reportIds = results.filter(Boolean) as string[];

    if (reportIds.length > 0) {
      await this.integrityRepository.deleteByIds(reportIds);
    }

    this.logger.log(`Processed ${items.length} paths and found ${reportIds.length} report(s) out of date.`);
    return JobStatus.Success;
  }

  private async queueRefreshAllMissingFiles() {
    this.logger.log(`Checking for out of date missing file reports...`);

    const reports = this.integrityRepository.streamIntegrityReportsWithAssetChecksum(IntegrityReport.MissingFile);

    let total = 0;
    for await (const batchReports of batched(reports, JOBS_LIBRARY_PAGINATION_SIZE)) {
      await this.jobRepository.queue({
        name: JobName.IntegrityMissingFilesRefresh,
        data: {
          items: batchReports,
        },
      });

      total += batchReports.length;
      this.logger.log(`Queued report check of ${batchReports.length} report(s) (${total} so far)`);
    }

    this.logger.log('Refresh complete.');
  }

  @OnJob({ name: JobName.IntegrityMissingFilesQueueAll, queue: QueueName.IntegrityCheck })
  async handleMissingFilesQueueAll({ refreshOnly }: IIntegrityJob = {}): Promise<JobStatus> {
    if (refreshOnly) {
      await this.queueRefreshAllMissingFiles();
      return JobStatus.Success;
    }

    this.logger.log(`Scanning for missing files...`);
    const runId = await this.startCheckRun(IntegrityReport.MissingFile);

    const assetPaths = this.integrityRepository.streamAssetPathsForMissingFiles();

    let total = 0;
    let batches = 0;
    for await (const batchPaths of batched(assetPaths, JOBS_LIBRARY_PAGINATION_SIZE)) {
      await this.jobRepository.queue({
        name: JobName.IntegrityMissingFiles,
        data: {
          items: batchPaths,
          runId,
        },
      });
      batches++;

      total += batchPaths.length;
      this.logger.log(`Queued missing check of ${batchPaths.length} file(s) (${total} so far)`);
    }

    await this.progressCheckRun(IntegrityReport.MissingFile, runId, { batches });
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.IntegrityMissingFiles, queue: QueueName.IntegrityCheck })
  async handleMissingFiles({ runId, ...job }: IIntegrityMissingFilesJob): Promise<JobStatus> {
    const status = await this.checkMissingFiles(job);
    await this.progressCheckRun(IntegrityReport.MissingFile, runId, { finished: 1 });
    return status;
  }

  private async checkMissingFiles({ items }: Omit<IIntegrityMissingFilesJob, 'runId'>): Promise<JobStatus> {
    this.logger.log(`Processing batch of ${items.length} files to check if they are missing.`);

    const results = await Promise.all(
      items.map(async (item) => {
        try {
          await this.storageRepository.stat(item.path);
          return { ...item, exists: true };
        } catch {
          return { ...item, exists: false };
        }
      }),
    );

    const outdatedReports = results
      .filter(({ exists, reportId }) => exists && reportId)
      .map(({ reportId }) => reportId!);

    if (outdatedReports.length > 0) {
      await this.integrityRepository.deleteByIds(outdatedReports);
    }

    const missingFiles = results.filter(({ exists }) => !exists);
    if (missingFiles.length > 0) {
      await this.integrityRepository.create(
        missingFiles.map(({ path, assetId, fileAssetId }) => ({
          type: IntegrityReport.MissingFile,
          path,
          assetId,
          fileAssetId,
        })),
      );
    }

    this.logger.log(`Processed ${items.length} and found ${missingFiles.length} missing file(s).`);
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.IntegrityMissingFilesRefresh, queue: QueueName.IntegrityCheck })
  async handleMissingRefresh({ items: paths }: IIntegrityPathWithReportJob): Promise<JobStatus> {
    this.logger.log(`Processing batch of ${paths.length} reports to check if they are out of date.`);

    const results = await Promise.all(
      paths.map(async ({ reportId, path }) => {
        try {
          await this.storageRepository.stat(path);
          return reportId;
        } catch {
          return;
        }
      }),
    );

    const reportIds = results.filter(Boolean) as string[];

    if (reportIds.length > 0) {
      await this.integrityRepository.deleteByIds(reportIds);
    }

    this.logger.log(`Processed ${paths.length} paths and found ${reportIds.length} report(s) out of date.`);
    return JobStatus.Success;
  }

  private async queueRefreshAllChecksumFiles() {
    this.logger.log(`Checking for out of date checksum file reports...`);

    const reports = this.integrityRepository.streamIntegrityReportsWithAssetChecksum(IntegrityReport.ChecksumFail);

    let total = 0;
    for await (const batchReports of batched(reports, JOBS_LIBRARY_PAGINATION_SIZE)) {
      await this.jobRepository.queue({
        name: JobName.IntegrityChecksumFilesRefresh,
        data: {
          items: batchReports.map(({ path, reportId, checksum, checksumAlgorithm }) => ({
            path,
            reportId,
            checksum: checksum?.toString('hex'),
            checksumAlgorithm,
          })),
        },
      });

      total += batchReports.length;
      this.logger.log(`Queued report check of ${batchReports.length} report(s) (${total} so far)`);
    }

    this.logger.log('Refresh complete.');
  }

  /**
   * The fork writes sha256 checksums for new server uploads and keeps sha1 for
   * legacy rows (see ChecksumAlgorithm), so integrity verification must hash
   * with the algorithm the row was written under. `sha1Path` checksums cover a
   * path string rather than file contents and cannot be verified from disk.
   */
  private hashForAlgorithm(checksumAlgorithm?: string | null) {
    switch (checksumAlgorithm) {
      case ChecksumAlgorithm.sha256File: {
        return createHash('sha256');
      }
      case ChecksumAlgorithm.sha1Path: {
        return null;
      }
      default: {
        return createHash('sha1');
      }
    }
  }

  private async checkAssetChecksum(
    originalPath: string,
    checksum: Buffer<ArrayBufferLike>,
    checksumAlgorithm: string | null,
    assetId: string,
    reportId: string | null,
  ) {
    if (!this.hashForAlgorithm(checksumAlgorithm)) {
      return;
    }

    const sha1Hash = createHash('sha1');
    const sha256Hash = createHash('sha256');
    let sizeInBytes = 0;

    try {
      await pipeline([
        this.storageRepository.createPlainReadStream(originalPath),
        new Writable({
          write(chunk, _encoding, callback) {
            sha1Hash.update(chunk);
            sha256Hash.update(chunk);
            sizeInBytes += chunk.length;
            callback();
          },
        }),
      ]);

      const sha1 = sha1Hash.digest();
      const sha256 = sha256Hash.digest();
      if (checksum.equals(sha1) || checksum.equals(sha256)) {
        await this.forkSchemaRepository.recordAssetChecksums({
          assetId,
          sha1,
          sha256,
          sizeInBytes,
          path: originalPath,
          source: 'integrity',
        });

        if (reportId) {
          await this.integrityRepository.deleteById(reportId);
        }
      } else {
        throw new Error('File failed checksum');
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        if (reportId) {
          await this.integrityRepository.deleteById(reportId);
        }

        // missing file; handled by the missing files job
        return;
      }

      this.logger.warn('Failed to process a file: ' + error);
      await this.integrityRepository.create({
        path: originalPath,
        type: IntegrityReport.ChecksumFail,
        assetId,
      });
    }
  }

  @OnJob({ name: JobName.IntegrityChecksumFiles, queue: QueueName.IntegrityCheck })
  async handleChecksumFiles({ refreshOnly }: IIntegrityJob = {}): Promise<JobStatus> {
    if (refreshOnly) {
      await this.queueRefreshAllChecksumFiles();
      return JobStatus.Success;
    }

    const {
      integrityChecks: {
        checksumFiles: { timeLimit, percentageLimit },
      },
    } = await this.getConfig({
      withCache: true,
    });

    this.logger.log(
      `Checking file checksums... (will run for up to ${(timeLimit / (60 * 60 * 1000)).toFixed(2)} hours or until ${(percentageLimit * 100).toFixed(2)}% of assets are processed)`,
    );

    let processed = 0;
    const startedAt = Date.now();
    const { count } = await this.integrityRepository.getAssetCount();
    const checkpoint = await this.systemMetadataRepository.get(SystemMetadataKey.IntegrityChecksumCheckpoint);

    const startMarker = checkpoint?.date ? new Date(checkpoint.date) : undefined;

    const printStats = () => {
      const averageTime = ((Date.now() - startedAt) / processed).toFixed(2);
      const completionProgress = ((processed / count) * 100).toFixed(2);

      this.logger.log(
        `Processed ${processed} files so far... (avg. ${averageTime} ms/asset, ${completionProgress}% of all assets)`,
      );
    };

    let lastCreatedAt: Date | undefined;

    this.logger.log(`Processing assets from ${startMarker?.toISOString() ?? 'beginning'}`);

    const assets = this.integrityRepository.streamAssetChecksums(startMarker);

    for await (const { originalPath, checksum, checksumAlgorithm, createdAt, assetId, reportId } of assets) {
      await this.checkAssetChecksum(originalPath, checksum, checksumAlgorithm, assetId, reportId);

      processed++;

      if (processed % 100 === 0) {
        printStats();
      }

      if (Date.now() > startedAt + timeLimit || processed > count * percentageLimit) {
        this.logger.log('Reached stop criteria.');
        lastCreatedAt = createdAt;
        break;
      }
    }

    await this.systemMetadataRepository.set(SystemMetadataKey.IntegrityChecksumCheckpoint, {
      date: lastCreatedAt?.toISOString(),
    });

    printStats();

    if (lastCreatedAt) {
      this.logger.log(`Finished checksum job, will continue from ${lastCreatedAt.toISOString()}.`);
    } else {
      this.logger.log(`Finished checksum job, covered all assets.`);
      // A pass that reached the last asset is a completed run (FL-81); one stopped by its limits
      // continues from the checkpoint next time and completes then.
      const runId = await this.startCheckRun(IntegrityReport.ChecksumFail);
      await this.systemMetadataRepository.completeIntegrityRun(IntegrityReport.ChecksumFail, runId, new Date());
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.IntegrityChecksumFilesRefresh, queue: QueueName.IntegrityCheck })
  async handleChecksumRefresh({ items: paths }: IIntegrityPathWithChecksumJob): Promise<JobStatus> {
    this.logger.log(`Processing batch of ${paths.length} reports to check if they are out of date.`);

    const results = await Promise.all(
      paths.map(async ({ reportId, path, checksum, checksumAlgorithm }) => {
        if (!checksum) {
          return reportId;
        }

        const hash = this.hashForAlgorithm(checksumAlgorithm);
        if (!hash) {
          return reportId;
        }

        try {
          await pipeline([
            this.storageRepository.createPlainReadStream(path),
            new Writable({
              write(chunk, _encoding, callback) {
                hash.update(chunk);
                callback();
              },
            }),
          ]);
        } catch (error) {
          if ((error as { code?: string }).code === 'ENOENT') {
            return reportId;
          }
        }

        if (Buffer.from(checksum, 'hex').equals(hash.digest())) {
          return reportId;
        }
      }),
    );

    const reportIds = results.filter(Boolean) as string[];

    if (reportIds.length > 0) {
      await this.integrityRepository.deleteByIds(reportIds);
    }

    this.logger.log(`Processed ${paths.length} paths and found ${reportIds.length} report(s) out of date.`);
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.IntegrityDeleteReportType, queue: QueueName.IntegrityCheck })
  async handleDeleteAllIntegrityReports({ type }: IIntegrityDeleteReportTypeJob): Promise<JobStatus> {
    this.logger.log(`Deleting all entries for ${type ?? 'all types of'} integrity report`);

    let properties;
    switch (type) {
      case IntegrityReport.ChecksumFail: {
        properties = ['assetId'] as const;
        break;
      }
      case IntegrityReport.MissingFile: {
        properties = ['assetId', 'fileAssetId'] as const;
        break;
      }
      case IntegrityReport.UntrackedFile: {
        properties = [void 0] as const;
        break;
      }
      default: {
        properties = [void 0, 'assetId', 'fileAssetId'] as const;
        break;
      }
    }

    for (const property of properties) {
      const reports = this.integrityRepository.streamIntegrityReportsByProperty(property, type);
      for await (const batch of batched(reports, JOBS_LIBRARY_PAGINATION_SIZE)) {
        await this.jobRepository.queue({
          name: JobName.IntegrityDeleteReports,
          data: {
            reports: batch,
          },
        });

        this.logger.log(`Queued ${batch.length} reports to delete.`);
      }
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.IntegrityDeleteReports, queue: QueueName.IntegrityCheck })
  async handleDeleteIntegrityReports({ reports }: IIntegrityDeleteReportsJob): Promise<JobStatus> {
    const byAsset = reports.filter((report) => report.assetId);
    const byFileAsset = reports.filter((report) => report.fileAssetId);
    const byPath = reports.filter((report) => !report.assetId && !report.fileAssetId);

    if (byAsset.length > 0) {
      const ids = byAsset.map(({ assetId }) => assetId!);
      await this.assetRepository.updateAll(ids, {
        deletedAt: new Date(),
        status: AssetStatus.Trashed,
      });

      await this.eventRepository.emit('AssetTrashAll', {
        assetIds: ids,
        userId: '', // we don't notify any users currently
      });

      await this.integrityRepository.deleteByIds(byAsset.map(({ id }) => id));
    }

    if (byFileAsset.length > 0) {
      await this.assetRepository.deleteFiles(byFileAsset.map(({ fileAssetId }) => ({ id: fileAssetId! })));
    }

    if (byPath.length > 0) {
      const tracked = await this.integrityRepository.getTrackedPaths(byPath.map(({ path }) => path));
      const trackedPaths = new Set(tracked.map(({ path }) => path));
      await Promise.all(
        byPath
          .filter(({ path }) => !trackedPaths.has(path))
          .map(({ path }) => this.storageRepository.unlink(path).catch(() => void 0)),
      );
      await this.integrityRepository.deleteByIds(byPath.map(({ id }) => id));
    }

    this.logger.log(`Deleted ${reports.length} reports.`);
    return JobStatus.Success;
  }
}
