import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { constants } from 'node:fs';
import path from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { JobOf } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnJob } from 'src/decorators.js';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import {
  CORRUPT_DELETE_STATUSES,
  CORRUPT_MEDIA_DELETE_CONFIRM_TEXT,
  CORRUPT_MEDIA_DELETE_RECENT_MS,
  MediaHealthBulkActionDto,
  MediaHealthBulkResponseDto,
  MediaHealthDeleteCorruptDto,
  MediaHealthListQueryDto,
  MediaHealthListResponseDto,
  MediaHealthRunResponseDto,
  MediaHealthScanResponseDto,
} from 'src/dtos/media-health.dto.js';
import {
  AssetVisibility,
  ChecksumAlgorithm,
  JobName,
  JobStatus,
  MediaHealthCategory,
  MediaHealthSeverity,
  MediaHealthStatus,
  QueueName,
  StorageFolder,
} from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { ForkSchemaRepository } from 'src/repositories/fork-schema.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MediaHealthAsset,
  MediaHealthCandidate,
  MediaHealthRepository,
  MediaHealthRun,
} from 'src/repositories/media-health.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { MediaIntegrityService } from 'src/services/media-integrity.service.js';
import { isAssetChecksumConstraint } from 'src/utils/database.js';
import { asDateTimeString } from 'src/utils/date.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { getErrorMessage } from 'src/utils/media-health.js';
import { mimeTypes } from 'src/utils/mime-types.js';

const MEDIA_HEALTH_PAGE_SIZE = 100;
const MANAGED_LOOKUP_MAX_ENTRIES = 10_000;
const MANAGED_LOOKUP_MAX_BYTES = 10 * 1024 ** 3;
const MANAGED_LOOKUP_COOLDOWN_MS = 5 * 60_000;

type CandidateValidation = {
  status: MediaHealthStatus;
  score: number | null;
  evidence: Record<string, unknown>;
  resolution: Record<string, unknown>;
};

@Injectable()
export class MediaHealthService {
  constructor(
    private logger: LoggingRepository,
    private assetRepository: AssetRepository,
    private cryptoRepository: CryptoRepository,
    private eventRepository: EventRepository,
    private forkSchemaRepository: ForkSchemaRepository,
    private jobRepository: JobRepository,
    private libraryRepository: LibraryRepository,
    private mediaHealthRepository: MediaHealthRepository,
    _mediaRepository: MediaRepository,
    private physicalFileRepository: PhysicalFileRepository,
    private storageRepository: StorageRepository,
    private userRepository: UserRepository,
    private integrityService: MediaIntegrityService,
  ) {
    this.logger.setContext(MediaHealthService.name);
  }

  async list(auth: AuthDto, dto: MediaHealthListQueryDto): Promise<MediaHealthListResponseDto> {
    const size = dto.size ?? MEDIA_HEALTH_PAGE_SIZE;
    const privacy = this.privacyFor(auth);
    const listOptions = {
      category: dto.category,
      ownerId: auth.user.id,
      privacy,
      status: dto.status,
    };
    const [findings, total, run, user] = await Promise.all([
      this.mediaHealthRepository.list({
        ...listOptions,
        size,
      }),
      this.mediaHealthRepository.count(listOptions),
      this.mediaHealthRepository.getLatestRun(dto.category, auth.user.id),
      this.userRepository.get(auth.user.id, {}),
    ]);
    const candidateRoots = [
      StorageCore.getFolderLocation(StorageFolder.Upload, auth.user.id),
      StorageCore.getLibraryFolder({ id: auth.user.id, storageLabel: user?.storageLabel ?? null }),
    ];
    const [assets, candidates] = await Promise.all([
      this.mediaHealthRepository.getAssets(
        findings.map(({ assetId }) => assetId),
        auth.user.id,
        privacy,
      ),
      this.mediaHealthRepository.getCandidatesByHealthIds(findings.map(({ id }) => id)),
    ]);

    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    const candidatesByHealthId = this.groupCandidates(candidates);
    const buckets = new Map<string, MediaHealthListResponseDto['buckets'][number]>();

    for (const finding of findings) {
      const asset = assetById.get(finding.assetId);
      if (!asset) {
        continue;
      }

      const isOwnedPath = asset.isExternal || this.isPathWithinRoots(finding.originalPath, candidateRoots);
      const originalPath = isOwnedPath ? finding.originalPath : 'Managed file in another user directory';
      const timeBucket = asset.localDateTime.toISOString().slice(0, 10);
      const bucket = buckets.get(timeBucket) ?? { timeBucket, count: 0, items: [] };
      bucket.items.push({
        id: finding.id,
        assetId: finding.assetId,
        category: finding.category,
        status: finding.status,
        severity: finding.severity,
        originalPath,
        originalFileName: finding.originalFileName,
        evidence: finding.evidence,
        resolution: finding.resolution,
        checkedAt: asDateTimeString(finding.checkedAt),
        dismissedAt: finding.dismissedAt ? asDateTimeString(finding.dismissedAt) : null,
        resolvedAt: finding.resolvedAt ? asDateTimeString(finding.resolvedAt) : null,
        asset: mapAsset(isOwnedPath ? asset : { ...asset, originalPath }, { auth }),
        candidates: (candidatesByHealthId.get(finding.id) ?? []).map((candidate) =>
          this.mapCandidateForRoots(candidate, asset.isExternal ? null : candidateRoots),
        ),
      });
      bucket.count = bucket.items.length;
      buckets.set(timeBucket, bucket);
    }

    return { buckets: buckets.values().toArray(), total, run: run ? this.mapRun(run) : null };
  }

  /** An interactive read's privacy: hidden-content settings, and Locked media only when elevated (FL-34). */
  private privacyFor(auth: AuthDto) {
    return { ...getHiddenContentQueryOptions(auth), ...getLockedVisibilityOptions(auth) };
  }

  async startMissingScan(auth: AuthDto, force?: boolean): Promise<MediaHealthScanResponseDto> {
    const { missingRunId } = await this.queueMediaHealthScan(auth.user.id, force);
    return { runId: missingRunId };
  }

  async startCorruptScan(auth: AuthDto, force?: boolean): Promise<MediaHealthScanResponseDto> {
    const { corruptRunId } = await this.queueMediaHealthScan(auth.user.id, force);
    return { runId: corruptRunId };
  }

  async locateMissing(auth: AuthDto, dto: MediaHealthBulkActionDto): Promise<MediaHealthScanResponseDto> {
    const findings = await this.mediaHealthRepository.getByIds(
      dto.ids,
      auth.user.id,
      this.privacyFor(auth),
    );
    const run = await this.mediaHealthRepository.createRun(
      MediaHealthCategory.Missing,
      auth.user.id,
      MANAGED_LOOKUP_COOLDOWN_MS,
    );
    if (!run) {
      throw new HttpException(
        'A missing-media run is active or was started within the last five minutes',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    try {
      await this.jobRepository.queue({
        name: JobName.MediaHealthLocateMissing,
        data: { runId: run.id, ids: findings.map(({ id }) => id), userId: auth.user.id },
      });
    } catch (error) {
      await this.mediaHealthRepository.finishRun(run.id, { status: 'failed', error: getErrorMessage(error) });
      throw error;
    }
    return { runId: run.id };
  }

  async dismiss(auth: AuthDto, dto: MediaHealthBulkActionDto): Promise<void> {
    const findings = await this.mediaHealthRepository.getByIds(
      dto.ids,
      auth.user.id,
      this.privacyFor(auth),
    );
    await this.mediaHealthRepository.markDismissed(
      findings.map(({ id }) => id),
      auth.user.id,
    );
  }

  async relinkMissing(auth: AuthDto, dto: MediaHealthBulkActionDto): Promise<MediaHealthBulkResponseDto> {
    const privacy = this.privacyFor(auth);
    const findings = await this.mediaHealthRepository.getByIds(dto.ids, auth.user.id, privacy);
    const assets = await this.mediaHealthRepository.getAssets(
      findings.map(({ assetId }) => assetId),
      auth.user.id,
      privacy,
    );
    const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
    const candidates = await this.mediaHealthRepository.getCandidatesByHealthIds(findings.map(({ id }) => id));
    const candidatesByHealthId = this.groupCandidates(candidates);

    const results: MediaHealthBulkResponseDto['results'] = [];
    for (const finding of findings) {
      const asset = assetsById.get(finding.assetId);
      const candidates = (candidatesByHealthId.get(finding.id) ?? []).filter(
        ({ status }) => status === MediaHealthStatus.Found,
      );

      if (!asset || candidates.length !== 1) {
        results.push({
          id: finding.id,
          success: false,
          error: 'Finding does not have exactly one validated candidate',
        });
        continue;
      }

      const candidate = candidates[0];
      if (asset.isExternal && !asset.libraryId) {
        results.push({ id: finding.id, success: false, error: 'External asset no longer belongs to a library' });
        continue;
      }
      const digests = await this.validateManagedCandidate(asset, candidate.candidatePath);
      if (!digests) {
        results.push({
          id: finding.id,
          success: false,
          error: 'Candidate no longer matches or could not be safely linked',
        });
        continue;
      }

      let stat: Awaited<ReturnType<StorageRepository['stat']>>;
      try {
        stat = await this.storageRepository.stat(candidate.candidatePath);
      } catch (error) {
        this.logger.warn(`Could not stat relink candidate ${candidate.candidatePath}: ${getErrorMessage(error)}`);
        results.push({ id: finding.id, success: false, error: 'Candidate is no longer readable' });
        continue;
      }
      const input = {
        assetId: asset.id,
        candidateId: candidate.id,
        ownerId: auth.user.id,
        healthId: finding.id,
        expectedUpdateId: asset.updateId,
        expectedChecksumAlgorithm: asset.checksumAlgorithm,
        expectedOriginalPath: asset.originalPath,
        originalPath: candidate.candidatePath,
        originalFileName: asset.originalFileName,
        expectedChecksum: asset.checksum,
        ...digests,
        fileModifiedAt: stat.mtime,
        verifyCandidate: () =>
          this.cryptoRepository.hashFileDigests(candidate.candidatePath).catch((): undefined => {}),
      };
      const relinked = asset.isExternal
        ? await this.mediaHealthRepository.relinkExternalAsset({
            ...input,
            expectedLibraryId: asset.libraryId!,
          })
        : await this.mediaHealthRepository.relinkManagedAsset(input);
      if (!relinked) {
        results.push({ id: finding.id, success: false, error: 'Asset or finding changed during relink' });
        continue;
      }
      await this.queueRelinkJobs(asset.id);
      results.push({ id: finding.id, success: true, status: MediaHealthStatus.Relinked });
    }

    return { results };
  }

  async deleteCorrupt(auth: AuthDto, dto: MediaHealthDeleteCorruptDto): Promise<MediaHealthBulkResponseDto> {
    if (dto.confirmText !== CORRUPT_MEDIA_DELETE_CONFIRM_TEXT) {
      throw new BadRequestException(`Type ${CORRUPT_MEDIA_DELETE_CONFIRM_TEXT} to move corrupt media to trash`);
    }

    const user = await this.userRepository.getForPinCode(auth.user.id);
    if (user?.pinCode && !auth.session?.hasElevatedPermission) {
      throw new ForbiddenException('Elevated PIN session is required to delete corrupt media');
    }

    const privacy = this.privacyFor(auth);
    const findings = await this.mediaHealthRepository.getByIds(dto.ids, auth.user.id, privacy);
    const now = Date.now();
    const accepted = findings.filter(
      (finding) =>
        finding.category === MediaHealthCategory.Corrupt &&
        CORRUPT_DELETE_STATUSES.has(finding.status) &&
        now - finding.checkedAt.getTime() <= CORRUPT_MEDIA_DELETE_RECENT_MS,
    );

    if (accepted.length === 0) {
      throw new BadRequestException('No recently confirmed corrupt media findings were selected');
    }

    const assets = await this.mediaHealthRepository.getAssets(
      accepted.map(({ assetId }) => assetId),
      auth.user.id,
      privacy,
    );
    const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
    const queuedIds: string[] = [];
    const resultStatusById = new Map<string, MediaHealthStatus>();

    for (const finding of accepted) {
      const asset = assetsById.get(finding.assetId);
      if (!asset) {
        continue;
      }
      const result = await this.validateAssetIntegrity(asset);

      if (result?.status === MediaHealthStatus.CorruptConfirmed) {
        queuedIds.push(finding.id);
        resultStatusById.set(finding.id, MediaHealthStatus.TrashQueued);
        continue;
      }

      const status = result?.status ?? MediaHealthStatus.Resolved;
      resultStatusById.set(finding.id, status);
      await this.mediaHealthRepository.upsertFinding({
        ...finding,
        expectedUpdateId: asset.updateId,
        status,
        severity: result ? MediaHealthSeverity.Warning : MediaHealthSeverity.Info,
        evidence: result?.evidence ?? { reason: 'trash_revalidation_passed' },
        resolution: result?.resolution ?? { trashSkipped: true },
        checkedAt: new Date(),
        resolvedAt: result ? null : new Date(),
      });
    }

    if (queuedIds.length === 0) {
      throw new BadRequestException('Selected corrupt media no longer failed deletion revalidation');
    }

    await this.mediaHealthRepository.markStatus(queuedIds, MediaHealthStatus.TrashQueued);
    await this.jobRepository.queue({
      name: JobName.MediaHealthDeleteCorrupt,
      data: { ids: queuedIds, userId: auth.user.id },
    });

    return {
      results: findings.map((finding) => ({
        id: finding.id,
        success: resultStatusById.get(finding.id) === MediaHealthStatus.TrashQueued,
        status: resultStatusById.get(finding.id) ?? finding.status,
        error:
          resultStatusById.get(finding.id) === MediaHealthStatus.TrashQueued
            ? undefined
            : 'Finding is not recently confirmed corrupt or failed revalidation',
      })),
    };
  }

  @OnJob({ name: JobName.MediaHealthScanMissing, queue: QueueName.MediaHealth })
  async handleMissingScan(job: JobOf<JobName.MediaHealthScanMissing>): Promise<JobStatus> {
    return this.handleMediaHealthScan(job);
  }

  @OnJob({ name: JobName.MediaHealthLocateMissing, queue: QueueName.MediaHealth })
  async handleLocateMissing(job: JobOf<JobName.MediaHealthLocateMissing>): Promise<JobStatus> {
    let run = job.runId;
    if (!run) {
      const created = await this.mediaHealthRepository.createRun(MediaHealthCategory.Missing, job.userId);
      run = created.id;
    }
    try {
      const findings = await this.mediaHealthRepository.getByIds(job.ids ?? [], job.userId);
      const assets = await this.mediaHealthRepository.getAssets(
        findings.map(({ assetId }) => assetId),
        job.userId,
      );
      const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
      const { candidates: managedCandidates, continuation } = await this.locateManagedCandidates(
        assets.filter(({ isExternal }) => !isExternal),
        job.managedSearch,
      );
      const truncated = !!continuation;
      let checkedAssets = 0;
      let foundAssets = 0;

      const externalCandidates = continuation
        ? new Map<string, CandidateValidation[]>()
        : await this.locateExternalCandidates(assets.filter(({ isExternal }) => isExternal));

      for (const finding of findings) {
        if (finding.category !== MediaHealthCategory.Missing) {
          continue;
        }

        const asset = assetsById.get(finding.assetId);
        if (!asset || (asset.isExternal && continuation)) {
          continue;
        }
        checkedAssets++;

        const candidates = asset.isExternal
          ? (externalCandidates.get(asset.id) ?? [])
          : (managedCandidates.get(asset.id) ?? []);
        if (candidates.some(({ status }) => status === MediaHealthStatus.Found)) {
          foundAssets++;
        }

        await this.mediaHealthRepository.replaceCandidates(
          finding.id,
          candidates.map((candidate) => ({
            healthId: finding.id,
            candidatePath: candidate.evidence.path as string,
            status: candidate.status,
            visualMatchScore: candidate.score,
            evidence: candidate.evidence,
            resolution: candidate.resolution,
            checkedAt: new Date(),
          })),
        );

        const validCandidates = candidates.filter(({ status }) => status === MediaHealthStatus.Found);
        const findingStatus =
          validCandidates.length > 0
            ? MediaHealthStatus.Found
            : candidates.length > 0
              ? MediaHealthStatus.Candidate
              : MediaHealthStatus.Missing;

        await this.mediaHealthRepository.upsertFinding({
          runId: run,
          assetId: asset.id,
          expectedUpdateId: asset.updateId,
          category: MediaHealthCategory.Missing,
          status: findingStatus,
          severity:
            findingStatus === MediaHealthStatus.Missing ? MediaHealthSeverity.Critical : MediaHealthSeverity.Warning,
          originalPath: asset.originalPath,
          originalFileName: asset.originalFileName,
          evidence: {
            ...(finding.evidence as Record<string, unknown>),
            candidateCount: candidates.length,
            validatedCandidateCount: validCandidates.length,
            searchTruncated: !asset.isExternal && truncated,
          },
          resolution: {
            ...(finding.resolution as Record<string, unknown>),
            autoRelinkable: validCandidates.length === 1,
          },
          checkedAt: new Date(),
        });
      }

      await this.mediaHealthRepository.finishRun(run, {
        status: continuation ? 'running' : 'completed',
        ...(continuation && { finishedAt: null }),
        totalAssets: checkedAssets,
        checkedAssets,
        foundAssets,
        error: truncated
          ? 'Managed media lookup incomplete: continuing in another batch; automatic relinking is disabled'
          : null,
      });
      if (continuation) {
        await this.jobRepository.queue({
          name: JobName.MediaHealthLocateMissing,
          data: { ...job, runId: run, managedSearch: continuation },
        });
      }
      return JobStatus.Success;
    } catch (error) {
      await this.mediaHealthRepository.finishRun(run, { status: 'failed', error: getErrorMessage(error) });
      throw error;
    }
  }

  @OnJob({ name: JobName.MediaHealthScanCorrupt, queue: QueueName.MediaHealth })
  async handleCorruptScan(job: JobOf<JobName.MediaHealthScanCorrupt>): Promise<JobStatus> {
    let run = job.runId;
    if (!run) {
      const created = await this.mediaHealthRepository.createRun(MediaHealthCategory.Corrupt, job.userId);
      run = created.id;
    }
    let checkedAssets = 0;
    let foundAssets = 0;
    // Buffer healthy-asset resolutions and flush in batches. On large rescans
    // (millions of assets, mostly healthy) doing one UPDATE per asset inside
    // the streaming loop dominates the DB cost; batching collapses that.
    const RESOLVE_BATCH = 500;
    const resolveBuffer: MediaHealthAsset[] = [];
    const flushResolved = async () => {
      if (resolveBuffer.length === 0) {
        return;
      }
      await this.mediaHealthRepository.markResolvedForAssets([MediaHealthCategory.Corrupt], resolveBuffer);
      resolveBuffer.length = 0;
    };

    try {
      for await (const asset of this.mediaHealthRepository.streamAssets({
        assetIds: job.assetIds,
        ownerId: job.userId,
      })) {
        checkedAssets++;
        const result = await this.validateAssetIntegrity(asset);
        if (!result) {
          resolveBuffer.push(asset);
          if (resolveBuffer.length >= RESOLVE_BATCH) {
            await flushResolved();
          }
          continue;
        }

        if (result.status === MediaHealthStatus.Missing) {
          continue;
        }
        foundAssets++;
        await this.mediaHealthRepository.upsertFinding({
          runId: run,
          assetId: asset.id,
          expectedUpdateId: asset.updateId,
          category: MediaHealthCategory.Corrupt,
          status: result.status,
          severity:
            result.status === MediaHealthStatus.CorruptConfirmed
              ? MediaHealthSeverity.Critical
              : result.status === MediaHealthStatus.UnsupportedRaw
                ? MediaHealthSeverity.Info
                : MediaHealthSeverity.Warning,
          originalPath: asset.originalPath,
          originalFileName: asset.originalFileName,
          evidence: result.evidence,
          resolution: result.resolution,
          checkedAt: new Date(),
        });
      }

      await flushResolved();

      await this.mediaHealthRepository.finishRun(run, {
        status: 'completed',
        totalAssets: checkedAssets,
        checkedAssets,
        foundAssets,
      });
      return JobStatus.Success;
    } catch (error) {
      await flushResolved();
      await this.mediaHealthRepository.finishRun(run, { status: 'failed', error: getErrorMessage(error) });
      throw error;
    }
  }

  @OnJob({ name: JobName.MediaHealthDeleteCorrupt, queue: QueueName.MediaHealth })
  async handleDeleteCorrupt(job: JobOf<JobName.MediaHealthDeleteCorrupt>): Promise<JobStatus> {
    const findings = await this.mediaHealthRepository.getByIds(job.ids, job.userId);
    const assets = await this.mediaHealthRepository.getAssets(
      findings.map(({ assetId }) => assetId),
      job.userId,
    );
    const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
    const assetIdsToTrash: string[] = [];

    for (const finding of findings) {
      const asset = assetsById.get(finding.assetId);
      if (!asset || finding.status !== MediaHealthStatus.TrashQueued) {
        continue;
      }

      const result = await this.validateAssetIntegrity(asset);
      if (result?.status === MediaHealthStatus.CorruptConfirmed) {
        if (await this.mediaHealthRepository.trashCorruptIfUnchanged({ healthId: finding.id, asset })) {
          assetIdsToTrash.push(finding.assetId);
        }
      } else {
        await this.mediaHealthRepository.upsertFinding({
          ...finding,
          expectedUpdateId: asset.updateId,
          runId: finding.runId,
          status: result?.status ?? MediaHealthStatus.Resolved,
          severity: result ? MediaHealthSeverity.Warning : MediaHealthSeverity.Info,
          evidence: result?.evidence ?? { reason: 'revalidation_passed' },
          resolution: result?.resolution ?? { trashSkipped: true },
          checkedAt: new Date(),
          resolvedAt: result ? null : new Date(),
        });
      }
    }

    if (assetIdsToTrash.length > 0) {
      await this.eventRepository.emit('AssetTrashAll', {
        assetIds: assetIdsToTrash,
        userId: job.userId,
      });
    }

    return JobStatus.Success;
  }

  private mapRun(run: MediaHealthRun): MediaHealthRunResponseDto {
    return {
      id: run.id,
      category: run.category,
      status: run.status,
      startedAt: asDateTimeString(run.startedAt),
      finishedAt: run.finishedAt ? asDateTimeString(run.finishedAt) : null,
      totalAssets: run.totalAssets,
      checkedAssets: run.checkedAssets,
      foundAssets: run.foundAssets,
      error: run.error,
    };
  }

  private async queueMediaHealthScan(
    userId: string,
    force?: boolean,
  ): Promise<{ missingRunId: string; corruptRunId: string }> {
    const [missingRun, corruptRun] = await Promise.all([
      this.mediaHealthRepository.createRun(MediaHealthCategory.Missing, userId),
      this.mediaHealthRepository.createRun(MediaHealthCategory.Corrupt, userId),
    ]);

    try {
      await this.jobRepository.queue({
        name: JobName.MediaHealthScanMissing,
        data: { missingRunId: missingRun.id, corruptRunId: corruptRun.id, force, userId },
      });
    } catch (error) {
      const failure = { status: 'failed' as const, error: getErrorMessage(error) };
      const results = await Promise.allSettled([
        this.mediaHealthRepository.finishRun(missingRun.id, failure),
        this.mediaHealthRepository.finishRun(corruptRun.id, failure),
      ]);
      for (const settled of results) {
        if (settled.status === 'rejected') {
          this.logger.warn(`Failed to mark orphaned media health run as failed: ${getErrorMessage(settled.reason)}`);
        }
      }
      throw error;
    }

    return { missingRunId: missingRun.id, corruptRunId: corruptRun.id };
  }

  private async handleMediaHealthScan(job: JobOf<JobName.MediaHealthScanMissing>): Promise<JobStatus> {
    const hasMissingRun = job.missingRunId || job.runId;
    const isLegacyMissingOnly = !job.missingRunId && !!job.runId && !job.corruptRunId;
    const includeCorrupt = !isLegacyMissingOnly;
    const [createdMissingRun, createdCorruptRun] = await Promise.all([
      hasMissingRun ? null : this.mediaHealthRepository.createRun(MediaHealthCategory.Missing, job.userId),
      includeCorrupt && !job.corruptRunId
        ? this.mediaHealthRepository.createRun(MediaHealthCategory.Corrupt, job.userId)
        : null,
    ]);
    const missingRunId = job.missingRunId ?? job.runId ?? createdMissingRun!.id;
    const corruptRunId = includeCorrupt ? (job.corruptRunId ?? createdCorruptRun!.id) : null;
    let checkedAssets = 0;
    let missingFoundAssets = 0;
    let corruptFoundAssets = 0;

    try {
      for await (const asset of this.mediaHealthRepository.streamAssets({
        assetIds: job.assetIds,
        ownerId: job.userId,
      })) {
        checkedAssets++;
        const sourceExists = await this.storageRepository.checkFileExists(asset.originalPath, constants.R_OK);
        if (!sourceExists) {
          missingFoundAssets++;
          await this.mediaHealthRepository.upsertFinding({
            runId: missingRunId,
            assetId: asset.id,
            expectedUpdateId: asset.updateId,
            category: MediaHealthCategory.Missing,
            status: MediaHealthStatus.Missing,
            severity: MediaHealthSeverity.Critical,
            originalPath: asset.originalPath,
            originalFileName: asset.originalFileName,
            evidence: { reason: 'source_file_missing_or_unreadable' },
            resolution: { autoRelinkable: !!asset.isExternal && !!asset.libraryId },
            checkedAt: new Date(),
          });
          continue;
        }

        if (!corruptRunId) {
          await this.mediaHealthRepository.markResolvedForAssets([MediaHealthCategory.Missing], [asset]);
          continue;
        }
        const result = await this.validateReadableAssetIntegrity(asset);
        if (!result) {
          await this.mediaHealthRepository.markResolvedForAssets(
            [MediaHealthCategory.Missing, MediaHealthCategory.Corrupt],
            [asset],
          );
          continue;
        }
        if (result.status === MediaHealthStatus.Missing) {
          missingFoundAssets++;
          await this.mediaHealthRepository.upsertFinding({
            runId: missingRunId,
            assetId: asset.id,
            expectedUpdateId: asset.updateId,
            category: MediaHealthCategory.Missing,
            status: MediaHealthStatus.Missing,
            severity: MediaHealthSeverity.Critical,
            originalPath: asset.originalPath,
            originalFileName: asset.originalFileName,
            evidence: result.evidence,
            resolution: result.resolution,
            checkedAt: new Date(),
          });
          continue;
        }
        await this.mediaHealthRepository.markResolvedForAssets([MediaHealthCategory.Missing], [asset]);

        corruptFoundAssets++;
        await this.mediaHealthRepository.upsertFinding({
          runId: corruptRunId,
          assetId: asset.id,
          expectedUpdateId: asset.updateId,
          category: MediaHealthCategory.Corrupt,
          status: result.status,
          severity:
            result.status === MediaHealthStatus.CorruptConfirmed
              ? MediaHealthSeverity.Critical
              : result.status === MediaHealthStatus.UnsupportedRaw
                ? MediaHealthSeverity.Info
                : MediaHealthSeverity.Warning,
          originalPath: asset.originalPath,
          originalFileName: asset.originalFileName,
          evidence: result.evidence,
          resolution: result.resolution,
          checkedAt: new Date(),
        });
      }

      if (job.userId) {
        await this.restoreUntrackedFiles(job.userId);
      }

      const finishCalls = [
        this.mediaHealthRepository.finishRun(missingRunId, {
          status: 'completed',
          totalAssets: checkedAssets,
          checkedAssets,
          foundAssets: missingFoundAssets,
        }),
      ];
      if (corruptRunId) {
        finishCalls.push(
          this.mediaHealthRepository.finishRun(corruptRunId, {
            status: 'completed',
            totalAssets: checkedAssets,
            checkedAssets,
            foundAssets: corruptFoundAssets,
          }),
        );
      }
      await Promise.all(finishCalls);
      return JobStatus.Success;
    } catch (error) {
      const update = { status: 'failed' as const, error: getErrorMessage(error) };
      const failCalls = [this.mediaHealthRepository.finishRun(missingRunId, update)];
      if (corruptRunId) {
        failCalls.push(this.mediaHealthRepository.finishRun(corruptRunId, update));
      }
      const settled = await Promise.allSettled(failCalls);
      for (const result of settled) {
        if (result.status === 'rejected') {
          this.logger.warn(`Failed to mark media health run as failed: ${getErrorMessage(result.reason)}`);
        }
      }
      throw error;
    }
  }

  private async validateAssetIntegrity(asset: MediaHealthAsset): Promise<CandidateValidation | null> {
    return this.validateReadableAssetIntegrity(asset);
  }

  private async restoreUntrackedFiles(userId: string): Promise<void> {
    const user = await this.userRepository.get(userId, {});
    if (!user) {
      return;
    }

    let importedBytes = 0;
    const pathsToCrawl = [
      StorageCore.getFolderLocation(StorageFolder.Upload, user.id),
      StorageCore.getLibraryFolder(user),
    ];
    for await (const batch of this.storageRepository.walk({
      pathsToCrawl,
      exclusionPatterns: [],
      includeHidden: false,
      take: 500,
    })) {
      const mediaPaths = batch.filter((candidatePath) => mimeTypes.isAsset(candidatePath));
      const tracked = await this.mediaHealthRepository.getTrackedPaths(mediaPaths);
      for (const candidatePath of mediaPaths) {
        if (tracked.has(candidatePath)) {
          continue;
        }

        let digests: Awaited<ReturnType<CryptoRepository['hashFileDigests']>>;
        try {
          digests = await this.cryptoRepository.hashFileDigests(candidatePath);
        } catch (error) {
          this.logger.warn(`Skipping unreadable recovered file ${candidatePath}: ${getErrorMessage(error)}`);
          continue;
        }
        const checksumAssets = await this.assetRepository.getByChecksums(userId, [digests.sha1, digests.sha256]);
        const duplicate =
          checksumAssets.length > 0 ||
          (await this.forkSchemaRepository.hasAssetChecksum(userId, digests.sha1, digests.sha256));
        if (duplicate) {
          continue;
        }
        if (
          user.quotaSizeInBytes !== null &&
          user.quotaUsageInBytes + importedBytes + digests.sizeInBytes > user.quotaSizeInBytes
        ) {
          this.logger.warn(`Skipping recovered file because user ${userId} has exceeded their quota`);
          continue;
        }

        let stat: Awaited<ReturnType<StorageRepository['stat']>>;
        try {
          stat = await this.storageRepository.stat(candidatePath);
        } catch (error) {
          this.logger.warn(`Skipping missing recovered file ${candidatePath}: ${getErrorMessage(error)}`);
          continue;
        }
        let asset: Awaited<ReturnType<AssetRepository['create']>> | undefined;
        try {
          asset = await this.assetRepository.create({
            ownerId: userId,
            libraryId: null,
            checksum: digests.sha256,
            checksumAlgorithm: ChecksumAlgorithm.sha256File,
            originalPath: path.normalize(candidatePath),
            fileCreatedAt: stat.mtime,
            fileModifiedAt: stat.mtime,
            localDateTime: stat.mtime,
            type: mimeTypes.assetType(candidatePath),
            isFavorite: false,
            duration: null,
            visibility: AssetVisibility.Timeline,
            livePhotoVideoId: null,
            originalFileName: path.basename(candidatePath),
          });
          await this.assetRepository.upsertExif({
            exif: { assetId: asset.id, fileSizeInByte: digests.sizeInBytes },
            lockedPropertiesBehavior: 'override',
          });
          await this.physicalFileRepository.ensureOriginalPhysicalFile(asset.id);
          await this.forkSchemaRepository.recordAssetChecksums({
            assetId: asset.id,
            ...digests,
            path: candidatePath,
            source: 'recovery',
          });
          await this.jobRepository.queue({
            name: JobName.AssetExtractMetadata,
            data: { id: asset.id, source: 'upload' },
          });
          await this.eventRepository.emit('AssetCreate', {
            asset,
            file: {
              uuid: asset.id,
              checksum: digests.sha256,
              legacyChecksum: digests.sha1,
              originalPath: candidatePath,
              originalName: path.basename(candidatePath),
              size: digests.sizeInBytes,
            },
          });
          importedBytes += digests.sizeInBytes;
        } catch (error) {
          if (asset) {
            await this.assetRepository.remove({ id: asset.id });
          }
          if (!isAssetChecksumConstraint(error)) {
            throw error;
          }
        }
      }
    }
  }

  private async validateReadableAssetIntegrity(asset: MediaHealthAsset): Promise<CandidateValidation | null> {
    const result = await this.integrityService.validate({
      path: asset.originalPath,
      originalFileName: asset.originalFileName,
      type: asset.type,
      expected:
        asset.checksumAlgorithm === ChecksumAlgorithm.sha1File
          ? { sha1: asset.checksum }
          : asset.checksumAlgorithm === ChecksumAlgorithm.sha256File
            ? { sha256: asset.checksum }
            : undefined,
      deep: true,
    });
    if (result.status === 'healthy') {
      return null;
    }
    return {
      status:
        result.status === 'missing' || result.status === 'unreadable'
          ? MediaHealthStatus.Missing
          : result.status === 'corrupt'
            ? MediaHealthStatus.CorruptConfirmed
            : result.status === 'unsupported'
              ? MediaHealthStatus.UnsupportedRaw
              : MediaHealthStatus.CorruptSuspect,
      score: null,
      evidence: { reason: result.reason, validationStatus: result.status },
      resolution: { reuploadRecommended: result.status === 'corrupt' },
    };
  }

  private async locateExternalCandidates(assets: MediaHealthAsset[]): Promise<Map<string, CandidateValidation[]>> {
    const result = new Map<string, CandidateValidation[]>();
    if (assets.length === 0) {
      return result;
    }

    const stored = await this.mediaHealthRepository.getAssetChecksums(assets.map(({ id }) => id));
    const storedByAsset = new Map(stored.map((checksum) => [checksum.assetId, checksum]));
    const targetByAsset = new Map<string, { asset: MediaHealthAsset; sha1: Buffer[]; sha256: Buffer[] }>();
    const sha1Targets = new Map<string, string[]>();
    const sha256Targets = new Map<string, string[]>();

    const addTarget = (index: Map<string, string[]>, digest: Buffer | undefined, assetId: string) => {
      if (!digest) {
        return;
      }
      const key = digest.toString('hex');
      index.set(key, [...(index.get(key) ?? []), assetId]);
    };

    for (const asset of assets) {
      if (!asset.libraryId) {
        continue;
      }
      const sidecar = storedByAsset.get(asset.id);
      const target = {
        asset,
        sha1: (asset.checksumAlgorithm === ChecksumAlgorithm.sha1File
          ? [asset.checksum]
          : asset.checksumAlgorithm === ChecksumAlgorithm.sha256File
            ? []
            : [sidecar?.sha1]
        ).filter((digest): digest is Buffer => !!digest),
        sha256: (asset.checksumAlgorithm === ChecksumAlgorithm.sha256File
          ? [asset.checksum]
          : asset.checksumAlgorithm === ChecksumAlgorithm.sha1File
            ? []
            : [sidecar?.sha256]
        ).filter((digest): digest is Buffer => !!digest),
      };
      targetByAsset.set(asset.id, target);
      for (const digest of target.sha1) {
        addTarget(sha1Targets, digest, asset.id);
      }
      for (const digest of target.sha256) {
        addTarget(sha256Targets, digest, asset.id);
      }
    }

    const assetsByLibrary = Map.groupBy(
      targetByAsset.values().map(({ asset }) => asset),
      ({ libraryId }) => libraryId!,
    );
    for (const [libraryId, libraryAssets] of assetsByLibrary) {
      const library = await this.libraryRepository.get(libraryId);
      if (!library) {
        continue;
      }
      const sizes = new Set(
        libraryAssets
          .map(({ id }) => storedByAsset.get(id)?.sizeInBytes)
          .filter((size): size is number => size !== undefined),
      );
      const hasUnknownSize = libraryAssets.some((asset) => {
        const sidecar = storedByAsset.get(asset.id);
        if (!sidecar) {
          return true;
        }
        return asset.checksumAlgorithm === ChecksumAlgorithm.sha1File
          ? !asset.checksum.equals(sidecar.sha1)
          : asset.checksumAlgorithm === ChecksumAlgorithm.sha256File
            ? !asset.checksum.equals(sidecar.sha256)
            : true;
      });
      const originalPaths = new Set(libraryAssets.map(({ originalPath }) => originalPath));
      for await (const batch of this.storageRepository.walk({
        pathsToCrawl: library.importPaths,
        exclusionPatterns: library.exclusionPatterns,
        includeHidden: false,
        take: 500,
      })) {
        for (const candidatePath of batch) {
          if (originalPaths.has(candidatePath)) {
            continue;
          }
          let size: number;
          try {
            ({ size } = await this.storageRepository.stat(candidatePath));
          } catch (error) {
            this.logger.debug(`Could not stat external media candidate ${candidatePath}: ${getErrorMessage(error)}`);
            continue;
          }
          if (!hasUnknownSize && !sizes.has(size)) {
            continue;
          }
          let digests: Awaited<ReturnType<CryptoRepository['hashFileDigests']>>;
          try {
            digests = await this.cryptoRepository.hashFileDigests(candidatePath);
          } catch (error) {
            this.logger.debug(`Could not hash external media candidate ${candidatePath}: ${getErrorMessage(error)}`);
            continue;
          }
          const matched = [
            ...(sha1Targets.get(digests.sha1.toString('hex')) ?? []).map((assetId) => ({
              assetId,
              algorithm: 'sha1' as const,
            })),
            ...(sha256Targets.get(digests.sha256.toString('hex')) ?? []).map((assetId) => ({
              assetId,
              algorithm: 'sha256' as const,
            })),
          ];
          for (const { assetId, algorithm } of matched) {
            const target = targetByAsset.get(assetId);
            if (
              !target ||
              target.asset.libraryId !== libraryId ||
              (target.sha1.length > 0 && target.sha1.every((digest) => !digest.equals(digests.sha1))) ||
              (target.sha256.length > 0 && target.sha256.every((digest) => !digest.equals(digests.sha256)))
            ) {
              continue;
            }
            const candidates = result.get(assetId) ?? [];
            const previous = candidates.find((candidate) => candidate.evidence.path === candidatePath);
            if (previous) {
              previous.evidence.algorithms = [
                ...new Set([...((previous.evidence.algorithms as string[] | undefined) ?? []), algorithm]),
              ];
              continue;
            }
            const existing = await this.assetRepository.getByLibraryIdAndOriginalPath(libraryId, candidatePath);
            const importedAssetId = existing && existing.id !== assetId ? existing.id : undefined;
            candidates.push({
              status: importedAssetId ? MediaHealthStatus.Candidate : MediaHealthStatus.Found,
              score: 1,
              evidence: {
                path: candidatePath,
                reason: importedAssetId ? 'candidate_already_imported' : 'checksum_match',
                algorithms: [algorithm],
                ...(importedAssetId && { assetId: importedAssetId }),
              },
              resolution: { autoRelinkable: !importedAssetId },
            });
            result.set(assetId, candidates);
          }
        }
      }
    }

    return result;
  }

  private async locateManagedCandidates(
    assets: MediaHealthAsset[],
    progress?: JobOf<JobName.MediaHealthLocateMissing>['managedSearch'],
  ) {
    const result = new Map<string, CandidateValidation[]>();
    if (assets.length === 0) {
      return { candidates: result, continuation: undefined };
    }

    const stored = await this.mediaHealthRepository.getAssetChecksums(assets.map(({ id }) => id));
    const storedByAsset = new Map(stored.map((checksum) => [checksum.assetId, checksum]));
    const knownSizes = new Set(stored.map(({ sizeInBytes }) => sizeInBytes));
    const hasUnknownSize = assets.some((asset) => {
      const sidecar = storedByAsset.get(asset.id);
      if (!sidecar) {
        return true;
      }
      return asset.checksumAlgorithm === ChecksumAlgorithm.sha1File
        ? !asset.checksum.equals(sidecar.sha1)
        : asset.checksumAlgorithm === ChecksumAlgorithm.sha256File
          ? !asset.checksum.equals(sidecar.sha256)
          : true;
    });
    const targetByAsset = new Map<string, { asset: MediaHealthAsset; sha1: Buffer[]; sha256: Buffer[] }>();
    const sha1Targets = new Map<string, string[]>();
    const sha256Targets = new Map<string, string[]>();

    const addTarget = (index: Map<string, string[]>, digest: Buffer | undefined, assetId: string) => {
      if (!digest) {
        return;
      }
      const key = digest.toString('hex');
      const ids = index.get(key) ?? [];
      if (!ids.includes(assetId)) {
        index.set(key, [...ids, assetId]);
      }
    };

    for (const asset of assets) {
      const sidecar = storedByAsset.get(asset.id);
      const target = {
        asset,
        sha1: (asset.checksumAlgorithm === ChecksumAlgorithm.sha1File
          ? [asset.checksum]
          : asset.checksumAlgorithm === ChecksumAlgorithm.sha256File
            ? []
            : [sidecar?.sha1]
        ).filter((digest): digest is Buffer => !!digest),
        sha256: (asset.checksumAlgorithm === ChecksumAlgorithm.sha256File
          ? [asset.checksum]
          : asset.checksumAlgorithm === ChecksumAlgorithm.sha1File
            ? []
            : [sidecar?.sha256]
        ).filter((digest): digest is Buffer => !!digest),
      };
      targetByAsset.set(asset.id, target);
      for (const digest of target.sha1) {
        addTarget(sha1Targets, digest, asset.id);
      }
      for (const digest of target.sha256) {
        addTarget(sha256Targets, digest, asset.id);
      }
    }

    if (!progress) {
      const users = await this.userRepository.getList();
      const roots = [
        ...new Set(
          users.flatMap((user) => [
            StorageCore.getFolderLocation(StorageFolder.Upload, user.id),
            StorageCore.getLibraryFolder(user),
          ]),
        ),
      ];
      progress = { cursor: roots.toReversed().map((path) => ({ path })), matches: {} };
    }
    const matches = new Map(
      Object.entries(progress.matches).map(([assetId, byPath]) => [
        assetId,
        new Map(Object.entries(byPath).map(([path, algorithms]) => [path, new Set(algorithms)])),
      ]),
    );
    const originalPaths = new Set(assets.map(({ originalPath }) => originalPath));
    let hashedBytes = 0;

    for await (const candidatePath of this.storageRepository.walkWithCursor(
      progress.cursor,
      MANAGED_LOOKUP_MAX_ENTRIES,
    )) {
      if (originalPaths.has(candidatePath)) {
        continue;
      }
      try {
        const { size } = await this.storageRepository.stat(candidatePath);
        if (!hasUnknownSize && !knownSizes.has(size)) {
          continue;
        }
        hashedBytes += size;
      } catch (error) {
        this.logger.debug(`Could not stat missing media candidate ${candidatePath}: ${getErrorMessage(error)}`);
        continue;
      }
      let digests: Awaited<ReturnType<CryptoRepository['hashFileDigests']>>;
      try {
        digests = await this.cryptoRepository.hashFileDigests(candidatePath);
      } catch (error) {
        this.logger.debug(`Could not hash missing media candidate ${candidatePath}: ${getErrorMessage(error)}`);
        if (hashedBytes >= MANAGED_LOOKUP_MAX_BYTES) {
          break;
        }
        continue;
      }
      const matched = [
        ...(sha1Targets.get(digests.sha1.toString('hex')) ?? []).map((assetId) => ({
          assetId,
          algorithm: 'sha1' as const,
        })),
        ...(sha256Targets.get(digests.sha256.toString('hex')) ?? []).map((assetId) => ({
          assetId,
          algorithm: 'sha256' as const,
        })),
      ];
      for (const { assetId, algorithm } of matched) {
        const target = targetByAsset.get(assetId);
        if (
          !target ||
          (target.sha1.length > 0 && target.sha1.every((digest) => !digest.equals(digests.sha1))) ||
          (target.sha256.length > 0 && target.sha256.every((digest) => !digest.equals(digests.sha256)))
        ) {
          continue;
        }
        const byPath = matches.get(assetId) ?? new Map<string, Set<'sha1' | 'sha256'>>();
        const algorithms = byPath.get(candidatePath) ?? new Set<'sha1' | 'sha256'>();
        algorithms.add(algorithm);
        byPath.set(candidatePath, algorithms);
        matches.set(assetId, byPath);
      }
      // Finish a single file even if it exceeds the byte target, so large videos cannot stall the cursor.
      if (hashedBytes >= MANAGED_LOOKUP_MAX_BYTES) {
        break;
      }
    }

    const truncated = progress.cursor.length > 0;
    for (const [assetId, target] of targetByAsset) {
      const byPath = matches.get(assetId) ?? new Map<string, Set<'sha1' | 'sha256'>>();
      const sha1Paths = new Set([...byPath].filter(([, algorithms]) => algorithms.has('sha1')).map(([path]) => path));
      const sha256Paths = new Set(
        [...byPath].filter(([, algorithms]) => algorithms.has('sha256')).map(([path]) => path),
      );
      const conflict =
        target.sha1.length > 0 &&
        target.sha256.length > 0 &&
        sha1Paths.size > 0 &&
        sha256Paths.size > 0 &&
        [...sha1Paths].every((candidatePath) => !sha256Paths.has(candidatePath));

      result.set(
        assetId,
        [...byPath].map(([candidatePath, algorithms]) => ({
          status: conflict || truncated ? MediaHealthStatus.Candidate : MediaHealthStatus.Found,
          score: algorithms.size === 2 ? 1 : 0.99,
          evidence: {
            path: candidatePath,
            reason: conflict ? 'checksum_evidence_conflict' : 'checksum_match',
            algorithms: [...algorithms],
            searchTruncated: truncated,
          },
          resolution: { autoRelinkable: !conflict && !truncated },
        })),
      );
    }

    return {
      candidates: result,
      continuation: truncated
        ? {
            cursor: progress.cursor,
            matches: Object.fromEntries(
              [...matches].map(([assetId, byPath]) => [
                assetId,
                Object.fromEntries([...byPath].map(([path, algorithms]) => [path, [...algorithms]])),
              ]),
            ),
          }
        : undefined,
    };
  }

  private async validateManagedCandidate(asset: MediaHealthAsset, candidatePath: string) {
    let digests: Awaited<ReturnType<CryptoRepository['hashFileDigests']>>;
    try {
      digests = await this.cryptoRepository.hashFileDigests(candidatePath);
    } catch (error) {
      this.logger.debug(`Could not revalidate missing media candidate ${candidatePath}: ${error}`);
      return;
    }
    const sidecars = await this.mediaHealthRepository.getAssetChecksums([asset.id]);
    const sidecar = sidecars[0];
    const matches =
      asset.checksumAlgorithm === ChecksumAlgorithm.sha1File
        ? digests.sha1.equals(asset.checksum)
        : asset.checksumAlgorithm === ChecksumAlgorithm.sha256File
          ? digests.sha256.equals(asset.checksum)
          : !!sidecar && digests.sha1.equals(sidecar.sha1) && digests.sha256.equals(sidecar.sha256);
    return matches ? digests : undefined;
  }

  private async queueRelinkJobs(assetId: string): Promise<void> {
    await this.jobRepository.queueAll([
      { name: JobName.SidecarCheck, data: { id: assetId, source: 'upload' } },
      { name: JobName.AssetGenerateThumbnails, data: { id: assetId, source: 'upload' } },
    ]);
  }

  private groupCandidates(candidates: MediaHealthCandidate[]): Map<string, MediaHealthCandidate[]> {
    const grouped = new Map<string, MediaHealthCandidate[]>();
    for (const candidate of candidates) {
      grouped.set(candidate.healthId, [...(grouped.get(candidate.healthId) ?? []), candidate]);
    }
    return grouped;
  }

  private mapCandidateForRoots(candidate: MediaHealthCandidate, roots: string[] | null) {
    const isOwned = !roots || this.isPathWithinRoots(candidate.candidatePath, roots);
    const evidence = candidate.evidence as Record<string, unknown>;
    const { path: _candidatePath, ...redactedEvidence } = evidence;

    return {
      id: candidate.id,
      healthId: candidate.healthId,
      candidatePath: isOwned ? candidate.candidatePath : 'Exact checksum match in another user directory',
      status: candidate.status,
      visualMatchScore: candidate.visualMatchScore,
      evidence: isOwned ? candidate.evidence : redactedEvidence,
      resolution: candidate.resolution,
      checkedAt: asDateTimeString(candidate.checkedAt),
    };
  }

  private isPathWithinRoots(candidatePath: string, roots: string[]) {
    return roots.some((root) => {
      const relative = path.relative(root, candidatePath);
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
  }
}
