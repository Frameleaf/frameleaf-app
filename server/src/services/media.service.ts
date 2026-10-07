import { BadRequestException, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ThumbnailOutput } from 'src/queue/sharp-operations.js';
import type { AssetEditRepository, VideoEditVersion } from 'src/repositories/asset-edit.repository.js';
import type { BoundingBox } from 'src/repositories/machine-learning.repository.js';
import type {
  AudioStreamInfo,
  DecodeToBufferOptions,
  GenerateThumbnailOptions,
  ImageDimensions,
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
import {
  AssetEditAction,
  AssetEditActionItem,
  CropParameters,
  TextOverlayPosition,
  VideoAdjustModel,
} from 'src/dtos/editing.dto.js';
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
import {
  afterJobCommit,
  attemptOutputPath,
  deferJobAdoption,
  jobSignal,
  publishJobDiagnostic,
  publishJobResult,
  queueExecution,
} from 'src/queue/context.js';
import { SharpOperationError } from 'src/queue/sharp-pool.js';
import { assertPublicationSource } from 'src/queue/transaction.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { lockFilePath } from 'src/repositories/physical-file.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { getAssetFile, getDimensions } from 'src/utils/asset.util.js';
import { straightenScale } from 'src/utils/develop-recipe.js';
import { EditOperationRun, EditOperationTracker } from 'src/utils/edit-operation-tracker.js';
import { checkFaceVisibility, checkOcrVisibility } from 'src/utils/editor.js';
import { readAliasedEnv } from 'src/utils/env-aliases.js';
import { executionSignal } from 'src/utils/execution-signal.js';
import { HDR_RENDITION_RENDERER_VERSION, imageRenditionIdentity } from 'src/utils/image-rendition.js';
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
  qualifyStreamCopyTrim,
  resolveEditedMasterColorPolicy,
  serializeEditedMasterLineage,
  validateAudioMaster,
  validateFullClipMasterTiming,
  validateVideoMaster,
} from 'src/utils/media-policy.js';
import { BaseConfig, ThumbnailConfig } from 'src/utils/media.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { batched, clamp } from 'src/utils/misc.js';
import { rational, toDisplaySeconds } from 'src/utils/rational-time.js';
import { RawRenderError, renderRawWithLibRaw } from 'src/utils/raw-renderer.js';
import { getStudioHdrProxyCommand, planStudioHdrProxy } from 'src/utils/studio-hdr-proxy.js';
import { getOutputDimensions } from 'src/utils/transform.js';
import { videoDevelopFilters } from 'src/utils/video-develop.js';

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
  renditionIdentity?: string | null;
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
    const selected = this.assetJobRepository.selectionForThumbnailJob({ force, fullsizeEnabled: isFullsizeEnabled });
    await this.jobRepository.queueSelection(
      JobName.AssetGenerateThumbnails,
      force ? selected : selected.where('asset.isEdited', '=', false),
    );
    await this.jobRepository.queueSelection(
      JobName.AssetEditThumbnailGeneration,
      selected.where('asset.isEdited', '=', true),
    );

    await this.jobRepository.queueSelection(
      JobName.PersonGenerateThumbnail,
      this.personRepository.selectionForThumbnails(!!force),
    );
    await this.jobRepository.collectFollowups(() =>
      this.jobRepository.queue({ name: JobName.ProfileImageRepair, data: {} }),
    );

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.ProfileImageRepair, queue: QueueName.ThumbnailGeneration })
  async handleProfileImageRepair(): Promise<JobStatus> {
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

  /** The generated file types this asset shares with a different primary asset (or one awaiting handover). */
  private async getSharedGeneratedFileTypes(asset: { id: string; files: AssetFile[] }): Promise<Set<AssetFileType>> {
    const shared = new Set<AssetFileType>();
    for (const file of asset.files ?? []) {
      if (file.isEdited) {
        continue;
      }
      if (!file.physicalFileId) {
        // no physical file yet (pre-upgrade, or a partner copy of such an asset that shares its path):
        // the file belongs to the oldest asset naming the path, never to a later copy
        const primaryAssetId = await this.physicalFileRepository.getGeneratedPathPrimaryAssetId(file.path);
        if (primaryAssetId && primaryAssetId !== asset.id) {
          shared.add(file.type);
        }
        continue;
      }
      const physicalFile = await this.physicalFileRepository.getPhysicalFile(file.physicalFileId);
      if (physicalFile && physicalFile.canonicalAssetId !== asset.id) {
        shared.add(file.type);
      }
    }
    return shared;
  }

  @OnJob({ name: JobName.AssetFileMigration, queue: QueueName.Migration })
  async handleAssetMigration({ id }: JobOf<JobName.AssetFileMigration>): Promise<JobStatus> {
    const { image } = await this.getConfig({ withCache: true });
    const asset = await this.assetJobRepository.getForMigrationJob(id);
    if (!asset) {
      return JobStatus.Failed;
    }

    // universal storage: a generated file shared with other assets lives where its primary asset put
    // it; only the primary moves it, so another owner's job never pulls it into their own folder
    const shared = await this.getSharedGeneratedFileTypes(asset);
    for (const [type, format] of [
      [AssetFileType.FullSize, image.fullsize.format],
      [AssetFileType.Preview, image.preview.format],
      [AssetFileType.HdrPreview, ImageFormat.Jpeg],
      [AssetFileType.HdrFullSize, ImageFormat.Jpeg],
      [AssetFileType.Thumbnail, image.thumbnail.format],
    ] as const) {
      if (!shared.has(type)) {
        await this.storageCore.moveAssetImage(asset, type, format);
      }
    }
    if (!shared.has(AssetFileType.EncodedVideo)) {
      await this.storageCore.moveAssetVideo(asset);
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetEditThumbnailGeneration, queue: QueueName.Editor })
  async handleAssetEditThumbnailGeneration({
    id,
    operationId,
  }: JobOf<JobName.AssetEditThumbnailGeneration>): Promise<JobStatus> {
    // FL-43: a saved edit's render runs under its Activity job, when it was queued with one.
    return this.editOperations.execute(operationId, (run) => this.renderEditThumbnails(id, run));
  }

  private editTracker?: EditOperationTracker;

  private get editOperations() {
    return (this.editTracker ??= new EditOperationTracker(
      this.mediaOperationRepository,
      this.jobRepository,
      this.logger,
    ));
  }

  private async renderEditThumbnails(id: string, run?: EditOperationRun): Promise<JobStatus> {
    await this.jobRepository.guardAssetSource(id);
    const asset = await this.assetJobRepository.getForGenerateThumbnailJob(id);
    const config = await this.getConfig({ withCache: true });

    if (!asset) {
      this.logger.warn(`Thumbnail generation failed for asset ${id}: not found in database or missing metadata`);
      return JobStatus.Failed;
    }

    const generated = await this.generateEditedThumbnails(asset, config, run);
    // FL-43: the asset's files change only under the job's claim; a stale or cancelled run stops here.
    if (run && !(await run.validate())) {
      return JobStatus.Skipped;
    }
    await this.syncFiles(
      asset.files.filter((file) => file.isEdited),
      generated?.files ?? [],
    );

    let thumbhash: Buffer | undefined = generated?.thumbhash;
    if (!thumbhash) {
      thumbhash = (await this.extractOriginalImage(asset, config.image)).thumbhash;
    }

    if (
      (!asset.thumbhash || Buffer.compare(asset.thumbhash, thumbhash) !== 0) &&
      !deferJobAdoption(async (tx) => {
        await sql`update asset set thumbhash = ${thumbhash} where id = ${asset.id}::uuid`.execute(tx);
      })
    ) {
      await this.assetRepository.update({ id: asset.id, thumbhash });
    }

    const fullsizeDimensions = generated?.fullsizeDimensions ?? getDimensions(asset.exifInfo!);
    await publishJobResult(() => this.assetRepository.update({ id: asset.id, ...fullsizeDimensions }).then(() => {}));

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

    deferJobAdoption(async () => {
      await assertPublicationSource(asset.id, asset.checksum);
      const current = await this.assetJobRepository.getForGenerateThumbnailJob(asset.id);
      if (
        !current ||
        current.originalPath !== asset.originalPath ||
        current.coverTimestampMs !== asset.coverTimestampMs ||
        JSON.stringify(current.edits) !== JSON.stringify(asset.edits)
      ) {
        throw new Error('Thumbnail source changed before publication');
      }
    });

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
        // FL-59: a cover the owner chose from the video's moments is where its thumbnail is cut.
        { coverSeconds: typeof asset.coverTimestampMs === 'number' ? asset.coverTimestampMs / 1000 : undefined },
      );
    } else if (asset.type === AssetType.Image) {
      this.logger.verbose(`Thumbnail generation for image ${id} ${asset.originalPath}`);
      try {
        generated = await this.generateImageThumbnails(asset, config);
      } catch (error) {
        executionSignal()?.throwIfAborted();
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
      await publishJobResult(async () => {
        await this.assetRepository.update({ id: asset.id, thumbhash });
      });
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

  private async renderRawImage(originalPath: string) {
    const signal = executionSignal();
    signal?.throwIfAborted();
    return { buffer: await renderRawWithLibRaw(originalPath, signal), format: RawExtractedFormat.Tiff };
  }

  private shouldSkipThumbnailDecodeError(error: unknown, fileName: string) {
    if (error instanceof RawRenderError) {
      return error.reason === 'unsupported';
    }
    if (!(error instanceof SharpOperationError)) {
      return false;
    }
    const message = error.message;
    return (
      isUnsupportedRawDecodeError(error) ||
      (mimeTypes.isRaw(fileName) &&
        (message.includes('dcraw_emu') ||
          message.includes('Command failed') ||
          message.includes('ENOENT') ||
          message.includes('unsupported RAW')))
    );
  }

  private async extractOriginalImage(
    asset: ThumbnailAsset,
    image: SystemConfig['image'],
    useEdits = false,
    outputs?: Record<'thumbnail' | 'preview' | 'fullsize', ThumbnailOutput>,
    sdrBase?: string,
  ) {
    // PSD is in the legacy RAW extension list, but is a layered image, not sensor data.
    const isRaw = mimeTypes.isRaw(asset.originalFileName) && !asset.originalFileName.toLowerCase().endsWith('.psd');
    const generateFullsize =
      !!sdrBase ||
      (mimeTypes.isWebSupportedImage(asset.originalPath) && asset.exifInfo.imageEncoding?.dynamicRange !== 'sdr') ||
      ((image.fullsize.enabled || asset.exifInfo.projectionType === 'EQUIRECTANGULAR') &&
        !mimeTypes.isWebSupportedImage(asset.originalPath)) ||
      useEdits;
    // Embedded camera images are fast previews only. Fullsize and edit input always comes from the sensor.
    let extracted =
      isRaw && image.extractEmbedded && !generateFullsize
        ? await this.extractImage(asset.originalPath, image.preview.size).catch((error: unknown) => {
            executionSignal()?.throwIfAborted();
            if (!(error instanceof SharpOperationError)) {
              throw error;
            }
            return null;
          })
        : null;
    let sensorRendered = false;
    if (isRaw && !extracted) {
      extracted = await this.renderRawImage(asset.originalPath);
      sensorRendered = true;
    }

    const colorspace = this.isSRGB(asset.exifInfo) ? Colorspace.Srgb : image.colorspace;
    const decodeSource = () => {
      const convertFullsize = generateFullsize && (!extracted || sensorRendered);
      const decodeOptions: DecodeToBufferOptions = {
        colorspace,
        processInvalidImages: readAliasedEnv('FRAMELEAF_PROCESS_INVALID_IMAGES') === 'true',
        size: convertFullsize ? undefined : image.preview.size,
        // Embedded previews take the asset's orientation. LibRaw and original-file decoders already apply it.
        orientation:
          extracted && !sensorRendered && asset.exifInfo.orientation ? Number(asset.exifInfo.orientation) : undefined,
      };
      return this.mediaRepository
        .generateImageThumbnails(extracted ? extracted.buffer : (sdrBase ?? asset.originalPath), decodeOptions, {
          outputs: outputs ? [outputs.thumbnail, outputs.preview, ...(convertFullsize ? [outputs.fullsize] : [])] : [],
          edits: useEdits ? asset.edits : [],
          checkTransparency: !extracted && mimeTypes.canBeTransparent(asset.originalPath),
        })
        .then((decoded) => ({ ...decoded, convertFullsize }));
    };
    let decoded: Awaited<ReturnType<typeof decodeSource>>;
    try {
      decoded = await decodeSource();
    } catch (error) {
      executionSignal()?.throwIfAborted();
      if (!(error instanceof SharpOperationError) || !error.decodeFailure || !isRaw || sensorRendered) {
        throw error;
      }
      // An unreadable embedded preview gets one sensor attempt, never a repeated repository/CLI fallback.
      extracted = await this.renderRawImage(asset.originalPath);
      sensorRendered = true;
      decoded = await decodeSource();
    }

    return decoded;
  }

  private async generateImageThumbnails(asset: ThumbnailAsset, { image }: SystemConfig, useEdits: boolean = false) {
    const previewFile = this.getImageFile(asset, {
      fileType: AssetFileType.Preview,
      format: image.preview.format,
      isEdited: useEdits,
      isProgressive: !!image.preview.progressive && image.preview.format !== ImageFormat.Webp,
      isTransparent: false,
    });
    const thumbnailFile = this.getImageFile(asset, {
      fileType: AssetFileType.Thumbnail,
      format: image.thumbnail.format,
      isEdited: useEdits,
      isProgressive: !!image.thumbnail.progressive && image.thumbnail.format !== ImageFormat.Webp,
      isTransparent: false,
    });
    const fullsizeFile = this.getImageFile(asset, {
      fileType: AssetFileType.FullSize,
      format: image.fullsize.format,
      isEdited: useEdits,
      isProgressive: !!image.fullsize.progressive && image.fullsize.format !== ImageFormat.Webp,
      isTransparent: false,
    });
    // Validate every possible output before the child opens any path for writing.
    for (const file of [previewFile, thumbnailFile, fullsizeFile]) {
      assertOriginalPreserved({ originalPath: asset.originalPath, outputPath: file.path });
    }
    this.storageCore.ensureFolders(previewFile.path);

    if (useEdits && !mimeTypes.isRaw(asset.originalFileName)) {
      const stored = asset.exifInfo.imageEncoding;
      const encoding =
        !stored || stored.dynamicRange === 'unknown'
          ? await this.mediaRepository.inspectImageEncoding(asset.originalPath)
          : stored;
      if (encoding?.dynamicRange === 'hdr') {
        throw new BadRequestException(
          'This edit requires the HDR-preserving Develop renderer; the previous rendition is retained',
        );
      }
    }
    let hdrFiles: UpsertFileOptions[] = useEdits
      ? []
      : asset.files
          .filter(
            (file) =>
              !file.isEdited && (file.type === AssetFileType.HdrPreview || file.type === AssetFileType.HdrFullSize),
          )
          .map((file) => ({ ...file, assetId: asset.id }));
    let hdrMaster: string | undefined;
    // Disabled until authored-media and physical-display qualification. Reuses this job's admission and lease.
    if (
      !useEdits &&
      process.env.FRAMELEAF_HDR_IMAGES === 'experimental' &&
      asset.exifInfo.imageEncoding?.dynamicRange === 'hdr' &&
      asset.exifInfo.imageEncoding.reconstructionAvailable
    ) {
      hdrFiles = [AssetFileType.HdrPreview, AssetFileType.HdrFullSize].map((fileType) =>
        this.getImageFile(asset, {
          fileType,
          format: ImageFormat.Jpeg,
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        }),
      );
      for (const file of hdrFiles) assertOriginalPreserved({ originalPath: asset.originalPath, outputPath: file.path });
      const outputs = await this.mediaRepository.generateHdrRenditions(asset.originalPath, [
        { path: hdrFiles[0].path, size: image.preview.size },
        { path: hdrFiles[1].path },
      ]);
      for (let index = 0; index < hdrFiles.length; index++) {
        const output = outputs[index];
        hdrFiles[index].renditionIdentity = imageRenditionIdentity({
          sourceChecksum: asset.checksum,
          editRevision: 0,
          rendererVersion: HDR_RENDITION_RENDERER_VERSION,
          width: output.width,
          height: output.height,
          gamut: output.gamut,
          dynamicRange: 'hdr',
        });
      }
      hdrMaster = hdrFiles[1].path;
    }

    const { info, thumbhash, convertFullsize, isTransparent } = await this.extractOriginalImage(
      asset,
      image,
      useEdits,
      {
        thumbnail: { path: thumbnailFile.path, options: image.thumbnail },
        preview: { path: previewFile.path, options: image.preview },
        fullsize: {
          path: fullsizeFile.path,
          options: {
            format: image.fullsize.format,
            quality: image.fullsize.quality,
            progressive: image.fullsize.progressive,
          },
        },
      },
      hdrMaster,
    );
    const files = convertFullsize ? [previewFile, thumbnailFile, fullsizeFile] : [previewFile, thumbnailFile];
    files.push(...hdrFiles);
    for (const file of files) {
      file.isTransparent = isTransparent;
    }
    this.warnOnTransparencyLoss(isTransparent, image.preview.format, asset.id);
    this.warnOnTransparencyLoss(isTransparent, image.thumbnail.format, asset.id);
    if (convertFullsize) {
      this.warnOnTransparencyLoss(isTransparent, image.fullsize.format, asset.id);
    }

    if (asset.exifInfo.projectionType === 'EQUIRECTANGULAR') {
      const promises = [
        this.mediaRepository.copyTagGroup('XMP-GPano', asset.originalPath, previewFile.path),
        convertFullsize
          ? this.mediaRepository.copyTagGroup('XMP-GPano', asset.originalPath, fullsizeFile.path)
          : Promise.resolve(),
      ];
      await Promise.all(promises);
    }

    const decodedDimensions = { width: info.width, height: info.height };
    const fullsizeDimensions = useEdits ? getOutputDimensions(asset.edits, decodedDimensions) : decodedDimensions;

    return { files, thumbhash, fullsizeDimensions };
  }

  @OnJob({ name: JobName.PersonGenerateThumbnail, queue: QueueName.ThumbnailGeneration })
  async handleGeneratePersonThumbnail({
    ownerId,
    personGroupId,
    selectionFaceId,
  }: JobOf<JobName.PersonGenerateThumbnail> & { selectionFaceId?: string }): Promise<JobStatus> {
    const { image } = await this.getConfig({ withCache: true });
    const person = queueExecution.getStore()
      ? await this.personRepository.getByGroupId({ personGroupId, ownerId })
      : undefined;
    if (selectionFaceId && person?.faceAssetId && person.faceAssetId !== selectionFaceId) return JobStatus.Skipped;
    const sourceFaceId = person?.faceAssetId ?? selectionFaceId;
    const sourceFace = sourceFaceId
      ? await this.personRepository.getFaceById(sourceFaceId, { viewingUserId: ownerId })
      : undefined;
    if (sourceFace) await this.jobRepository.guardAssetSource(sourceFace.assetId);
    const data = await this.personRepository.getDataForThumbnailGenerationJob(
      { ownerId, personGroupId },
      person?.faceAssetId ? undefined : selectionFaceId,
    );
    if (!data) {
      this.logger.debug(`Skipping person thumbnail for ${personGroupId}: source is ineligible`);
      return JobStatus.Skipped;
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
      processInvalidImages: readAliasedEnv('FRAMELEAF_PROCESS_INVALID_IMAGES') === 'true',
      // if this is an extracted image, it may not have orientation metadata
      orientation: Buffer.isBuffer(inputImage) && exifOrientation ? Number(exifOrientation) : undefined,
    });

    const thumbnailPath = attemptOutputPath(StorageCore.getPersonThumbnailPath({ ownerId, personGroupId }));
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
    if (
      !deferJobAdoption(async (tx) => {
        await lockFilePath(tx, thumbnailPath);
        await tx
          .selectFrom('person')
          .select('personGroupId')
          .where('ownerId', '=', ownerId)
          .where('personGroupId', '=', personGroupId)
          .forUpdate()
          .execute();
        const currentPerson = await this.personRepository.getByGroupId({ personGroupId, ownerId });
        const current = await this.personRepository.getDataForThumbnailGenerationJob(
          { ownerId, personGroupId },
          person?.faceAssetId ? undefined : selectionFaceId,
        );
        if (
          !sourceFace ||
          currentPerson?.faceAssetId !== person?.faceAssetId ||
          JSON.stringify(current) !== JSON.stringify(data)
        ) {
          throw new Error('Person thumbnail source changed before publication');
        }
        await tx
          .updateTable('person')
          .set({ thumbnailPath, ...(sourceFaceId && { faceAssetId: sourceFaceId }) })
          .where('ownerId', '=', ownerId)
          .where('personGroupId', '=', personGroupId)
          .execute();
        const oldPath = currentPerson?.thumbnailPath;
        if (oldPath && oldPath !== thumbnailPath) {
          await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [oldPath] } });
        }
      })
    ) {
      await this.personRepository.update({ ownerId, personGroupId, thumbnailPath });
    }

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

  /**
   * FL-59: the owner's chosen cover time, kept clear of the clip's final stretch like the automatic
   * candidates are; undefined when the clip is too short to seek in.
   */
  private getVideoCoverStartTime(videoStream: VideoStreamInfo, format: VideoFormat, seconds: number) {
    const duration = this.getVideoThumbnailDurationSeconds(videoStream, format);
    if (!Number.isFinite(duration) || duration <= 1 || !Number.isFinite(seconds) || seconds < 0) {
      return;
    }
    const tail = Math.min(Math.max(duration * 0.1, 0.5), 5);
    return Number(Math.min(seconds, Math.max(duration - tail, 0)).toFixed(3));
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
      /** FL-59: the owner's chosen cover, in seconds; the automatic pick is skipped. */
      coverSeconds?: number;
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
    const cover =
      options.coverSeconds === undefined
        ? undefined
        : this.getVideoCoverStartTime(videoStream, format, options.coverSeconds);
    const startTime =
      cover ??
      (await this.pickVideoThumbnailStartTime(sourcePath, previewFile.path, videoStream, format, (timestamp) =>
        ThumbnailConfig.create(previewConfig, timestamp).getCommand(
          TranscodeTarget.Video,
          videoStream,
          undefined,
          format,
        ),
      ));
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
      processInvalidImages: readAliasedEnv('FRAMELEAF_PROCESS_INVALID_IMAGES') === 'true',
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

    await this.jobRepository.queueSelection(
      JobName.AssetEncodeVideo,
      this.assetJobRepository.selectionForVideoConversion(force),
    );

    return JobStatus.Success;
  }

  /**
   * FL-97: the Studio HDR intermediate of one placed HDR video (see utils/studio-hdr-proxy.ts). Made
   * from the original once, and skipped for anything that is not a decodable BT.2020 PQ/HLG video.
   */
  @OnJob({ name: JobName.StudioHdrProxyGenerate, queue: QueueName.VideoConversion })
  async handleStudioHdrProxy({ id }: JobOf<JobName.StudioHdrProxyGenerate>): Promise<JobStatus> {
    const asset = await this.assetJobRepository.getForVideoConversion(id);
    if (!asset) {
      return JobStatus.Failed;
    }
    // Everyone but the owner's quick editor plays the edited master, so the unedited original's
    // intermediate would show them what the owner cut away.
    if (getAssetFile(asset.files, AssetFileType.EncodedVideo, { isEdited: true })) {
      return JobStatus.Skipped;
    }
    // Taken before the transcode: an original replaced or rewritten meanwhile is not recorded.
    const sourceFingerprint = await this.assetRepository.getStudioHdrSourceFingerprint(asset.id);
    if (!sourceFingerprint) {
      return JobStatus.Failed;
    }
    const current = (await this.assetRepository.getCurrentStudioHdrIntermediates([asset.id])).get(asset.id);
    if (current && (await this.storageRepository.checkFileExists(current))) {
      return JobStatus.Skipped;
    }
    // Deleted by FileDelete, under the path lock and only while no row references the file.
    const releaseFiles = async (...files: Array<string | undefined>) => {
      const paths = files.filter((file): file is string => !!file);
      if (paths.length > 0) {
        await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: paths } });
      }
    };
    const refuse = async (status: 'ineligible' | 'failed', reason: string) => {
      this.logger.warn(`No Studio HDR intermediate for asset ${asset.id}: ${reason}`);
      const { replacedPath } = await this.assetRepository.recordStudioHdrIntermediate({
        assetId: asset.id,
        ownerId: asset.ownerId,
        sourceFingerprint,
        status,
      });
      await releaseFiles(replacedPath);
    };

    const { videoStream } = asset;
    if (!videoStream) {
      await refuse('ineligible', 'no video stream was probed');
      return JobStatus.Skipped;
    }
    const plan = planStudioHdrProxy(videoStream);
    if (!plan.eligible) {
      await refuse('ineligible', plan.reason);
      return JobStatus.Skipped;
    }
    const { ffmpeg } = await this.getConfig({ withCache: true });
    const qualification = qualifySourceDecode(videoStream, ffmpeg);
    if (qualification.support === DecodeSupport.Refused) {
      await refuse('ineligible', qualification.reason);
      return JobStatus.Skipped;
    }

    // A new name per generation, recorded only once the file is complete: the row never names a
    // half-written or older file, and nothing queued earlier can name this one.
    const output = StorageCore.getStudioHdrProxyPath(asset, randomUUID());
    const discard = () => this.storageRepository.unlink(output).catch(() => {});
    this.storageCore.ensureFolders(output);
    try {
      await this.mediaRepository.transcode(
        asset.originalPath,
        output,
        getStudioHdrProxyCommand(videoStream, plan.transfer, ffmpeg.threads),
      );
    } catch (error: any) {
      await discard();
      // Recorded, so the next project read does not start the same failing transcode again.
      await refuse('failed', `the transcode failed: ${error.message}`);
      return JobStatus.Failed;
    }
    const { recorded, replacedPath } = await this.assetRepository.recordStudioHdrIntermediate({
      assetId: asset.id,
      ownerId: asset.ownerId,
      sourceFingerprint,
      status: 'ready',
      path: output,
    });
    if (!recorded) {
      await discard();
      return JobStatus.Skipped;
    }
    await releaseFiles(replacedPath);
    this.logger.log(`Made the Studio HDR intermediate of asset ${asset.id}`);
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetEncodeVideo, queue: QueueName.VideoConversion })
  async handleVideoConversion({ id }: JobOf<JobName.AssetEncodeVideo>): Promise<JobStatus> {
    const asset = await this.assetJobRepository.getForVideoConversion(id);
    if (!asset) {
      return JobStatus.Failed;
    }

    deferJobAdoption(async () => {
      await assertPublicationSource(asset.id, asset.checksum);
      const current = await this.assetJobRepository.getForVideoConversion(asset.id);
      if (!current || current.originalPath !== asset.originalPath) {
        throw new Error('Video source changed before publication');
      }
    });

    const input = asset.originalPath;
    const output = attemptOutputPath(StorageCore.getEncodedVideoPath(asset));

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

    if (queueExecution.getStore()) {
      await this.stageGeneratedFiles(
        this.toExistingAssetFiles(
          asset.files.filter((file) => file.type === AssetFileType.EncodedVideo && !file.isEdited),
        ),
        [
          {
            assetId: asset.id,
            type: AssetFileType.EncodedVideo,
            path: output,
            isEdited: false,
            isProgressive: false,
            isTransparent: false,
          },
        ],
      );
      return JobStatus.Success;
    }

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
  async handleAssetVideoEditGeneration({
    id,
    versionId,
    operationId,
  }: JobOf<JobName.AssetVideoEditGeneration>): Promise<JobStatus> {
    // FL-43: a video edit or export runs under its Activity job, when it was queued with one.
    return this.editOperations.execute(operationId, (run) => this.renderVideoEdit(id, versionId, run));
  }

  private async renderVideoEdit(id: string, versionId: string | undefined, run?: EditOperationRun): Promise<JobStatus> {
    await this.jobRepository.guardAssetSource(id);
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

    // Every save, revert and export is a retained version. The
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
      return this.renderVideoVersion(version, { ...thumbnailAsset, files: asset.files }, config, run);
    }

    const edits = (await this.assetEditRepository.getAll(id)) as AssetEditActionItem[];
    const editedFiles = this.toExistingAssetFiles(asset.files.filter((file) => file.isEdited));
    deferJobAdoption(async () => {
      await assertPublicationSource(asset.id, asset.checksum);
      const current = await this.assetEditRepository.getAll(id);
      if (
        JSON.stringify(current) !== JSON.stringify(edits) ||
        (await this.assetEditRepository.getRequestedVideoVersion(id))
      ) {
        throw new Error('Video edit changed before publication');
      }
    });

    if (edits.length === 0) {
      if (run && !(await run.validate())) {
        return JobStatus.Skipped;
      }
      await this.syncFiles(editedFiles, []);
      const generated = await this.generateVideoThumbnails(thumbnailAsset, config);
      await this.syncFiles(
        this.toExistingAssetFiles(asset.files.filter((file) => !file.isEdited && this.isVideoThumbnailFile(file.type))),
        generated.files,
      );
      await publishJobResult(() =>
        this.assetRepository
          .update({
            id: asset.id,
            thumbhash: generated.thumbhash,
            duration: Math.round(format.duration * 1000),
            ...generated.fullsizeDimensions,
          })
          .then(() => {}),
      );
      return JobStatus.Success;
    }

    const output = attemptOutputPath(this.getEditedEncodedVideoPath(thumbnailAsset));

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
      run?.noteError('The edited video could not be encoded');
      return JobStatus.Failed;
    }

    // FL-43: the edited master is adopted only under the job's claim; a stale run leaves the last one.
    if (run && !(await run.validate())) {
      return JobStatus.Skipped;
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

    const encodedFile: UpsertFileOptions = {
      assetId: asset.id,
      type: AssetFileType.EncodedVideo,
      path: output,
      isEdited: true,
      isProgressive: false,
      isTransparent: false,
    };

    const fullsizeDimensions = this.getVideoEditDimensions(edits, videoStream);
    const generated = await this.generateVideoThumbnails(thumbnailAsset, config, {
      sourcePath: output,
      isEdited: true,
      fullsizeDimensions,
    });
    await this.syncFiles(editedFiles, [encodedFile, ...generated.files]);

    const duration = await this.getRenderedVideoDurationMs(edits, { videoStream, audioStream, format }, output);
    await publishJobResult(() =>
      this.assetRepository
        .update({
          id: asset.id,
          thumbhash: generated.thumbhash,
          duration,
          ...fullsizeDimensions,
        })
        .then(() => {}),
    );

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
      jobSignal()?.throwIfAborted();
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
    run?: EditOperationRun,
  ): Promise<JobStatus> {
    const suffix = `${version.id}_${randomUUID()}`;
    // FL-43: a version is published only under its job's claim. A run that lost its claim, or whose
    // job was cancelled, stops before publishing: its files are removed below and the version that
    // is current stays current.
    const mayPublish = async () => !run || (await run.validate());
    const { dir, name } = path.parse(this.getEditedEncodedVideoPath(asset));
    const master = attemptOutputPath(path.join(dir, `${name}.${suffix}.master.mp4`));
    const proxy = attemptOutputPath(path.join(dir, `${name}.${suffix}.proxy.mp4`));
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
        if (!(await mayPublish())) {
          return JobStatus.Skipped;
        }
        published = await this.publishVideoVersion(
          version,
          {
            files: [],
            masterPath: null,
            thumbhash: originalPreview
              ? await this.mediaRepository.generateThumbhash(originalPreview.path, {
                  colorspace: config.image.colorspace,
                  processInvalidImages: readAliasedEnv('FRAMELEAF_PROCESS_INVALID_IMAGES') === 'true',
                })
              : null,
            ...this.getVideoEditDimensions([], videoStream),
            duration: Math.round(original.format.duration * 1000),
          },
          run,
          candidates,
        );
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
      // FL-102: the audio survives too — present, same layout and rate, and ending with the picture.
      validateAudioMaster({
        source: audioStream,
        output: masterInfo.audioStreams[0],
        outputVideo: masterVideo,
        muted: edits.some((edit) => edit.action === AssetEditAction.Audio && !!edit.parameters.muted),
      });
      // Only full-clip timing-preserving recipes: trim/speed retain their separate semantics.
      if (edits.every((edit) => !(edit.action === AssetEditAction.Trim || edit.action === AssetEditAction.Speed))) {
        const sourcePackets = await this.mediaRepository.probePackets(version.sourcePath, videoStream.index);
        const masterPackets = await this.mediaRepository.probePackets(master, masterVideo.index);
        validateFullClipMasterTiming(videoStream, masterVideo, sourcePackets, masterPackets);
      }

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
      const duration = await this.getRenderedVideoDurationMs(
        edits,
        { videoStream, audioStream, format: original.format },
        masterInfo,
      );

      if (version.purpose === 'export') {
        if (!(await mayPublish())) {
          return JobStatus.Skipped;
        }
        published = await this.publishVideoVersion(
          version,
          {
            masterPath: master,
            files: [proxyFile],
            ...dimensions,
            duration,
          },
          run,
          candidates,
        );
        return published ? JobStatus.Success : JobStatus.Skipped;
      }

      const generated = await this.generateVideoThumbnails(
        { ...source, videoStream: masterVideo, format: masterInfo.format },
        config,
        { sourcePath: master, isEdited: true, fullsizeDimensions: dimensions, pathSuffix: suffix, candidates },
      );
      if (!(await mayPublish())) {
        return JobStatus.Skipped;
      }
      published = await this.publishVideoVersion(
        version,
        {
          masterPath: master,
          files: [proxyFile, ...generated.files],
          ...dimensions,
          duration,
          thumbhash: generated.thumbhash,
        },
        run,
        candidates,
      );
      return published ? JobStatus.Success : JobStatus.Skipped;
    } catch (error: any) {
      jobSignal()?.throwIfAborted();
      this.logger.error(`Video version ${version.id} render failed for asset ${asset.id}: ${error?.message ?? error}`);
      await publishJobDiagnostic(() => this.assetEditRepository.failVideoVersion(version.assetId, version.id));
      run?.noteError(error);
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
    run?: EditOperationRun,
    candidates: string[] = [],
  ): Promise<boolean> {
    let adopted = false;
    if (
      deferJobAdoption(async () => {
        const publication = await this.assetEditRepository.publishVideoVersion(version, result);
        adopted = publication.published;
        if (!adopted) {
          if (!publication.superseded) throw new Error('Video version changed before publication');
          if (candidates.length > 0) {
            await afterJobCommit(async () => {
              await Promise.all(candidates.map((candidate) => this.storageRepository.unlink(candidate)));
            });
          }
          return;
        }
        const { releasedPaths } = publication;
        if (releasedPaths.length > 0) {
          await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: releasedPaths } });
        }
      })
    ) {
      if (run && !(await run.complete(() => (adopted ? version.assetId : null)))) {
        throw new Error('Edit operation lost its claim before publication');
      }
      // Keep private candidates until the enclosing queue and operation claims accept them.
      // A rejected transaction leaves no canonical references and cannot delete prior output.
      return true;
    }
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
      jobSignal()?.throwIfAborted();
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
    // The whole-clip rate plays everywhere a speed range does not (FL-113, `develop.mjs` speedAt).
    const intervals = this.getSpeedIntervals(edits, startMs, endMs, globalSpeed?.parameters.rate ?? 1);

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

    // FL-113: a fast trim with nothing else in the recipe copies the packets between keyframes.
    const streamCopyTrim = qualifyStreamCopyTrim({ edits, videoStream, audioStream, format });
    if (streamCopyTrim) {
      return this.getStreamCopyTrimCommand(streamCopyTrim, videoStream, audioStream);
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
    // With speed ranges the segmented graph carries the whole-clip rate in its gaps (FL-113), so
    // the whole-clip rate is applied here only when there are no ranges.
    if (globalSpeed && speedSegments.length === 0) {
      // The recipe spans the container timeline, including audio after the last picture.
      // Hold that picture before changing speed so the source audio tail survives.
      if (
        !trim &&
        audioStream &&
        typeof videoStream.duration === 'number' &&
        Number.isFinite(videoStream.duration) &&
        videoStream.duration > 0 &&
        Number.isFinite(format.duration) &&
        format.duration > videoStream.duration
      ) {
        videoFilters.push(
          `tpad=stop_mode=clone:stop_duration=${this.roundFilterNumber(format.duration - videoStream.duration)}`,
        );
      }
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
      // `fill` (FL-113 quick editor): scale the straightened picture to cover its own frame, as the
      // prototype and the still renderer do (`straightenScale`). Recipes without it keep their
      // black corners, so an earlier save re-renders exactly as it did.
      const { width, height } = this.getVideoEditDimensions(edits, videoStream);
      const cover = straightenScale(width, height, straighten.parameters.angle);
      if (straighten.parameters.fill && cover > 1) {
        videoFilters.push(
          `scale=trunc(iw*${this.roundFilterNumber(cover)}/2)*2:trunc(ih*${this.roundFilterNumber(cover)}/2)*2`,
          `crop=${width}:${height}`,
        );
      }
    }

    const mirrors = edits.filter((edit) => edit.action === AssetEditAction.Mirror);
    for (const mirror of mirrors) {
      videoFilters.push(mirror.parameters.axis === 'horizontal' ? 'hflip' : 'vflip');
    }

    const stabilize = edits.find(isEditAction(AssetEditAction.Stabilize));
    if (stabilize?.parameters.enabled) {
      videoFilters.push('deshake');
      // `cropEdges` (FL-113, `Editor.jsx` Stabilize: "Edges are cropped slightly to hide the
      // correction"): crop 4% and scale back to the frame. Earlier recipes render as before.
      if (stabilize.parameters.cropEdges) {
        const { width, height } = this.getVideoEditDimensions(edits, videoStream);
        videoFilters.push('crop=trunc(iw*0.96/2)*2:trunc(ih*0.96/2)*2', `scale=${width}:${height}`);
      }
    }

    if (edits.some((edit) => edit.action === AssetEditAction.AutoEnhance && edit.parameters.enabled)) {
      videoFilters.push('eq=contrast=1.08:saturation=1.08:gamma=1.02');
    }

    const adjust = edits.find((edit) => edit.action === AssetEditAction.Adjust);
    if (adjust) {
      videoFilters.push(
        ...(adjust.parameters.model === VideoAdjustModel.Develop
          ? videoDevelopFilters(adjust.parameters)
          : this.getAdjustmentFilters(adjust.parameters)),
      );
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
    const outputDimensions = overlays.length > 0 ? this.getVideoEditDimensions(edits, videoStream) : null;
    for (const overlay of overlays) {
      videoFilters.push(this.getTextOverlayFilter(overlay.parameters, timeline, outputDimensions!));
    }

    videoFilters.push(...transcodeFilters);

    const audioEdit = edits.find((edit) => edit.action === AssetEditAction.Audio);
    const muted = !!audioEdit?.parameters.muted;
    if (audioEdit?.parameters.volume !== undefined && !muted) {
      audioFilters.push(`volume=${this.roundFilterNumber(audioEdit.parameters.volume)}`);
      // `limit` (FL-113, `Editor.jsx` Audio): gain above 100% is limited so it cannot clip.
      if (audioEdit.parameters.limit && audioEdit.parameters.volume > 1) {
        audioFilters.push('alimiter=limit=0.98');
      }
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

  /**
   * The keyframe-snapped fast trim (FL-113): the input is opened at the keyframe at or before the in
   * point and every packet up to the out point is copied, so nothing is decoded or re-encoded.
   */
  private getStreamCopyTrimCommand(
    trim: { startMs: number; endMs: number },
    videoStream: VideoStreamInfo,
    audioStream: AudioStreamInfo | undefined,
  ): TranscodeCommand {
    const outputOptions = [
      '-t',
      this.msToSeconds(trim.endMs - trim.startMs),
      '-c',
      'copy',
      '-map',
      `0:${videoStream.index}`,
      '-map_metadata',
      '-1',
    ];
    if (audioStream) {
      outputOptions.push('-map', `0:${audioStream.index}`);
    }
    outputOptions.push('-avoid_negative_ts', 'make_zero', '-movflags', 'faststart');

    return {
      inputOptions: ['-ss', this.msToSeconds(trim.startMs)],
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

  private getSpeedIntervals(
    edits: AssetEditActionItem[],
    startMs: number,
    endMs: number,
    baseRate = 1,
  ): SpeedInterval[] {
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
        intervals.push({ startMs: cursorMs, endMs: segmentStartMs, rate: baseRate });
      }

      intervals.push({ startMs: segmentStartMs, endMs: segmentEndMs, rate: segment.parameters.rate });
      cursorMs = segmentEndMs;
    }

    if (cursorMs < endMs) {
      intervals.push({ startMs: cursorMs, endMs, rate: baseRate });
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
    output: ImageDimensions,
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
    const { x, y } = parameters.position
      ? this.getTextOverlayAnchor(parameters.position)
      : { x: `w*${this.roundFilterNumber(parameters.x)}`, y: `h*${this.roundFilterNumber(parameters.y)}` };
    // The prototype's shadow is `0 2px 6px` at its preview size; drawtext has no blur, so it is an
    // offset shadow of the same proportion.
    const shadow = parameters.shadow
      ? `:shadowcolor=black@0.7:shadowx=0:shadowy=${Math.max(1, Math.round(output.height / 360))}`
      : '';
    return `drawtext=text='${this.escapeFfmpegText(parameters.text)}':x=${x}:y=${y}:fontsize=h*${this.roundFilterNumber(parameters.size)}:fontcolor=${color}${shadow}${enable}`;
  }

  /**
   * Text aligned on the prototype's 3 × 3 grid (`Editor.jsx` `.ed-text-layer`, padding 4% of the
   * width on every side).
   */
  private getTextOverlayAnchor(position: TextOverlayPosition) {
    const margin = 'w*0.04';
    const column = position.endsWith('left') ? 0 : position.endsWith('right') ? 2 : 1;
    const row = position.startsWith('top') ? 0 : position.startsWith('bottom') ? 2 : 1;
    const x = [margin, '(w-text_w)/2', `w-text_w-${margin}`][column];
    const y = [margin, '(h-text_h)/2', `h-text_h-${margin}`][row];
    return { x, y };
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

  /**
   * The rendered length to record. A stream-copied fast trim starts at the keyframe at or before
   * the in point, so it runs longer than out minus in (FL-113): its length is read from the file
   * that was written. Every other render is exactly the recipe's timeline.
   */
  private async getRenderedVideoDurationMs(
    edits: AssetEditActionItem[],
    source: { videoStream: VideoStreamInfo; audioStream?: AudioStreamInfo; format: VideoFormat },
    output: string | VideoInfo,
  ): Promise<number> {
    if (qualifyStreamCopyTrim({ edits, ...source })) {
      const info = typeof output === 'string' ? await this.mediaRepository.probe(output) : output;
      const probed = Math.round((info.format.duration ?? 0) * 1000);
      if (probed > 0) {
        return probed;
      }
    }
    return this.getVideoEditDurationMs(edits, source.format);
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
    if (
      [
        JobName.AssetGenerateThumbnails,
        JobName.AssetEditThumbnailGeneration,
        JobName.AssetVideoEditGeneration,
      ].includes(queueExecution.getStore()?.claim.name as JobName)
    ) {
      await this.stageGeneratedFiles(oldFiles, newFiles);
      return;
    }

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
        existingFile.isTransparent !== newFile.isTransparent ||
        (existingFile.renditionIdentity ?? null) !== (newFile.renditionIdentity ?? null)
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

  /** Hash/stat happen without a connection. Only accepted output references enter the final SQL commit. */
  private async stageGeneratedFiles(oldFiles: ExistingAssetFile[], newFiles: UpsertFileOptions[]) {
    const prepared: Array<{
      file: UpsertFileOptions;
      physical: { id: string; checksum: Buffer; size: number; type: PhysicalFileType } | undefined;
    }> = [];
    const discarded: string[] = [];
    for (const input of newFiles) {
      const original = await this.physicalFileRepository.getOriginalPhysicalFile(input.assetId);
      const canonical =
        !input.isEdited && original?.canonicalAssetId !== input.assetId
          ? await this.physicalFileRepository.getCanonicalGeneratedFile(
              input.assetId,
              input.type,
              input.renditionIdentity,
            )
          : undefined;
      if (canonical) {
        prepared.push({ file: { ...input, path: canonical.path, physicalFileId: canonical.id }, physical: undefined });
        if (input.path !== canonical.path) {
          discarded.push(input.path);
        }
      } else {
        const physical =
          !input.isEdited && original?.canonicalAssetId === input.assetId
            ? {
                id: randomUUID(),
                checksum: await this.cryptoRepository.hashFile(input.path),
                size: (await this.storageRepository.stat(input.path)).size,
                type: this.toPhysicalFileType(input.type),
              }
            : undefined;
        prepared.push({ file: { ...input, physicalFileId: physical?.id ?? null }, physical });
      }
    }
    const retained = new Set(prepared.map(({ file }) => file.path));
    const obsolete = oldFiles.filter((file) => !retained.has(file.path));
    deferJobAdoption(async (tx) => {
      for (const { file, physical } of prepared) {
        if (physical) {
          await sql`insert into physical_file(id, type, checksum, "sizeInBytes", path, "canonicalAssetId")
            values (${physical.id}::uuid, ${physical.type}, ${physical.checksum}, ${physical.size}, ${file.path}, ${file.assetId}::uuid)
            on conflict (path) do nothing`.execute(tx);
        }
        await sql`insert into asset_file("assetId", type, path, "isEdited", "isProgressive", "isTransparent", "physicalFileId", "renditionIdentity")
          values (${file.assetId}::uuid, ${file.type}, ${file.path}, ${file.isEdited}, ${file.isProgressive}, ${file.isTransparent}, ${file.physicalFileId}::uuid, ${file.renditionIdentity ?? null})
          on conflict ("assetId", type, "isEdited") do update set path = excluded.path,
            "isProgressive" = excluded."isProgressive", "isTransparent" = excluded."isTransparent",
            "physicalFileId" = excluded."physicalFileId", "renditionIdentity" = excluded."renditionIdentity"`.execute(
          tx,
        );
      }
      for (const file of obsolete) {
        if (
          prepared.every(
            ({ file: replacement }) => replacement.type !== file.type || replacement.isEdited !== file.isEdited,
          )
        ) {
          await sql`delete from asset_file where id = ${file.id}::uuid and type = ${file.type}
            and "isEdited" = ${file.isEdited} and path = ${file.path}`.execute(tx);
        }
      }
    });
    const paths = [...discarded, ...obsolete.map((file) => file.path)];
    if (paths.length > 0) {
      await this.jobRepository.collectFollowups(() =>
        this.jobRepository.queue({ name: JobName.FileDelete, data: { files: paths } }),
      );
    }
  }

  private async applyPhysicalDeduplicationToGeneratedFile(
    file: UpsertFileOptions,
  ): Promise<{ file: UpsertFileOptions; pathToDelete?: string }> {
    if (file.isEdited || !this.isPhysicalDeduplicationGeneratedFile(file.type)) {
      return { file };
    }

    // universal storage is always on: a copy linked to another asset's original shares its generated files
    const canonical = await this.physicalFileRepository.getCanonicalGeneratedFile(
      file.assetId,
      file.type,
      file.renditionIdentity,
    );
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
      AssetFileType.HdrPreview,
      AssetFileType.HdrFullSize,
      AssetFileType.EncodedVideo,
    ].includes(type);
  }

  private toPhysicalFileType(type: AssetFileType) {
    switch (type) {
      case AssetFileType.Thumbnail: {
        return PhysicalFileType.Thumbnail;
      }
      case AssetFileType.HdrPreview: {
        return PhysicalFileType.HdrPreview;
      }
      case AssetFileType.HdrFullSize: {
        return PhysicalFileType.HdrFullSize;
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

  private async generateEditedThumbnails(asset: ThumbnailAsset, config: SystemConfig, run?: EditOperationRun) {
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

    // A cancelled/lost edit returns Skipped. It must not leave visibility changes queued for
    // the enclosing job's successful completion after the operation itself refused publication.
    if (run && !(await run.validate())) {
      return;
    }
    await publishJobResult(async () => {
      const originalDimensions = getDimensions(asset.exifInfo!);
      const assetFaces = await this.personRepository.getFaces(asset.id, { viewingUserId: asset.ownerId });
      const ocrData = await this.ocrRepository.getByAssetId(asset.id, {});

      const faceStatuses = checkFaceVisibility(assetFaces, originalDimensions, cropBox);
      await this.personRepository.updateVisibility(faceStatuses.visible, faceStatuses.hidden);

      const ocrStatuses = checkOcrVisibility(ocrData, originalDimensions, cropBox);
      await this.ocrRepository.updateOcrVisibilities(asset.id, ocrStatuses.visible, ocrStatuses.hidden);
    });

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
    const originalPath = StorageCore.getImagePath(asset, options);
    const path = [
      JobName.AssetGenerateThumbnails,
      JobName.AssetEditThumbnailGeneration,
      JobName.AssetVideoEditGeneration,
    ].includes(queueExecution.getStore()?.claim.name as JobName)
      ? attemptOutputPath(originalPath)
      : originalPath;
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
