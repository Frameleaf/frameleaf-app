import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { JobItem } from 'src/types.js';
import { OnEvent } from 'src/decorators.js';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { JobRunItemPageDto, JobRunPageDto, JobRunSearchDto } from 'src/dtos/job-run.dto.js';
import { JobCreateDto } from 'src/dtos/job.dto.js';
import {
  AssetType,
  AssetVisibility,
  IntegrityReport,
  JobName,
  JobStatus,
  LibraryScope,
  ManualJobName,
} from 'src/enum.js';
import { afterJobCommit, queueExecution } from 'src/queue/context.js';
import { ArgsOf } from 'src/repositories/event.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { hexOrBufferToBase64 } from 'src/utils/bytes.js';
import { deferForLockedKey } from 'src/utils/locked-read.js';
import { effectiveVisibilityOf, isLockedRow } from 'src/utils/locked.js';
import {
  isFacialRecognitionEnabled,
  isImageDescriptionEnabled,
  isNsfwDetectionEnabled,
  isOcrEnabled,
  isSmartSearchEnabled,
} from 'src/utils/misc.js';

const asJobItem = (dto: JobCreateDto): JobItem => {
  switch (dto.name) {
    case ManualJobName.TagCleanup: {
      return { name: JobName.TagCleanup };
    }

    case ManualJobName.PersonCleanup: {
      return { name: JobName.PersonCleanup };
    }

    case ManualJobName.UserCleanup: {
      return { name: JobName.UserDeleteCheck };
    }

    case ManualJobName.MemoryCleanup: {
      return { name: JobName.MemoryCleanup };
    }

    case ManualJobName.MemoryCreate: {
      return { name: JobName.MemoryGenerate };
    }

    case ManualJobName.BackupDatabase: {
      return { name: JobName.DatabaseBackup };
    }

    case ManualJobName.AnalyticsCollect: {
      return { name: JobName.AnalyticsCollect };
    }

    case ManualJobName.BestPhotosBackfill: {
      return { name: JobName.BestPhotosScoreQueueAll, data: { force: true } };
    }

    case ManualJobName.PhysicalDeduplicationDryRun:
    case ManualJobName.PhysicalDeduplicationApply: {
      // FL-413: the per-account merge is retired; identical files merge automatically
      throw new BadRequestException('Replaced by identical-files-check');
    }

    case ManualJobName.IdenticalFilesCheck: {
      return { name: JobName.IdenticalFilesCheck };
    }

    case ManualJobName.IntegrityMissingFiles: {
      return { name: JobName.IntegrityMissingFilesQueueAll };
    }

    case ManualJobName.IntegrityUntrackedFiles: {
      return { name: JobName.IntegrityUntrackedFilesQueueAll };
    }

    case ManualJobName.IntegrityChecksumFiles: {
      return { name: JobName.IntegrityChecksumFiles };
    }

    case ManualJobName.IntegrityMissingFilesRefresh: {
      return { name: JobName.IntegrityMissingFilesQueueAll, data: { refreshOnly: true } };
    }

    case ManualJobName.IntegrityUntrackedFilesRefresh: {
      return { name: JobName.IntegrityUntrackedFilesQueueAll, data: { refreshOnly: true } };
    }

    case ManualJobName.IntegrityChecksumFilesRefresh: {
      return { name: JobName.IntegrityChecksumFiles, data: { refreshOnly: true } };
    }

    case ManualJobName.IntegrityMissingFilesDeleteAll: {
      return { name: JobName.IntegrityDeleteReportType, data: { type: IntegrityReport.MissingFile } };
    }

    case ManualJobName.IntegrityUntrackedFilesDeleteAll: {
      return { name: JobName.IntegrityDeleteReportType, data: { type: IntegrityReport.UntrackedFile } };
    }

    case ManualJobName.IntegrityChecksumFilesDeleteAll: {
      return { name: JobName.IntegrityDeleteReportType, data: { type: IntegrityReport.ChecksumFail } };
    }

    default: {
      throw new BadRequestException('Invalid job name');
    }
  }
};

@Injectable()
export class JobService extends BaseService {
  async getRuns({ take, skip }: JobRunSearchDto): Promise<JobRunPageDto> {
    const rows = await this.jobRepository.listRuns(take + 1, skip);
    return {
      items: rows.slice(0, take).map((row) => ({
        id: row.id,
        kind: row.kind,
        createdAt: row.createdAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
        enumerationDone: row.enumerationDone,
        total: row.total,
        completed: row.completed,
        failed: row.failed,
        needsAttention: row.needsAttention,
        cancelled: row.cancelled,
        active: row.active,
        retrying: row.retrying,
        delayed: row.delayed,
        paused: row.paused,
        waiting: row.waiting,
        blocked: row.blocked,
        stageTotals: row.stageTotals,
        state: row.state,
        lastProgressAt: row.lastProgressAt?.toISOString() ?? null,
        lastStage: row.lastStage,
        reasons: row.reasons,
        noDispatchBacklog: row.noDispatchBacklog,
      })),
      hasNextPage: rows.length > take,
    };
  }

  async getRunItems(id: string, { take, skip }: JobRunSearchDto): Promise<JobRunItemPageDto> {
    const rows = await this.jobRepository.listRunItems(id, take + 1, skip);
    if (!rows) {
      throw new NotFoundException('Job run not found');
    }
    return {
      items: rows.slice(0, take).map((row) => ({
        id: row.id,
        outcome: row.outcome,
        stageTotals: row.stageTotals,
        lastProgressAt: row.lastProgressAt?.toISOString() ?? null,
        lastStage: row.lastStage,
        reasons: row.reasons,
      })),
      hasNextPage: rows.length > take,
    };
  }

  async create(dto: JobCreateDto): Promise<void> {
    await this.jobRepository.queue(asJobItem(dto));
  }

  @OnEvent({ name: 'JobRun' })
  async onJobRun(...[queueName, job]: ArgsOf<'JobRun'>) {
    try {
      await this.eventRepository.emit('JobStart', queueName, job);
      const response = await this.jobRepository.run(job);
      // Explicit Failed is a durable failed outcome, never a successful worker callback.
      if (response === JobStatus.Failed) {
        if (job.name === JobName.AssetVideoEditGeneration) {
          const asset = await this.assetRepository.getById(job.data.id);
          if (asset) {
            this.websocketRepository.clientSend('VideoEditVersionFailedV1', asset.ownerId, {
              assetId: asset.id,
              versionId: job.data.versionId ?? null,
            });
          }
        }
        throw new Error('Handler returned Failed');
      }
      await this.jobRepository.collectFollowups(() => this.onSuccess(job, response));
    } catch (error: unknown) {
      // FL-721: waiting for a Locked key is a deferral too (spec §8)
      deferForLockedKey(error);
      // A dependency refusal defers the job rather than failing it; the queue warns about it once.
      if (!queueExecution.getStore()?.dependencyReason) {
        await this.reportJobError(job, error);
      }
      throw error;
    } finally {
      try {
        await afterJobCommit(() => this.eventRepository.emit('JobComplete', queueName, job));
      } catch {
        this.logger.warn(`Unable to notify completion of ${job.name}`);
      }
    }
  }

  /** Reports a handler error; a failing listener is logged and never replaces the handler's error. */
  private async reportJobError(job: JobItem, error: any) {
    try {
      await this.eventRepository.emit('JobError', { job, error });
    } catch (listenerError: any) {
      this.logger.error(`Unable to report the error of job ${job.name}: ${listenerError}`, listenerError?.stack);
    }
  }

  private async onSuccess(job: JobItem, response: JobStatus | undefined) {
    try {
      await afterJobCommit(() => this.eventRepository.emit('JobSuccess', { job, response }));
    } catch {
      this.logger.error(`Unable to notify success of ${job.name}`);
    }
    const shouldRunFollowUp =
      response &&
      typeof response === 'string' &&
      [JobStatus.Success, JobStatus.Skipped].includes(response) &&
      !(job.name === JobName.AssetVideoFingerprint && response === JobStatus.Skipped);
    if (shouldRunFollowUp) {
      await this.onDone(job);
    }
  }

  /** Tells the owner's clients that a video edit job settled, whatever its outcome. */
  private async sendAssetEditReady(id: string) {
    const asset = await this.assetRepository.getById(id);
    if (!asset) {
      return;
    }
    if (asset.libraryScope === LibraryScope.Design) return asset;
    const edits = await this.assetEditRepository.getWithSyncInfo(id);
    this.websocketRepository.clientSend('AssetEditReadyV2', asset.ownerId, {
      asset: {
        id: asset.id,
        ownerId: asset.ownerId,
        originalFileName: asset.originalFileName,
        thumbhash: asset.thumbhash ? hexOrBufferToBase64(asset.thumbhash) : null,
        checksum: hexOrBufferToBase64(asset.checksum),
        fileCreatedAt: asset.fileCreatedAt,
        fileModifiedAt: asset.fileModifiedAt,
        createdAt: asset.createdAt,
        localDateTime: asset.localDateTime,
        duration: asset.duration,
        type: asset.type,
        deletedAt: asset.deletedAt,
        isFavorite: asset.isFavorite,
        visibility: effectiveVisibilityOf(asset),
        livePhotoVideoId: asset.livePhotoVideoId,
        stackId: asset.stackId,
        libraryId: asset.libraryId,
        width: asset.width,
        height: asset.height,
        isEdited: asset.isEdited,
      },
      edit: edits,
    });
    return asset;
  }

  /**
   * Queue follow up jobs
   */
  private async onDone(item: JobItem) {
    switch (item.name) {
      case JobName.SidecarCheck: {
        await this.jobRepository.queue({ name: JobName.AssetExtractMetadata, data: item.data });
        break;
      }

      case JobName.SidecarWrite: {
        await this.jobRepository.queue({
          name: JobName.AssetExtractMetadata,
          data: { id: item.data.id, source: 'sidecar-write' },
        });
        break;
      }

      case JobName.StorageTemplateMigrationSingle: {
        if (item.data.source === 'upload' || item.data.source === 'copy') {
          await this.jobRepository.queue({ name: JobName.AssetGenerateThumbnails, data: item.data });
        }
        break;
      }

      case JobName.PersonGenerateThumbnail: {
        const { ownerId, personGroupId } = item.data;
        await afterJobCommit(() => {
          this.websocketRepository.clientSend('on_person_thumbnail', ownerId, personGroupId);
          return Promise.resolve();
        });
        break;
      }

      case JobName.AssetEditThumbnailGeneration: {
        const asset = await this.sendAssetEditReady(item.data.id);
        if (asset && asset.libraryScope !== LibraryScope.Design) {
          await this.jobRepository.queue({ name: JobName.BestPhotosScore, data: item.data });
        }
        break;
      }

      case JobName.AssetEncodeVideo: {
        // FL-650: seek-bar previews come from the copy playback serves, so they follow the encode
        await this.jobRepository.queue({ name: JobName.AssetWarmFilmstrip, data: { id: item.data.id } });
        break;
      }

      case JobName.AssetVideoEditGeneration: {
        const asset = await this.sendAssetEditReady(item.data.id);
        if (asset) {
          // Export completion updates history only. A ready save/revert also refreshes
          // viewers and caches through the application-wide asset update subscription.
          const version = item.data.versionId
            ? await this.assetEditRepository.getVideoVersion(item.data.id, item.data.versionId)
            : undefined;
          if (!item.data.versionId || (version?.status === 'ready' && version.purpose !== 'export')) {
            const [updatedAsset] = await this.assetRepository.getByIdsWithAllRelationsButStacks([asset.id]);
            if (updatedAsset) {
              this.websocketRepository.clientSend(
                updatedAsset.libraryScope === LibraryScope.Design ? 'LibraryAssetUpdateV1' : 'on_asset_update',
                updatedAsset.ownerId,
                await this.withLandmarks(mapAsset(updatedAsset)),
              );
            }
          }
        }

        break;
      }

      case JobName.AssetGenerateThumbnails: {
        if (!item.data.notify && item.data.source !== 'upload') {
          break;
        }

        const [asset] = await this.assetRepository.getByIdsWithAllRelationsButStacks([item.data.id]);
        if (!asset) {
          this.logger.warn(`Could not find asset ${item.data.id} after generating thumbnails`);
          break;
        }

        const { machineLearning } = await this.getConfig({ withCache: true });
        const jobs: JobItem[] = [];
        if (isSmartSearchEnabled(machineLearning)) {
          jobs.push({ name: JobName.SmartSearch, data: item.data });
        }
        if (asset.libraryScope !== LibraryScope.Design && isFacialRecognitionEnabled(machineLearning)) {
          jobs.push({ name: JobName.AssetDetectFaces, data: item.data });
        }
        if (isOcrEnabled(machineLearning)) {
          jobs.push({ name: JobName.Ocr, data: item.data });
        }

        if (asset.type === AssetType.Video) {
          // Videos are scored for Best Photos too (via sampled frames).
          jobs.push({ name: JobName.AssetEncodeVideo, data: item.data });
          if (asset.libraryScope !== LibraryScope.Design) jobs.push({ name: JobName.BestPhotosScore, data: item.data });
        }

        if (asset.type === AssetType.Image) {
          if (asset.libraryScope !== LibraryScope.Design) jobs.push({ name: JobName.BestPhotosScore, data: item.data });

          if (isImageDescriptionEnabled(machineLearning)) {
            jobs.push({ name: JobName.ImageDescription, data: item.data });
          } else if (isNsfwDetectionEnabled(machineLearning)) {
            jobs.push({ name: JobName.NsfwDetection, data: item.data });
          }
        }

        await this.jobRepository.queueAll(jobs);
        await afterJobCommit(async () => {
          const [asset] = await this.assetRepository.getByIdsWithAllRelationsButStacks([item.data.id]);
          if (!asset) {
            return;
          }
          // a locked upload (FL-34) stays out of every open timeline; the Locked view fetches it itself
          if (
            (asset.visibility === AssetVisibility.Timeline || asset.visibility === AssetVisibility.Archive) &&
            !isLockedRow(asset) &&
            asset.libraryScope !== LibraryScope.Design
          ) {
            // FL-169: an upload trashed before its thumbnails were ready is not announced as a new timeline
            // item. Clients treat `on_upload_success` as "add this to the timeline", so a trashed (or
            // permanently deleted, still awaiting removal) asset would reappear in every open timeline.
            // The v2 event below carries `deletedAt`, so its clients place the asset correctly.
            if (!asset.deletedAt) {
              this.websocketRepository.clientSend('on_upload_success', asset.ownerId, mapAsset(asset));
            }
            if (asset.exifInfo) {
              const exif = asset.exifInfo;
              this.websocketRepository.clientSend('AssetUploadReadyV2', asset.ownerId, {
                // TODO remove `on_upload_success` and then modify the query to select only the required fields)
                asset: {
                  id: asset.id,
                  ownerId: asset.ownerId,
                  originalFileName: asset.originalFileName,
                  thumbhash: asset.thumbhash ? hexOrBufferToBase64(asset.thumbhash) : null,
                  checksum: hexOrBufferToBase64(asset.checksum),
                  fileCreatedAt: asset.fileCreatedAt,
                  fileModifiedAt: asset.fileModifiedAt,
                  createdAt: asset.createdAt,
                  localDateTime: asset.localDateTime,
                  duration: asset.duration,
                  type: asset.type,
                  deletedAt: asset.deletedAt,
                  isFavorite: asset.isFavorite,
                  visibility: effectiveVisibilityOf(asset),
                  livePhotoVideoId: asset.livePhotoVideoId,
                  stackId: asset.stackId,
                  libraryId: asset.libraryId,
                  width: asset.width,
                  height: asset.height,
                  isEdited: asset.isEdited,
                },
                exif: {
                  assetId: exif.assetId,
                  description: exif.description,
                  exifImageWidth: exif.exifImageWidth,
                  exifImageHeight: exif.exifImageHeight,
                  fileSizeInByte: exif.fileSizeInByte,
                  orientation: exif.orientation,
                  dateTimeOriginal: exif.dateTimeOriginal ? new Date(exif.dateTimeOriginal) : null,
                  modifyDate: exif.modifyDate ? new Date(exif.modifyDate) : null,
                  timeZone: exif.timeZone,
                  latitude: exif.latitude,
                  longitude: exif.longitude,
                  projectionType: exif.projectionType,
                  city: exif.city,
                  state: exif.state,
                  country: exif.country,
                  make: exif.make,
                  model: exif.model,
                  lensModel: exif.lensModel,
                  fNumber: exif.fNumber,
                  focalLength: exif.focalLength,
                  iso: exif.iso,
                  exposureTime: exif.exposureTime,
                  profileDescription: exif.profileDescription,
                  rating: exif.rating,
                  fps: exif.fps,
                },
              });
            }
          }
        });

        break;
      }

      case JobName.SmartSearch: {
        // FL-58: a fresh CLIP embedding is what pet recognition reads. The handler returns at once
        // for an owner who has not confirmed a pet yet, before any destination is contacted.
        const asset = await this.assetRepository.getById(item.data.id);
        if (asset && asset.libraryScope !== LibraryScope.Design)
          await this.jobRepository.queue({ name: JobName.PetRecognition, data: { id: item.data.id } });
        if (item.data.source === 'upload') {
          // FL-651: a video is fingerprinted first, unless video comparison is off
          const fingerprint =
            asset?.type === AssetType.Video &&
            (await this.getConfig({ withCache: true })).machineLearning.duplicateDetection.enhancedVideo.enabled;
          await this.jobRepository.queue({
            name: fingerprint ? JobName.AssetVideoFingerprint : JobName.AssetDetectDuplicates,
            data: item.data,
          });
        }
        break;
      }

      case JobName.AssetDetectFaces: {
        const { machineLearning } = await this.getConfig({ withCache: true });
        const asset = await this.assetRepository.getById(item.data.id);
        if (asset && asset.libraryScope !== LibraryScope.Design && isFacialRecognitionEnabled(machineLearning)) {
          await this.jobRepository.queue({ name: JobName.BestPhotosScore, data: item.data });
        }
        break;
      }

      case JobName.AssetVideoFingerprint: {
        // FL-651: its group mates too, whose check may have waited on this fingerprint
        const mates = await this.duplicateRepository.getGroupMateIds(item.data.id);
        await this.jobRepository.queueAll([
          // its own check, a new run item beside the one that found it without a fingerprint
          { name: JobName.AssetDetectDuplicates, data: { id: item.data.id, recheckAfter: item.data.id } },
          ...mates.map((id) => ({
            name: JobName.AssetDetectDuplicates as const,
            data: { id, recheckAfter: item.data.id },
          })),
        ]);
        break;
      }

      // no default
    }
  }
}
