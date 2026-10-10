import { Injectable } from '@nestjs/common';
import { ContainerDirectoryItem, ExifDateTime, Tags } from 'exiftool-vendored';
import { Insertable, Kysely } from 'kysely';
import { isUndefined, omitBy, pick } from 'lodash-es';
import { DateTime, Duration } from 'luxon';
import { Stats } from 'node:fs';
import { constants } from 'node:fs/promises';
import { join, parse } from 'node:path';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobOf } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { Asset, AssetFile, placeProperties } from 'src/database.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { ImageEncodingSchema, unknownImageEncoding } from 'src/dtos/image-encoding.dto.js';
import {
  AssetFileType,
  AssetType,
  AssetVisibility,
  ChecksumAlgorithm,
  DatabaseLock,
  ExifOrientation,
  ImmichWorker,
  JobName,
  JobStatus,
  QueueName,
  SourceType,
  StorageFolder,
} from 'src/enum.js';
import { afterJobCommit, attemptOutputPath, jobSignal, publishJobResult, queueExecution } from 'src/queue/context.js';
import { SharpResourceLimitError } from 'src/queue/sharp-protocol.js';
import { assertPublicationSource } from 'src/queue/transaction.js';
import { ReverseGeocodeResult } from 'src/repositories/map.repository.js';
import { ImmichTags } from 'src/repositories/metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table.js';
import { AssetFaceTable } from 'src/schema/tables/asset-face.table.js';
import { BaseService } from 'src/services/base.service.js';
import { getAssetFiles } from 'src/utils/asset.util.js';
import { resolveCameraIdentification } from 'src/utils/camera-identification.js';
import { mergeTimeZone } from 'src/utils/date.js';
import { isLockedRow } from 'src/utils/locked.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { isFaceImportEnabled } from 'src/utils/misc.js';
import { normalizeTagValue, upsertTags } from 'src/utils/tag.js';
import { Tasks } from 'src/utils/tasks.js';

const POSTGRES_INT_MAX = 2_147_483_647;
const POSTGRES_INT_MIN = -2_147_483_648;

/** look for a date from these tags (in order) */
const EXIF_DATE_TAGS: Array<keyof ImmichTags> = [
  'SubSecDateTimeOriginal',
  'SubSecCreateDate',
  'DateTimeOriginal',
  'CreationDate',
  'CreateDate',
  'MediaCreateDate',
  'DateTimeCreated',
  'GPSDateTime',
  'DateTimeUTC',
  'SonyDateTime2',
  // Undocumented, non-standard tag from insta360 in xmp.GPano namespace
  'SourceImageCreateTime' as keyof ImmichTags,
];

export function firstDateTime(tags: ImmichTags) {
  for (const tag of EXIF_DATE_TAGS) {
    const tagValue = tags?.[tag];

    if (tagValue instanceof ExifDateTime) {
      return {
        tag,
        dateTime: tagValue,
      };
    }

    if (typeof tagValue !== 'string') {
      continue;
    }

    const exifDateTime = ExifDateTime.fromEXIF(tagValue);
    if (exifDateTime) {
      return {
        tag,
        dateTime: exifDateTime,
      };
    }
  }
}

const validate = <T>(value: T): NonNullable<T> | null => {
  // handle lists of numbers
  if (Array.isArray(value)) {
    value = value[0];
  }

  if (typeof value === 'string') {
    // string means a failure to parse a number, throw out result
    return null;
  }

  if (
    typeof value === 'number' &&
    (Number.isNaN(value) || !Number.isFinite(value) || value < POSTGRES_INT_MIN || value > POSTGRES_INT_MAX)
  ) {
    return null;
  }

  return value ?? null;
};

const validateRange = (value: number | undefined, min: number, max: number): NonNullable<number> | null => {
  // reutilizes the validate function
  const val = validate(value);

  // check if the value is within the range
  if (val === null || val < min || val > max) {
    return null;
  }

  return Math.round(val);
};

const getLensModel = (exifTags: ImmichTags): string | null => {
  for (const value of [exifTags.LensID, exifTags.LensType, exifTags.LensSpec, exifTags.LensModel]) {
    const lens = String(value ?? '').trim();
    if (lens && lens.toLowerCase() !== 'n/a' && lens !== '----' && !lens.startsWith('Unknown')) {
      return lens;
    }
  }
  return null;
};

type ImmichTagsWithFaces = ImmichTags & { RegionInfo: NonNullable<ImmichTags['RegionInfo']> };

type Dates = {
  dateTimeOriginal: Date;
  localDateTime: Date;
};

@Injectable()
export class MetadataService extends BaseService {
  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async onBootstrap() {
    this.logger.log('Bootstrapping metadata service');
    await this.init();
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    await this.metadataRepository.teardown();
  }

  @OnEvent({ name: 'ConfigInit', workers: [ImmichWorker.Microservices] })
  onConfigInit({ newConfig }: ArgOf<'ConfigInit'>) {
    this.metadataRepository.setMaxConcurrency(newConfig.job.metadataExtraction.concurrency);
  }

  @OnEvent({ name: 'ConfigUpdate', workers: [ImmichWorker.Microservices], server: true })
  onConfigUpdate({ newConfig }: ArgOf<'ConfigUpdate'>) {
    this.metadataRepository.setMaxConcurrency(newConfig.job.metadataExtraction.concurrency);
  }

  private async init() {
    this.logger.log('Initializing metadata service');

    try {
      await this.jobRepository.pause(QueueName.MetadataExtraction);
      await this.databaseRepository.withLock(DatabaseLock.GeodataImport, () => this.mapRepository.init());
      await this.jobRepository.resume(QueueName.MetadataExtraction);

      this.logger.log(`Initialized local reverse geocoder`);
    } catch (error: Error | any) {
      this.logger.error(`Unable to initialize reverse geocoding: ${error}`, error?.stack);
      throw new Error('Metadata service init failed', { cause: error });
    }
  }

  private async linkLivePhotos(
    asset: { id: string; type: AssetType; ownerId: string; libraryId: string | null },
    exifInfo: Insertable<AssetExifTable>,
  ): Promise<void> {
    if (!exifInfo.livePhotoCID) {
      return;
    }

    const otherType = asset.type === AssetType.Video ? AssetType.Image : AssetType.Video;
    const match = await this.assetRepository.findLivePhotoMatch({
      livePhotoCID: exifInfo.livePhotoCID,
      ownerId: asset.ownerId,
      libraryId: asset.libraryId,
      otherAssetId: asset.id,
      type: otherType,
    });

    if (!match) {
      return;
    }

    const [photoAsset, motionAsset] = asset.type === AssetType.Image ? [asset, match] : [match, asset];
    await this.assetRepository.update({ id: photoAsset.id, livePhotoVideoId: motionAsset.id });
    await this.assetRepository.update({ id: motionAsset.id, visibility: AssetVisibility.Hidden });
    await this.albumRepository.removeAssetsFromAll([motionAsset.id]);
    await afterJobCommit(() =>
      this.eventRepository.emit('AssetHide', { assetId: motionAsset.id, userId: motionAsset.ownerId }),
    );
  }

  private isOrientationSidewards(orientation: ExifOrientation | number): boolean {
    return [
      ExifOrientation.MirrorHorizontalRotate270CW,
      ExifOrientation.Rotate90CW,
      ExifOrientation.MirrorHorizontalRotate90CW,
      ExifOrientation.Rotate270CW,
    ].includes(orientation);
  }

  @OnJob({ name: JobName.AssetExtractMetadataQueueAll, queue: QueueName.MetadataExtraction })
  async handleQueueMetadataExtraction(job: JobOf<JobName.AssetExtractMetadataQueueAll>): Promise<JobStatus> {
    const { force } = job;

    await this.jobRepository.queueSelection(
      JobName.AssetExtractMetadata,
      process.env.FRAMELEAF_HDR_IMAGES === 'experimental'
        ? this.assetJobRepository.selectionForMetadataExtraction(force, true)
        : this.assetJobRepository.selectionForMetadataExtraction(force),
    );

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetExtractMetadata, queue: QueueName.MetadataExtraction })
  async handleMetadataExtraction(data: JobOf<JobName.AssetExtractMetadata>) {
    // Snapshot before fetching the file list too: a sidecar created after that fetch must not
    // leave us applying the original file's older values against a newer EXIF revision (FL-202).
    // A tag added after this snapshot is never taken for one the file dropped.
    const [{ metadata, reverseGeocoding }, previous] = await Promise.all([
      this.getConfig({ withCache: true }),
      this.assetRepository.getForMetadataExtractionTags(data.id),
    ]);
    const asset = await this.assetJobRepository.getForMetadataExtraction(data.id);

    if (!asset) {
      return;
    }
    const [exifResult, stats] = await Promise.all([
      this.getExifTags(asset),
      this.storageRepository.stat(asset.originalPath),
    ]);
    const { tags: exifTags, originalTags, cameraEvidence, audio, video, packets, format } = exifResult;
    this.logger.verbose('Exif Tags', exifTags);

    const dates = this.getDates(asset, exifTags, stats);

    const { width, height } = this.getImageDimensions(exifTags);
    // FL-51: coordinates the owner set or removed are locked; the place names then stay as stored
    // instead of being read from the file's own coordinates
    const lockedProperties = (await this.assetJobRepository.getLockedPropertiesForMetadataExtraction(asset.id)) ?? [];
    const locationLocked = lockedProperties.includes('latitude');
    // Persisted locks can include camera fields beyond the public editable-property union.
    const cameraLocked = lockedProperties.some((property: string) => property === 'make' || property === 'model');
    if (
      !cameraLocked &&
      asset.type === AssetType.Image &&
      originalTags.FileType === 'JPEG' &&
      !cameraEvidence.recorded
    ) {
      try {
        cameraEvidence.suggestion = await this.metadataRepository.readJpegSignature(asset.originalPath);
      } catch (error) {
        this.logger.warn(`Unable to read optional JPEG encoding clue for ${asset.id}: ${error}`);
      }
    }
    let geo: ReverseGeocodeResult = { country: null, state: null, city: null },
      latitude: number | null = null,
      longitude: number | null = null;
    if (this.hasGeo(exifTags) && !locationLocked) {
      latitude = Number(exifTags.GPSLatitude);
      longitude = Number(exifTags.GPSLongitude);
      if (reverseGeocoding.enabled) {
        geo = await this.mapRepository.reverseGeocode({ latitude, longitude });
      }
    }

    const tags = this.getTagList(exifTags);

    let imageEncoding;
    if (asset.type === AssetType.Image && !mimeTypes.isRaw(asset.originalFileName)) {
      try {
        imageEncoding = ImageEncodingSchema.parse({
          ...(await this.mediaRepository.inspectImageEncoding(asset.originalPath)),
          inspectionStatus: 'identified',
        });
      } catch (error) {
        jobSignal()?.throwIfAborted();
        const code =
          error instanceof SharpResourceLimitError
            ? 'resource-limit'
            : error instanceof Error &&
                ['CORRUPT_IMAGE', 'INVALID_GAIN_MAP', 'UNSUPPORTED_IMAGE_CODEC'].includes(error.message)
              ? error.message.toLowerCase().replaceAll('_', '-')
              : 'inspection-unavailable';
        imageEncoding = { ...unknownImageEncoding(), inspectionStatus: 'failed' as const, fallbackReason: code };
        this.logger.warn(`Image encoding inspection unavailable: ${code}`);
      }
    }

    const exifData: Insertable<AssetExifTable> = {
      assetId: asset.id,
      imageEncoding: imageEncoding ?? null,

      // dates
      dateTimeOriginal: dates.dateTimeOriginal,
      modifyDate: stats.mtime,
      timeZone: dates.timeZone,

      // gps
      latitude,
      longitude,
      ...(!locationLocked && { country: geo.country, state: geo.state, city: geo.city }),

      // image/file
      fileSizeInByte: stats.size,
      exifImageHeight: validate(height),
      exifImageWidth: validate(width),
      orientation: validate(exifTags.Orientation)?.toString() ?? null,
      projectionType: exifTags.ProjectionType ? exifTags.ProjectionType.toUpperCase() : null,
      bitsPerSample: this.getBitsPerSample(exifTags),
      colorspace: exifTags.ColorSpace === undefined ? null : String(exifTags.ColorSpace),

      // camera
      make: cameraEvidence.recorded?.make ?? null,
      model: cameraEvidence.recorded?.model ?? null,
      fps: video?.frameRate ?? validate(Number(exifTags.VideoFrameRate!)),
      iso: validate(exifTags.ISO) as number,
      exposureTime: exifTags.ExposureTime ?? null,
      lensModel: getLensModel(exifTags),
      fNumber: validate(exifTags.FNumber),
      focalLength: validate(exifTags.FocalLength),

      // comments
      description: String(exifTags.ImageDescription || exifTags.Description || '').trim(),
      profileDescription: exifTags.ProfileDescription || null,
      rating:
        Number.isSafeInteger(exifTags.Rating) && exifTags.Rating !== 0 ? validateRange(exifTags.Rating, -1, 5) : null,

      // grouping
      livePhotoCID: (exifTags.ContentIdentifier || exifTags.MediaGroupUUID) ?? null,
      autoStackId: this.getAutoStackId(exifTags),

      tags: tags.length > 0 ? tags : null,
    };

    const audioData =
      format && audio?.codecName
        ? {
            assetId: asset.id,
            bitrate: audio.bitrate,
            index: audio.index,
            profile: audio.profile,
            codecName: audio.codecName,
            // FL-102: channel-aware audio. Null stays null; it means "not probed", not "stereo".
            channels: audio.channels ?? null,
            channelLayout: audio.channelLayout ?? null,
            sampleRate: audio.sampleRate ?? null,
          }
        : undefined;

    const videoData =
      format?.formatName && format.formatLongName && video?.codecName && video?.timeBase
        ? {
            assetId: asset.id,
            bitrate: video.bitrate,
            frameCount: video.frameCount,
            timeBase: video.timeBase,
            index: video.index,
            profile: video.profile,
            level: video.level,
            colorPrimaries: video.colorPrimaries,
            colorTransfer: video.colorTransfer,
            colorMatrix: video.colorMatrix,
            dvProfile: video.dvProfile,
            dvLevel: video.dvLevel,
            dvBlSignalCompatibilityId: video.dvBlSignalCompatibilityId,
            codecName: video.codecName,
            formatName: format.formatName,
            formatLongName: format.formatLongName,
            pixelFormat: video.pixelFormat,
          }
        : undefined;

    const keyframeData =
      packets && packets.keyframePts.length > 0
        ? {
            assetId: asset.id,
            totalDuration: packets.totalDuration,
            packetCount: packets.packetCount,
            outputFrames: packets.outputFrames,
            pts: packets.keyframePts,
            accDuration: packets.keyframeAccDuration,
            ownDuration: packets.keyframeOwnDuration,
          }
        : undefined;

    const isSidewards = exifTags.Orientation && this.isOrientationSidewards(exifTags.Orientation);
    const assetWidth = validate(isSidewards ? height : width);
    const assetHeight = validate(isSidewards ? width : height);

    if (this.isMotionPhoto(asset, exifTags)) {
      await this.applyMotionPhotos(asset, exifTags, dates, stats);
    }
    await publishJobResult(async () => {
      await assertPublicationSource(asset.id, asset.checksum);
      const current = await this.assetJobRepository.getForMetadataExtraction(asset.id);
      if (!current || !current.checksum.equals(asset.checksum) || current.originalPath !== asset.originalPath) {
        throw new Error('Metadata source changed before publication');
      }
      const tasks = new Tasks();

      tasks.push(
        () =>
          this.assetRepository.update({
            id: asset.id,
            duration: this.getDuration(exifTags),
            localDateTime: dates.localDateTime,
            fileCreatedAt: dates.dateTimeOriginal ?? undefined,
            fileModifiedAt: stats.mtime,

            // Keep unedited assets in sync with the file on disk, but don't overwrite edited dimensions.
            width: !current.isEdited || current.width === null ? assetWidth : undefined,
            height: !current.isEdited || current.height === null ? assetHeight : undefined,
          }),
        async () => {
          await this.assetRepository.upsertExif({
            exif: exifData,
            cameraEvidence: cameraLocked ? undefined : cameraEvidence,
            audio: audioData,
            video: videoData,
            keyframes: keyframeData,
            lockedPropertiesBehavior: 'skip',
            // FL-202: a write can lock AND unlock a property while the file is being read. The
            // revision check is atomic with this save, so even that interleaving keeps newer values.
            expectedUpdateId: previous?.updateId ?? null,
          });
          await this.applyTagList(asset, previous?.tags ?? []);
        },
      );

      if (isFaceImportEnabled(metadata) && this.hasTaggedFaces(exifTags)) {
        tasks.push(() => this.applyTaggedFaces(asset, exifTags));
      }

      await tasks.all();

      if (exifData.livePhotoCID) {
        await this.linkLivePhotos(asset, exifData);
      }

      await this.assetRepository.upsertJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });

      if (data.source === 'motion-photo') {
        // Encoding requires the EXIF/video rows accepted in this same publication.
        await this.jobRepository.queue({ name: JobName.AssetEncodeVideo, data: { id: asset.id } });
      }

      if (queueExecution.getStore()) {
        await this.jobRepository.queue({ name: JobName.AssetMetadataPostprocess, data });
      } else {
        await this.eventRepository.emit('AssetMetadataExtracted', {
          assetId: asset.id,
          userId: asset.ownerId,
          source: data.source,
        });
      }
    });
  }

  @OnJob({ name: JobName.AssetMetadataPostprocess, queue: QueueName.MetadataExtraction })
  async handleMetadataPostprocess({ id, source }: JobOf<JobName.AssetMetadataPostprocess>) {
    const asset = await this.assetRepository.getById(id);
    if (!asset) {
      return JobStatus.Skipped;
    }
    await this.eventRepository.emit('AssetMetadataExtracted', { assetId: id, userId: asset.ownerId, source });
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.SidecarQueueAll, queue: QueueName.Sidecar })
  async handleQueueSidecar({ force }: JobOf<JobName.SidecarQueueAll>): Promise<JobStatus> {
    await this.jobRepository.queueSelection(JobName.SidecarCheck, this.assetJobRepository.selectionForSidecar(force));

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.SidecarCheck, queue: QueueName.Sidecar })
  async handleSidecarCheck({ id }: JobOf<JobName.SidecarCheck>): Promise<JobStatus | undefined> {
    const asset = await this.assetJobRepository.getForSidecarCheckJob(id);
    if (!asset) {
      return;
    }

    let sidecarPath = null;
    for (const candidate of await this.getSidecarCandidates(asset)) {
      const isExists = await this.storageRepository.checkFileExists(candidate, constants.R_OK);
      if (!isExists) {
        continue;
      }

      sidecarPath = candidate;
      break;
    }

    const { sidecarFile } = getAssetFiles(asset.files);

    const isChanged = sidecarPath !== sidecarFile?.path;

    if (sidecarFile?.path || sidecarPath) {
      this.logger.debug(
        `Sidecar check found old=${sidecarFile?.path}, new=${sidecarPath} will ${isChanged ? 'update' : 'do nothing for'} asset ${asset.id}: ${asset.originalPath}`,
      );
    } else {
      this.logger.verbose(`No sidecars found for asset ${asset.id}: ${asset.originalPath}`);
    }

    if (!isChanged) {
      return JobStatus.Skipped;
    }

    await (sidecarPath === null
      ? this.assetRepository.deleteFile({ assetId: asset.id, type: AssetFileType.Sidecar })
      : this.assetRepository.upsertFile({ assetId: asset.id, type: AssetFileType.Sidecar, path: sidecarPath }));

    return JobStatus.Success;
  }

  @OnEvent({ name: 'AssetTag' })
  async handleTagAsset({ assetId }: ArgOf<'AssetTag'>) {
    await this.jobRepository.queue({ name: JobName.SidecarWrite, data: { id: assetId } });
  }

  @OnEvent({ name: 'AssetUntag' })
  async handleUntagAsset({ assetId }: ArgOf<'AssetUntag'>) {
    await this.jobRepository.queue({ name: JobName.SidecarWrite, data: { id: assetId } });
  }

  @OnJob({ name: JobName.SidecarWrite, queue: QueueName.Sidecar })
  async handleSidecarWrite(job: JobOf<JobName.SidecarWrite>): Promise<JobStatus> {
    return this.databaseRepository.withAssetSidecarLock(job.id, (kysely) => this.writeSidecar(job, kysely));
  }

  /** Every query here runs on the sidecar lock's own connection; see `withAssetSidecarLock`. */
  private async writeSidecar(job: JobOf<JobName.SidecarWrite>, kysely: Kysely<DB>): Promise<JobStatus> {
    const { id } = job;
    const asset = await this.assetJobRepository.getForSidecarWriteJob(id, kysely);
    if (!asset) {
      // An absent join result can mean a deleted asset or missing EXIF on an existing row.
      return (await this.assetJobRepository.getForSidecarCheckJob(id, kysely)) ? JobStatus.Failed : JobStatus.Skipped;
    }

    const lockedProperties = await this.assetJobRepository.getLockedPropertiesForMetadataExtraction(id, kysely);

    const { sidecarFile } = getAssetFiles(asset.files);
    const sidecarPath =
      sidecarFile?.path && (await this.canUseExistingSidecarPath(asset, sidecarFile.path, kysely))
        ? sidecarFile.path
        : await this.getSidecarWritePath(asset, kysely);

    const { description, dateTimeOriginal, latitude, longitude, rating, tags, timeZone } = pick(
      {
        description: asset.exifInfo.description,
        dateTimeOriginal: asset.exifInfo.dateTimeOriginal,
        latitude: asset.exifInfo.latitude,
        longitude: asset.exifInfo.longitude,
        rating: asset.exifInfo.rating ?? 0,
        tags: asset.exifInfo.tags,
        timeZone: asset.exifInfo.timeZone,
      },
      lockedProperties,
    );

    const exif = omitBy(
      <Tags>{
        Description: description,
        ImageDescription: description,
        DateTimeOriginal: mergeTimeZone(dateTimeOriginal, timeZone)?.toISO(),
        GPSLatitude: latitude,
        GPSLongitude: longitude,
        Rating: rating,
        TagsList: tags,
      },
      isUndefined,
    );

    if (Object.keys(exif).length === 0) {
      return JobStatus.Skipped;
    }

    this.storageCore.ensureFolders(sidecarPath);
    await this.metadataRepository.writeTags(sidecarPath, exif);

    if (!sidecarFile || sidecarFile.path !== sidecarPath) {
      await this.assetRepository.upsertFile({ assetId: id, type: AssetFileType.Sidecar, path: sidecarPath }, kysely);
    }

    // FL-36 (V-24): the sidecar has no place names, so a typed city, state or country stays locked.
    // FL-51: a removed location stays locked, so the next metadata read does not bring the original
    // file's coordinates back
    const locationRemoved =
      lockedProperties.includes('latitude') && asset.exifInfo.latitude === null && asset.exifInfo.longitude === null;
    // Tags set in Frameleaf stay locked too. The sidecar is written by a job that can run behind the tag
    // edits, so the next metadata read may find an older list in it; unlocked, that read took the
    // older list as the file's and dropped the tags added since.
    const keptLocked = new Set<string>([
      ...placeProperties,
      'tags',
      ...(locationRemoved ? ['latitude', 'longitude'] : []),
    ]);
    await this.assetRepository.unlockProperties(
      asset.id,
      lockedProperties.filter((property) => !keptLocked.has(property)),
      kysely,
    );

    return JobStatus.Success;
  }

  private async getSidecarWritePath(
    asset: {
      id: string;
      ownerId: string;
      originalPath: string;
      physicalOriginalFileId?: string | null;
    },
    kysely?: Kysely<DB>,
  ) {
    if (!asset.physicalOriginalFileId) {
      return `${asset.originalPath}.xmp`;
    }

    const isCanonical = await this.physicalFileRepository.isOriginalCanonical(
      asset.id,
      asset.physicalOriginalFileId,
      kysely,
    );
    if (isCanonical) {
      return `${asset.originalPath}.xmp`;
    }

    return StorageCore.getNestedPath(StorageFolder.Upload, asset.ownerId, `${asset.id}.xmp`);
  }

  private async canUseExistingSidecarPath(
    asset: { id: string; originalPath: string; physicalOriginalFileId?: string | null },
    path: string,
    kysely?: Kysely<DB>,
  ) {
    if (!asset.physicalOriginalFileId) {
      return true;
    }

    if (await this.physicalFileRepository.isOriginalCanonical(asset.id, asset.physicalOriginalFileId, kysely)) {
      return true;
    }

    return !this.getOriginalPathSidecarCandidates(asset.originalPath).includes(path);
  }

  private async getSidecarCandidates({
    files,
    id,
    ownerId,
    originalPath,
    physicalOriginalFileId,
  }: {
    files: AssetFile[];
    id: string;
    ownerId: string;
    originalPath: string;
    physicalOriginalFileId?: string | null;
  }) {
    const candidates: string[] = [];

    const { sidecarFile } = getAssetFiles(files);
    if (
      sidecarFile?.path &&
      (await this.canUseExistingSidecarPath({ id, originalPath, physicalOriginalFileId }, sidecarFile.path))
    ) {
      candidates.push(sidecarFile.path);
    }

    if (physicalOriginalFileId) {
      const isCanonical = await this.physicalFileRepository.isOriginalCanonical(id, physicalOriginalFileId);
      if (!isCanonical) {
        candidates.push(StorageCore.getNestedPath(StorageFolder.Upload, ownerId, `${id}.xmp`));
        return candidates;
      }
    }

    candidates.push(...this.getOriginalPathSidecarCandidates(originalPath));
    return candidates;
  }

  private getOriginalPathSidecarCandidates(originalPath: string) {
    const assetPath = parse(originalPath);

    return [
      // IMG_123.jpg.xmp
      `${originalPath}.xmp`,
      // IMG_123.xmp
      `${join(assetPath.dir, assetPath.name)}.xmp`,
    ];
  }

  private getImageDimensions(exifTags: ImmichTags): { width?: number; height?: number } {
    /*
     * The "true" values for width and height are a bit hidden, depending on the camera model and file format.
     * For RAW images in the CR2 or RAF format, the "ImageSize" value seems to be correct,
     * but ImageWidth and ImageHeight are not correct (they contain the dimensions of the preview image).
     */
    let [width, height] =
      exifTags.ImageSize?.toString()
        ?.split('x')
        ?.map((dim) => Number.parseInt(dim) || undefined) ?? [];
    if (!width || !height) {
      [width, height] = [exifTags.ImageWidth, exifTags.ImageHeight];
    }
    return { width, height };
  }

  private async getExifTags(asset: { originalPath: string; files: AssetFile[]; type: AssetType }) {
    const { sidecarFile } = getAssetFiles(asset.files);
    const shouldProbe = asset.type === AssetType.Video || asset.originalPath.toLowerCase().endsWith('.gif');

    const [mediaTags, sidecarTags, videoResult] = await Promise.all([
      this.metadataRepository.readTags(asset.originalPath),
      sidecarFile ? this.metadataRepository.readTags(sidecarFile.path) : null,
      shouldProbe ? this.getVideoTags(asset.originalPath) : null,
    ]);

    // Resolve capture identity before merging sidecar tags or deleting any original fields.
    const cameraEvidence = resolveCameraIdentification(mediaTags, sidecarTags);
    const originalTags = { ...mediaTags };

    // prefer dates from sidecar tags
    if (sidecarTags) {
      const result = firstDateTime(sidecarTags);
      const sidecarDate = result?.dateTime;
      if (sidecarDate) {
        for (const tag of EXIF_DATE_TAGS) {
          delete mediaTags[tag];
        }

        // exiftool-vendored derives tz information from the date.
        // if the sidecar file has date information, we also assume the tz information come from there.
        //
        // this is especially important in the case of UTC+0 where exiftool-vendored does not return tz/zone fields
        // and as such the tags aren't overwritten when returning all tags.
        for (const tag of ['zone', 'tz', 'tzSource'] as const) {
          delete mediaTags[tag];
        }
      }
    }

    // prefer duration from video tags
    // don't save duration if asset is definitely not an animated image (see e.g. CR3 with Duration: 1s)
    if (videoResult || !mimeTypes.isPossiblyAnimatedImage(asset.originalPath)) {
      delete mediaTags.Duration;
    }

    // never use duration from sidecar
    delete sidecarTags?.Duration;

    // don't use Exif Orientation for HEIF based images, it's usually missing or invalid.
    // prefer irot (ExifTool QuickTime:Rotation) mapped to ExifOrientation.
    if (mimeTypes.isHeifImage(asset.originalPath)) {
      const orientation = this.getHeifOrientation(mediaTags);
      if (orientation === null) {
        delete mediaTags.Orientation;
      } else {
        mediaTags.Orientation = orientation;
      }
    }

    return {
      tags: { ...mediaTags, ...videoResult?.tags, ...sidecarTags },
      originalTags,
      cameraEvidence,
      audio: videoResult?.audio,
      video: videoResult?.video,
      packets: videoResult?.packets,
      format: videoResult?.format ?? null,
    };
  }

  private getTagList(exifTags: ImmichTags): string[] {
    let tags: string[];
    if (exifTags.TagsList) {
      tags = exifTags.TagsList.map(String);
    } else if (exifTags.HierarchicalSubject) {
      tags = exifTags.HierarchicalSubject.map((tag) =>
        // convert | to /
        typeof tag === 'number'
          ? String(tag)
          : tag
              .split('|')
              .map((tag) => tag.replaceAll('/', '|'))
              .join('/'),
      );
    } else if (exifTags.Keywords) {
      let keywords = exifTags.Keywords;
      if (!Array.isArray(keywords)) {
        keywords = [keywords];
      }
      tags = keywords.map(String);
    } else {
      tags = [];
    }
    return tags;
  }

  /**
   * Applies the file's tag list as a change, not a replacement: the tags it lists are added, and only
   * those it listed before (`previousTags`) and no longer does are removed. Replacing the asset's whole
   * tag set here dropped a tag added through the API between this job reading the list and writing it
   * (a photo tagged right after upload lost the tag, and with it any Locked rule that matched it).
   */
  private async applyTagList({ id, ownerId }: { id: string; ownerId: string }, previousTags: string[]) {
    const asset = await this.assetRepository.getForMetadataExtractionTags(id);
    const tags = asset?.tags ?? [];
    const results = await upsertTags(this.tagRepository, { userId: ownerId, tags });

    const current = new Set(tags.map((tag) => normalizeTagValue(tag)));
    const dropped = [...new Set(previousTags.map((tag) => normalizeTagValue(tag)))].filter(
      (value) => value && !current.has(value),
    );
    await this.tagRepository.removeAssetTagValues(id, ownerId, dropped);
    await this.tagRepository.upsertAssetIds(results.map((tag) => ({ tagId: tag.id, assetId: id })));
  }

  private isMotionPhoto(asset: { type: AssetType }, tags: ImmichTags): boolean {
    return asset.type === AssetType.Image && !!(tags.MotionPhoto || tags.MicroVideo);
  }

  private async applyMotionPhotos(asset: Asset, tags: ImmichTags, dates: Dates, stats: Stats) {
    const isMotionPhoto = tags.MotionPhoto;
    const isMicroVideo = tags.MicroVideo;
    const videoOffset = tags.MicroVideoOffset;
    const hasMotionPhotoVideo = tags.MotionPhotoVideo;
    const hasEmbeddedVideoFile = tags.EmbeddedVideoType === 'MotionPhoto_Data' && tags.EmbeddedVideoFile;
    const directory = Array.isArray(tags.ContainerDirectory)
      ? (tags.ContainerDirectory as ContainerDirectoryItem[])
      : null;

    let length = 0;
    let padding = 0;

    if (isMotionPhoto && directory) {
      for (const entry of directory) {
        if (entry?.Item?.Semantic === 'MotionPhoto') {
          length = entry.Item.Length ?? 0;
          padding = entry.Item.Padding ?? 0;
          break;
        }
      }
    }

    if (isMicroVideo && typeof videoOffset === 'number') {
      length = videoOffset;
    }

    if (!length && !hasEmbeddedVideoFile && !hasMotionPhotoVideo) {
      return;
    }

    this.logger.debug(`Starting motion photo video extraction for asset ${asset.id}: ${asset.originalPath}`);

    try {
      const position = stats.size - length - padding;
      let video: Buffer;
      // Samsung MotionPhoto video extraction
      //     HEIC-encoded
      if (hasMotionPhotoVideo) {
        video = await this.metadataRepository.extractBinaryTag(asset.originalPath, 'MotionPhotoVideo');
      }
      //     JPEG-encoded; HEIC also contains these tags, so this conditional must come second
      else if (hasEmbeddedVideoFile) {
        video = await this.metadataRepository.extractBinaryTag(asset.originalPath, 'EmbeddedVideoFile');
      }
      // Default video extraction
      else {
        video = await this.storageRepository.readFile(asset.originalPath, {
          buffer: Buffer.alloc(length),
          position,
          length,
        });
      }
      const checksum = this.cryptoRepository.hashSha1(video);
      const existing = await this.assetRepository.getByChecksum({
        ownerId: asset.ownerId,
        libraryId: asset.libraryId ?? undefined,
        checksum,
      });
      if (existing) {
        if (!(await this.storageRepository.checkFileExists(existing.originalPath))) {
          throw new Error('Existing motion video original is missing; repair is required before extracting metadata');
        }
        if (existing.id === asset.livePhotoVideoId) {
          return;
        }
      }
      const motionAssetId = this.cryptoRepository.randomUUID();
      const outputPath = attemptOutputPath(StorageCore.getAndroidMotionPath(asset, motionAssetId));
      this.storageCore.ensureFolders(outputPath);
      await this.storageRepository.createFile(outputPath, video);
      await publishJobResult(async () => {
        await assertPublicationSource(asset.id, asset.checksum);
        const checksumQuery = { ownerId: asset.ownerId, libraryId: asset.libraryId ?? undefined, checksum };
        let motionAsset = await this.assetRepository.getByChecksum(checksumQuery);
        const created = !motionAsset;
        if (!motionAsset) {
          motionAsset = await this.assetRepository.create({
            id: motionAssetId,
            libraryId: asset.libraryId,
            type: AssetType.Video,
            fileCreatedAt: dates.dateTimeOriginal,
            fileModifiedAt: stats.mtime,
            localDateTime: dates.localDateTime,
            checksum,
            checksumAlgorithm: ChecksumAlgorithm.sha1File,
            ownerId: asset.ownerId,
            originalPath: outputPath,
            originalFileName: `${parse(asset.originalFileName).name}.mp4`,
            visibility: AssetVisibility.Hidden,
          });
          if (!asset.isExternal) {
            await this.userRepository.updateUsage(asset.ownerId, video.byteLength);
          }
        }
        if (!created && motionAsset.originalPath !== outputPath) {
          await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [outputPath] } });
        }
        await this.assetRepository.update({ id: asset.id, livePhotoVideoId: motionAsset.id });
        await this.assetRepository.update({ id: motionAsset.id, visibility: AssetVisibility.Hidden });
        if (asset.livePhotoVideoId && asset.livePhotoVideoId !== motionAsset.id) {
          await this.jobRepository.queue({
            name: JobName.AssetDelete,
            data: { id: asset.livePhotoVideoId, deleteOnDisk: true },
          });
        }
        await this.jobRepository.queue({
          name: JobName.AssetExtractMetadata,
          data: { id: motionAsset.id, source: 'motion-photo' },
        });
      });
    } catch (error) {
      // A partial publication must roll back and consume the same single queue retry budget.
      this.logger.error(`Motion extraction failed for asset ${asset.id}`);
      throw error;
    }
  }

  private hasTaggedFaces(tags: ImmichTags): tags is ImmichTagsWithFaces {
    return (
      tags.RegionInfo !== undefined && tags.RegionInfo.AppliedToDimensions && tags.RegionInfo.RegionList.length > 0
    );
  }

  private orientRegionInfo(
    regionInfo: ImmichTagsWithFaces['RegionInfo'],
    orientation: ExifOrientation | undefined,
  ): ImmichTagsWithFaces['RegionInfo'] {
    // skip default Orientation
    if (orientation === undefined || orientation === ExifOrientation.Horizontal) {
      return regionInfo;
    }

    const isSidewards = this.isOrientationSidewards(orientation);

    // swap image dimensions in AppliedToDimensions if orientation is sidewards
    const adjustedAppliedToDimensions = isSidewards
      ? {
          ...regionInfo.AppliedToDimensions,
          W: regionInfo.AppliedToDimensions.H,
          H: regionInfo.AppliedToDimensions.W,
        }
      : regionInfo.AppliedToDimensions;

    // update area coordinates and dimensions in RegionList assuming "normalized" unit as per MWG guidelines
    const adjustedRegionList = regionInfo.RegionList.map((region) => {
      let { X, Y, W, H } = region.Area;

      // EXIF floats with >16 decimals are serialized as strings. Ensure they are numbers.
      X = Number(X);
      Y = Number(Y);
      W = Number(W);
      H = Number(H);

      switch (orientation) {
        case ExifOrientation.MirrorHorizontal: {
          X = 1 - X;
          break;
        }
        case ExifOrientation.Rotate180: {
          [X, Y] = [1 - X, 1 - Y];
          break;
        }
        case ExifOrientation.MirrorVertical: {
          Y = 1 - Y;
          break;
        }
        case ExifOrientation.MirrorHorizontalRotate270CW: {
          [X, Y] = [Y, X];
          break;
        }
        case ExifOrientation.Rotate90CW: {
          [X, Y] = [1 - Y, X];
          break;
        }
        case ExifOrientation.MirrorHorizontalRotate90CW: {
          [X, Y] = [1 - Y, 1 - X];
          break;
        }
        case ExifOrientation.Rotate270CW: {
          [X, Y] = [Y, 1 - X];
          break;
        }
      }
      if (isSidewards) {
        [W, H] = [H, W];
      }
      return {
        ...region,
        Area: { ...region.Area, X, Y, W, H },
      };
    });

    return {
      ...regionInfo,
      AppliedToDimensions: adjustedAppliedToDimensions,
      RegionList: adjustedRegionList,
    };
  }

  private async applyTaggedFaces(
    asset: {
      id: string;
      ownerId: string;
      clusterGroupId: string;
      faces: { id: string; sourceType: SourceType }[];
      originalPath: string;
      visibility: AssetVisibility;
      isLocked?: boolean | null;
    },
    tags: ImmichTags,
  ) {
    if (!tags.RegionInfo?.AppliedToDimensions || tags.RegionInfo.RegionList.length === 0) {
      return;
    }

    const facesToAdd: (Insertable<AssetFaceTable> & { assetId: string })[] = [];
    const existingNames = await this.personRepository.getDistinctNames(asset.ownerId, { withHidden: true });
    const existingNameMap = new Map(
      existingNames.map(({ personGroupId, name }) => [name.toLowerCase(), personGroupId]),
    );
    const missing: { name: string; ownerId: string; personGroupId: string; clusterGroupId: string }[] = [];
    const missingWithFaceAsset: { personGroupId: string; ownerId: string; faceAssetId: string }[] = [];

    const adjustedRegionInfo = this.orientRegionInfo(tags.RegionInfo, tags.Orientation);
    const imageWidth = adjustedRegionInfo.AppliedToDimensions.W;
    const imageHeight = adjustedRegionInfo.AppliedToDimensions.H;

    for (const region of adjustedRegionInfo.RegionList) {
      if (!region.Name) {
        continue;
      }

      const loweredName = region.Name.toLowerCase();
      const personGroupId = existingNameMap.get(loweredName) || this.cryptoRepository.randomUUID();

      const X = Number(region.Area.X);
      const Y = Number(region.Area.Y);
      const W = Number(region.Area.W);
      const H = Number(region.Area.H);

      const face = {
        id: this.cryptoRepository.randomUUID(),
        personGroupId,
        assetId: asset.id,
        imageWidth,
        imageHeight,
        boundingBoxX1: Math.floor((X - W / 2) * imageWidth),
        boundingBoxY1: Math.floor((Y - H / 2) * imageHeight),
        boundingBoxX2: Math.floor((X + W / 2) * imageWidth),
        boundingBoxY2: Math.floor((Y + H / 2) * imageHeight),
        sourceType: SourceType.Exif,
      };

      facesToAdd.push(face);
      if (!existingNameMap.has(loweredName)) {
        missing.push({
          personGroupId,
          ownerId: asset.ownerId,
          clusterGroupId: asset.clusterGroupId,
          name: region.Name,
        });
        // A face on a Locked photo is never a person's thumbnail (FL-53): the person is created without
        // one and takes another face of theirs later (the missing-thumbnail sweep), or keeps none.
        if (!isLockedRow(asset)) {
          missingWithFaceAsset.push({ personGroupId, ownerId: asset.ownerId, faceAssetId: face.id });
        }
      }
    }

    if (missing.length > 0) {
      this.logger.debugFn(() => `Creating missing persons: ${missing.map((p) => `${p.name}/${p.personGroupId}`)}`);
      await this.personRepository.createGroups(
        missing.map((item) => ({ id: item.personGroupId, clusterGroupId: asset.clusterGroupId })),
      );
      await this.personRepository.createAll(
        missing.map(({ name, ownerId, personGroupId }) => ({ name, ownerId, personGroupId })),
      );

      const jobs = missingWithFaceAsset.map(
        ({ personGroupId, ownerId }) =>
          ({ name: JobName.PersonGenerateThumbnail, data: { personGroupId, ownerId } }) as const,
      );
      await this.jobRepository.queueAll(jobs);
    }

    const facesToRemove = asset.faces.filter((face) => face.sourceType === SourceType.Exif).map((face) => face.id);
    if (facesToRemove.length > 0) {
      this.logger.debug(`Removing ${facesToRemove.length} faces for asset ${asset.id}: ${asset.originalPath}`);
    }

    if (facesToAdd.length > 0) {
      this.logger.debug(
        `Creating ${facesToAdd.length} faces from metadata for asset ${asset.id}: ${asset.originalPath}`,
      );
    }

    if (facesToRemove.length > 0 || facesToAdd.length > 0) {
      await this.personRepository.refreshFaces(facesToAdd, facesToRemove);
    }

    if (missingWithFaceAsset.length > 0) {
      await this.personRepository.updateAll(missingWithFaceAsset);
    }
  }

  private getDates(
    asset: { id: string; originalPath: string; fileCreatedAt: Date },
    exifTags: ImmichTags,
    stats: Stats,
  ) {
    const result = firstDateTime(exifTags);
    const tag = result?.tag;
    const dateTime = result?.dateTime;
    if (dateTime) {
      this.logger.verbose(
        `Date and time is ${dateTime} using exifTag ${tag} for asset ${asset.id}: ${asset.originalPath}`,
      );
    } else {
      this.logger.verbose(`No exif date time information found for asset ${asset.id}: ${asset.originalPath}`);
    }

    // timezone
    let timeZone = exifTags.zone ?? null;
    if (timeZone === null && (dateTime?.rawValue?.endsWith('Z') || dateTime?.rawValue?.endsWith('+00:00'))) {
      // exiftool-vendored returns "no timezone" information even though "+00:00" might be set explicitly
      // https://github.com/photostructure/exiftool-vendored.js/issues/203
      timeZone = 'UTC+0';
    }

    if (timeZone) {
      this.logger.verbose(
        `Found timezone ${timeZone} via ${exifTags.zoneSource} for asset ${asset.id}: ${asset.originalPath}`,
      );
    } else {
      this.logger.debug(`No timezone information found for asset ${asset.id}: ${asset.originalPath}`);
    }

    let dateTimeOriginal = dateTime?.toDateTime();

    // do not let JavaScript use local timezone
    if (dateTimeOriginal && !dateTime?.hasZone) {
      dateTimeOriginal = dateTimeOriginal.setZone('UTC', { keepLocalTime: true });
    }

    // align with whatever timeZone we chose
    dateTimeOriginal = dateTimeOriginal?.setZone(timeZone ?? 'UTC');

    // store as "local time"
    let localDateTime = dateTimeOriginal?.setZone('UTC', { keepLocalTime: true });

    if (!localDateTime || !dateTimeOriginal) {
      // FileCreateDate is not available on linux, likely because exiftool hasn't integrated the statx syscall yet
      // birthtime is not available in Docker on macOS, so it appears as 0
      const earliestDate = DateTime.fromMillis(
        Math.min(
          asset.fileCreatedAt.getTime(),
          stats.birthtimeMs ? Math.min(stats.mtimeMs, stats.birthtimeMs) : stats.mtime.getTime(),
        ),
      );
      this.logger.debug(
        `No exif date time found, falling back on ${earliestDate.toISO()}, earliest of file creation and modification for asset ${asset.id}: ${asset.originalPath}`,
      );
      dateTimeOriginal = localDateTime = earliestDate;
    }

    this.logger.verbose(`Found local date time ${localDateTime.toISO()} for asset ${asset.id}: ${asset.originalPath}`);

    return {
      timeZone,
      localDateTime: localDateTime.toJSDate(),
      dateTimeOriginal: dateTimeOriginal.toJSDate(),
    };
  }

  private hasGeo(tags: ImmichTags) {
    const lat = Number(tags.GPSLatitude);
    const lng = Number(tags.GPSLongitude);
    return !Number.isNaN(lat) && !Number.isNaN(lng) && (lat !== 0 || lng !== 0);
  }

  private getAutoStackId(tags: ImmichTags | null): string | null {
    if (!tags) {
      return null;
    }
    return tags.BurstID ?? tags.BurstUUID ?? tags.CameraBurstID ?? tags.MediaUniqueID ?? null;
  }

  private getBitsPerSample(tags: ImmichTags): number | null {
    const bitDepthTags = [
      tags.BitsPerSample,
      tags.ComponentBitDepth,
      tags.ImagePixelDepth,
      tags.BitDepth,
      tags.ColorBitDepth,
      // `numericTags` doesn't parse values like '12 12 12'
    ].map((tag) => (typeof tag === 'string' ? Number.parseInt(tag) : tag));

    let bitsPerSample = validate(bitDepthTags.find((tag) => typeof tag === 'number' && !Number.isNaN(tag)));
    if (bitsPerSample && bitsPerSample >= 24 && bitsPerSample % 3 === 0) {
      bitsPerSample /= 3; // converts per-pixel bit depth to per-channel
    }

    return bitsPerSample;
  }

  private getDuration(tags: ImmichTags): number | null {
    const duration = tags.Duration;
    // eslint-disable-next-line unicorn/prefer-number-coercion
    const seconds = typeof duration === 'number' ? duration : Number.parseFloat(duration as string);
    return Number.isFinite(seconds) ? Math.round(Duration.fromObject({ seconds }).toMillis()) : null;
  }

  private async getVideoTags(originalPath: string) {
    const { videoStreams, audioStreams, format } = await this.mediaRepository.probe(originalPath);
    const video = videoStreams[0];
    const audio = audioStreams[0];
    let packets = null;
    if (video?.timeBase) {
      try {
        packets = await this.mediaRepository.probePackets(originalPath, video.index);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          this.logger.warn(`Skipping packet scan for ${originalPath}: ffprobe stdout maxBuffer exceeded`);
        } else {
          throw error;
        }
      }
    }

    const tags: Pick<ImmichTags, 'Duration' | 'Orientation' | 'ImageWidth' | 'ImageHeight'> = {};

    if (video) {
      if (video.width) {
        tags.ImageWidth = video.width;
      }
      if (video.height) {
        tags.ImageHeight = video.height;
      }

      switch (video.rotation) {
        case -90: {
          tags.Orientation = ExifOrientation.Rotate90CW;
          break;
        }
        case 0: {
          tags.Orientation = ExifOrientation.Horizontal;
          break;
        }
        case 90: {
          tags.Orientation = ExifOrientation.Rotate270CW;
          break;
        }
        case 180: {
          tags.Orientation = ExifOrientation.Rotate180;
          break;
        }
      }
    }

    if (format.duration) {
      tags.Duration = format.duration;
    }

    return { tags, audio, video, packets, format };
  }

  private getHeifOrientation(exifTags: ImmichTags): ExifOrientation | null {
    // https://exiftool.org/TagNames/QuickTime.html#ItemPropCont
    const rotation = typeof exifTags.Rotation === 'number' ? exifTags.Rotation : undefined;
    switch (rotation) {
      case 0: {
        return ExifOrientation.Horizontal;
      }
      case 1: {
        return ExifOrientation.Rotate270CW;
      }
      case 2: {
        return ExifOrientation.Rotate180;
      }
      case 3: {
        return ExifOrientation.Rotate90CW;
      }
      default: {
        return null;
      }
    }
  }
}
