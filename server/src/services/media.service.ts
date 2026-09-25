import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AssetEditRepository, VideoEditVersion } from 'src/repositories/asset-edit.repository.js';
import type { BoundingBox } from 'src/repositories/machine-learning.repository.js';
import type {
  AudioStreamInfo,
  DecodeToBufferOptions,
  GenerateThumbnailOptions,
  ImageDimensions,
  JobItem,
  JobOf,
  TranscodeCommand,
  VideoFormat,
  VideoInfo,
  VideoInterfaces,
  VideoStreamInfo,
} from 'src/types.js';
import { FACE_THUMBNAIL_SIZE } from 'src/constants.js';
import { ImagePathOptions, StorageCore, ThumbnailPathEntity } from 'src/cores/storage.core.js';
import { AssetFile } from 'src/database.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { ConfigFFmpegDto, SystemConfig } from 'src/dtos/config.dto.js';
import { AssetEditAction, AssetEditActionItem, CropParameters } from 'src/dtos/editing.dto.js';
import {
  AssetFileType,
  AssetType,
  AssetVisibility,
  AudioCodec,
  Colorspace,
  ImageFormat,
  ImmichWorker,
  JobName,
  JobStatus,
  PhysicalFileType,
  QueueName,
  RawExtractedFormat,
  StorageFolder,
  TranscodeHardwareAcceleration,
  TranscodePolicy,
  TranscodeTarget,
  VideoCodec,
  VideoContainer,
} from 'src/enum.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { getAssetFile, getDimensions } from 'src/utils/asset.util.js';
import { checkFaceVisibility, checkOcrVisibility } from 'src/utils/editor.js';
import {
  type DecodeQualification,
  DecodeSupport,
  assertDecodeQualified,
  qualifySourceDecode,
  selectDecodeAcceleration,
} from 'src/utils/media-decode.js';
import {
  EncoderPixelFormatPlan,
  applyFloatEncodePixelFormat,
  requiresFloatIntermediate,
  selectEncoderPixelFormat,
} from 'src/utils/media-encode.js';
import { isUnsupportedRawDecodeError } from 'src/utils/media-health.js';
import {
  EditedMasterColorDecision,
  EditedMasterColorPolicy,
  MediaPolicyError,
  MediaPolicyViolation,
  applyEditedMasterAudioPolicy,
  applyEditedMasterPixelFormatPolicy,
  assertOriginalPreserved,
  assertRenderSourceIsOriginal,
  buildEditedMasterLineage,
  getEditedMasterColorArgs,
  getEditedMasterColorRange,
  getEditedMasterFfmpegConfig,
  getEditedMasterLineagePath,
  getEditedMasterTimingArgs,
  qualifyMetadataOnlyRotation,
  resolveEditedMasterColorPolicy,
  serializeEditedMasterLineage,
  validateVideoMaster,
} from 'src/utils/media-policy.js';
import { BaseConfig, ThumbnailConfig } from 'src/utils/media.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { batched, clamp } from 'src/utils/misc.js';
import { rational, toDisplaySeconds } from 'src/utils/rational-time.js';
import { renderRawWithLibRaw } from 'src/utils/raw-renderer.js';
import { getOutputDimensions } from 'src/utils/transform.js';

/**
 * Decimal places in a generated ffmpeg filter argument. Four has always been this service's
 * precision; FL-93 names it so the rational path and the remaining float path round the same way.
 */
const FILTER_DECIMAL_PLACES = 4;

interface UpsertFileOptions {
  assetId: string;
  type: AssetFileType;
  path: string;
  physicalFileId?: string | null;
  isEdited: boolean;
  isProgressive: boolean;
  isTransparent: boolean;
}

type ExistingAssetFile = Omit<AssetFile, 'physicalFileId'> & {
  physicalFileId?: string | null;
  isProgressive: boolean;
  isTransparent: boolean;
};

type ThumbnailAsset = NonNullable<Awaited<ReturnType<AssetJobRepository['getForGenerateThumbnailJob']>>>;

type VideoThumbnailAsset = ThumbnailPathEntity & {
  originalPath: string;
  videoStream: VideoStreamInfo;
  format: VideoFormat;
};

type SpeedInterval = {
  startMs: number;
  endMs: number;
  rate: number;
};

type VideoEditTimeline = {
  startMs: number;
  endMs: number;
  intervals: SpeedInterval[];
};

enum VideoEditAccelerationMode {
  Software = 'Software',
  HardwareNative = 'HardwareNative',
  HybridHardwareEncode = 'HybridHardwareEncode',
  SoftwareFallback = 'SoftwareFallback',
}

type VideoEditCommandPlan = {
  command: TranscodeCommand;
  config: ConfigFFmpegDto;
  hasCpuVideoFilters: boolean;
  mode: VideoEditAccelerationMode;
  fallbackReason?: string;
};

const cpuVideoEditActions = new Set<AssetEditAction>([
  AssetEditAction.Crop,
  AssetEditAction.Rotate,
  AssetEditAction.Straighten,
  AssetEditAction.Mirror,
  AssetEditAction.Stabilize,
  AssetEditAction.AutoEnhance,
  AssetEditAction.Adjust,
  AssetEditAction.Filter,
  AssetEditAction.Effect,
  AssetEditAction.TextOverlay,
  AssetEditAction.Speed,
]);

const isEditAction =
  <T extends AssetEditAction>(action: T) =>
  (edit: AssetEditActionItem): edit is Extract<AssetEditActionItem, { action: T }> =>
    edit.action === action;

@Injectable()
export class MediaService extends BaseService {
  videoInterfaces: VideoInterfaces = { dri: [], mali: false };

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async onBootstrap() {
    this.videoInterfaces = await this.storageCore.getVideoInterfaces();
  }

  @OnJob({ name: JobName.AssetGenerateThumbnailsQueueAll, queue: QueueName.ThumbnailGeneration })
  async handleQueueGenerateThumbnails({ force }: JobOf<JobName.AssetGenerateThumbnailsQueueAll>): Promise<JobStatus> {
    const config = await this.getConfig({ withCache: true });

    const isFullsizeEnabled = config.image.fullsize.enabled;
    for await (const assets of batched(
      this.assetJobRepository.streamForThumbnailJob({ force, fullsizeEnabled: isFullsizeEnabled }),
    )) {
      const jobs: JobItem[] = [];
      for (const asset of assets) {
        if (force || !asset.isEdited) {
          jobs.push({ name: JobName.AssetGenerateThumbnails, data: { id: asset.id } });
        }

        if (asset.isEdited) {
          jobs.push({ name: JobName.AssetEditThumbnailGeneration, data: { id: asset.id } });
        }
      }

      await this.jobRepository.queueAll(jobs);
    }

    for await (const people of batched(this.personRepository.getAll(force ? undefined : { thumbnailPath: '' }))) {
      const jobs: JobItem[] = [];
      for (const person of people) {
        const { ownerId, personGroupId } = person;
        if (!person.faceAssetId) {
          const face = await this.personRepository.getRandomFace(personGroupId);
          if (!face) {
            continue;
          }

          await this.personRepository.update({ ownerId, personGroupId, faceAssetId: face.id });
        }

        jobs.push({ name: JobName.PersonGenerateThumbnail, data: { ownerId, personGroupId } });
      }

      await this.jobRepository.queueAll(jobs);
    }

    // profile pictures copied from a photo that became Locked where no replacement could run (FL-53)
    await this.replaceLockedProfileImages();

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.FileMigrationQueueAll, queue: QueueName.Migration })
  async handleQueueMigration(): Promise<JobStatus> {
    const { active, waiting } = await this.jobRepository.getJobCounts(QueueName.Migration);
    if (active === 1 && waiting === 0) {
      await this.storageCore.removeEmptyDirs(StorageFolder.Thumbnails);
      await this.storageCore.removeEmptyDirs(StorageFolder.EncodedVideo);
    }

    for await (const assets of batched(this.assetJobRepository.streamForMigrationJob())) {
      await this.jobRepository.queueAll(
        assets.map((asset) => ({ name: JobName.AssetFileMigration, data: { id: asset.id } })),
      );
    }

    for await (const people of batched(this.personRepository.getAll())) {
      await this.jobRepository.queueAll(
        people.map(({ ownerId, personGroupId }) => ({
          name: JobName.PersonFileMigration,
          data: { ownerId, personGroupId },
        })),
      );
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetFileMigration, queue: QueueName.Migration })
  async handleAssetMigration({ id }: JobOf<JobName.AssetFileMigration>): Promise<JobStatus> {
    const { image } = await this.getConfig({ withCache: true });
    const asset = await this.assetJobRepository.getForMigrationJob(id);
    if (!asset) {
      return JobStatus.Failed;
    }

    await this.storageCore.moveAssetImage(asset, AssetFileType.FullSize, image.fullsize.format);
    await this.storageCore.moveAssetImage(asset, AssetFileType.Preview, image.preview.format);
    await this.storageCore.moveAssetImage(asset, AssetFileType.Thumbnail, image.thumbnail.format);
    await this.storageCore.moveAssetVideo(asset);

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetEditThumbnailGeneration, queue: QueueName.Editor })
  async handleAssetEditThumbnailGeneration({ id }: JobOf<JobName.AssetEditThumbnailGeneration>): Promise<JobStatus> {
    const asset = await this.assetJobRepository.getForGenerateThumbnailJob(id);
    const config = await this.getConfig({ withCache: true });

    if (!asset) {
      this.logger.warn(`Thumbnail generation failed for asset ${id}: not found in database or missing metadata`);
      return JobStatus.Failed;
    }

    const generated = await this.generateEditedThumbnails(asset, config);
    await this.syncFiles(
      asset.files.filter((file) => file.isEdited),
      generated?.files ?? [],
    );

    let thumbhash: Buffer | undefined = generated?.thumbhash;
    if (!thumbhash) {
      const extractedImage = await this.extractOriginalImage(asset, config.image);
      const { info, data, colorspace } = extractedImage;

      thumbhash = await this.mediaRepository.generateThumbhash(data, {
        colorspace,
        processInvalidImages: false,
        raw: info,
        edits: [],
      });
    }

    if (!asset.thumbhash || Buffer.compare(asset.thumbhash, thumbhash) !== 0) {
      await this.assetRepository.update({ id: asset.id, thumbhash });
    }

    const fullsizeDimensions = generated?.fullsizeDimensions ?? getDimensions(asset.exifInfo!);
    await this.assetRepository.update({ id: asset.id, ...fullsizeDimensions });

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetGenerateThumbnails, queue: QueueName.ThumbnailGeneration })
  async handleGenerateThumbnails({ id }: JobOf<JobName.AssetGenerateThumbnails>): Promise<JobStatus> {
    const asset = await this.assetJobRepository.getForGenerateThumbnailJob(id);
    const config = await this.getConfig({ withCache: true });

    if (!asset) {
      this.logger.warn(`Thumbnail generation failed for asset ${id}: not found in database or missing metadata`);
      return JobStatus.Failed;
    }

    if (asset.visibility === AssetVisibility.Hidden) {
      this.logger.verbose(`Thumbnail generation skipped for asset ${id}: not visible`);
      return JobStatus.Skipped;
    }

    let generated: Awaited<ReturnType<MediaService['generateImageThumbnails']>>;
    if (asset.type === AssetType.Video || asset.originalFileName.toLowerCase().endsWith('.gif')) {
      this.logger.verbose(`Thumbnail generation for video ${id} ${asset.originalPath}`);
      let videoStream: VideoStreamInfo | null = asset.videoStream;
      let format: VideoFormat | null = asset.format;
      if (!videoStream || !format) {
        this.logger.warn(`Missing persisted video metadata for asset ${asset.id}; probing ${asset.originalPath}`);
        const exists = await this.storageRepository.checkFileExists(asset.originalPath);
        if (!exists) {
          throw new Error(
            `Cannot probe video metadata for asset ${asset.id}: original file missing at ${asset.originalPath}`,
          );
        }
        let videoInfo;
        try {
          videoInfo = await this.mediaRepository.probe(asset.originalPath);
        } catch (error) {
          throw new Error(`Failed to probe video metadata for asset ${asset.id}: ${(error as Error).message}`, {
            cause: error,
          });
        }
        videoStream = videoInfo?.videoStreams[0] ?? null;
        format = videoInfo?.format ?? null;
      }

      if (!videoStream || !format || !videoStream.timeBase) {
        throw new Error(`Missing video metadata for asset ${asset.id}`);
      }
      generated = await this.generateVideoThumbnails(
        {
          id: asset.id,
          ownerId: asset.ownerId,
          originalPath: asset.originalPath,
          videoStream,
          format,
        },
        config,
      );
    } else if (asset.type === AssetType.Image) {
      this.logger.verbose(`Thumbnail generation for image ${id} ${asset.originalPath}`);
      try {
        generated = await this.generateImageThumbnails(asset, config);
      } catch (error) {
        if (this.shouldSkipThumbnailDecodeError(error, asset.originalFileName)) {
          this.logger.warn(`Skipping thumbnail generation for asset ${id}: ${error}`);
          return JobStatus.Skipped;
        }

        throw error;
      }
    } else {
      this.logger.warn(`Skipping thumbnail generation for asset ${id}: ${asset.type} is not an image or video`);
      return JobStatus.Skipped;
    }

    const editedGenerated = await this.generateEditedThumbnails(asset, config);
    if (editedGenerated) {
      generated.files.push(...editedGenerated.files);
    }

    await this.syncFiles(asset.files, generated.files);
    const thumbhash = editedGenerated?.thumbhash || generated.thumbhash;

    if (!asset.thumbhash || Buffer.compare(asset.thumbhash, thumbhash) !== 0) {
      await this.assetRepository.update({ id: asset.id, thumbhash });
    }

    return JobStatus.Success;
  }

  private async extractImage(originalPath: string, minSize: number) {
    let extracted = await this.mediaRepository.extract(originalPath);
    if (extracted && !(await this.shouldUseExtractedImage(extracted.buffer, minSize))) {
      extracted = null;
    }

    return extracted;
  }

  private async renderRawImage(originalPath: string, minSize: number) {
    const buffer = await renderRawWithLibRaw(originalPath);
    if (!(await this.shouldUseExtractedImage(buffer, minSize))) {
      return null;
    }

    return { buffer, format: RawExtractedFormat.Tiff };
  }

  private async decodeImage(thumbSource: string | Buffer, exifInfo: ThumbnailAsset['exifInfo'], targetSize?: number) {
    const { image } = await this.getConfig({ withCache: true });
    const colorspace = this.isSRGB(exifInfo) ? Colorspace.Srgb : image.colorspace;
    const decodeOptions: DecodeToBufferOptions = {
      colorspace,
      processInvalidImages: process.env.IMMICH_PROCESS_INVALID_IMAGES === 'true',
      size: targetSize,
      orientation: exifInfo.orientation ? Number(exifInfo.orientation) : undefined,
    };

    const { info, data } = await this.mediaRepository.decodeImage(thumbSource, decodeOptions);
    return { info, data, colorspace };
  }

  private shouldSkipThumbnailDecodeError(error: unknown, fileName: string) {
    const message = error instanceof Error ? error.message : String(error);
    return (
      isUnsupportedRawDecodeError(error) ||
      (mimeTypes.isRaw(fileName) &&
        (message.includes('dcraw_emu') ||
          message.includes('Command failed') ||
          message.includes('ENOENT') ||
          message.includes('unsupported RAW')))
    );
  }

  private async extractOriginalImage(asset: ThumbnailAsset, image: SystemConfig['image'], useEdits = false) {
    const isRaw = mimeTypes.isRaw(asset.originalFileName);
    const extractEmbedded = image.extractEmbedded && isRaw;
    const enhancedRawEnabled = image.enhancedRaw?.enabled;
    let extracted = extractEmbedded ? await this.extractImage(asset.originalPath, image.preview.size) : null;
    let renderedRaw = false;
    let rawRenderError: unknown;

    if (!extracted && extractEmbedded && enhancedRawEnabled) {
      try {
        extracted = await this.renderRawImage(asset.originalPath, image.preview.size);
        renderedRaw = !!extracted;
      } catch (error) {
        rawRenderError = error;
        this.logger.debug(`Could not render RAW image with LibRaw for ${asset.id}: ${error}`);
      }
    }

    const generateFullsize =
      ((image.fullsize.enabled || asset.exifInfo.projectionType === 'EQUIRECTANGULAR') &&
        !mimeTypes.isWebSupportedImage(asset.originalPath)) ||
      useEdits;

    const decodeThumbSource = () => {
      const convertFullsize =
        generateFullsize && (!extracted || !mimeTypes.isWebSupportedImage(` .${extracted.format}`));
      const thumbSource = extracted ? extracted.buffer : asset.originalPath;
      return this.decodeImage(
        thumbSource,
        // only specify orientation to extracted images which don't have EXIF orientation data
        // or it can double rotate the image
        extracted ? asset.exifInfo : { ...asset.exifInfo, orientation: null },
        convertFullsize ? undefined : image.preview.size,
      ).then((decoded) => ({ ...decoded, convertFullsize }));
    };

    let decoded: Awaited<ReturnType<typeof decodeThumbSource>>;
    try {
      decoded = await decodeThumbSource();
    } catch (error) {
      if (isRaw && enhancedRawEnabled && !renderedRaw) {
        try {
          extracted = await this.renderRawImage(asset.originalPath, image.preview.size);
          renderedRaw = !!extracted;
          if (extracted) {
            decoded = await decodeThumbSource();
          } else {
            throw error;
          }
        } catch (fallbackError) {
          throw rawRenderError ?? fallbackError;
        }
      } else {
        throw rawRenderError ?? error;
      }
    }

    const { data, info, colorspace, convertFullsize } = decoded;

    let isTransparent = false;
    if (!extracted && mimeTypes.canBeTransparent(asset.originalPath)) {
      ({ isTransparent } = await this.mediaRepository.getImageMetadata(asset.originalPath));
    }

    return {
      extracted,
      data,
      info,
      colorspace,
      convertFullsize,
      generateFullsize,
      isTransparent,
    };
  }

  private async generateImageThumbnails(asset: ThumbnailAsset, { image }: SystemConfig, useEdits: boolean = false) {
    // Handle embedded preview extraction for RAW files
    const extractedImage = await this.extractOriginalImage(asset, image, useEdits);
    const { info, data, colorspace, generateFullsize, convertFullsize, extracted, isTransparent } = extractedImage;

    const previewFormat = image.preview.format;
    this.warnOnTransparencyLoss(isTransparent, previewFormat, asset.id);

    const thumbnailFormat = image.thumbnail.format;
    this.warnOnTransparencyLoss(isTransparent, thumbnailFormat, asset.id);

    const previewFile = this.getImageFile(asset, {
      fileType: AssetFileType.Preview,
      format: previewFormat,
      isEdited: useEdits,
      isProgressive: !!image.preview.progressive && previewFormat !== ImageFormat.Webp,
      isTransparent,
    });
    const thumbnailFile = this.getImageFile(asset, {
      fileType: AssetFileType.Thumbnail,
      format: thumbnailFormat,
      isEdited: useEdits,
      isProgressive: !!image.thumbnail.progressive && thumbnailFormat !== ImageFormat.Webp,
      isTransparent,
    });
    // FL-39: a still develop recipe produces a new preview and a new edited master; it never writes
    // back over the original. Checked before any of these paths is opened for writing.
    assertOriginalPreserved({ originalPath: asset.originalPath, outputPath: previewFile.path });
    assertOriginalPreserved({ originalPath: asset.originalPath, outputPath: thumbnailFile.path });

    this.storageCore.ensureFolders(previewFile.path);

    // generate final images
    const baseOptions = { colorspace, processInvalidImages: false, raw: info, edits: useEdits ? asset.edits : [] };
    const thumbnailOptions = { ...image.thumbnail, ...baseOptions, format: thumbnailFormat };
    const previewOptions = { ...image.preview, ...baseOptions, format: previewFormat };
    const promises = [
      this.mediaRepository.generateThumbhash(data, baseOptions),
      this.mediaRepository.generateThumbnail(data, thumbnailOptions, thumbnailFile.path),
      this.mediaRepository.generateThumbnail(data, previewOptions, previewFile.path),
    ];

    let fullsizeFile: UpsertFileOptions | undefined;
    if (convertFullsize) {
      const fullsizeFormat = image.fullsize.format;
      this.warnOnTransparencyLoss(isTransparent, fullsizeFormat, asset.id);
      // convert a new fullsize image from the same source as the thumbnail
      fullsizeFile = this.getImageFile(asset, {
        fileType: AssetFileType.FullSize,
        format: fullsizeFormat,
        isEdited: useEdits,
        isProgressive: !!image.fullsize.progressive && fullsizeFormat !== ImageFormat.Webp,
        isTransparent,
      });
      const fullsizeOptions = {
        ...baseOptions,
        format: fullsizeFormat,
        quality: image.fullsize.quality,
        progressive: image.fullsize.progressive,
      };
      assertOriginalPreserved({ originalPath: asset.originalPath, outputPath: fullsizeFile.path });
      promises.push(this.mediaRepository.generateThumbnail(data, fullsizeOptions, fullsizeFile.path));
    } else if (generateFullsize && extracted && extracted.format === RawExtractedFormat.Jpeg) {
      fullsizeFile = this.getImageFile(asset, {
        fileType: AssetFileType.FullSize,
        format: extracted.format,
        isEdited: false,
        isProgressive: !!image.fullsize.progressive && image.fullsize.format !== ImageFormat.Webp,
        isTransparent,
      });
      this.storageCore.ensureFolders(fullsizeFile.path);

      // Write the buffer to disk with essential EXIF data
      await this.storageRepository.createOrOverwriteFile(fullsizeFile.path, extracted.buffer);
      await this.mediaRepository.writeExif(
        {
          orientation: asset.exifInfo.orientation,
          colorspace: asset.exifInfo.colorspace,
        },
        fullsizeFile.path,
      );
      // FL-54: the embedded preview carries the camera's GPS; a derived image never keeps it. If it cannot
      // be removed, drop the fullsize file and let viewers fall back to the preview.
      if (!(await this.mediaRepository.removeLocation(fullsizeFile.path))) {
        await this.storageRepository.unlink(fullsizeFile.path);
        fullsizeFile = undefined;
      }
    }

    const outputs = await Promise.all(promises);

    if (asset.exifInfo.projectionType === 'EQUIRECTANGULAR') {
      const promises = [
        this.mediaRepository.copyTagGroup('XMP-GPano', asset.originalPath, previewFile.path),
        fullsizeFile
          ? this.mediaRepository.copyTagGroup('XMP-GPano', asset.originalPath, fullsizeFile.path)
          : Promise.resolve(),
      ];
      await Promise.all(promises);
    }

    const decodedDimensions = { width: info.width, height: info.height };
    const fullsizeDimensions = useEdits ? getOutputDimensions(asset.edits, decodedDimensions) : decodedDimensions;

    return {
      files: fullsizeFile ? [previewFile, thumbnailFile, fullsizeFile] : [previewFile, thumbnailFile],
      thumbhash: outputs[0] as Buffer,
      fullsizeDimensions,
    };
  }

  @OnJob({ name: JobName.PersonGenerateThumbnail, queue: QueueName.ThumbnailGeneration })
  async handleGeneratePersonThumbnail({
    ownerId,
    personGroupId,
  }: JobOf<JobName.PersonGenerateThumbnail>): Promise<JobStatus> {
    const { image } = await this.getConfig({ withCache: true });
    const data = await this.personRepository.getDataForThumbnailGenerationJob({ ownerId, personGroupId });
    if (!data) {
      this.logger.error(`Could not generate person thumbnail for ${personGroupId}: missing data`);
      return JobStatus.Failed;
    }

    const { x1, y1, x2, y2, oldWidth, oldHeight, exifOrientation, previewPath, originalPath } = data;
    let inputImage: string | Buffer;
    if (data.type === AssetType.Video) {
      if (!previewPath) {
        this.logger.error(`Could not generate person thumbnail for video ${personGroupId}: missing preview path`);
        return JobStatus.Failed;
      }
      inputImage = previewPath;
    } else if (image.extractEmbedded && mimeTypes.isRaw(originalPath)) {
      const extracted = await this.extractImage(originalPath, image.preview.size);
      inputImage = extracted ? extracted.buffer : originalPath;
    } else {
      inputImage = originalPath;
    }

    const { data: decodedImage, info } = await this.mediaRepository.decodeImage(inputImage, {
      colorspace: image.colorspace,
      processInvalidImages: process.env.IMMICH_PROCESS_INVALID_IMAGES === 'true',
      // if this is an extracted image, it may not have orientation metadata
      orientation: Buffer.isBuffer(inputImage) && exifOrientation ? Number(exifOrientation) : undefined,
    });

    const thumbnailPath = StorageCore.getPersonThumbnailPath({ ownerId, personGroupId });
    this.storageCore.ensureFolders(thumbnailPath);

    const thumbnailOptions: GenerateThumbnailOptions = {
      colorspace: image.colorspace,
      format: ImageFormat.Jpeg,
      raw: info,
      quality: image.thumbnail.quality,
      progressive: false,
      processInvalidImages: false,
      size: FACE_THUMBNAIL_SIZE,
      edits: [
        {
          action: AssetEditAction.Crop,
          parameters: this.getCrop(
            { old: { width: oldWidth, height: oldHeight }, new: { width: info.width, height: info.height } },
            { x1, y1, x2, y2 },
          ),
        },
      ],
    };

    await this.mediaRepository.generateThumbnail(decodedImage, thumbnailOptions, thumbnailPath);
    await this.personRepository.update({ ownerId, personGroupId, thumbnailPath });

    return JobStatus.Success;
  }

  private getCrop(
    dims: { old: ImageDimensions; new: ImageDimensions },
    { x1, y1, x2, y2 }: BoundingBox,
  ): CropParameters {
    // face bounding boxes can spill outside the image dimensions
    const clampedX1 = clamp(x1, 0, dims.old.width);
    const clampedY1 = clamp(y1, 0, dims.old.height);
    const clampedX2 = clamp(x2, 0, dims.old.width);
    const clampedY2 = clamp(y2, 0, dims.old.height);

    const widthScale = dims.new.width / dims.old.width;
    const heightScale = dims.new.height / dims.old.height;

    const halfWidth = (widthScale * (clampedX2 - clampedX1)) / 2;
    const halfHeight = (heightScale * (clampedY2 - clampedY1)) / 2;

    const middleX = Math.round(widthScale * clampedX1 + halfWidth);
    const middleY = Math.round(heightScale * clampedY1 + halfHeight);

    // zoom out 10%
    const targetHalfSize = Math.floor(Math.max(halfWidth, halfHeight) * 1.1);

    // get the longest distance from the center of the image without overflowing
    const newHalfSize = Math.min(
      middleX - Math.max(0, middleX - targetHalfSize),
      middleY - Math.max(0, middleY - targetHalfSize),
      Math.min(dims.new.width - 1, middleX + targetHalfSize) - middleX,
      Math.min(dims.new.height - 1, middleY + targetHalfSize) - middleY,
    );

    return {
      x: middleX - newHalfSize,
      y: middleY - newHalfSize,
      width: newHalfSize * 2,
      height: newHalfSize * 2,
    };
  }

  private getVideoThumbnailDurationSeconds(videoStream: VideoStreamInfo, format: VideoFormat) {
    const durationFromFormat = format.duration;
    const durationFromFrames =
      videoStream.frameCount > 0 && videoStream.frameRate && videoStream.frameRate > 0
        ? videoStream.frameCount / videoStream.frameRate
        : null;

    if (!durationFromFrames || !Number.isFinite(durationFromFrames) || durationFromFrames <= 0) {
      return durationFromFormat;
    }

    if (!Number.isFinite(durationFromFormat) || durationFromFormat <= 0) {
      return durationFromFrames;
    }

    const durationRatio =
      Math.max(durationFromFormat, durationFromFrames) / Math.min(durationFromFormat, durationFromFrames);
    return durationRatio >= 100 ? durationFromFrames : durationFromFormat;
  }

  private getVideoThumbnailCandidateTimestamps(videoStream: VideoStreamInfo, format: VideoFormat) {
    const duration = this.getVideoThumbnailDurationSeconds(videoStream, format);
    if (!Number.isFinite(duration) || duration <= 1) {
      return [];
    }

    // Keep candidates clear of the final stretch of the clip. The frame-selection
    // chain (fps + thumbnail, decoding only keyframes via -skip_frame nointra)
    // needs a run of trailing frames to emit one; a timestamp inside that tail
    // produces zero frames and ffmpeg aborts the whole transcode with "Nothing
    // was written into output file". Reserve a proportional tail, but never less
    // than the historical 0.5s (so very short clips keep their existing spread).
    const tail = Math.min(Math.max(duration * 0.1, 0.5), 5);
    const latest = Math.max(duration - tail, 0);

    // Sample a few spread-out points. For long clips, also anchor an early fixed
    // sample (~30s, past typical intros) -- but only when it sits safely before
    // the tail. The previous implementation instead mapped every long-clip
    // candidate through Math.max(30, timestamp), which collapsed them all onto
    // ~30s for clips of roughly 30-43s; for a clip barely over 30s that single
    // value then clamped into the dead zone above and failed the transcode (e.g.
    // rotating a ~30s video, which regenerates its thumbnails from the edit).
    const fractions = duration >= 30 ? [0.35, 0.55, 0.75] : [0.2, 0.5, 0.8];
    const candidates = fractions.map((fraction) => duration * fraction);
    if (duration >= 30 && 30 < latest) {
      candidates.unshift(30);
    }

    return [
      ...new Set(
        candidates
          .map((timestamp) => Number(Math.min(timestamp, latest).toFixed(3)))
          .filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0),
      ),
    ];
  }

  private getVideoThumbnailCandidatePath(output: string, index: number) {
    const { dir, ext, name } = path.parse(output);
    return path.join(dir, `${name}_candidate_${index}${ext}`);
  }

  private async pickVideoThumbnailStartTime(
    input: string,
    output: string,
    videoStream: VideoStreamInfo,
    format: VideoFormat,
    getOptions: (timestamp: number) => TranscodeCommand,
  ) {
    const timestamps = this.getVideoThumbnailCandidateTimestamps(videoStream, format);
    if (timestamps.length === 0) {
      return 0;
    }

    let selected = 0;
    let bestScore = -Infinity;
    const candidates: string[] = [];

    try {
      for (const [index, timestamp] of timestamps.entries()) {
        const candidate = this.getVideoThumbnailCandidatePath(output, index);
        candidates.push(candidate);

        try {
          await this.mediaRepository.transcode(input, candidate, getOptions(timestamp));
          const score = await this.mediaRepository.scoreThumbnailCandidate(candidate);
          if (score > bestScore) {
            bestScore = score;
            selected = timestamp;
          }
        } catch (error: any) {
          this.logger.warn(`Could not score thumbnail candidate at ${timestamp}s: ${error?.message ?? error}`);
        }
      }
    } finally {
      await Promise.all(candidates.map((candidate) => fs.rm(candidate, { force: true })));
    }

    return Number.isFinite(bestScore) ? selected : 0;
  }

  private async generateVideoThumbnails(
    asset: VideoThumbnailAsset,
    { ffmpeg, image }: SystemConfig,
    options: {
      sourcePath?: string;
      isEdited?: boolean;
      fullsizeDimensions?: ImageDimensions;
      /** FL-39: a retained version's thumbnails get unique paths, so history keeps its own files. */
      pathSuffix?: string;
      /** FL-39: receives every path this call may create, for cleanup if the version is not published. */
      candidates?: string[];
    } = {},
  ) {
    const sourcePath = options.sourcePath ?? asset.originalPath;
    const isEdited = options.isEdited ?? false;
    const previewFile = this.getImageFile(asset, {
      fileType: AssetFileType.Preview,
      format: image.preview.format,
      isEdited,
      isProgressive: false,
      isTransparent: false,
    });
    const thumbnailFile = this.getImageFile(asset, {
      fileType: AssetFileType.Thumbnail,
      format: image.thumbnail.format,
      isEdited,
      isProgressive: false,
      isTransparent: false,
    });
    if (options.pathSuffix) {
      for (const file of [previewFile, thumbnailFile]) {
        const parsed = path.parse(file.path);
        file.path = path.join(parsed.dir, `${parsed.name}_${options.pathSuffix}${parsed.ext}`);
      }
    }
    options.candidates?.push(previewFile.path, thumbnailFile.path);
    const { videoStream, format } = asset;
    if (!videoStream || !format) {
      throw new Error(`Missing video metadata for asset ${asset.id}`);
    }

    // FL-101: qualify the source before anything is created on disk. A refused source must not
    // reach the point where an existing, valid preview has already been cleared out of the way.
    assertDecodeQualified(qualifySourceDecode(videoStream, ffmpeg));

    this.storageCore.ensureFolders(previewFile.path);

    const previewConfig = { ...ffmpeg, targetResolution: image.preview.size.toString() };
    const thumbConfig = { ...ffmpeg, targetResolution: image.thumbnail.size.toString() };
    const startTime = await this.pickVideoThumbnailStartTime(
      sourcePath,
      previewFile.path,
      videoStream,
      format,
      (timestamp) =>
        ThumbnailConfig.create(previewConfig, timestamp).getCommand(
          TranscodeTarget.Video,
          videoStream,
          undefined,
          format,
        ),
    );
    const previewOptions = ThumbnailConfig.create(previewConfig, startTime).getCommand(
      TranscodeTarget.Video,
      videoStream,
      undefined,
      format,
    );
    const thumbnailOptions = ThumbnailConfig.create(thumbConfig, startTime).getCommand(
      TranscodeTarget.Video,
      videoStream,
      undefined,
      format,
    );

    await this.mediaRepository.transcode(sourcePath, previewFile.path, previewOptions);
    await this.mediaRepository.transcode(sourcePath, thumbnailFile.path, thumbnailOptions);

    const thumbhash = await this.mediaRepository.generateThumbhash(previewFile.path, {
      colorspace: image.colorspace,
      processInvalidImages: process.env.IMMICH_PROCESS_INVALID_IMAGES === 'true',
    });

    return {
      files: [previewFile, thumbnailFile],
      thumbhash,
      fullsizeDimensions: options.fullsizeDimensions ?? { width: videoStream.width, height: videoStream.height },
    };
  }

  @OnJob({ name: JobName.AssetEncodeVideoQueueAll, queue: QueueName.VideoConversion })
  async handleQueueVideoConversion(job: JobOf<JobName.AssetEncodeVideoQueueAll>): Promise<JobStatus> {
    const { force } = job;

    for await (const assets of batched(this.assetJobRepository.streamForVideoConversion(force))) {
      await this.jobRepository.queueAll(
        assets.map((asset) => ({ name: JobName.AssetEncodeVideo, data: { id: asset.id } })),
      );
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetEncodeVideo, queue: QueueName.VideoConversion })
  async handleVideoConversion({ id }: JobOf<JobName.AssetEncodeVideo>): Promise<JobStatus> {
    const asset = await this.assetJobRepository.getForVideoConversion(id);
    if (!asset) {
      return JobStatus.Failed;
    }

    const input = asset.originalPath;
    const output = StorageCore.getEncodedVideoPath(asset);

    const { videoStream, format } = asset;
    const audioStream = asset.audioStream ?? undefined;
    if (!videoStream || !format) {
      this.logger.warn(`Skipped transcoding for asset ${asset.id}: missing metadata; re-run extraction first`);
      return JobStatus.Failed;
    }
    if (!videoStream.height || !videoStream.width) {
      this.logger.warn(`Skipped transcoding for asset ${asset.id}: no video dimensions`);
      return JobStatus.Failed;
    }

    let { ffmpeg } = await this.getConfig({ withCache: true });

    // FL-101: classify the source before the output directory exists, so a refusal leaves any
    // existing proxy untouched and the original is never the thing that changes.
    const qualification = qualifySourceDecode(videoStream, ffmpeg);
    if (qualification.support === DecodeSupport.Refused) {
      this.logger.warn(`Skipped transcoding for asset ${asset.id}: ${qualification.reason}`);
      return JobStatus.Skipped;
    }

    // FL-101: hardware decoding is used only where the fixed-function path can hand back the
    // source's own planes. This narrows `accelDecode`; it never changes `accel`, so hardware
    // encoding is unaffected.
    const decodeAcceleration = selectDecodeAcceleration(ffmpeg, qualification);
    if (ffmpeg.accelDecode && !decodeAcceleration.accelDecode) {
      this.logger.debug(`Asset ${asset.id}: ${decodeAcceleration.reason}`);
    }
    ffmpeg = decodeAcceleration.config;

    const target = this.getTranscodeTarget(ffmpeg, videoStream, audioStream);
    if (target === TranscodeTarget.None && !this.isRemuxRequired(ffmpeg, format)) {
      const encodedVideo = getAssetFile(asset.files, AssetFileType.EncodedVideo, { isEdited: false });
      if (encodedVideo) {
        this.logger.log(`Transcoded video exists for asset ${asset.id}, but is no longer required. Deleting...`);
        await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [encodedVideo.path] } });
        await this.assetRepository.deleteFiles([encodedVideo]);
      } else {
        this.logger.verbose(`Asset ${asset.id} does not require transcoding based on current policy, skipping`);
      }

      return JobStatus.Skipped;
    }

    this.storageCore.ensureFolders(output);

    const command = BaseConfig.create(ffmpeg, this.videoInterfaces).getCommand(target, videoStream, audioStream);
    if (ffmpeg.accel === TranscodeHardwareAcceleration.Disabled) {
      this.logger.log(`Transcoding video ${asset.id} without hardware acceleration`);
    } else {
      this.logger.log(
        `Transcoding video ${asset.id} with ${ffmpeg.accel.toUpperCase()}-accelerated encoding and${ffmpeg.accelDecode ? '' : ' software'} decoding`,
      );
    }

    try {
      await this.mediaRepository.transcode(input, output, command);
    } catch (error: any) {
      this.logger.error(`Error occurred during transcoding: ${error.message}`);
      if (ffmpeg.accel === TranscodeHardwareAcceleration.Disabled) {
        return JobStatus.Failed;
      }

      let isPartialFallbackSuccess = false;
      if (ffmpeg.accelDecode) {
        try {
          this.logger.error(`Retrying with ${ffmpeg.accel.toUpperCase()}-accelerated encoding and software decoding`);
          ffmpeg = { ...ffmpeg, accelDecode: false };
          const command = BaseConfig.create(ffmpeg, this.videoInterfaces).getCommand(target, videoStream, audioStream);
          await this.mediaRepository.transcode(input, output, command);
          isPartialFallbackSuccess = true;
        } catch (error: any) {
          this.logger.error(`Error occurred during transcoding: ${error.message}`);
        }
      }

      if (!isPartialFallbackSuccess) {
        this.logger.error(`Retrying with ${ffmpeg.accel.toUpperCase()} acceleration disabled`);
        ffmpeg = { ...ffmpeg, accel: TranscodeHardwareAcceleration.Disabled };
        const command = BaseConfig.create(ffmpeg, this.videoInterfaces).getCommand(target, videoStream, audioStream);
        await this.mediaRepository.transcode(input, output, command);
      }
    }

    this.logger.log(`Successfully encoded ${asset.id}`);

    const { file: encodedVideo, pathToDelete } = await this.applyPhysicalDeduplicationToGeneratedFile({
      assetId: asset.id,
      type: AssetFileType.EncodedVideo,
      path: output,
      isEdited: false,
      isProgressive: false,
      isTransparent: false,
    });
    await this.assetRepository.upsertFile(encodedVideo);
    if (pathToDelete) {
      await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [pathToDelete] } });
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetVideoEditGeneration, queue: QueueName.VideoConversion })
  async handleAssetVideoEditGeneration({ id, versionId }: JobOf<JobName.AssetVideoEditGeneration>): Promise<JobStatus> {
    const asset = await this.assetJobRepository.getForVideoConversion(id);
    if (!asset) {
      return JobStatus.Failed;
    }

    const { videoStream, format } = asset;
    const audioStream = asset.audioStream ?? undefined;
    if (!videoStream || !format) {
      this.logger.warn(`Skipped video edit generation for asset ${asset.id}: missing metadata`);
      return JobStatus.Failed;
    }

    const thumbnailAsset = {
      id: asset.id,
      ownerId: asset.ownerId,
      originalPath: asset.originalPath,
      videoStream,
      format,
    };
    const config = await this.getConfig({ withCache: true });

    // FL-39: with fork writes enabled every save, revert and export is a retained version. The
    // job renders the requested (or the named export) version into its own master and proxy, and
    // publication decides — transactionally — whether it is still the one to show.
    let version: VideoEditVersion | undefined;
    try {
      version = versionId
        ? await this.assetEditRepository.getVideoVersion(id, versionId)
        : await this.assetEditRepository.getRequestedVideoVersion(id);
    } catch (error: any) {
      this.logger.error(`Refusing to render a video version for asset ${asset.id}: ${error?.message ?? error}`);
      return JobStatus.Failed;
    }
    if (versionId && !version) {
      return JobStatus.Skipped;
    }
    if (version) {
      if (version.status === 'ready') {
        return JobStatus.Skipped;
      }
      return this.renderVideoVersion(version, { ...thumbnailAsset, files: asset.files }, config);
    }

    const edits = (await this.assetEditRepository.getAll(id)) as AssetEditActionItem[];
    const editedFiles = this.toExistingAssetFiles(asset.files.filter((file) => file.isEdited));

    if (edits.length === 0) {
      await this.syncFiles(editedFiles, []);
      const generated = await this.generateVideoThumbnails(thumbnailAsset, config);
      await this.syncFiles(
        this.toExistingAssetFiles(asset.files.filter((file) => !file.isEdited && this.isVideoThumbnailFile(file.type))),
        generated.files,
      );
      await this.assetRepository.update({
        id: asset.id,
        thumbhash: generated.thumbhash,
        duration: Math.round(format.duration * 1000),
        ...generated.fullsizeDimensions,
      });
      return JobStatus.Success;
    }

    const output = this.getEditedEncodedVideoPath(thumbnailAsset);

    // FL-39: an edit never overwrites the original, and a new master is always rendered from the
    // original plus its recipe — never from a playback proxy or from an earlier, already lossy,
    // edited master. Both are checked before the encoder is started, so a failure here leaves any
    // existing valid edited master in place.
    let colorDecision: EditedMasterColorDecision;
    try {
      colorDecision = this.qualifyEditedMasterRender({
        videoStream,
        config: config.ffmpeg,
        originalPath: asset.originalPath,
        sourcePath: asset.originalPath,
        outputPaths: [output],
        derivedPaths: asset.files.map((file) => file.path),
      });
    } catch (error) {
      if (error instanceof MediaPolicyError) {
        this.logger.error(`Refusing to render an edited master for asset ${asset.id}: ${error.message}`);
        return JobStatus.Failed;
      }
      throw error;
    }

    this.storageCore.ensureFolders(output);

    const rendered = await this.transcodeEditedMaster({
      assetId: asset.id,
      input: asset.originalPath,
      output,
      config: config.ffmpeg,
      edits,
      videoStream,
      audioStream,
      format,
      colorDecision,
    });
    if (!rendered) {
      return JobStatus.Failed;
    }

    // FL-39: an edited master is a new file that records where it came from — the source asset and
    // its original, the exact recipe revision, the renderer identity and the colour decision — so a
    // stale or unreproducible master can always be recognised and re-rendered from the original.
    await this.writeEditedMasterLineage({
      masterPath: output,
      assetId: asset.id,
      originalPath: asset.originalPath,
      checksum: asset.checksum,
      edits,
      colorDecision,
      decode: qualifySourceDecode(videoStream, config.ffmpeg),
    });

    await this.assetRepository.upsertFile({
      assetId: asset.id,
      type: AssetFileType.EncodedVideo,
      path: output,
      isEdited: true,
      isProgressive: false,
      isTransparent: false,
    });

    const fullsizeDimensions = this.getVideoEditDimensions(edits, videoStream);
    const generated = await this.generateVideoThumbnails(thumbnailAsset, config, {
      sourcePath: output,
      isEdited: true,
      fullsizeDimensions,
    });
    await this.syncFiles(
      editedFiles.filter((file) => file.type !== AssetFileType.EncodedVideo),
      generated.files,
    );

    await this.assetRepository.update({
      id: asset.id,
      thumbhash: generated.thumbhash,
      duration: this.getVideoEditDurationMs(edits, format),
      ...fullsizeDimensions,
    });

    return JobStatus.Success;
  }

  /**
   * The checks every edited-master render passes before anything is created on disk (FL-39,
   * FL-101, FL-102). Throws a {@link MediaPolicyError} when the render must not start.
   */
  private qualifyEditedMasterRender({
    videoStream,
    config,
    originalPath,
    sourcePath,
    outputPaths,
    derivedPaths,
  }: {
    videoStream: VideoStreamInfo;
    config: ConfigFFmpegDto;
    originalPath: string;
    sourcePath: string;
    outputPaths: string[];
    derivedPaths: string[];
  }): EditedMasterColorDecision {
    for (const outputPath of outputPaths) {
      assertOriginalPreserved({ originalPath, outputPath });
    }
    assertRenderSourceIsOriginal({ originalPath, sourcePath, derivedPaths });
    // FL-101: the source has to be one this renderer can decode honestly before anything
    // else is decided. Dolby Vision profile 5, an undescribable pixel format or a bit depth
    // beyond what can be delivered all stop here — before ensureFolders, so an existing valid
    // edited master survives the refusal untouched.
    const qualification = qualifySourceDecode(videoStream, config);
    assertDecodeQualified(qualification);
    const colorDecision = resolveEditedMasterColorPolicy(videoStream, config);
    // FL-102: reject an incompatible output option here too — a 10-bit source aimed at an
    // encoder with no qualified 10-bit path is refused rather than quietly flattened. This is
    // the same call, under the same condition, that `getVideoEditCommand` makes; doing it here
    // as well keeps the refusal ahead of ensureFolders, where nothing has been disturbed yet.
    if (qualification.layout && requiresFloatIntermediate(qualification.layout, qualification.transfer)) {
      const masterConfig = getEditedMasterFfmpegConfig(config, videoStream);
      selectEncoderPixelFormat({
        codec: masterConfig.targetVideoCodec,
        accel: masterConfig.accel,
        layout: qualification.layout,
        policy: colorDecision.policy,
        colorMatrix: videoStream.colorMatrix,
        range: getEditedMasterColorRange(videoStream, colorDecision),
      });
    }
    return colorDecision;
  }

  /** Renders an edited master, falling back to software once when a hardware plan fails. */
  private async transcodeEditedMaster({
    assetId,
    input,
    output,
    config,
    edits,
    videoStream,
    audioStream,
    format,
    colorDecision,
  }: {
    assetId: string;
    input: string;
    output: string;
    config: ConfigFFmpegDto;
    edits: AssetEditActionItem[];
    videoStream: VideoStreamInfo;
    audioStream: AudioStreamInfo | undefined;
    format: VideoFormat;
    colorDecision: EditedMasterColorDecision;
  }): Promise<boolean> {
    const plan = this.getVideoEditCommandPlan(config, edits, videoStream, audioStream, format, colorDecision);
    this.logVideoEditCommandPlan(assetId, plan);

    try {
      await this.mediaRepository.transcode(input, output, plan.command);
      return true;
    } catch (error: any) {
      const message = error?.message ?? error;
      this.logger.error(`Error occurred during video edit generation: ${message}`);

      if (plan.config.accel === TranscodeHardwareAcceleration.Disabled) {
        return false;
      }

      const fallbackPlan = this.getVideoEditSoftwareFallbackCommandPlan(
        config,
        edits,
        videoStream,
        audioStream,
        format,
        String(message),
        colorDecision,
      );
      this.logVideoEditCommandPlan(assetId, fallbackPlan);

      try {
        await this.mediaRepository.transcode(input, output, fallbackPlan.command);
        return true;
      } catch (error: any) {
        this.logger.error(`Error occurred during software video edit generation fallback: ${error?.message ?? error}`);
        return false;
      }
    }
  }

  /**
   * FL-39: renders one retained video version. The master is rendered from the version's own
   * original with the current media policy, validated by probing it, and a separate playback
   * proxy is transcoded from it — so master and proxy have independent paths and qualities.
   * Nothing is referenced until {@link AssetEditRepository.publishVideoVersion} accepts the result;
   * every file this render created is removed when it does not.
   */
  private async renderVideoVersion(
    version: VideoEditVersion,
    asset: VideoThumbnailAsset & { files: Array<{ path: string; type: AssetFileType; isEdited: boolean }> },
    config: SystemConfig,
  ): Promise<JobStatus> {
    const suffix = `${version.id}_${randomUUID()}`;
    const { dir, name } = path.parse(this.getEditedEncodedVideoPath(asset));
    const master = path.join(dir, `${name}.${suffix}.master.mp4`);
    const proxy = path.join(dir, `${name}.${suffix}.proxy.mp4`);
    const candidates: string[] = [];
    let published = false;
    try {
      // Bounds, orientation and audio come from the original this version was saved against,
      // never from the current (possibly edited) asset metadata.
      const original = await this.mediaRepository.probe(version.sourcePath);
      const videoStream = original.videoStreams[0];
      if (!videoStream) {
        throw new Error('Original video metadata is unavailable');
      }
      const audioStream = original.audioStreams[0];
      const source = { ...asset, videoStream, format: original.format };
      const edits = version.recipe;

      if (edits.length === 0 && version.purpose !== 'export') {
        const originalPreview = asset.files.find((file) => file.type === AssetFileType.Preview && !file.isEdited);
        published = await this.publishVideoVersion(version, {
          files: [],
          masterPath: null,
          thumbhash: originalPreview
            ? await this.mediaRepository.generateThumbhash(originalPreview.path, {
                colorspace: config.image.colorspace,
                processInvalidImages: process.env.IMMICH_PROCESS_INVALID_IMAGES === 'true',
              })
            : null,
          ...this.getVideoEditDimensions([], videoStream),
          duration: Math.round(original.format.duration * 1000),
        });
        return published ? JobStatus.Success : JobStatus.Skipped;
      }

      // FL-39: a master maps one audio track. Silently dropping the others is not an edit.
      if (original.audioStreams.length > 1) {
        throw new MediaPolicyError(
          MediaPolicyViolation.UnsupportedPreservation,
          'Edited masters with multiple audio tracks are not qualified; the original is preserved unchanged.',
        );
      }

      const colorDecision = this.qualifyEditedMasterRender({
        videoStream,
        config: config.ffmpeg,
        originalPath: version.sourcePath,
        sourcePath: version.sourcePath,
        outputPaths: [master, proxy],
        derivedPaths: asset.files.map((file) => file.path),
      });

      candidates.push(master, getEditedMasterLineagePath(master), proxy);
      this.storageCore.ensureFolders(master);
      const rendered = await this.transcodeEditedMaster({
        assetId: asset.id,
        input: version.sourcePath,
        output: master,
        config: config.ffmpeg,
        edits,
        videoStream,
        audioStream,
        format: original.format,
        colorDecision,
      });
      if (!rendered) {
        throw new Error('Edited master render failed');
      }

      // FL-39: probe the master before anything can reference it.
      const masterInfo = await this.mediaRepository.probe(master);
      const masterVideo = masterInfo.videoStreams[0];
      const dimensions = this.getVideoEditDimensions(edits, videoStream);
      const metadataRotation = qualifyMetadataOnlyRotation({
        edits,
        videoStream,
        audioStream,
        format: original.format,
      });
      validateVideoMaster({
        source: videoStream,
        output: masterVideo,
        dimensions,
        expectedRotation: metadataRotation?.displayRotation ?? 0,
        colorDecision,
        packetCopy: !!metadataRotation,
      });

      await this.writeEditedMasterLineage({
        masterPath: master,
        assetId: asset.id,
        originalPath: version.sourcePath,
        checksum: version.sourceChecksum,
        edits,
        colorDecision,
        decode: qualifySourceDecode(videoStream, config.ffmpeg),
      });

      // The playback proxy follows the playback policy. A packet-preserving master keeps its
      // rotation in the display matrix, which hardware decoders do not apply, so it is decoded in
      // software and auto-rotated into the proxy.
      await this.transcodePlaybackProxy(master, proxy, masterInfo, config.ffmpeg);
      const proxyInfo = await this.mediaRepository.probe(proxy);
      if (!proxyInfo.videoStreams[0]?.width || !proxyInfo.videoStreams[0]?.height) {
        throw new Error('Video version playback proxy is invalid');
      }

      const proxyFile = {
        assetId: version.assetId,
        type: AssetFileType.EncodedVideo,
        path: proxy,
        isEdited: true,
        isProgressive: false,
        isTransparent: false,
      };
      const duration = this.getVideoEditDurationMs(edits, original.format);

      if (version.purpose === 'export') {
        published = await this.publishVideoVersion(version, {
          masterPath: master,
          files: [proxyFile],
          ...dimensions,
          duration,
        });
        return published ? JobStatus.Success : JobStatus.Skipped;
      }

      const generated = await this.generateVideoThumbnails(
        { ...source, videoStream: masterVideo, format: masterInfo.format },
        config,
        { sourcePath: master, isEdited: true, fullsizeDimensions: dimensions, pathSuffix: suffix, candidates },
      );
      published = await this.publishVideoVersion(version, {
        masterPath: master,
        files: [proxyFile, ...generated.files],
        ...dimensions,
        duration,
        thumbhash: generated.thumbhash,
      });
      return published ? JobStatus.Success : JobStatus.Skipped;
    } catch (error: any) {
      this.logger.error(`Video version ${version.id} render failed for asset ${asset.id}: ${error?.message ?? error}`);
      await this.assetEditRepository.failVideoVersion(version.assetId, version.id);
      return JobStatus.Failed;
    } finally {
      if (!published) {
        await Promise.all(candidates.map((candidate) => this.storageRepository.unlink(candidate)));
      }
    }
  }

  /**
   * Publishes a rendered version and queues any edited files it released (a pre-history edit's
   * proxy, thumbnails and lineage) for deletion. FileDelete re-checks references under the path lock.
   */
  private async publishVideoVersion(
    version: VideoEditVersion,
    result: Parameters<AssetEditRepository['publishVideoVersion']>[1],
  ): Promise<boolean> {
    const { published, releasedPaths } = await this.assetEditRepository.publishVideoVersion(version, result);
    if (releasedPaths.length > 0) {
      await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: releasedPaths } });
    }
    return published;
  }

  private async transcodePlaybackProxy(input: string, output: string, master: VideoInfo, config: ConfigFFmpegDto) {
    const video = master.videoStreams[0];
    const proxyConfig = video.rotation === 0 ? config : { ...config, accelDecode: false };
    const command = BaseConfig.create(proxyConfig, this.videoInterfaces).getCommand(
      TranscodeTarget.All,
      video,
      master.audioStreams[0],
      master.format,
    );
    try {
      await this.mediaRepository.transcode(input, output, command);
    } catch (error: any) {
      if (proxyConfig.accel === TranscodeHardwareAcceleration.Disabled) {
        throw error;
      }
      this.logger.error(
        `Error occurred during playback proxy transcode, retrying in software: ${error?.message ?? error}`,
      );
      const software = BaseConfig.create(
        { ...proxyConfig, accel: TranscodeHardwareAcceleration.Disabled, accelDecode: false },
        this.videoInterfaces,
      ).getCommand(TranscodeTarget.All, video, master.audioStreams[0], master.format);
      await this.mediaRepository.transcode(input, output, software);
    }
  }

  private isVideoThumbnailFile(type: AssetFileType) {
    return [AssetFileType.Preview, AssetFileType.Thumbnail].includes(type);
  }

  private toExistingAssetFiles(
    files: Array<
      Pick<ExistingAssetFile, 'id' | 'path' | 'type' | 'isEdited'> &
        Partial<Pick<ExistingAssetFile, 'physicalFileId' | 'isProgressive' | 'isTransparent'>>
    >,
  ): ExistingAssetFile[] {
    return files.map(
      (file) =>
        ({
          ...file,
          isProgressive: file.isProgressive ?? false,
          isTransparent: file.isTransparent ?? false,
        }) as ExistingAssetFile,
    );
  }

  private getEditedEncodedVideoPath(asset: ThumbnailPathEntity) {
    const { dir, ext, name } = path.parse(StorageCore.getEncodedVideoPath(asset));
    return path.join(dir, `${name}_edited${ext}`);
  }

  /**
   * Writes the lineage sidecar that identifies an edited master (FL-39). A failure to write it is
   * logged and does not fail the job: the master itself is already on disk and the original is
   * untouched either way.
   */
  private async writeEditedMasterLineage({
    masterPath,
    assetId,
    originalPath,
    checksum,
    edits,
    colorDecision,
    decode,
  }: {
    masterPath: string;
    assetId: string;
    originalPath: string;
    checksum?: Buffer | null;
    edits: AssetEditActionItem[];
    colorDecision: EditedMasterColorDecision;
    /** FL-101: the source's decode qualification, recorded for video masters. */
    decode?: DecodeQualification;
  }) {
    const lineage = buildEditedMasterLineage({
      sourceAssetId: assetId,
      sourceOriginalPath: originalPath,
      sourceChecksum: checksum ? checksum.toString('base64') : null,
      edits,
      color: colorDecision,
      decode,
    });

    try {
      await this.storageRepository.createOrOverwriteFile(
        getEditedMasterLineagePath(masterPath),
        serializeEditedMasterLineage(lineage),
      );
    } catch (error: any) {
      this.logger.warn(`Failed to record edited-master lineage for asset ${assetId}: ${error?.message ?? error}`);
    }

    return lineage;
  }

  private getVideoEditCommandPlan(
    config: ConfigFFmpegDto,
    edits: AssetEditActionItem[],
    videoStream: VideoStreamInfo,
    audioStream: AudioStreamInfo | undefined,
    format: VideoFormat,
    colorDecision: EditedMasterColorDecision,
  ): VideoEditCommandPlan {
    const hasCpuVideoFilters = this.hasCpuVideoEditFilters(edits) || videoStream.rotation !== 0;
    // FL-101: a CPU filter graph forces software decoding, and so does a source the
    // fixed-function decoder cannot hand back faithfully. The qualification is recomputed from
    // the stream rather than passed in, so no caller of this helper can skip it.
    const decodeAcceleration = selectDecodeAcceleration(config, qualifySourceDecode(videoStream, config));
    const planConfig =
      config.accel === TranscodeHardwareAcceleration.Disabled || !hasCpuVideoFilters
        ? decodeAcceleration.config
        : { ...config, accelDecode: false };
    const mode =
      config.accel === TranscodeHardwareAcceleration.Disabled
        ? VideoEditAccelerationMode.Software
        : hasCpuVideoFilters
          ? VideoEditAccelerationMode.HybridHardwareEncode
          : VideoEditAccelerationMode.HardwareNative;

    return {
      command: this.getVideoEditCommand(planConfig, edits, videoStream, audioStream, format, colorDecision),
      config: planConfig,
      hasCpuVideoFilters,
      mode,
    };
  }

  private getVideoEditSoftwareFallbackCommandPlan(
    config: ConfigFFmpegDto,
    edits: AssetEditActionItem[],
    videoStream: VideoStreamInfo,
    audioStream: AudioStreamInfo | undefined,
    format: VideoFormat,
    fallbackReason: string,
    colorDecision: EditedMasterColorDecision,
  ): VideoEditCommandPlan {
    const fallbackConfig = {
      ...config,
      accel: TranscodeHardwareAcceleration.Disabled,
      accelDecode: false,
    };

    return {
      command: this.getVideoEditCommand(fallbackConfig, edits, videoStream, audioStream, format, colorDecision),
      config: fallbackConfig,
      hasCpuVideoFilters: this.hasCpuVideoEditFilters(edits),
      mode: VideoEditAccelerationMode.SoftwareFallback,
      fallbackReason,
    };
  }

  private logVideoEditCommandPlan(assetId: string, plan: VideoEditCommandPlan) {
    this.logger.debug(
      `Video edit acceleration plan: ${JSON.stringify({
        assetId,
        mode: plan.mode,
        accel: plan.config.accel,
        accelDecode: plan.config.accelDecode,
        hasCpuVideoFilters: plan.hasCpuVideoFilters,
        fallbackReason: plan.fallbackReason,
      })}`,
    );
  }

  private hasCpuVideoEditFilters(edits: AssetEditActionItem[]) {
    return edits.some((edit) => cpuVideoEditActions.has(edit.action));
  }

  private getVideoEditTimeline(edits: AssetEditActionItem[], format: VideoFormat): VideoEditTimeline {
    const trim = edits.find(isEditAction(AssetEditAction.Trim));
    const knownDurationMs = Math.round(format.duration * 1000);
    const lastSegmentEndMs = Math.max(
      0,
      ...edits.filter(isEditAction(AssetEditAction.Speed)).map((edit) => edit.parameters.endMs ?? 0),
    );
    const startMs = trim?.parameters.startMs ?? 0;
    const endMs = trim?.parameters.endMs ?? Math.max(knownDurationMs, lastSegmentEndMs);
    const globalSpeed = edits
      .filter(isEditAction(AssetEditAction.Speed))
      .find((edit) => edit.parameters.startMs === undefined && edit.parameters.endMs === undefined);
    const intervals =
      globalSpeed === undefined
        ? this.getSpeedIntervals(edits, startMs, endMs)
        : [{ startMs, endMs, rate: globalSpeed.parameters.rate }];

    return { startMs, endMs, intervals };
  }

  private getRenderedTimelineMs(timeMs: number, timeline: VideoEditTimeline) {
    let elapsedMs = 0;
    for (const interval of timeline.intervals) {
      if (timeMs <= interval.startMs) {
        return Math.round(elapsedMs);
      }

      if (timeMs <= interval.endMs) {
        return Math.round(elapsedMs + (timeMs - interval.startMs) / interval.rate);
      }

      elapsedMs += (interval.endMs - interval.startMs) / interval.rate;
    }

    return Math.round(elapsedMs);
  }

  private getVideoEditCommand(
    config: ConfigFFmpegDto,
    edits: AssetEditActionItem[],
    videoStream: VideoStreamInfo,
    audioStream: AudioStreamInfo | undefined,
    format: VideoFormat,
    colorDecision: EditedMasterColorDecision,
  ): TranscodeCommand {
    const videoFilters: string[] = [];
    const audioFilters: string[] = [];
    // FL-39: the general playback transcode settings describe a proxy. They must not cap the
    // edited master's resolution, quality target, bitrate or bit depth.
    const masterConfig = getEditedMasterFfmpegConfig(config, videoStream);
    const transcodeConfig = BaseConfig.create(masterConfig, this.videoInterfaces) as BaseConfig;

    // FL-39: a recipe that only turns the picture by a right angle needs no re-encode at all. When
    // it qualifies, every packet is preserved and the rotation lives in the container's display
    // matrix instead. This is a fidelity choice, never a change of what the edit means.
    const metadataRotation = qualifyMetadataOnlyRotation({ edits, videoStream, audioStream, format });
    if (metadataRotation) {
      return this.getMetadataOnlyRotationCommand(metadataRotation, videoStream, audioStream);
    }

    const inputOptions = [...transcodeConfig.getBaseInputOptions(videoStream, format)];
    let transcodeFilters = applyEditedMasterPixelFormatPolicy(
      transcodeConfig.getFilterOptions({
        ...videoStream,
        ...this.getVideoEditDimensions(edits, videoStream),
        rotation: 0,
      }),
      videoStream,
      colorDecision,
    );

    // FL-102: the render graph works in floating point, and the step back to integer planes is
    // stated rather than left to swscale's defaults — a named intermediate, an explicit colour
    // matrix and range, an explicit dither, and a pixel format chosen for *this* encoder.
    //
    // The conversion is inserted only for a preserving render on a software encoder. A
    // tone-mapped render already ends in `tonemapx=…:format=yuv420p`, which is the deliberate
    // reduction FL-39 chose; re-expanding that to float and quantising again would add dither
    // noise to a picture that is already 8-bit. A hardware render's own filter chain owns the
    // conversion and the device upload, so the plan there only names the surface format and
    // supplies the refusal. `-pix_fmt` is still stated on every software command.
    const qualification = qualifySourceDecode(videoStream, config);
    let encodePlan: EncoderPixelFormatPlan | null = null;
    if (qualification.layout && requiresFloatIntermediate(qualification.layout, qualification.transfer)) {
      encodePlan = selectEncoderPixelFormat({
        codec: masterConfig.targetVideoCodec,
        accel: masterConfig.accel,
        layout: qualification.layout,
        policy: colorDecision.policy,
        colorMatrix: videoStream.colorMatrix,
        range: getEditedMasterColorRange(videoStream, colorDecision),
      });
      if (colorDecision.policy === EditedMasterColorPolicy.Preserve) {
        transcodeFilters = applyFloatEncodePixelFormat(transcodeFilters, encodePlan);
      }
    }

    const trim = edits.find((edit) => edit.action === AssetEditAction.Trim);
    const speedEdits = edits.filter(isEditAction(AssetEditAction.Speed));
    const speedSegments = speedEdits.filter(
      (edit) => edit.parameters.startMs !== undefined && edit.parameters.endMs !== undefined,
    );
    const timeline = this.getVideoEditTimeline(edits, format);
    if (trim && speedSegments.length === 0) {
      inputOptions.push('-ss', this.msToSeconds(trim.parameters.startMs));
    }

    const globalSpeed = speedEdits.find(
      (edit) =>
        edit.parameters.startMs === undefined && edit.parameters.endMs === undefined && edit.parameters.rate !== 1,
    );
    if (globalSpeed) {
      videoFilters.push(`setpts=${this.roundFilterNumber(1 / globalSpeed.parameters.rate)}*PTS`);
      audioFilters.push(...this.getAudioTempoFilters(globalSpeed.parameters.rate));
    }

    const crop = edits.find((edit) => edit.action === AssetEditAction.Crop);
    if (crop) {
      const { x, y, width, height } = crop.parameters;
      videoFilters.push(`crop=${this.toEvenDimension(width)}:${this.toEvenDimension(height)}:${x}:${y}`);
    }

    const rotate = edits.find((edit) => edit.action === AssetEditAction.Rotate);
    if (rotate) {
      switch (rotate.parameters.angle) {
        case 90: {
          videoFilters.push('transpose=1');
          break;
        }
        case 180: {
          videoFilters.push('transpose=1', 'transpose=1');
          break;
        }
        case 270: {
          videoFilters.push('transpose=2');
          break;
        }
      }
    }

    const straighten = edits.find((edit) => edit.action === AssetEditAction.Straighten);
    if (straighten && straighten.parameters.angle !== 0) {
      videoFilters.push(`rotate=${this.roundFilterNumber(straighten.parameters.angle)}*PI/180:fillcolor=black`);
    }

    const mirrors = edits.filter((edit) => edit.action === AssetEditAction.Mirror);
    for (const mirror of mirrors) {
      videoFilters.push(mirror.parameters.axis === 'horizontal' ? 'hflip' : 'vflip');
    }

    if (edits.some((edit) => edit.action === AssetEditAction.Stabilize && edit.parameters.enabled)) {
      videoFilters.push('deshake');
    }

    if (edits.some((edit) => edit.action === AssetEditAction.AutoEnhance && edit.parameters.enabled)) {
      videoFilters.push('eq=contrast=1.08:saturation=1.08:gamma=1.02');
    }

    const adjust = edits.find((edit) => edit.action === AssetEditAction.Adjust);
    if (adjust) {
      videoFilters.push(...this.getAdjustmentFilters(adjust.parameters));
    }

    const looks = edits.filter(
      (edit) => edit.action === AssetEditAction.Filter || edit.action === AssetEditAction.Effect,
    );
    for (const look of looks) {
      const filter = this.getLookFilter(look.parameters.name, look.parameters.intensity);
      if (filter) {
        videoFilters.push(filter);
      }
    }

    const overlays = edits.filter((edit) => edit.action === AssetEditAction.TextOverlay);
    for (const overlay of overlays) {
      videoFilters.push(this.getTextOverlayFilter(overlay.parameters, timeline));
    }

    videoFilters.push(...transcodeFilters);

    const audioEdit = edits.find((edit) => edit.action === AssetEditAction.Audio);
    const muted = !!audioEdit?.parameters.muted;
    if (audioEdit?.parameters.volume !== undefined && !muted) {
      audioFilters.push(`volume=${this.roundFilterNumber(audioEdit.parameters.volume)}`);
    }

    let outputOptions = [
      ...transcodeConfig.getBaseOutputOptions(TranscodeTarget.All, videoStream, muted ? undefined : audioStream),
    ];

    // FL-16: the shared playback output options force a stereo downmix, which is acceptable for a
    // proxy and never for a master. Strip it, and stream-copy the source track when the recipe
    // leaves audio alone so the channel layout and sample rate survive exactly.
    const audioPolicy = applyEditedMasterAudioPolicy(outputOptions, {
      audioStream,
      hasAudioFilters: audioFilters.length > 0 || speedSegments.length > 0,
      muted,
    });

    if (speedSegments.length > 0) {
      const { filters, maps } = this.getSegmentedSpeedFilterGraph(
        timeline.intervals,
        videoStream,
        audioStream,
        muted,
        videoFilters,
        audioFilters,
      );
      outputOptions.push('-filter_complex', filters);
      outputOptions = this.replaceOutputMaps(outputOptions, maps);
    } else if (trim) {
      outputOptions.unshift('-t', this.msToSeconds(trim.parameters.endMs - trim.parameters.startMs));
    }

    if (speedSegments.length === 0 && videoFilters.length > 0) {
      outputOptions.push('-vf', videoFilters.join(','));
    }

    if (muted) {
      outputOptions.push('-an');
    } else if (speedSegments.length === 0 && audioFilters.length > 0) {
      outputOptions.push('-filter:a', audioFilters.join(','));
    }

    outputOptions.push(
      ...transcodeConfig.getPresetOptions(),
      ...transcodeConfig.getOutputThreadOptions(),
      ...transcodeConfig.getBitrateOptions(),
      ...audioPolicy.args,
      // FL-102: the encoder's input pixel format, stated on the command for a software encoder.
      ...(encodePlan?.args ?? []),
      // FL-16: rational timing and any variable-frame-rate mapping survive the render.
      ...getEditedMasterTimingArgs(videoStream),
      // FL-16: the master's colour intent is tagged explicitly, never inferred.
      ...getEditedMasterColorArgs(
        videoStream,
        colorDecision,
        colorDecision.policy === EditedMasterColorPolicy.Preserve ? (encodePlan?.statedRange ?? null) : null,
      ),
    );

    return {
      inputOptions,
      outputOptions,
      twoPass: false,
      progress: { frameCount: videoStream.frameCount, percentInterval: 10 },
    };
  }

  /**
   * The packet-preserving master for a qualified right-angle rotation (FL-39): the picture is not
   * decoded at all, so quality, timing, variable frame rate and audio are preserved exactly, and
   * the rotation is written into the container's display matrix.
   */
  private getMetadataOnlyRotationCommand(
    rotation: { angle: number; displayRotation: number },
    videoStream: VideoStreamInfo,
    audioStream: AudioStreamInfo | undefined,
  ): TranscodeCommand {
    const outputOptions = ['-c', 'copy', '-map', `0:${videoStream.index}`, '-map_metadata', '-1'];
    if (audioStream) {
      outputOptions.push('-map', `0:${audioStream.index}`);
    }
    outputOptions.push('-movflags', 'faststart');

    return {
      // `-display_rotation` is an input option: it replaces the stream's display matrix and turns
      // off the decoder's auto-rotation, so the packets are copied through untouched.
      inputOptions: ['-display_rotation', String(rotation.displayRotation)],
      outputOptions,
      twoPass: false,
      progress: { frameCount: videoStream.frameCount, percentInterval: 10 },
    };
  }

  private getSegmentedSpeedFilterGraph(
    intervals: SpeedInterval[],
    videoStream: VideoStreamInfo,
    audioStream: AudioStreamInfo | undefined,
    muted: boolean,
    videoFilters: string[],
    audioFilters: string[],
  ) {
    const filters: string[] = [];
    const hasAudio = !!audioStream && !muted;

    for (const [index, interval] of intervals.entries()) {
      const start = this.msToSeconds(interval.startMs);
      const end = this.msToSeconds(interval.endMs);
      filters.push(
        `[0:${videoStream.index}]trim=start=${start}:end=${end},setpts=${this.roundFilterNumber(1 / interval.rate)}*(PTS-STARTPTS)[v${index}]`,
      );

      if (hasAudio) {
        const tempoFilters = interval.rate === 1 ? [] : this.getAudioTempoFilters(interval.rate);
        filters.push(
          `[0:${audioStream.index}]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS${tempoFilters.length > 0 ? `,${tempoFilters.join(',')}` : ''}[a${index}]`,
        );
      }
    }

    if (hasAudio) {
      const concatInput = intervals.map((_, index) => `[v${index}][a${index}]`).join('');
      const concatVideoLabel = videoFilters.length > 0 ? 'vconcat' : 'vout';
      const concatAudioLabel = audioFilters.length > 0 ? 'aconcat' : 'aout';
      filters.push(`${concatInput}concat=n=${intervals.length}:v=1:a=1[${concatVideoLabel}][${concatAudioLabel}]`);

      if (videoFilters.length > 0) {
        filters.push(`[${concatVideoLabel}]${videoFilters.join(',')}[vout]`);
      }
      if (audioFilters.length > 0) {
        filters.push(`[${concatAudioLabel}]${audioFilters.join(',')}[aout]`);
      }

      return { filters: filters.join(';'), maps: ['[vout]', '[aout]'] };
    }

    const concatInput = intervals.map((_, index) => `[v${index}]`).join('');
    const concatVideoLabel = videoFilters.length > 0 ? 'vconcat' : 'vout';
    filters.push(`${concatInput}concat=n=${intervals.length}:v=1:a=0[${concatVideoLabel}]`);
    if (videoFilters.length > 0) {
      filters.push(`[${concatVideoLabel}]${videoFilters.join(',')}[vout]`);
    }

    return { filters: filters.join(';'), maps: ['[vout]'] };
  }

  private getSpeedIntervals(edits: AssetEditActionItem[], startMs: number, endMs: number): SpeedInterval[] {
    const speedSegments = edits
      .filter(isEditAction(AssetEditAction.Speed))
      .filter((edit) => edit.parameters.startMs !== undefined && edit.parameters.endMs !== undefined)
      .sort((a, b) => a.parameters.startMs! - b.parameters.startMs!);

    const intervals: SpeedInterval[] = [];
    let cursorMs = startMs;
    for (const segment of speedSegments) {
      const segmentStartMs = clamp(segment.parameters.startMs!, startMs, endMs);
      const segmentEndMs = clamp(segment.parameters.endMs!, startMs, endMs);
      if (segmentEndMs <= segmentStartMs) {
        continue;
      }

      if (segmentStartMs > cursorMs) {
        intervals.push({ startMs: cursorMs, endMs: segmentStartMs, rate: 1 });
      }

      intervals.push({ startMs: segmentStartMs, endMs: segmentEndMs, rate: segment.parameters.rate });
      cursorMs = segmentEndMs;
    }

    if (cursorMs < endMs) {
      intervals.push({ startMs: cursorMs, endMs, rate: 1 });
    }

    return intervals;
  }

  private replaceOutputMaps(outputOptions: string[], maps: string[]) {
    const filteredOptions: string[] = [];
    for (let index = 0; index < outputOptions.length; index++) {
      if (outputOptions[index] === '-map') {
        index++;
        continue;
      }

      filteredOptions.push(outputOptions[index]);
    }

    return [...filteredOptions, ...maps.flatMap((map) => ['-map', map])];
  }

  private getAdjustmentFilters(adjust: Extract<AssetEditActionItem, { action: AssetEditAction.Adjust }>['parameters']) {
    const filters: string[] = [];
    const eqOptions: string[] = [];

    if (adjust.brightness) {
      eqOptions.push(`brightness=${this.roundFilterNumber(adjust.brightness / 100)}`);
    }
    if (adjust.contrast) {
      eqOptions.push(`contrast=${this.roundFilterNumber(1 + adjust.contrast / 100)}`);
    }
    if (adjust.saturation) {
      eqOptions.push(`saturation=${this.roundFilterNumber(1 + adjust.saturation / 100)}`);
    }
    if (adjust.highlights || adjust.shadows || adjust.whitePoint || adjust.blackPoint || adjust.hdr) {
      const gamma =
        1 +
        ((adjust.shadows ?? 0) -
          (adjust.highlights ?? 0) +
          (adjust.hdr ?? 0) +
          (adjust.blackPoint ?? 0) -
          (adjust.whitePoint ?? 0)) /
          500;
      eqOptions.push(`gamma=${this.roundFilterNumber(gamma)}`);
    }
    if (eqOptions.length > 0) {
      filters.push(`eq=${eqOptions.join(':')}`);
    }

    const warmth = adjust.warmth ?? 0;
    const tint = adjust.tint ?? 0;
    const skinTone = adjust.skinTone ?? 0;
    const blueTone = adjust.blueTone ?? 0;
    if (warmth || tint || skinTone || blueTone) {
      filters.push(
        `colorbalance=rm=${this.roundFilterNumber((warmth + skinTone) / 350)}:gm=${this.roundFilterNumber(tint / 350)}:bm=${this.roundFilterNumber((blueTone - warmth) / 350)}`,
      );
    }

    if (adjust.vignette) {
      filters.push(`vignette=angle=${this.roundFilterNumber((Math.PI / 4) * (Math.abs(adjust.vignette) / 100))}`);
    }

    return filters;
  }

  private getLookFilter(name: string, intensity = 100) {
    const amount = clamp(intensity / 100, 0, 1);
    switch (name.trim().toLowerCase()) {
      case 'vivid': {
        return `eq=saturation=${this.roundFilterNumber(1 + 0.3 * amount)}:contrast=${this.roundFilterNumber(1 + 0.12 * amount)}`;
      }
      case 'warm': {
        return `colorbalance=rm=${this.roundFilterNumber(0.12 * amount)}:bm=${this.roundFilterNumber(-0.1 * amount)}`;
      }
      case 'cool': {
        return `colorbalance=rm=${this.roundFilterNumber(-0.08 * amount)}:bm=${this.roundFilterNumber(0.12 * amount)}`;
      }
      case 'black_white':
      case 'black-and-white':
      case 'black and white':
      case 'bw': {
        return 'hue=s=0';
      }
      case 'fade': {
        return `eq=contrast=${this.roundFilterNumber(1 - 0.18 * amount)}:saturation=${this.roundFilterNumber(1 - 0.25 * amount)}`;
      }
      case 'vignette': {
        return `vignette=angle=${this.roundFilterNumber((Math.PI / 4) * amount)}`;
      }
      default: {
        return null;
      }
    }
  }

  private getTextOverlayFilter(
    parameters: Extract<AssetEditActionItem, { action: AssetEditAction.TextOverlay }>['parameters'],
    timeline: VideoEditTimeline,
  ) {
    const color = parameters.color.replace('#', '0x');
    const escapedComma = `${String.fromCodePoint(92)},`;
    const startMs =
      parameters.startMs === undefined ? undefined : this.getRenderedTimelineMs(parameters.startMs, timeline);
    const endMs = parameters.endMs === undefined ? undefined : this.getRenderedTimelineMs(parameters.endMs, timeline);
    const enable =
      startMs !== undefined && endMs !== undefined
        ? `:enable='between(t${escapedComma}${this.msToSeconds(startMs)}${escapedComma}${this.msToSeconds(endMs)})'`
        : '';
    return `drawtext=text='${this.escapeFfmpegText(parameters.text)}':x=w*${this.roundFilterNumber(parameters.x)}:y=h*${this.roundFilterNumber(parameters.y)}:fontsize=h*${this.roundFilterNumber(parameters.size)}:fontcolor=${color}${enable}`;
  }

  private getVideoEditDimensions(edits: AssetEditActionItem[], videoStream: VideoStreamInfo): ImageDimensions {
    let width = videoStream.width;
    let height = videoStream.height;

    if (Math.abs(videoStream.rotation) === 90) {
      [width, height] = [height, width];
    }

    const crop = edits.find((edit) => edit.action === AssetEditAction.Crop);
    if (crop) {
      width = this.toEvenDimension(crop.parameters.width);
      height = this.toEvenDimension(crop.parameters.height);
    }

    const rotate = edits.find((edit) => edit.action === AssetEditAction.Rotate);
    if (rotate && [90, 270].includes(rotate.parameters.angle)) {
      [width, height] = [height, width];
    }

    return { width, height };
  }

  private getVideoEditDurationMs(edits: AssetEditActionItem[], format: VideoFormat) {
    const timeline = this.getVideoEditTimeline(edits, format);
    return Math.round(
      timeline.intervals.reduce((durationMs, interval) => {
        return durationMs + (interval.endMs - interval.startMs) / interval.rate;
      }, 0),
    );
  }

  private getAudioTempoFilters(rate: number) {
    const filters: string[] = [];
    let remaining = rate;
    while (remaining < 0.5) {
      filters.push('atempo=0.5');
      remaining /= 0.5;
    }
    while (remaining > 2) {
      filters.push('atempo=2');
      remaining /= 2;
    }
    filters.push(`atempo=${this.roundFilterNumber(remaining)}`);
    return filters;
  }

  private escapeFfmpegText(value: string) {
    const escape = String.fromCodePoint(92);
    return value
      .replaceAll(escape, () => escape + escape)
      .replaceAll(':', () => `${escape}:`)
      .replaceAll("'", () => `${escape}'`)
      .replaceAll(',', () => `${escape},`);
  }

  /**
   * FL-93: a filter's time argument is produced by an exact decimal expansion of the
   * millisecond value rather than by `toFixed` on a float division. For whole milliseconds the
   * two agree exactly, so no existing command changes; what it buys is that a boundary derived
   * from a cadence — a speed segment, a trim snapped to a frame — is rounded once, by the
   * pinned half-away-from-zero rule, instead of inheriting whatever the float landed on. A
   * fractional input is taken to microsecond precision, which is finer than any time base the
   * fork encodes to.
   */
  private msToSeconds(milliseconds: number) {
    return toDisplaySeconds(rational(Math.round(milliseconds * 1000), 1_000_000), FILTER_DECIMAL_PLACES);
  }

  private roundFilterNumber(value: number) {
    return Number(value.toFixed(FILTER_DECIMAL_PLACES)).toString();
  }

  private toEvenDimension(value: number) {
    return Math.max(2, value - (value % 2));
  }

  private getTranscodeTarget(
    config: ConfigFFmpegDto,
    videoStream: VideoStreamInfo,
    audioStream?: AudioStreamInfo,
  ): TranscodeTarget {
    const isAudioTranscodeRequired = this.isAudioTranscodeRequired(config, audioStream);
    const isVideoTranscodeRequired = this.isVideoTranscodeRequired(config, videoStream);

    if (isAudioTranscodeRequired && isVideoTranscodeRequired) {
      return TranscodeTarget.All;
    }

    if (isAudioTranscodeRequired) {
      return TranscodeTarget.Audio;
    }

    if (isVideoTranscodeRequired) {
      return TranscodeTarget.Video;
    }

    return TranscodeTarget.None;
  }

  private isAudioTranscodeRequired(ffmpegConfig: ConfigFFmpegDto, stream?: AudioStreamInfo): boolean {
    if (!stream) {
      return false;
    }

    switch (ffmpegConfig.transcode) {
      case TranscodePolicy.Disabled: {
        return false;
      }
      case TranscodePolicy.All: {
        return true;
      }
      case TranscodePolicy.Required:
      case TranscodePolicy.Optimal:
      case TranscodePolicy.Bitrate: {
        return !ffmpegConfig.acceptedAudioCodecs.includes(stream.codecName as AudioCodec);
      }
      default: {
        throw new Error(`Unsupported transcode policy: ${ffmpegConfig.transcode}`);
      }
    }
  }

  private isVideoTranscodeRequired(ffmpegConfig: ConfigFFmpegDto, stream: VideoStreamInfo): boolean {
    const isScalingEnabled = ffmpegConfig.targetResolution !== 'original';
    const targetRes = Number.parseInt(ffmpegConfig.targetResolution);
    const isLargerThanTargetRes = isScalingEnabled && Math.min(stream.height, stream.width) > targetRes;
    const maxBitrate = this.parseBitrateToBps(ffmpegConfig.maxBitrate);
    const isLargerThanTargetBitrate = maxBitrate > 0 && stream.bitrate > maxBitrate;

    const isTargetVideoCodec = ffmpegConfig.acceptedVideoCodecs.includes(stream.codecName as VideoCodec);
    const isRequired = !isTargetVideoCodec || !stream.pixelFormat.endsWith('420p');

    switch (ffmpegConfig.transcode) {
      case TranscodePolicy.Disabled: {
        return false;
      }
      case TranscodePolicy.All: {
        return true;
      }
      case TranscodePolicy.Required: {
        return isRequired;
      }
      case TranscodePolicy.Optimal: {
        return isRequired || isLargerThanTargetRes;
      }
      case TranscodePolicy.Bitrate: {
        return isRequired || isLargerThanTargetBitrate;
      }
      default: {
        throw new Error(`Unsupported transcode policy: ${ffmpegConfig.transcode}`);
      }
    }
  }

  private isRemuxRequired(ffmpegConfig: ConfigFFmpegDto, { formatName, formatLongName }: VideoFormat): boolean {
    if (ffmpegConfig.transcode === TranscodePolicy.Disabled) {
      return false;
    }

    const formatLongNameMapping: Record<string, VideoContainer> = {
      'QuickTime / MOV': VideoContainer.Mov,
      'Matroska / WebM': VideoContainer.Webm,
    };

    const name = (formatLongName ? formatLongNameMapping[formatLongName] : undefined) ?? (formatName as VideoContainer);

    return name !== VideoContainer.Mp4 && !ffmpegConfig.acceptedContainers.includes(name);
  }

  isSRGB({
    colorspace,
    profileDescription,
    bitsPerSample,
  }: {
    colorspace: string | null;
    profileDescription: string | null;
    bitsPerSample: number | null;
  }): boolean {
    if (colorspace || profileDescription) {
      return [colorspace, profileDescription].some((s) => s?.toLowerCase().includes('srgb'));
    }
    if (bitsPerSample) {
      // assume sRGB for 8-bit images with no color profile or colorspace metadata
      return bitsPerSample === 8;
    }
    // assume sRGB for images with no relevant metadata
    return true;
  }

  private parseBitrateToBps(bitrateString: string) {
    const bitrateValue = Number.parseInt(bitrateString);

    if (Number.isNaN(bitrateValue)) {
      this.logger.log(`Maximum bitrate '${bitrateString} is not a number and will be ignored.`);
      return 0;
    }

    if (bitrateString.toLowerCase().endsWith('k')) {
      return bitrateValue * 1000; // Kilobits per second to bits per second
    }
    if (bitrateString.toLowerCase().endsWith('m')) {
      return bitrateValue * 1_000_000; // Megabits per second to bits per second
    }
    return bitrateValue;
  }

  private async shouldUseExtractedImage(extractedPathOrBuffer: string | Buffer, targetSize: number) {
    const { width, height } = await this.mediaRepository.getImageMetadata(extractedPathOrBuffer);
    const extractedSize = Math.min(width, height);
    return extractedSize >= targetSize;
  }

  private async syncFiles(oldFiles: ExistingAssetFile[], newFiles: UpsertFileOptions[]) {
    const toUpsert: UpsertFileOptions[] = [];
    const pathsToDelete: string[] = [];
    const toDelete = new Set(oldFiles);

    for (const inputFile of newFiles) {
      const { file: newFile, pathToDelete } = await this.applyPhysicalDeduplicationToGeneratedFile(inputFile);
      if (pathToDelete) {
        pathsToDelete.push(pathToDelete);
      }
      const existingFile = oldFiles.find((file) => file.type === newFile.type && file.isEdited === newFile.isEdited);
      if (existingFile) {
        toDelete.delete(existingFile);
      }

      // upsert new file path
      if (
        existingFile?.path !== newFile.path ||
        existingFile.isProgressive !== newFile.isProgressive ||
        existingFile.isTransparent !== newFile.isTransparent
      ) {
        toUpsert.push(newFile);

        // delete old file from disk
        if (existingFile && existingFile.path !== newFile.path) {
          this.logger.debug(
            `Deleting old ${newFile.type} image for asset ${newFile.assetId} in favor of a replacement`,
          );
          pathsToDelete.push(existingFile.path);
        }
      }
    }

    if (toUpsert.length > 0) {
      await this.assetRepository.upsertFiles(toUpsert);
    }

    if (toDelete.size > 0) {
      const toDeleteArray = [...toDelete];
      for (const file of toDeleteArray) {
        pathsToDelete.push(file.path);
      }
      await this.assetRepository.deleteFiles(toDeleteArray);
    }

    if (pathsToDelete.length > 0) {
      await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: pathsToDelete } });
    }
  }

  private async applyPhysicalDeduplicationToGeneratedFile(
    file: UpsertFileOptions,
  ): Promise<{ file: UpsertFileOptions; pathToDelete?: string }> {
    if (file.isEdited || !this.isPhysicalDeduplicationGeneratedFile(file.type)) {
      return { file };
    }

    const { physicalDeduplication } = await this.getConfig({ withCache: true });
    if (!physicalDeduplication.enabled) {
      return { file };
    }

    const canonical = await this.physicalFileRepository.getCanonicalGeneratedFile(file.assetId, file.type);
    if (canonical) {
      return {
        file: { ...file, path: canonical.path, physicalFileId: canonical.id },
        pathToDelete: file.path === canonical.path ? undefined : file.path,
      };
    }

    const originalPhysical = await this.physicalFileRepository.getOriginalPhysicalFile(file.assetId);
    if (originalPhysical?.canonicalAssetId !== file.assetId) {
      return { file };
    }

    const stat = await this.storageRepository.stat(file.path);
    const physicalFile = await this.physicalFileRepository.upsertPhysicalFile({
      canonicalAssetId: file.assetId,
      checksum: await this.cryptoRepository.hashFile(file.path),
      path: file.path,
      sizeInBytes: stat.size,
      type: this.toPhysicalFileType(file.type),
    });

    return { file: { ...file, physicalFileId: physicalFile.id } };
  }

  private isPhysicalDeduplicationGeneratedFile(type: AssetFileType) {
    return [
      AssetFileType.Thumbnail,
      AssetFileType.Preview,
      AssetFileType.FullSize,
      AssetFileType.EncodedVideo,
    ].includes(type);
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
        throw new Error(`Unsupported physical file type: ${type}`);
      }
    }
  }

  private async generateEditedThumbnails(asset: ThumbnailAsset, config: SystemConfig) {
    if (asset.type !== AssetType.Image || (asset.files.length === 0 && asset.edits.length === 0)) {
      return;
    }

    const generated = asset.edits.length > 0 ? await this.generateImageThumbnails(asset, config, true) : undefined;

    // FL-39: a still edited master records the same lineage as a video one. The highest-fidelity
    // edited output is the master; the smaller renditions beside it are replaceable previews.
    const editedMaster =
      generated?.files.find((file) => file.isEdited && file.type === AssetFileType.FullSize) ??
      generated?.files.find((file) => file.isEdited && file.type === AssetFileType.Preview);
    if (editedMaster) {
      await this.writeEditedMasterLineage({
        masterPath: editedMaster.path,
        assetId: asset.id,
        originalPath: asset.originalPath,
        checksum: asset.checksum,
        edits: asset.edits,
        colorDecision: {
          policy: EditedMasterColorPolicy.Preserve,
          reason: `Still develop recipe rendered from the original into ${config.image.fullsize.format}.`,
        },
      });
    }

    const crop = asset.edits.find((e) => e.action === AssetEditAction.Crop);
    const cropBox = crop
      ? {
          x1: crop.parameters.x,
          y1: crop.parameters.y,
          x2: crop.parameters.x + crop.parameters.width,
          y2: crop.parameters.y + crop.parameters.height,
        }
      : undefined;

    const originalDimensions = getDimensions(asset.exifInfo!);
    const assetFaces = await this.personRepository.getFaces(asset.id, { viewingUserId: asset.ownerId });
    const ocrData = await this.ocrRepository.getByAssetId(asset.id, {});

    const faceStatuses = checkFaceVisibility(assetFaces, originalDimensions, cropBox);
    await this.personRepository.updateVisibility(faceStatuses.visible, faceStatuses.hidden);

    const ocrStatuses = checkOcrVisibility(ocrData, originalDimensions, cropBox);
    await this.ocrRepository.updateOcrVisibilities(asset.id, ocrStatuses.visible, ocrStatuses.hidden);

    return generated;
  }

  private warnOnTransparencyLoss(isTransparent: boolean, format: ImageFormat, assetId: string) {
    if (isTransparent && format === ImageFormat.Jpeg) {
      this.logger.warn(
        `Asset ${assetId} has transparency but the configured format is ${format} which does not support it, consider using a format that does, such as ${ImageFormat.Webp}`,
      );
    }
  }

  private getImageFile(
    asset: ThumbnailPathEntity,
    options: ImagePathOptions & { isProgressive: boolean; isTransparent: boolean },
  ) {
    const path = StorageCore.getImagePath(asset, options);
    return {
      assetId: asset.id,
      type: options.fileType,
      path,
      isEdited: options.isEdited,
      isProgressive: options.isProgressive,
      isTransparent: options.isTransparent,
    };
  }
}
