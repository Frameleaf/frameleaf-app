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
  IntegrityCheckHistoryEntry,
} from 'src/types.js';
import { JOBS_LIBRARY_PAGINATION_SIZE } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  IntegrityCheckRunsResponseDto,
  IntegrityFindingAssetsDto,
  IntegrityFindingAssetsResponseDto,
  IntegrityGetReportDto,
  IntegrityOverviewResponseDto,
  IntegrityReportClearResponseDto,
  IntegrityReportResponseDto,
  IntegrityReportSummaryResponseDto,
  IntegrityUnreachableFolder,
} from 'src/dtos/integrity.dto.js';
import {
  AssetStatus,
  CacheControl,
  ChecksumAlgorithm,
  DatabaseLock,
  FrameleafWorker,
  IntegrityReport,
  JobName,
  JobStatus,
  QueueName,
  StorageFolder,
  SystemMetadataKey,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { moveFileWithin } from 'src/utils/file-trash.js';
import { FileDownloadResponse } from 'src/utils/file.js';
import { isLockedPath } from 'src/utils/locked-read.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { batched, handlePromiseError } from 'src/utils/misc.js';

/** FL-520: how many past checks "Recent checks" keeps. */
export const INTEGRITY_HISTORY_KEPT = 30;
/** FL-520: the most photos "Restore from a backup" takes at once (the restore request's own limit). */
const FINDING_ASSETS_LIMIT = 10_000;
/** FL-520: how often (in files) the damage check saves its progress and looks for a Stop. */
const CHECKSUM_PROGRESS_EVERY = 100;

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
   * FL-363: the three checks no longer start on timers of their own. The overnight schedule's
   * "Check files" step (`OvernightService`) queues each one that is switched on; the missing-file and
   * untracked-file checks also need Library care → "Audit database and file references" (FL-69).
   * The timers are kept, stopped, so an expression set before still reads back. Asking for a check
   * from the job manager still runs it.
   */
  @OnEvent({ name: 'ConfigInit', workers: [FrameleafWorker.Microservices] })
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
      // FL-363: the overnight schedule runs the file checks
      start: false,
    });

    this.cronRepository.create({
      name: 'integrityMissingFiles',
      expression: missingFiles.cronExpression,
      onTick: () =>
        handlePromiseError(
          this.jobRepository.queue({ name: JobName.IntegrityMissingFilesQueueAll, data: {} }),
          this.logger,
        ),
      start: false,
    });

    this.cronRepository.create({
      name: 'integrityChecksumFiles',
      expression: checksumFiles.cronExpression,
      onTick: () =>
        handlePromiseError(this.jobRepository.queue({ name: JobName.IntegrityChecksumFiles, data: {} }), this.logger),
      start: false,
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
      // FL-363: the overnight schedule runs the file checks
      start: false,
    });

    this.cronRepository.update({
      name: 'integrityMissingFiles',
      expression: missingFiles.cronExpression,
      start: false,
    });

    this.cronRepository.update({
      name: 'integrityChecksumFiles',
      expression: checksumFiles.cronExpression,
      start: false,
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

  /**
   * FL-520: Library care's one source of findings (a photo two checkers both report is counted once),
   * the folders of originals that cannot be reached, the checks running now and the recent checks.
   */
  async getIntegrityOverview(): Promise<IntegrityOverviewResponseDto> {
    const [counts, unreachable, runs, history] = await Promise.all([
      this.integrityRepository.getFindingsOverview(Object.keys(mimeTypes.raw)),
      this.getUnreachableFolders(),
      this.systemMetadataRepository.get(SystemMetadataKey.IntegrityCheckRuns),
      this.systemMetadataRepository.get(SystemMetadataKey.IntegrityCheckHistory),
    ]);
    const running = Object.values(IntegrityReport).flatMap((type) => {
      const current = runs?.[type]?.current;
      return current ? [{ type, startedAt: current.startedAt, done: current.done, total: current.batches }] : [];
    });
    return {
      missing: counts.missing,
      damaged: counts.damaged,
      stray: counts.stray,
      rawToMatch: counts.rawToMatch,
      unreachable,
      running,
      history: history?.entries ?? [],
    };
  }

  /**
   * FL-520: a real "drive unplugged" signal. Frameleaf's own folders are reachable while their mount
   * file (`.frameleaf`) is there; an external library's folder while it exists. Each folder that
   * cannot be reached says how many missing files are inside it.
   */
  private async getUnreachableFolders(): Promise<IntegrityUnreachableFolder[]> {
    const candidates: Omit<IntegrityUnreachableFolder, 'missing'>[] = [];
    for (const folder of [StorageFolder.Library, StorageFolder.Upload, StorageFolder.EncodedVideo]) {
      const base = StorageCore.getBaseFolder(folder);
      if ((await this.pathState(`${base}/.frameleaf`)) === 'missing') {
        candidates.push({ kind: 'storage', name: '', path: base });
      }
    }
    const libraries = await this.libraryRepository.getAll().catch(() => []);
    for (const library of libraries) {
      for (const importPath of library.importPaths) {
        if ((await this.pathState(importPath)) === 'missing') {
          candidates.push({ kind: 'library', name: library.name, path: importPath.replace(/\/+$/, '') });
        }
      }
    }
    const counts = await this.integrityRepository.countMissingUnder(candidates.map(({ path }) => `${path}/`));
    return candidates.map((candidate, index) => ({ ...candidate, missing: counts[index] }));
  }

  /** `missing` only when the filesystem says so; any other failure says nothing. */
  private async pathState(path: string): Promise<'present' | 'missing' | 'unknown'> {
    try {
      await this.storageRepository.stat(path);
      return 'present';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unknown';
    }
  }

  /** FL-520: the photos behind the missing or damaged findings, for "Restore from a backup". */
  async getFindingAssetIds({ kind }: IntegrityFindingAssetsDto): Promise<IntegrityFindingAssetsResponseDto> {
    return { assetIds: await this.integrityRepository.getFindingAssetIds(kind, FINDING_ASSETS_LIMIT) };
  }

  /**
   * FL-520: Stop. Checks waiting their turn are taken off the queue, the checks in progress end as
   * "stopped" in Recent checks, and the damage check stops at its next save point. Nothing found so far
   * is lost: the damage check carries on from where it stopped the next night, and the other two look
   * again in full the next night.
   */
  async stopIntegrityChecks(): Promise<IntegrityOverviewResponseDto> {
    const requestedAt = new Date().toISOString();
    await this.systemMetadataRepository.set(SystemMetadataKey.IntegrityCheckStop, { requestedAt });
    await this.jobRepository.empty(QueueName.IntegrityCheck);
    const runs = (await this.systemMetadataRepository.get(SystemMetadataKey.IntegrityCheckRuns)) ?? {};
    for (const type of Object.values(IntegrityReport)) {
      const current = runs[type]?.current;
      if (current && (await this.systemMetadataRepository.clearIntegrityRun(type, current.runId))) {
        await this.recordHistory(type, current.startedAt, 'stopped', null);
      }
    }
    return this.getIntegrityOverview();
  }

  /** Whether Stop was pressed after `startedAt`. */
  private async stopRequestedSince(startedAt: string): Promise<boolean> {
    const stop = await this.systemMetadataRepository.get(SystemMetadataKey.IntegrityCheckStop);
    return !!stop && stop.requestedAt >= startedAt;
  }

  /** FL-520: adds one ended check to Recent checks, newest first, with how many findings its list holds. */
  private async recordHistory(
    type: IntegrityReport,
    startedAt: string,
    outcome: IntegrityCheckHistoryEntry['outcome'],
    checked: number | null,
    encrypted?: number,
  ) {
    const summary = await this.integrityRepository.getIntegrityReportSummary();
    const entry: IntegrityCheckHistoryEntry = {
      type,
      startedAt,
      finishedAt: new Date().toISOString(),
      outcome,
      found: summary[type] ?? 0,
      checked,
      ...(encrypted !== undefined && { encrypted }),
    };
    const history = await this.systemMetadataRepository.get(SystemMetadataKey.IntegrityCheckHistory);
    await this.systemMetadataRepository.set(SystemMetadataKey.IntegrityCheckHistory, {
      entries: [entry, ...(history?.entries ?? [])].slice(0, INTEGRITY_HISTORY_KEPT),
    });
  }

  /**
   * FL-721 (spec §8.3): the reported items whose original is a sealed Locked file now, read when the
   * delete acts: the reported path, or the item's current original (moved since the report). A
   * checksum failure on such a file speaks of ciphertext, so the item is never trashed from here.
   */
  private async encryptedAssetIds(reports: { assetId: string; path: string }[]): Promise<Set<string>> {
    const encrypted = new Set<string>();
    if (reports.length === 0) {
      return encrypted;
    }
    const current = new Map(
      (await this.assetRepository.getByIds(reports.map(({ assetId }) => assetId))).map((asset) => [
        asset.id,
        asset.originalPath,
      ]),
    );
    for (const { assetId, path } of reports) {
      const original = current.get(assetId);
      if ((await isLockedPath(path)) || (original && original !== path && (await isLockedPath(original)))) {
        encrypted.add(assetId);
      }
    }
    return encrypted;
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
    if (
      run &&
      run.batches !== null &&
      run.done >= run.batches &&
      (await this.systemMetadataRepository.completeIntegrityRun(type, runId, new Date()))
    ) {
      await this.recordHistory(type, run.startedAt, 'completed', null);
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

  async getIntegrityReportFile(id: string): Promise<FileDownloadResponse> {
    const { path } = await this.integrityRepository.getById(id);

    return new FileDownloadResponse({
      path,
      fileName: basename(path),
      contentType: 'application/octet-stream',
      cacheControl: CacheControl.PrivateWithoutCache,
    });
  }

  async deleteIntegrityReport(userId: string, id: string): Promise<void> {
    const { path, assetId, fileAssetId } = await this.integrityRepository.getById(id);

    if (assetId && (await this.encryptedAssetIds([{ assetId, path }])).has(assetId)) {
      // FL-721 (spec §8.3): an encrypted Locked item is never trashed from here; the stale report goes
      await this.integrityRepository.deleteById(id);
    } else if (assetId) {
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
      // kept while tracked (fork-only paths such as video duplicate frames), and otherwise only through
      // the reference-counted guard: a path any row references (a shared original, the file trash) is kept
      const trackedPaths = await this.integrityRepository.getTrackedPaths([path]);
      // FL-721 (spec §8.3): a sealed Locked file nothing tracks may be the only copy of an item's
      // bytes; it is never deleted from here
      if (trackedPaths.length === 0 && !(await isLockedPath(path))) {
        await this.physicalFileRepository.deleteUnreferencedPath(path, () => this.storageRepository.unlink(path), {
          trash: this.originalsToFileTrash(),
        });
      }
      await this.integrityRepository.deleteById(id);
    }
  }

  /**
   * FL-366 "Clear this list": forgets one finding without acting on it. Unlike
   * `deleteIntegrityReport`, nothing is trashed or deleted; the next check reports it again if the
   * problem is still there.
   */
  async dismissIntegrityReport(id: string): Promise<void> {
    await this.integrityRepository.getById(id);
    await this.integrityRepository.deleteById(id);
  }

  /** FL-366 "Clear this list" for a whole check: empties its findings and touches no file or photo. */
  async clearIntegrityReports(type: IntegrityReport): Promise<IntegrityReportClearResponseDto> {
    const cleared = await this.integrityRepository.deleteByType(type);
    return { cleared };
  }

  /**
   * FL-412: universal storage never unlinks an original. A report's file that turns out to be a registered
   * original goes to the file trash, where only an administrator empties it; any other file is deleted.
   */
  private originalsToFileTrash() {
    return { move: (from: string, to: string) => moveFileWithin(this.storageRepository, from, to) };
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

  private async checkUntrackedFiles({ paths }: Omit<IIntegrityUntrackedFilesJob, 'runId'>): Promise<JobStatus> {
    this.logger.log(`Processing batch of ${paths.length} files to check if they are untracked.`);

    // Every owner of a file on disk — originals, sidecars, thumbnails, video frames, develop versions,
    // Studio outputs, registered files — comes from one list, `getTrackedPaths`, the same one a delete trusts.
    const untrackedFiles = new Set<string>(paths);
    for (const { path } of await this.integrityRepository.getTrackedPaths(paths)) {
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

        return (await this.pathExists(path)) === false ? reportId : undefined;
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

  /** Whether the path exists, or undefined when it cannot be checked (EACCES, EIO, ENOTDIR …): such a path is never reported
   * missing, and must not fail its batch. */
  private async pathExists(path: string): Promise<boolean | undefined> {
    try {
      await this.storageRepository.stat(path);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        return false;
      }
      this.logger.warn(`Could not check ${path}: ${code ?? error}`);
      return undefined;
    }
  }

  private async checkMissingFiles({ items }: Omit<IIntegrityMissingFilesJob, 'runId'>): Promise<JobStatus> {
    this.logger.log(`Processing batch of ${items.length} files to check if they are missing.`);

    const exists = await Promise.all(items.map(({ path }) => this.pathExists(path)));

    const outdatedReports: string[] = [];
    const missingFiles = [];
    for (const [index, { reportId, path, assetId, fileAssetId }] of items.entries()) {
      if (exists[index] === false) {
        missingFiles.push({ type: IntegrityReport.MissingFile, path, assetId, fileAssetId });
      } else if (exists[index] && reportId) {
        outdatedReports.push(reportId);
      }
    }
    if (outdatedReports.length > 0) {
      await this.integrityRepository.deleteByIds(outdatedReports);
    }
    if (missingFiles.length > 0) {
      await this.integrityRepository.create(missingFiles);
    }

    this.logger.log(`Processed ${items.length} and found ${missingFiles.length} missing file(s).`);
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.IntegrityMissingFilesRefresh, queue: QueueName.IntegrityCheck })
  async handleMissingRefresh({ items: paths }: IIntegrityPathWithReportJob): Promise<JobStatus> {
    this.logger.log(`Processing batch of ${paths.length} reports to check if they are out of date.`);

    const results = await Promise.all(
      paths.map(async ({ reportId, path }) => {
        return (await this.pathExists(path)) === true ? reportId : undefined;
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
   * legacy rows until a check verifies them (see ChecksumAlgorithm), so
   * integrity verification must hash with the algorithm the row was written
   * under. `sha1Path` checksums cover a path string rather than file contents
   * and cannot be verified from disk.
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
    // FL-721 (spec §8.3): a sealed Locked file holds ciphertext, so its plaintext checksum can't be
    // compared: "encrypted, not checked", never a checksum failure (its GCM tags prove it intact)
    if (await isLockedPath(originalPath)) {
      return 'encrypted' as const;
    }

    const sha1Hash = createHash('sha1');
    const sha256Hash = createHash('sha256');
    let sizeInBytes = 0;

    let actualSha256: string | null = null;
    let result: 'passed' | 'mismatched' | 'missing' | 'unreadable';
    let sha1: Buffer | undefined;
    let sha256: Buffer | undefined;
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
      sha1 = sha1Hash.digest();
      sha256 = sha256Hash.digest();
      actualSha256 = sha256.toString('hex');
      result = checksum.equals(checksumAlgorithm === ChecksumAlgorithm.sha256File ? sha256 : sha1)
        ? 'passed'
        : 'mismatched';
    } catch (error) {
      result = (error as { code?: string }).code === 'ENOENT' ? 'missing' : 'unreadable';
      if (result === 'unreadable') {
        this.logger.warn('Failed to process a file: ' + error);
      }
    }

    // Persistence errors are not file failures. Keep successful rechecks separate from the original baseline.
    const current = await this.integrityRepository.recordVerification({
      assetId,
      originalPath,
      expectedChecksum: checksum,
      checksumAlgorithm,
      actualSha256,
      result,
    });
    if (!current) {
      return;
    }
    if (result === 'passed') {
      await this.forkSchemaRepository.recordAssetChecksums({
        assetId,
        sha1: sha1!,
        sha256: sha256!,
        sizeInBytes,
        path: originalPath,
        source: 'integrity',
      });
      // A legacy upload moves to the SHA-256 just read, so the apps' uploads and duplicate checks, which send
      // SHA-256, find it. The check just made holds for that checksum too: recorded under it, the file stays
      // verified for Library care and the safety lookup. A real duplicate keeps its SHA-1 (`promoteToSha256`).
      if (
        checksumAlgorithm === ChecksumAlgorithm.sha1File &&
        (await this.forkSchemaRepository.promoteToSha256({ assetId, sha1: sha1!, sha256: sha256! }))
      ) {
        await this.integrityRepository.recordVerification({
          assetId,
          originalPath,
          expectedChecksum: sha256!,
          checksumAlgorithm: ChecksumAlgorithm.sha256File,
          actualSha256,
          result: 'passed',
        });
      }
    }
    if (result === 'passed' || result === 'missing') {
      if (reportId) {
        await this.integrityRepository.deleteById(reportId);
      }
      return;
    }
    await this.integrityRepository.create({ path: originalPath, type: IntegrityReport.ChecksumFail, assetId });
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
    let stopped = false;

    this.logger.log(`Processing assets from ${startMarker?.toISOString() ?? 'beginning'}`);

    // FL-520: the night's damage check is a run of its own, so its progress and its end show in
    // Library care: the files it plans to read tonight, and how many it has read.
    const runId = await this.startCheckRun(IntegrityReport.ChecksumFail);
    const runStartedAt = new Date(startedAt).toISOString();
    await this.systemMetadataRepository.updateIntegrityRun(IntegrityReport.ChecksumFail, runId, {
      batches: Math.max(0, Math.min(count, Math.ceil(count * percentageLimit))),
    });

    const assets = this.integrityRepository.streamAssetChecksums(startMarker);

    let encrypted = 0;
    for await (const { originalPath, checksum, checksumAlgorithm, createdAt, assetId, reportId } of assets) {
      if (
        (await this.checkAssetChecksum(originalPath, checksum, checksumAlgorithm, assetId, reportId)) === 'encrypted'
      ) {
        encrypted++;
      }

      processed++;

      if (processed % CHECKSUM_PROGRESS_EVERY === 0) {
        printStats();
        await this.systemMetadataRepository.updateIntegrityRun(IntegrityReport.ChecksumFail, runId, {
          finished: CHECKSUM_PROGRESS_EVERY,
        });
        if (await this.stopRequestedSince(runStartedAt)) {
          this.logger.log('Stopped by an administrator.');
          lastCreatedAt = createdAt;
          stopped = true;
          break;
        }
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
      // FL-520: a pass stopped by its limits (or by Stop) is not a completed run: it carries on from the
      // checkpoint next night. Stop already wrote its own line in Recent checks.
      if (await this.systemMetadataRepository.clearIntegrityRun(IntegrityReport.ChecksumFail, runId)) {
        await this.recordHistory(
          IntegrityReport.ChecksumFail,
          runStartedAt,
          stopped ? 'stopped' : 'paused',
          processed - encrypted,
          encrypted,
        );
      }
    } else {
      this.logger.log(`Finished checksum job, covered all assets.`);
      // A pass that reached the last asset is a completed run (FL-81).
      if (await this.systemMetadataRepository.completeIntegrityRun(IntegrityReport.ChecksumFail, runId, new Date())) {
        await this.recordHistory(
          IntegrityReport.ChecksumFail,
          runStartedAt,
          'completed',
          processed - encrypted,
          encrypted,
        );
      }
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
        // FL-721: a sealed Locked file's plaintext checksum can't be compared: its report is out of
        // date ("encrypted, not checked"), never a failure anything may act on
        if (await isLockedPath(path)) {
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
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
            return reportId;
          }
          throw error;
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

    // FL-721 (spec §8.3): an encrypted Locked item is never trashed from here; its stale report goes
    const encrypted = await this.encryptedAssetIds(byAsset.map(({ assetId, path }) => ({ assetId: assetId!, path })));
    const skipped = byAsset.filter(({ assetId }) => encrypted.has(assetId!));
    if (skipped.length > 0) {
      await this.integrityRepository.deleteByIds(skipped.map(({ id }) => id));
    }
    const trashed = byAsset.filter(({ assetId }) => !encrypted.has(assetId!));

    if (trashed.length > 0) {
      const ids = trashed.map(({ assetId }) => assetId!);
      await this.assetRepository.updateAll(ids, {
        deletedAt: new Date(),
        status: AssetStatus.Trashed,
      });

      await this.eventRepository.emit('AssetTrashAll', {
        assetIds: ids,
        userId: '', // we don't notify any users currently
      });

      await this.integrityRepository.deleteByIds(trashed.map(({ id }) => id));
    }

    if (byFileAsset.length > 0) {
      await this.assetRepository.deleteFiles(byFileAsset.map(({ fileAssetId }) => ({ id: fileAssetId! })));
    }

    if (byPath.length > 0) {
      const tracked = await this.integrityRepository.getTrackedPaths(byPath.map(({ path }) => path));
      const trackedPaths = new Set(tracked.map(({ path }) => path));
      for (const { path } of byPath) {
        // FL-721 (spec §8.3): a sealed Locked file is never deleted from here
        if (trackedPaths.has(path) || (await isLockedPath(path))) {
          continue;
        }
        await this.physicalFileRepository
          .deleteUnreferencedPath(path, () => this.storageRepository.unlink(path), {
            trash: this.originalsToFileTrash(),
          })
          .catch(() => void 0);
      }
      await this.integrityRepository.deleteByIds(byPath.map(({ id }) => id));
    }

    this.logger.log(`Deleted ${reports.length} reports.`);
    return JobStatus.Success;
  }
}
