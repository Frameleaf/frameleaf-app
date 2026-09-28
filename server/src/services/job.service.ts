import { BadRequestException, Injectable } from '@nestjs/common';
import type { JobItem } from 'src/types.js';
import { JOBS_NOT_RETRIED } from 'src/constants.js';
import { OnEvent } from 'src/decorators.js';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { JobCreateDto } from 'src/dtos/job.dto.js';
import { AssetType, AssetVisibility, IntegrityReport, JobName, JobStatus, ManualJobName } from 'src/enum.js';
import { ArgsOf } from 'src/repositories/event.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { hexOrBufferToBase64 } from 'src/utils/bytes.js';

import { effectiveVisibilityOf, isLockedRow } from 'src/utils/locked.js';
import { isFacialRecognitionEnabled, isImageDescriptionEnabled, isNsfwDetectionEnabled } from 'src/utils/misc.js';

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

    case ManualJobName.PhysicalDeduplicationDryRun: {
      return { name: JobName.PhysicalDeduplicationMigrationDryRun };
    }

    case ManualJobName.PhysicalDeduplicationApply: {
      // FL-73: applying needs one specific reviewed plan, never a whole-server queue button.
      throw new BadRequestException('Apply a reviewed plan from the Physical deduplication page');
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
  async create(dto: JobCreateDto): Promise<void> {
    await this.jobRepository.queue(asJobItem(dto));
  }

  @OnEvent({ name: 'JobRun' })
  async onJobRun(...[queueName, job]: ArgsOf<'JobRun'>) {
    try {
      let response: JobStatus | undefined;
      try {
        await this.eventRepository.emit('JobStart', queueName, job);
        response = await this.jobRepository.run(job);
      } catch (error: any) {
        await this.reportJobError(job, error);
        // FL-71: a job whose handler throws is a failed job. Rethrown, BullMQ records it as failed with
        // its reason and attempts, which the Job manager's Failed tab, "Retry failed" and "Remove failed
        // records" work on. Jobs that are unsafe to run again, or whose data is sensitive, are reported
        // but not kept (JOBS_NOT_RETRIED).
        if (JOBS_NOT_RETRIED.has(job.name)) {
          return;
        }
        throw error;
      }

      // FL-71: the handler has succeeded from here on. An error in the events or follow-up jobs below
      // is logged, not rethrown, so it cannot record the job as failed and have a retry repeat it.
      try {
        await this.onSuccess(job, response);
      } catch (error: any) {
        this.logger.error(`Unable to finish job ${job.name} after it succeeded: ${error}`, error?.stack);
      }
    } finally {
      await this.eventRepository.emit('JobComplete', queueName, job);
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
    await this.eventRepository.emit('JobSuccess', { job, response });
    const shouldRunFollowUp =
      response &&
      typeof response === 'string' &&
      [JobStatus.Success, JobStatus.Skipped].includes(response) &&
      !(job.name === JobName.AssetGenerateVideoDuplicateFrames && response === JobStatus.Skipped);
    if (shouldRunFollowUp) {
      await this.onDone(job);
    } else if (job.name === JobName.AssetVideoEditGeneration && response === JobStatus.Failed) {
      // FL-39: a failed version render still settles. Only the fork's history view listens for
      // this; official clients would treat AssetEditReadyV2 as a published edit and refetch.
      const asset = await this.assetRepository.getById(job.data.id);
      if (asset) {
        this.websocketRepository.clientSend('VideoEditVersionFailedV1', asset.ownerId, {
          assetId: asset.id,
          versionId: job.data.versionId ?? null,
        });
      }
    }
  }

  /** Tells the owner's clients that a video edit job settled, whatever its outcome. */
  private async sendAssetEditReady(id: string) {
    const asset = await this.assetRepository.getById(id);
    if (!asset) {
      return;
    }
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
        this.websocketRepository.clientSend('on_person_thumbnail', ownerId, personGroupId);
        break;
      }

      case JobName.AssetEditThumbnailGeneration: {
        const asset = await this.assetRepository.getById(item.data.id);
        const edits = await this.assetEditRepository.getWithSyncInfo(item.data.id);

        if (asset) {
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

          await this.jobRepository.queue({ name: JobName.BestPhotosScore, data: item.data });
        }

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
              this.websocketRepository.clientSend('on_asset_update', updatedAsset.ownerId, mapAsset(updatedAsset));
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

        const jobs: JobItem[] = [
          { name: JobName.SmartSearch, data: item.data },
          { name: JobName.AssetDetectFaces, data: item.data },
          { name: JobName.Ocr, data: item.data },
        ];

        if (asset.type === AssetType.Video) {
          // Videos are scored for Best Photos too (via sampled frames).
          jobs.push(
            { name: JobName.AssetEncodeVideo, data: item.data },
            { name: JobName.BestPhotosScore, data: item.data },
          );
        }

        if (asset.type === AssetType.Image) {
          jobs.push({ name: JobName.BestPhotosScore, data: item.data });

          const { machineLearning } = await this.getConfig({ withCache: true });
          if (isImageDescriptionEnabled(machineLearning)) {
            jobs.push({ name: JobName.ImageDescription, data: item.data });
          } else if (isNsfwDetectionEnabled(machineLearning)) {
            jobs.push({ name: JobName.NsfwDetection, data: item.data });
          }
        }

        await this.jobRepository.queueAll(jobs);
        // a locked upload (FL-34) stays out of every open timeline; the Locked view fetches it itself
        if (
          (asset.visibility === AssetVisibility.Timeline || asset.visibility === AssetVisibility.Archive) &&
          !isLockedRow(asset)
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

        break;
      }

      case JobName.SmartSearch: {
        // FL-58: a fresh CLIP embedding is what pet recognition reads. The handler returns at once
        // for an owner who has not confirmed a pet yet, before any destination is contacted.
        await this.jobRepository.queue({ name: JobName.PetRecognition, data: { id: item.data.id } });
        if (item.data.source === 'upload') {
          const asset = await this.assetRepository.getById(item.data.id);
          await this.jobRepository.queue({
            name:
              asset?.type === AssetType.Video
                ? JobName.AssetGenerateVideoDuplicateFrames
                : JobName.AssetDetectDuplicates,
            data: item.data,
          });
        }
        break;
      }

      case JobName.AssetDetectFaces: {
        const { machineLearning } = await this.getConfig({ withCache: true });
        if (isFacialRecognitionEnabled(machineLearning)) {
          await this.jobRepository.queue({ name: JobName.BestPhotosScore, data: item.data });
        }
        break;
      }

      case JobName.AssetGenerateVideoDuplicateFrames: {
        await this.jobRepository.queue({ name: JobName.AssetDetectDuplicates, data: item.data });
        break;
      }

      // no default
    }
  }
}
