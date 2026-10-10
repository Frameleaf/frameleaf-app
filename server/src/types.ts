import { ShallowDehydrateObject } from 'kysely';
import { Mocked } from 'vitest';
import type { HardwareCheck } from 'src/dtos/hardware-check.dto.js';
import type { CloudDescriptionEstimateRecord } from 'src/utils/cloud-description-batch.js';
import type { CloudMlJobEstimateRecord } from 'src/utils/cloud-ml-job.js';
import type { ConfigHistory } from 'src/utils/config-history.js';
import type { PushNotice } from 'src/utils/frameleaf-push.js';
import type { SuppressionPreferences } from 'src/utils/hidden-content.js';
import type { Rational } from 'src/utils/rational-time.js';
import { VECTOR_EXTENSIONS } from 'src/constants.js';
import { AssetFile } from 'src/database.js';
import { UploadFieldName } from 'src/dtos/asset-media.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { SystemConfig } from 'src/dtos/config.dto.js';
import { AssetEditActionItem } from 'src/dtos/editing.dto.js';
import { SetMaintenanceModeDto } from 'src/dtos/maintenance.dto.js';
import {
  PhysicalDeduplicationCopyState,
  PhysicalDeduplicationRetainedState,
} from 'src/dtos/physical-deduplication.dto.js';
import {
  AacProfile,
  AssetOrder,
  AssetType,
  Av1Profile,
  ColorMatrix,
  ColorPrimaries,
  ColorTransfer,
  DvProfile,
  DvSignalCompatibility,
  ExifOrientation,
  H264Profile,
  HevcProfile,
  ImageFormat,
  IntegrityReport,
  JobName,
  MemoryType,
  QueueName,
  StorageFolder,
  SyncEntityType,
  SystemMetadataKey,
  TranscodeTarget,
  UserMetadataKey,
} from 'src/enum.js';

export type DeepPartial<T> = T extends Date
  ? T
  : T extends Array<infer R>
    ? DeepPartial<R>[]
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

export type RepositoryInterface<T extends object> = Pick<T, keyof T>;

export type FullsizeImageOptions = {
  format: ImageFormat;
  quality: number;
  enabled: boolean;
  progressive?: boolean;
};

export type ImageOptions = {
  format: ImageFormat;
  quality: number;
  size: number;
  progressive?: boolean;
};

export type RawImageInfo = {
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
};

type DecodeImageOptions = {
  colorspace: string;
  processInvalidImages: boolean;
  raw?: RawImageInfo;
  edits?: AssetEditActionItem[];
};

export interface DecodeToBufferOptions extends DecodeImageOptions {
  size?: number;
  orientation?: ExifOrientation;
}

export type GenerateThumbnailOptions = Pick<ImageOptions, 'format' | 'quality' | 'progressive'> & DecodeToBufferOptions;
export type GenerateThumbhashOptions = DecodeImageOptions;

/** A video signal range as ffmpeg names it: `tv` is limited (MPEG) range, `pc` full (JPEG) range. */
export type VideoColorRange = 'tv' | 'pc';

export interface VideoStreamInfo {
  index: number;
  height: number;
  width: number;
  rotation: number;
  codecName: string | null;
  profile: H264Profile | HevcProfile | Av1Profile | null;
  level: number | null;
  frameCount: number;
  frameRate: number | null;
  timeBase: number | null;
  /**
   * FL-93: the exact source time base, in seconds per tick, as ffprobe reported it
   * (`1/30000`). `timeBase` above keeps only the denominator, which is enough for the HLS
   * playlist maths and loses a numerator when a container has one. Optional and additive: a
   * stream that came from persisted metadata rather than a fresh probe does not carry it.
   */
  timeBaseRational?: Rational | null;
  /**
   * FL-93: the exact average cadence as a rational (`30000/1001`). `frameRate` above is that
   * fraction already flattened into a float, which is not a cadence a timeline can be built on.
   */
  frameRateRational?: Rational | null;
  /**
   * FL-102: this stream's own duration in seconds, when the container states one. Optional and
   * additive, like the fields above: persisted metadata does not carry it.
   */
  duration?: number | null;
  /**
   * CLD-202: when this stream's first picture is presented, in seconds, as ffprobe states it. Optional
   * and additive: a re-attached audio track is kept in step with the picture from it.
   */
  startTime?: number | null;
  bitrate: number;
  pixelFormat: string;
  colorPrimaries: ColorPrimaries;
  colorMatrix: ColorMatrix;
  colorTransfer: ColorTransfer;
  /**
   * FL-102: the signal range ffprobe reported (`color_range`): `tv` is limited range, `pc` full
   * range. Null when the stream does not say. Optional and additive like the rationals above: a
   * stream from persisted metadata or an older probe stub does not carry it.
   */
  colorRange?: VideoColorRange | null;
  dvProfile: DvProfile | null;
  dvLevel: number | null;
  dvBlSignalCompatibilityId: DvSignalCompatibility | null;
}

export interface AudioStreamInfo {
  index: number;
  codecName: string | null;
  profile: AacProfile | null;
  bitrate: number;
  /**
   * FL-102 (VID-104): channel-aware audio. Optional and additive so every existing construction
   * site — probe stubs, fixtures, the upstream transcode paths — keeps compiling unchanged, and
   * so an absent value stays distinguishable from a known one. A render never guesses these:
   * when they are unknown it emits no channel argument at all rather than a silent downmix.
   * Populated by `MediaRepository.probe` and persisted on `asset_audio`.
   */
  channels?: number | null;
  channelLayout?: string | null;
  sampleRate?: number | null;
  /** FL-102: this stream's own duration in seconds, when the container states one. */
  duration?: number | null;
  /** CLD-202: when this stream's first sample is presented, in seconds, as ffprobe states it. */
  startTime?: number | null;
}

/** Packet-derived video data needed for accurate HLS playlists. */
export interface VideoPacketInfo {
  /** FL-16: non-discard presentation endpoints, independent of decode order and duration sums.
   * Absent/null means packet timing could not be measured safely; never infer it from fps.
   */
  presentation?: { startPts: number; endPts: number } | null;
  /** FL-105: exact duration/spacing of every sorted non-discard presentation slot.
   * Null/absent means slots are unknown, duplicated, gapped, off-grid or unequal in duration.
   */
  presentationCadenceTicks?: number | null;
  /** Sum of source packet duration across all packets (includes discard). */
  totalDuration: number;
  /** Post-discard packet count. */
  packetCount: number;
  /** Output CFR frame count at `packetCount / format.duration`. */
  outputFrames: number;
  /** All keyframe PTS in source ticks, including pre-roll discard keyframes. */
  keyframePts: number[];
  /** Cumulative packet duration through each keyframe, inclusive. */
  keyframeAccDuration: number[];
  /** Each keyframe's own packet duration (needed for VFR). */
  keyframeOwnDuration: number[];
  /**
   * FL-93: the smallest presentation timestamp in the stream, in source ticks. A container
   * whose first frame is not at zero (an edit list, a recording that starts mid-stream, a
   * burst with a pre-roll) has a nonzero origin, and an export that assumes zero shifts every
   * frame. Optional and additive; `keyframePts[0]` is the persisted fallback.
   */
  startPts?: number;
  /**
   * FL-93: true when the scanned packets do not all carry the same duration, i.e. the source
   * is genuinely variable frame rate. Recorded rather than inferred, because coercing a VFR
   * source to a nominal fps is exactly what this story forbids.
   */
  variableFrameRate?: boolean;
}

export interface VideoFormat {
  formatName?: string;
  formatLongName?: string;
  duration: number;
  bitrate: number;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface VideoInfo {
  format: VideoFormat;
  videoStreams: VideoStreamInfo[];
  audioStreams: AudioStreamInfo[];
}

export interface TranscodeCommand {
  inputOptions: string[];
  outputOptions: string[];
  twoPass: boolean;
  progress: {
    frameCount: number;
    percentInterval: number;
  };
}

export interface VideoTuning {
  strictGop: boolean;
  lowLatency: boolean;
}

export interface HlsCommandOptions {
  initFilename: string;
  inputPath: string;
  packetCount: number;
  playlistFilename: string;
  seekSeconds?: number;
  segmentDuration: number;
  segmentFilename: string;
  startSegment: number;
  target: TranscodeTarget;
  timeBase: number;
  totalDuration: number;
}

export interface BitrateDistribution {
  max: number;
  target: number;
  min: number;
  unit: string;
}

export interface VideoCodecSWConfig {
  getCommand(
    target: TranscodeTarget,
    video: VideoStreamInfo,
    audio?: AudioStreamInfo,
    format?: VideoFormat,
  ): TranscodeCommand;
  getHlsCommand(options: HlsCommandOptions, video: VideoStreamInfo, audio?: AudioStreamInfo): string[];
}

export interface ProbeOptions {
  countFrames: boolean;
}

export interface VideoInterfaces {
  dri: string[];
  mali: boolean;
}

export type ConcurrentQueueName = Exclude<
  QueueName,
  | QueueName.StorageTemplateMigration
  | QueueName.FacialRecognition
  | QueueName.DuplicateDetection
  | QueueName.BackupDatabase
>;

export type Jobs = { [K in JobItem['name']]: (JobItem & { name: K })['data'] };
export type JobOf<T extends JobName> = Jobs[T];

export interface IBaseJob {
  force?: boolean;
}

/** Retried independently after a duplicate decision commits; no original media is carried. */
export type IDuplicateResolutionLifecycleJob = {
  id: string;
  userId: string;
  sidecarIds: string[];
  lockedIds: string[];
  trashIds: string[];
  force: boolean;
};

/** FL-79: `attempt` is 1 for the one automatic retry a failed collection gets. */
export interface IAnalyticsCollectJob {
  attempt?: number;
}

/** FL-71: a preview may retain originals in an account chosen on the page and review one account's copies. */
export interface IPhysicalDeduplicationDryRunJob extends IBaseJob {
  masterUserId?: string;
  scopeUserId?: string;
}

export interface IDelayedJob extends IBaseJob {
  /** The minimum time to wait to execute this job, in milliseconds. */
  delay?: number;
}

export type JobSource = 'upload' | 'sidecar-write' | 'copy' | 'edit' | 'motion-photo';
export interface IPersonJob {
  ownerId: string;
  personGroupId: string;
}

/** FL-43: the `media_operation` row an edit render runs under, when it was recorded as a job. */
export interface IEditOperationJob {
  operationId?: string;
}

/**
 * FL-57: face or person changes that may make generated text name the wrong people. The owner's assets
 * showing `personGroupIds`, and `assetIds`, have their stale generated descriptions regenerated and
 * their stale generated video captions withdrawn.
 */
export interface IPersonIdentityRefreshJob {
  ownerId: string;
  personGroupIds?: string[];
  assetIds?: string[];
}

/** FL-326: one partnership's backfill. */
export interface IPartnerBackfillJob {
  sharedById: string;
  sharedWithId: string;
}

/** FL-326: copy `sourceAssetId` into `targetOwnerId`'s library because `partnerSharedById` shares with them. */
export interface IPartnerCopyAssetJob {
  sourceAssetId: string;
  targetOwnerId: string;
  partnerSharedById: string;
}

/** FL-326: copy `sourceAlbumId` into `targetOwnerId`'s library because `partnerSharedById` shares with them. */
export interface IPartnerCopyAlbumJob {
  sourceAlbumId: string;
  targetOwnerId: string;
  partnerSharedById: string;
}

/** FL-326: push `fields` of a changed source into its following copies (and theirs, onward). */
export interface IPartnerPropagateJob {
  kind: 'asset' | 'album';
  sourceId: string;
  fields: string[];
}

export interface IEntityJob extends IBaseJob {
  id: string;
  source?: JobSource;
  notify?: boolean;
}

export interface IAssetDeleteJob extends IEntityJob {
  deleteOnDisk: boolean;
}

export interface ILibraryFileJob {
  libraryId: string;
  paths: string[];
  progressCounter?: number;
  totalAssets?: number;
}

export interface ILibraryBulkIdsJob {
  libraryId: string;
  importPaths: string[];
  exclusionPatterns: string[];
  assetIds: string[];
  progressCounter: number;
  totalAssets: number;
}

export interface IDeleteFilesJob extends IBaseJob {
  files: Array<string | null | undefined>;
  /**
   * FL-169: set when the removal of this asset queued the job inside its transaction. Its files go
   * only once the asset no longer exists: if the removal rolled back after the job was queued, every
   * file is kept, including ones no remaining row is counted as referencing.
   */
  removedAssetId?: string;
  /**
   * Universal storage: the removed asset's original, so it goes to the file trash with its history
   * even when it was never registered as a physical file. The checksum is hex encoded.
   */
  original?: {
    path: string;
    ownerId: string;
    assetId: string;
    originalFileName: string;
    checksum: string;
    sizeInBytes: number;
  };
}

export interface IDeferrableJob extends IEntityJob {
  deferred?: boolean;
}

export interface IMediaHealthScanJob extends IBaseJob {
  runId?: string;
  missingRunId?: string;
  corruptRunId?: string;
  assetIds?: string[];
  userId?: string;
}

export interface IMediaHealthLocateJob extends IBaseJob {
  runId?: string;
  ids?: string[];
  userId?: string;
  managedSearch?: {
    cursor: Array<{ path: string; after?: string }>;
    matches: Record<string, Record<string, Array<'sha1' | 'sha256'>>>;
  };
}

export interface IMediaHealthDeleteCorruptJob extends IBaseJob {
  ids: string[];
  userId: string;
}

export interface INightlyJob extends IBaseJob {
  nightly?: boolean;
  clusterGroupId?: string;
}

export type EmailImageAttachment = {
  filename: string;
  path: string;
  cid: string;
};

export interface IEmailJob {
  /** Current authority for newly generated album mail; never credentials or stored permissions. */
  albumMailContext?: { albumId: string; recipientId: string; kind: 'invite' | 'update'; senderName?: string };
  to: string;
  subject: string;
  html: string;
  text: string;
  imageAttachments?: EmailImageAttachment[];
}

export interface INotifySignupJob extends IEntityJob {
  password?: string;
}

export interface INotifyAlbumInviteJob extends IEntityJob {
  recipientId: string;
  senderName: string;
}

export interface INotifyAlbumUpdateJob extends IEntityJob, IDelayedJob {
  recipientId: string;
}

/** FL-228: a push notice; tokens and keys are read at delivery, never carried in the job. */
export interface IPushDeliverJob extends IBaseJob {
  notice: PushNotice;
}

export interface IIntegrityJob {
  refreshOnly?: boolean;
}

export interface IIntegrityDeleteReportTypeJob {
  type?: IntegrityReport;
}

export interface IIntegrityDeleteReportsJob {
  reports: {
    id: string;
    assetId: string | null;
    fileAssetId: string | null;
    path: string;
  }[];
}

export interface IIntegrityUntrackedFilesJob {
  type: 'asset' | 'asset_file';
  paths: string[];
  /** FL-81: the full run this batch belongs to; its last batch records "Last run". */
  runId?: string;
}

export interface IIntegrityMissingFilesJob {
  items: ({ path: string; reportId: string | null } & (
    { assetId: string; fileAssetId: null } | { assetId: null; fileAssetId: string }
  ))[];
  /** FL-81: the full run this batch belongs to; its last batch records "Last run". */
  runId?: string;
}

export interface IIntegrityPathWithReportJob {
  items: { path: string; reportId: string | null }[];
  runId?: string;
}

export interface IIntegrityPathWithChecksumJob {
  items: { path: string; reportId: string | null; checksum?: string | null; checksumAlgorithm?: string | null }[];
}

export interface JobCounts {
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  waiting: number;
  paused: number;
}

export type JobItem =
  | { name: JobName.ICloudSync; data: IEntityJob }
  | { name: JobName.ICloudRelations; data: { id: string; ownerId: string } }

  // Audit
  | { name: JobName.AuditTableCleanup; data?: IBaseJob }

  // Backups
  | { name: JobName.DatabaseBackup; data?: IBaseJob }

  // Transcoding
  | { name: JobName.AssetEncodeVideoQueueAll; data: IBaseJob }
  | { name: JobName.AssetEncodeVideo; data: IEntityJob }
  | { name: JobName.StudioHdrProxyGenerate; data: IEntityJob }
  | { name: JobName.AssetVideoEditGeneration; data: IEntityJob & IEditOperationJob & { versionId?: string } }

  // Thumbnails
  | { name: JobName.AssetGenerateThumbnailsQueueAll; data: IBaseJob }
  | { name: JobName.AssetGenerateThumbnails; data: IEntityJob }

  // Best Photos
  | { name: JobName.BestPhotosScoreQueueAll; data: IBaseJob }
  | { name: JobName.BestPhotosScore; data: IEntityJob }

  // Media Health
  | { name: JobName.MediaHealthScanMissing; data: IMediaHealthScanJob }
  | { name: JobName.MediaHealthLocateMissing; data: IMediaHealthLocateJob }
  | { name: JobName.MediaHealthScanCorrupt; data: IMediaHealthScanJob }
  | { name: JobName.MediaHealthDeleteCorrupt; data: IMediaHealthDeleteCorruptJob }

  // User
  | { name: JobName.UserDeleteCheck; data?: IBaseJob }
  | { name: JobName.UserDelete; data: IEntityJob }
  | { name: JobName.UserSyncUsage; data?: IBaseJob }

  // Analytics (FL-79)
  | { name: JobName.AnalyticsCollect; data?: IAnalyticsCollectJob }

  // Storage Template
  | { name: JobName.StorageTemplateMigration; data?: IBaseJob }
  | { name: JobName.StorageTemplateMigrationSingle; data: IEntityJob }
  | { name: JobName.PhysicalDeduplicationMigrationDryRun; data?: IPhysicalDeduplicationDryRunJob }
  | { name: JobName.PhysicalDeduplicationMigrationApply; data?: IBaseJob }

  // Migration
  | { name: JobName.FileMigrationQueueAll; data?: IBaseJob }
  | { name: JobName.AssetFileMigration; data: IEntityJob }
  | { name: JobName.PersonFileMigration; data: IPersonJob }

  // Metadata Extraction
  | { name: JobName.AssetExtractMetadataQueueAll; data: IBaseJob }
  | { name: JobName.AssetExtractMetadata; data: IEntityJob }

  // Notifications
  | { name: JobName.NotificationsCleanup; data?: IBaseJob }

  // Sidecar Scanning
  | { name: JobName.SidecarQueueAll; data: IBaseJob }
  | { name: JobName.SidecarCheck; data: IEntityJob }
  | { name: JobName.SidecarWrite; data: IEntityJob }
  | { name: JobName.DuplicateResolutionLifecycle; data: IDuplicateResolutionLifecycleJob }

  // Facial Recognition
  | { name: JobName.AssetDetectFacesQueueAll; data: IBaseJob }
  | { name: JobName.AssetDetectFaces; data: IEntityJob & { preserveImportedFaces?: boolean } }
  | { name: JobName.FacialRecognitionQueueAll; data: INightlyJob }
  | { name: JobName.FacialRecognition; data: IDeferrableJob & { force?: boolean } }
  | { name: JobName.ProfileImageRepair; data: Record<string, never> }
  | { name: JobName.PersonGenerateThumbnail; data: IPersonJob }
  | { name: JobName.PersonIdentityRefresh; data: IPersonIdentityRefreshJob }

  // Smart Search
  | { name: JobName.SmartSearchQueueAll; data: IBaseJob }
  | { name: JobName.SmartSearch; data: IEntityJob }
  | { name: JobName.SmartSearchPostprocess; data: IEntityJob }
  | { name: JobName.AssetMetadataPostprocess; data: IEntityJob }
  | {
      name: JobName.ImageEnrichmentPostprocess;
      data: IEntityJob & {
        lockedIds?: string[];
        description?: boolean;
        cloudDescription?: boolean;
        videoMomentCaptions?: boolean;
        searchDestinationId?: string;
        planRun?: boolean;
      };
    }
  | { name: JobName.AssetEmptyTrash; data?: IBaseJob }

  // Duplicate Detection
  | { name: JobName.AssetDetectDuplicatesQueueAll; data: IBaseJob }
  | { name: JobName.AssetDetectDuplicates; data: IEntityJob }
  | { name: JobName.AssetGenerateVideoDuplicateFramesQueueAll; data: IBaseJob }
  | { name: JobName.AssetGenerateVideoDuplicateFrames; data: IEntityJob }

  // Memories
  | { name: JobName.MemoryCleanup; data?: IBaseJob }
  | { name: JobName.MemoryGenerate; data?: IBaseJob }
  | { name: JobName.LandmarkMatchAll; data?: IBaseJob }
  | { name: JobName.MemoryExport; data: IEntityJob }

  // Filesystem
  | { name: JobName.FileDelete; data: IDeleteFilesJob }

  // Cleanup
  | { name: JobName.SessionCleanup; data?: IBaseJob }
  | { name: JobName.HlsSessionCleanup; data?: IBaseJob }

  // Tags
  | { name: JobName.TagCleanup; data?: IBaseJob }

  // Asset Deletion
  | { name: JobName.PersonCleanup; data?: IBaseJob }
  | { name: JobName.AssetDelete; data: IAssetDeleteJob }
  | { name: JobName.AssetDeleteCheck; data?: IBaseJob }

  // Library Management
  | { name: JobName.LibrarySyncFiles; data: ILibraryFileJob }
  | { name: JobName.LibrarySyncFilesQueueAll; data: IEntityJob }
  | { name: JobName.LibrarySyncAssetsQueueAll; data: IEntityJob }
  | { name: JobName.LibrarySyncAssets; data: ILibraryBulkIdsJob }
  | { name: JobName.LibraryRemoveAsset; data: ILibraryFileJob }
  | { name: JobName.LibraryDelete; data: IEntityJob }
  | { name: JobName.LibraryScanQueueAll; data?: IBaseJob }
  | { name: JobName.LibraryScanRun; data?: IBaseJob }
  | { name: JobName.LibraryDeleteCheck; data: IBaseJob }

  // Notification
  | { name: JobName.SendMail; data: IEmailJob }
  | { name: JobName.NotifyAlbumInvite; data: INotifyAlbumInviteJob }
  | { name: JobName.NotifyAlbumUpdate; data: INotifyAlbumUpdateJob }
  | { name: JobName.NotifyUserSignup; data: INotifySignupJob }

  // Version check
  | { name: JobName.VersionCheck; data: IBaseJob }

  // Frameleaf Cloud (FL-155, FL-156)
  | { name: JobName.FrameleafHeartbeat; data: IBaseJob }
  | { name: JobName.FrameleafLicenseRefresh; data: IBaseJob }
  // FL-163: one pass over Frameleaf Cloud description batches
  | { name: JobName.CloudMlDescriptionBatch; data: IBaseJob }
  // FL-164: the cloud backup schedule and the verification check
  | { name: JobName.CloudBackupSchedule; data: IBaseJob }
  | { name: JobName.CloudBackupVerify; data: IBaseJob }
  // FL-228: push delivery through the Frameleaf push gateway, and the nightly stale-backup wake-up
  | { name: JobName.PushDeliver; data: IPushDeliverJob }
  | { name: JobName.PushBackupStaleCheck; data?: IBaseJob }
  // FL-326: partner sharing v2 copies
  | { name: JobName.PartnerBackfill; data: IPartnerBackfillJob }
  | { name: JobName.PartnerCopyAsset; data: IPartnerCopyAssetJob }
  | { name: JobName.PartnerCopyAlbum; data: IPartnerCopyAlbumJob }
  | { name: JobName.PartnerPropagate; data: IPartnerPropagateJob }

  // OCR
  | { name: JobName.OcrQueueAll; data: IBaseJob }
  | { name: JobName.Ocr; data: IEntityJob }

  // Image enrichment
  | { name: JobName.ImageDescriptionQueueAll; data: IBaseJob }
  | {
      name: JobName.ImageDescription;
      /** `onlyAffected`: a full rerun under Library care's "Reprocess only affected outputs" (FL-69). */
      data: IEntityJob & { onlyAffected?: boolean };
    }
  /** FL-59: caption a newly described video's reusable frames, when "Describe video moments" is on. */
  | { name: JobName.VideoMomentCaptions; data: IEntityJob }
  | { name: JobName.NsfwDetectionQueueAll; data: IBaseJob }
  | { name: JobName.NsfwDetection; data: IEntityJob }

  // Pet recognition (FL-58). A queue-all without `userId` is the administrator's run over every
  // library; with one it is that owner's run, and `runId` ties its per-asset jobs to the owner's
  // `pet_recognition_run` so a cancel stops them.
  | { name: JobName.PetRecognitionQueueAll; data: IBaseJob & { userId?: string } }
  | { name: JobName.PetRecognition; data: IEntityJob & { runId?: string } }
  | { name: JobName.PetRecognitionNearest; data: { petId: string; assetId: string } }

  // Smart albums. Optional `kind` scopes the re-evaluate to a single built-in
  // kind (one of the SystemConfig['smartAlbums']['builtIn'] keys); omit/undefined
  // means "all kinds".
  | {
      name: JobName.SmartAlbumReevaluateAll;
      data?: IBaseJob & { kind?: keyof SystemConfig['smartAlbums']['builtIn'] };
    }
  | { name: JobName.SmartAlbumReevaluate; data: IEntityJob & { kind?: keyof SystemConfig['smartAlbums']['builtIn'] } }

  // Workflow
  | {
      name: JobName.WorkflowAssetTrigger;
      data: {
        workflowId: string;
        assetId: string;
        /**
         * The run this job belongs to and which attempt it is (FL-82). Set when the run is queued, so a
         * replay of a stalled job logs to the same run; a job queued before that gets a new run id.
         */
        runId?: string;
        attempt?: number;
        /**
         * FL-179: identifies this queued job. Completed steps are recorded under it, so a replay of the
         * same job after its worker stopped skips them. Every newly queued run and retry has its own.
         */
        executionId?: string;
        /** The automatic retry starts at the step that failed; earlier steps already applied. */
        fromStepId?: string;
        /** The complete definition at failure; continuation is refused if it has changed. */
        definitionSha256?: string;
        /** A manual retry is never retried automatically. */
        manual?: boolean;
      };
    }

  // Integrity
  | { name: JobName.IntegrityUntrackedFilesQueueAll; data?: IIntegrityJob }
  | { name: JobName.IntegrityUntrackedFiles; data: IIntegrityUntrackedFilesJob }
  | { name: JobName.IntegrityUntrackedFilesRefresh; data: IIntegrityPathWithReportJob }
  | { name: JobName.IntegrityMissingFilesQueueAll; data?: IIntegrityJob }
  | { name: JobName.IntegrityMissingFiles; data: IIntegrityPathWithReportJob }
  | { name: JobName.IntegrityMissingFilesRefresh; data: IIntegrityPathWithReportJob }
  | { name: JobName.IntegrityChecksumFiles; data?: IIntegrityJob }
  | { name: JobName.IntegrityChecksumFilesRefresh; data?: IIntegrityPathWithChecksumJob }
  | { name: JobName.IntegrityDeleteReportType; data: IIntegrityDeleteReportTypeJob }
  | { name: JobName.IntegrityDeleteReports; data: IIntegrityDeleteReportsJob }
  | { name: JobName.PhotographyWorkflowRender; data: IEntityJob & IDelayedJob }

  // Editor
  | { name: JobName.AssetEditThumbnailGeneration; data: IEntityJob & IEditOperationJob }
  | { name: JobName.AssetDevelopRender; data: IEntityJob & IDelayedJob & IEditOperationJob };

export type VectorExtension = (typeof VECTOR_EXTENSIONS)[number];

export interface ExtensionVersion {
  name: VectorExtension;
  availableVersion: string | null;
  installedVersion: string | null;
}

export interface ImmichFile extends Express.Multer.File {
  uuid: string;
  /** sha256 hash of file */
  checksum: Buffer;
  /** sha1 hash of the same bytes, for clients that pre-check with sha1 */
  legacyChecksum?: Buffer;
}

export interface UploadFile {
  uuid: string;
  checksum: Buffer;
  legacyChecksum?: Buffer;
  originalPath: string;
  originalName: string;
  size: number;
}

export interface UploadBody {
  filename?: string;
  [key: string]: unknown;
}

export type UploadRequest = {
  auth: AuthDto | null;
  fieldName: UploadFieldName;
  file: UploadFile;
  body: UploadBody;
};

export interface UploadFiles {
  assetData: ImmichFile[];
  sidecarData: ImmichFile[];
}

export interface IBulkAsset {
  getAssetIds: (id: string, assetIds: string[]) => Promise<Set<string>>;
  addAssetIds: (id: string, assetIds: string[]) => Promise<void>;
  removeAssetIds: (id: string, assetIds: string[]) => Promise<void>;
}

export type SyncAck = {
  type: SyncEntityType;
  updateId: string;
  extraId?: string;
};

export type StorageAsset = {
  id: string;
  ownerId: string;
  livePhotoVideoId: string | null;
  type: AssetType;
  isExternal: boolean;
  checksum: Buffer;
  timeZone: string | null;
  fileCreatedAt: Date;
  originalPath: string;
  physicalOriginalFileId?: string | null;
  originalFileName: string;
  fileSizeInByte: number | null;
  files: AssetFile[];
  make: string | null;
  model: string | null;
  lensModel: string | null;
};

export type OnThisDayData = { year: number };

export interface MemoryData {
  [MemoryType.OnThisDay]: OnThisDayData;
}

export type VersionCheckMetadata = {
  checkedAt: string;
  releaseVersion: string;
  /** FL-142: this server's random, never-sent place in staged rollouts; kept across checks. */
  rolloutSeed?: string;
};
export type SystemFlags = { mountChecks: Record<StorageFolder, boolean> };
export type PhysicalDeduplicationMigrationState = {
  mode: 'dry-run' | 'apply';
  ranAt: string;
  masterUserId: string;
  eligibleAssets: number;
  linkedAssets: number;
  skippedExternal: number;
  skippedMissingMaster: number;
  reclaimableBytes: number;
  deletedBytes: number;
  samples: string[];
  /** FL-71 preview evidence; absent on records written before the preview contract existed. */
  scopeUserId?: string | null;
  retained?: PhysicalDeduplicationRetainedState[];
  copies?: PhysicalDeduplicationCopyState[];
  copiesTruncated?: boolean;
};
export type MaintenanceModeState =
  { isMaintenanceMode: true; secret: string; action?: SetMaintenanceModeDto } | { isMaintenanceMode: false };
export type MemoriesState = {
  /** memories have already been created through this date */
  lastOnThisDayDate: string;
  /** event stories have already been generated for local days through this date (FL-62) */
  lastEventStoryDate?: string;
  /** the most recent calendar year a year-in-review recap was generated for (FL-62) */
  lastYearInReviewYear?: number;
  /** the most recent calendar year person and pet recaps were generated for (FL-62) */
  lastPersonRecapYear?: number;
};
export type MediaLocation = { location: string };

/**
 * FL-159: the Frameleaf Cloud link as written by linking the server (FL-155, CLD-002). Cloud processing
 * only reads it: without `status: 'linked'` and an `instanceId`, nothing is contacted and every Frameleaf
 * Cloud admission is refused with `cloud-unavailable`.
 */
/** FL-292: the setup state of a server without an administrator (system metadata, never in an API). */
export type FrameleafSetupCodeState = {
  code: string;
  /** `FRAMELEAF_SETUP_CODE`: not replaced after wrong tries, locked until the next start instead. */
  pinned: boolean;
  failures: number;
  locked: boolean;
  generatedAt: string;
  /** The one setup ticket handed out: SHA-256 (hex), the address it is bound to, and its expiry. */
  ticket?: { hash: string; address: string; expiresAt: string };
};

export type FrameleafCloudLink = {
  status: 'unlinked' | 'pending' | 'linked' | 'revoked';
  /** The cloud base address this link was made against; a different FRAMELEAF_CLOUD_URL voids it. */
  cloudUrl: string;
  instanceId?: string;
  accountId?: string;
  accountLabel?: string;
  /** The account's data region (`eu`, `na`); it selects the regional processing gateway. */
  dataRegion?: string;
  linkedAt?: string;
  lastContactAt?: string;
  revoked?: { at: string; reason: string };
  lastError?: string;
  /** FL-155: an RFC 8628 device authorization waiting for approval. Cleared once it ends. */
  pending?: {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresAt: string;
    intervalSeconds: number;
    nextPollAt: string;
    /** The administrator who started linking. */
    startedBy?: string;
  };
  /** FC-18: the regions of the last `region-mismatch` refusal of the headless `FRAMELEAF_LINK_TOKEN`. */
  lastRegionMismatch?: { accountRegion: string; requestedRegion?: string };
  /** FL-155: how the last device authorization ended. */
  lastLinkResult?: 'approved' | 'denied' | 'expired';
  /** FL-177: why Frameleaf Cloud refused the last registration, when it said (shown with its own help). */
  lastLinkRefusal?: FrameleafCloudLinkRefusal;
  /**
   * FC-18: an approved device-flow link token Frameleaf Cloud refused with 409 `region-mismatch`. The
   * cloud wrote nothing and did not spend the token, so it is kept (never returned) until the
   * administrator links in the account's region (`accountRegion`) or cancels, or a new attempt starts.
   */
  heldLink?: {
    linkToken: string;
    accountRegion: string;
    requestedRegion?: string;
    /** The administrator who started linking. */
    startedBy?: string;
  };
  /** FL-155: what Frameleaf Cloud may ask this server to do. */
  permissions?: FrameleafCloudPermissions;
  /**
   * FL-155: the OpenID client Frameleaf Cloud registered for this server (no secret is kept). Since
   * FL-177 the cloud registers it itself; `registrationEndpoint` only survives on older link records.
   */
  oidc?: {
    issuer: string;
    clientId: string;
    registrationEndpoint?: string;
    scope: string;
    roleClaim: string;
    storageLabelClaim: string;
  };
  /** FL-155: service descriptors the cloud returned when the server registered. */
  services?: Record<string, unknown>;
  /** FL-177: the account site's store from discovery, as last seen when linking or checking in. */
  store?: string;
  /**
   * FL-155: desired state of cloud-connected features the cloud may change by command. Unlink and
   * revoke set every flag false; the features that read them never turn on without a link.
   */
  desired?: { remoteAccess: boolean; cloudBackup: boolean };
  /** FL-155: check-in bookkeeping. */
  heartbeat?: {
    nextAt?: string;
    failures: number;
    lastFailureAt?: string;
    cloneSuspected?: boolean;
    relinkRequested?: boolean;
    /**
     * FL-177/FL-178: why the relink was asked for. `key` (every instance route answered `key_retired`)
     * lets later `key_retired` check-ins stay quiet; a relink the cloud commanded does not.
     */
    relinkReason?: 'command' | 'key';
    /**
     * FL-175: the recovery rotation after a damaged key. `nextAttemptAt` spaces retries (at least 20
     * minutes, or the cloud's Retry-After); `closed` means the previous key's window closed and the
     * server must be linked again.
     */
    keyRecovery?: { nextAttemptAt?: string; closed?: boolean };
    /**
     * FL-167: the address the last check-in came from, as Frameleaf Cloud saw it; the edge worker
     * compares it with the router's public address to tell carrier-grade NAT.
     */
    observedIp?: string | null;
    /**
     * FC-62: the notice ids (`fc-notice-<uuid>`, or `fc-notice-<uuid>-<yyyymmdd>` for one that cannot be
     * dismissed) already shown to the administrators, with when, so a notice the cloud keeps sending for
     * up to 90 days is shown once, however soon a dismissed notification is cleaned up.
     */
    shownNotices?: Record<string, string>;
    /**
     * FC-27: the custom hostname failure episode already announced to administrators. A verified
     * hostname clears this, so a later failure is announced once for the new episode.
     */
    customHostnameFailure?: {
      host: string;
      state: 'failing' | 'failed' | 'caa_blocked' | 'missing';
      noticedAt: string;
    };
  };
  /** FL-155: sha256 of headless link tokens already used, so a token never links twice. */
  usedLinkTokens?: string[];
};

/**
 * FL-177: a registration Frameleaf Cloud refused for a reason an administrator can act on:
 * `instance-limit` (402, the plan allows no more servers), `server-refused` (403, the server was
 * removed or the account is suspended), `instance-id-taken` (409, this server's id is registered with
 * another key) and `key-already-linked` (409 `jwk_already_bound`, a copied identity directory).
 */
export type FrameleafCloudLinkRefusal =
  'instance-limit' | 'server-refused' | 'instance-id-taken' | 'key-already-linked' | 'region-mismatch';

/** FL-177: one boot id per server start, shared by every worker (as-built decision #14). */
export type FrameleafBoot = { bootId: string; startedAt: string };

/**
 * FL-185: cloud processing paused because Frameleaf Cloud suspects a copy of this server. It belongs
 * to the link it was recorded for (`cloudUrl`, `instanceId`); a record for another link is ignored.
 */
export type FrameleafMlSuspension = {
  reason: 'clone-suspected';
  cloudUrl: string;
  instanceId: string;
  since: string;
};

/** FL-160: who generated a cloud backup bucket key and where it is kept. */
export type CloudBackupKeyMode = 'server' | 'own-stored' | 'own-memory';

/** FL-160: where cloud backups are stored. FL-164: `managed` is a Frameleaf Cloud backup grant (FC-33). */
export type CloudBackupTarget = 'managed' | 'byo-s3';

/** FL-160: how the last cloud backup run went. Counts are files, not assets. */
export type FrameleafCloudBackupRun = {
  operationId: string;
  status: 'running' | 'waiting-for-key' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  uploaded: number;
  skipped: number;
  missing: number;
  bytesUploaded: number;
  manifestKey?: string;
  error?: string;
};

/**
 * FL-160: this server's cloud backup claim. Never holds the key: `keyFingerprint` only lets a key file
 * be matched to the bucket. The key is a 0600 file under the identity directory (`server`,
 * `own-stored`) or held in memory only (`own-memory`).
 */
export type FrameleafCloudBackup = {
  target: CloudBackupTarget;
  /** Managed storage uses its stable storage ID; BYO uses `<endpoint>/<bucket>`. The object index key. */
  bucketRef: string;
  endpoint: string;
  region: string;
  bucket: string;
  instanceId: string;
  claimedAt: string;
  keyMode: CloudBackupKeyMode;
  keyFingerprint: string;
  /** Set once the first run filled the object index from the bucket listing. */
  reconciledAt?: string;
  lastRun?: FrameleafCloudBackupRun;
  lastSuccessAt?: string;
  lastManifestKey?: string;
  /** The last run's checks of the bucket (listing and claim) that reached the provider. */
  lastCheckAt?: string;
  /** FL-164: the last verification of the bucket, sampled (weekly) or full (monthly). */
  lastVerify?: FrameleafCloudBackupVerification;
  /** FL-164: the last full verification, which decides when the next monthly one is due. */
  lastFullVerifyAt?: string;
  /** FL-164: the last clean-up of runs past their retention, or its dry run. */
  lastPrune?: FrameleafCloudBackupPrune;
  /**
   * FL-164, Frameleaf-managed storage only: what the grant and usage last said. Never a credential: the
   * bucket-scoped key is rotated at the start of every operation and held in memory for that operation.
   */
  managed?: FrameleafCloudBackupManaged;
  /** FL-164: a passphrase-wrapped copy of the bucket key is stored with Frameleaf Cloud (server key mode). */
  escrow?: { storedAt: string };
  /** FL-164: how the last restore from this bucket ended. */
  lastRestore?: FrameleafCloudBackupRestore;
  /** FL-164: a scheduled run found the bucket busy; it starts when the operation holding it ends. */
  scheduledRunDueAt?: string;
};

/** FL-164: one restore from a manifest. Counts are files; `databaseFile` is the dump's name in `<media>/backups`. */
export type FrameleafCloudBackupRestore = {
  operationId: string;
  scope: 'files' | 'asset' | 'album' | 'database' | 'library';
  manifestKey: string;
  status: 'completed' | 'failed' | 'cancelled';
  at: string;
  files: number;
  bytes: number;
  skipped: number;
  replaced: number;
  destination?: string;
  databaseFile?: string;
  /** Deleted items made again, and items whose details came back (manifest v2). */
  recreated?: number;
  detailsRestored?: number;
  error?: string;
};

/** FL-164: one verification of the bucket's objects against their SHA-256 names. */
export type FrameleafCloudBackupVerification = {
  operationId: string;
  depth: 'sample' | 'full';
  at: string;
  status: 'passed' | 'degraded' | 'failed';
  checked: number;
  missing: number;
  mismatched: number;
  /** Manifests marked degraded because they name a missing or damaged object. */
  degradedManifests: number;
  error?: string;
};

/** FL-164: one clean-up of manifests past retention and the objects only they referenced. */
export type FrameleafCloudBackupPrune = {
  operationId: string;
  dryRun: boolean;
  at: string;
  manifestsKept: number;
  manifestsRemoved: number;
  objectsRemoved: number;
  bytesRemoved: number;
  dumpsRemoved: number;
};

/** FL-164: Frameleaf-managed storage as the grant and the usage report last described it. */
export type FrameleafCloudBackupManaged = {
  storageId?: string;
  location?: {
    locationId: string;
    cityId: string;
    city: string;
    country: string;
    countryCode: string;
  };
  readOnly: boolean;
  readOnlyReason: string | null;
  quotaBytes: number;
  usage?: {
    measuredAt: string | null;
    bytesCurrent: number;
    objects: number;
    allowanceBytes: number;
    extraBlocks: number;
  };
  checkedAt: string;
  /** Why the last grant request was refused, in words an administrator can act on. */
  refusal?: string;
};

export type FrameleafCloudPermissions = {
  allowRemoteEnable: boolean;
  allowBackupTrigger: boolean;
  allowEntitlementRefresh: boolean;
};

/**
 * FL-156: the verified claims of a Frameleaf licence certificate (instance contract, "License
 * certificate"). Dates are seconds since the epoch, as in the JWS.
 */
export type FrameleafLicenseClaims = {
  iss: string;
  aud: string;
  sub: string;
  iid: string;
  cnf?: { jkt?: string };
  lic?: { id?: string; last4?: string; kind?: string };
  ent: string[];
  lim?: Record<string, number>;
  lic_exp: number | null;
  upd?: { after?: number; url?: string };
  grace_days?: number;
  iat: number;
  nbf?: number;
  exp: number;
  jti?: string;
};

/** FL-156: this server's licence certificate and its refresh bookkeeping. */
export type FrameleafLicense = {
  certificate: string;
  /** `server` or `individual` for a supporter key, `plan` for a subscription certificate. */
  kind: 'server' | 'individual' | 'plan';
  /** How it arrived: activated by key, installed from an offline file, or delivered to the linked account. */
  source: 'key' | 'file' | 'account';
  kid: string;
  keyHint?: string;
  activationId?: string;
  claims: FrameleafLicenseClaims;
  verifiedAt: string;
  refreshedAt?: string;
  nextRefreshAt?: string;
  lastRefreshError?: string;
};

/**
 * FL-156: the licences held by this server, kept apart so each can be removed on its own: the
 * supporter key's certificate (`key`) and the Frameleaf Cloud plan's (`plan`). `noticeState` is the
 * last state administrators were told about, so grace and expiry notices are sent once.
 */
export type FrameleafLicenseStore = {
  key: FrameleafLicense | null;
  plan: FrameleafLicense | null;
  noticeState?: 'active' | 'grace' | 'expired';
};

/**
 * Plan pricing Frameleaf Cloud publishes on the heartbeat: the prices version and the percentage
 * taken off the Frameleaf Cloud plans on a licensed server (never AI credit or extra backup).
 */
export type FrameleafPricing = {
  pricesVersion: string;
  licensedDiscountPercent: number;
  effectiveFrom: string;
};

/**
 * The published pricing kept in system metadata: the last good value already in force (`current`)
 * and a newer one waiting for its `effectiveFrom` (`pending`). Which one applies is decided when it
 * is read, with the server clock.
 */
export type FrameleafPricingState = {
  current: FrameleafPricing | null;
  pending?: FrameleafPricing;
};

/** FL-159: the public half of this server's identity; the private key stays in a 0600 file. */
export type FrameleafInstanceIdentity = {
  instanceId: string;
  kid: string;
  publicJwk: { kty: 'OKP'; crv: 'Ed25519'; x: string };
  keyFile: string;
  createdAt: string;
  /** FL-155: the key replaced by the last rotation; the cloud keeps accepting it until `until`. */
  retiring?: { kid: string; keyFile: string; until: string; rotationId: string };
  /**
   * FL-155: a new key whose registration with the cloud may or may not have landed (the answer was
   * lost). Kept for at most a day; tried when the cloud stops accepting the current key.
   */
  candidate?: { kid: string; keyFile: string; since: string };
  /**
   * FL-175: the key the cloud accepted in the last rotation could not be read and was set aside, so
   * this server still uses its previous key, which the cloud only accepts for a while. The next
   * check-in rotates again; a finished rotation clears this. The cloud keeps the previous key's
   * original retire deadline (never extended), so recovery must finish by `until`, an upper bound.
   */
  rotationNeeded?: { since: string; until: string };
};

/** FL-159: the cached discovery document (`/.well-known/frameleaf-services`). */
export type FrameleafServiceDiscovery = {
  fetchedAt: string;
  validUntil: string;
  cloudUrl: string;
  document: {
    version: number;
    issuer: string;
    api: string;
    ml: Record<string, string>;
  };
};

/** FL-159: the last AI Wallet read (USD display). `topUpUrl` only when the cloud returned one. */
export type FrameleafMlWallet = {
  balanceUsd: number;
  heldUsd: number;
  dailyCapUsd: number | null;
  spentTodayUsd: number;
  topUpUrl: string | null;
  /** Automatic top-up is on for the account (read from Frameleaf Cloud). */
  autoTopUp?: boolean;
  /**
   * FL-177: the account-app page where the daily cap is raised and automatic top-up turned on (both
   * need the owner there), from the wallet read or the last `step-up-required` answer.
   */
  settingsUrl?: string | null;
  updatedAt: string;
};

/** FL-159: what migration 2100000000620 removed, so administrators are told once in plain language. */
export type FrameleafCloudMigrationNotice = {
  removedDestinations: Array<{ name: string; workloads: string[] }>;
  cancelledOperations: number;
  revokedRenderWorkers?: number;
  createdAt: string;
};

/**
 * FL-163: photos whose description job reached the Frameleaf Cloud route while "Describe new photos
 * automatically" collects them, oldest first, and when each owner's last automatic batch was made.
 */
export type FrameleafCloudDescriptionQueue = {
  items: Array<{ assetId: string; ownerId: string; queuedAt: string }>;
  lastBatchAt: Record<string, string>;
};

/**
 * FL-165: the enrolment Frameleaf Cloud answered `POST /v1/remote/enroll` with (contract
 * `remote/enroll.ts`), kept with the link it belongs to. `domain` is the direct domain the cloud uses
 * now; it is never assumed.
 */
export type FrameleafRemoteEnrollment = {
  cloudUrl: string;
  instanceId: string;
  label: string;
  domain: string;
  names: { relay: string; lanPattern: string; ipv6Pattern: string };
  relay: { id: string; host: string; port: number };
  caa: { issue: string; validationMethods: string; accountUri: string | null };
  certProfile: string;
  renewBeforeDays: number;
  cloneSuspected: boolean;
  /** The link this enrolment was made for (`FrameleafCloudLink.linkedAt`): a new link enrols again. */
  linkedAt?: string;
  enrolledAt: string;
};

/** FL-165: facts about one certificate the edge worker holds. Its private key is a 0600 file that never leaves the host. */
export type FrameleafEdgeCertificate = {
  names: string[];
  serial: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  /** Reported to Frameleaf Cloud (`POST /v1/remote/certs`) as the Certificate Transparency baseline. */
  reported: boolean;
};

/**
 * FL-165: when a certificate is next checked for renewal (daily, with 0–6 h of jitter) and how its
 * issuance is failing: retries wait 1 h, doubling up to 24 h.
 */
export type FrameleafEdgeIssuance = {
  failures: number;
  lastError?: string;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  nextCheckAt?: string;
};

/** FL-165: one connection candidate, in the shape of the cloud's `connections[]` (contract `instance/connections.ts`). */
export type FrameleafRemoteConnection = {
  kind: 'local' | 'wan' | 'relay' | 'ipv6';
  uri: string;
  protocol: 'http' | 'https';
  address: string;
  port: number;
  local: boolean;
  relay: boolean;
  ipv6: boolean;
  custom: boolean;
  dnsRebindingProtection: boolean;
  httpsRequired: boolean;
  verified: boolean;
};

/** FL-165: the last remote access self-check an administrator ran (`POST admin/cloud/remote/test`). */
export type FrameleafRemoteAccessTest = {
  at: string;
  ok: boolean;
  checks: Array<{ id: string; ok: boolean; detail: string }>;
};

/**
 * FL-165: what the edge worker is doing for remote access, written by the edge worker that holds
 * `DatabaseLock.FrameleafEdge` and read by the API. No key or secret is ever part of it.
 */
export type FrameleafRemoteAccess = {
  status: 'off' | 'idle' | 'starting' | 'ready' | 'error';
  /** A new id every time an edge worker starts serving. */
  bootId: string;
  updatedAt: string;
  /** Why it is off, idle or failing, in plain words. */
  reason: string | null;
  /** The enrolment: label, direct domain, names, relay assignment and CAA parameters. */
  names?: FrameleafRemoteEnrollment;
  acmeAccountUri?: string;
  certificate?: FrameleafEdgeCertificate | null;
  certificateIssuance?: FrameleafEdgeIssuance;
  customCertificate?: (FrameleafEdgeCertificate & { host: string }) | null;
  customCertificateIssuance?: FrameleafEdgeIssuance & { host: string };
  /** The relay tunnel (FL-166): which relay, its round trip, since when, bytes and the last problem. */
  relay: {
    connected: boolean;
    relayId?: string;
    host?: string;
    latencyMs?: number;
    connectedAt?: string;
    bytesIn?: number;
    bytesOut?: number;
    lastError?: string;
    lastErrorAt?: string;
    /** Since when there is no tunnel while remote access serves (the admin notice waits 15 minutes). */
    disconnectedSince?: string | null;
    /** Frameleaf Cloud revoked or suspended the tunnel; it is tried again once the server is linked again. */
    revoked?: boolean;
  };
  direct: {
    listening: boolean;
    port: number;
    mapping?: { externalPort: number; method: 'manual' | 'upnp' | 'nat-pmp' } | null;
    cgnatSuspected: boolean;
    /** FL-167: the router's public address (automatic mapping) or the check-in's (manual port). */
    externalIp?: string | null;
    /** FL-167: why the router did not open the port. */
    mappingError?: string | null;
    /** FL-167: `bridge`: in a container no router answered (use host networking or a manual port). */
    guidance?: 'bridge' | null;
    /** FL-167: Frameleaf Cloud's reachability probe of the WAN candidate (`POST /v1/remote/wan-probe`). */
    wan?: { key: string; uri: string | null; verified: boolean; reason: string | null; checkedAt: string } | null;
  };
  candidates: FrameleafRemoteConnection[];
};

export interface SystemMetadata extends Record<SystemMetadataKey, Record<string, any>> {
  [SystemMetadataKey.AdminOnboarding]: { isOnboarded: boolean };
  [SystemMetadataKey.FacialRecognitionState]: { lastRun?: string };
  [SystemMetadataKey.MaintenanceMode]: MaintenanceModeState;
  [SystemMetadataKey.MediaLocation]: MediaLocation;
  [SystemMetadataKey.PhysicalDeduplicationMigration]: PhysicalDeduplicationMigrationState;
  [SystemMetadataKey.ReverseGeocodingState]: { lastUpdate?: string; lastImportFileName?: string };
  [SystemMetadataKey.SystemConfig]: DeepPartial<SystemConfig>;
  [SystemMetadataKey.EffectiveConfigEpoch]: {
    format: 1;
    epoch: number;
    sourceKind: 'database' | 'file';
    digest: string;
    trashEnabled: boolean;
    recoveryMl?: import('src/utils/recovery-ml-authority.js').RecoveryMlOverlay;
    recoveryMlBinding?: import('src/utils/recovery-ml-authority.js').RecoveryMlBinding;
  };
  [SystemMetadataKey.FrameleafRecoveryMlAuthority]: import('src/utils/recovery-ml-authority.js').RecoveryMlRegistry;
  [SystemMetadataKey.SystemFlags]: DeepPartial<SystemFlags>;
  [SystemMetadataKey.VersionCheckState]: VersionCheckMetadata;
  [SystemMetadataKey.MemoriesState]: MemoriesState;
  [SystemMetadataKey.FrameleafCloudLink]: FrameleafCloudLink;
  [SystemMetadataKey.FrameleafInstance]: FrameleafInstanceIdentity;
  [SystemMetadataKey.FrameleafServerId]: { id: string; createdAt: string };
  [SystemMetadataKey.FrameleafSetupCode]: FrameleafSetupCodeState;
  [SystemMetadataKey.FrameleafServiceDiscovery]: FrameleafServiceDiscovery;
  [SystemMetadataKey.FrameleafMlWallet]: FrameleafMlWallet;
  [SystemMetadataKey.FrameleafLicense]: FrameleafLicenseStore;
  [SystemMetadataKey.FrameleafPricing]: FrameleafPricingState;
  [SystemMetadataKey.FrameleafBoot]: FrameleafBoot;
  [SystemMetadataKey.FrameleafMlSuspension]: FrameleafMlSuspension;
  [SystemMetadataKey.FrameleafCloudBackup]: FrameleafCloudBackup;
  [SystemMetadataKey.FrameleafRemoteAccess]: FrameleafRemoteAccess;
  [SystemMetadataKey.FrameleafRemoteAccessTest]: FrameleafRemoteAccessTest;
  [SystemMetadataKey.HardwareCheck]: HardwareCheck;
  [SystemMetadataKey.FrameleafCloudMigrationNotice]: FrameleafCloudMigrationNotice;
  [SystemMetadataKey.FrameleafCloudDescriptionQueue]: FrameleafCloudDescriptionQueue;
  [SystemMetadataKey.FrameleafCloudDescriptionEstimates]: { records: CloudDescriptionEstimateRecord[] };
  [SystemMetadataKey.FrameleafCloudMlJobEstimates]: {
    records: CloudMlJobEstimateRecord[];
    /** FL-162: whole videos prepared once for their estimates, dropped a day after nothing uses them. */
    prepared?: { dir: string; ownerId: string; at: string }[];
  };
  [SystemMetadataKey.IntegrityChecksumCheckpoint]: { date?: string };
  [SystemMetadataKey.SystemConfigHistory]: ConfigHistory;
  [SystemMetadataKey.IntegrityCheckRuns]: IntegrityCheckRuns;
  [SystemMetadataKey.BackupRestoreVerification]: BackupRestoreVerification;
  [SystemMetadataKey.FrameleafSetup]: FrameleafSetupState;
}

/** FL-176: which first-run setup flow an administrator sees. */
export type FrameleafSetupFlow = 'new' | 'existing';

/** FL-176: the saved first-run setup state. `progress` is the validated, password-free step payload. */
export type FrameleafSetupState = {
  completed: boolean;
  completedAt: string | null;
  flow: FrameleafSetupFlow | null;
  progress: Record<string, unknown> | null;
  updatedAt: string | null;
};

/** FL-71: the last recorded restore test of each part of a backup (ISO date-times), and who recorded it. */
export type BackupRestoreVerification = {
  metadataVerifiedAt?: string | null;
  originalsVerifiedAt?: string | null;
  verifiedBy?: string | null;
};

/**
 * FL-81: per integrity check, when its last full run completed (ISO date-time), and the run in
 * progress: its batches once all are queued (null until then) and how many have finished.
 */
export type IntegrityCheckRun = { runId: string; startedAt: string; batches: number | null; done: number };
export type IntegrityCheckRuns = Partial<Record<IntegrityReport, { lastRunAt?: string; current?: IntegrityCheckRun }>>;

export type UserPreferences = {
  /** FL-329: origin-rendered system text; device overrides are scoped to signed-in sessions. */
  notifications?: import('src/utils/notification-locale.js').NotificationLocalePreferences;
  albums: {
    defaultAssetOrder: AssetOrder;
  };
  folders: {
    enabled: boolean;
    sidebarWeb: boolean;
  };
  memories: {
    enabled: boolean;
    duration: number;
    sidebarWeb: boolean;
  };
  people: {
    enabled: boolean;
    sidebarWeb: boolean;
    minimumFaces: number;
  };
  ratings: {
    enabled: boolean;
  };
  sharedLinks: {
    enabled: boolean;
    sidebarWeb: boolean;
  };
  tags: {
    enabled: boolean;
    sidebarWeb: boolean;
  };
  emailNotifications: {
    enabled: boolean;
    albumInvite: boolean;
    albumUpdate: boolean;
  };
  download: {
    archiveSize: number;
    includeEmbeddedVideos: boolean;
  };
  purchase: {
    showSupportBadge: boolean;
    hideBuyButtonUntil: string;
  };
  cast: {
    gCastEnabled: boolean;
  };
  privacy: {
    suppression: SuppressionPreferences;
  };
  recentlyAdded: {
    sidebarWeb: boolean;
  };
  /** FL-49: named searches from the search palette; `query` is the client's own search body */
  savedSearches: SavedSearch[];
};

export type SavedSearch = { name: string; query: Record<string, unknown> };

export type UserMetadataItem<T extends keyof UserMetadata = UserMetadataKey> = {
  key: T;
  value: UserMetadata[T];
};

export interface UserMetadata extends Record<UserMetadataKey, Record<string, any>> {
  [UserMetadataKey.PhotographyWorkspace]: {
    shoots: import('src/dtos/photography-workspace.dto.js').StoredShoot[];
    brand?: import('src/dtos/photography-workspace.dto.js').PhotographyBrand;
  };
  [UserMetadataKey.PinnedCollections]: { pins: import('src/dtos/pinned-collection.dto.js').StoredPinnedCollection[] };
  [UserMetadataKey.Preferences]: DeepPartial<UserPreferences>;
  /** FL-156: a mirror of the person's supporter key summary (`public.frameleaf_user_license`). */
  [UserMetadataKey.License]: { kind: 'individual'; keyHint: string; activatedAt: string };
  [UserMetadataKey.Onboarding]: { isOnboarded: boolean };
  /** FL-196: the first time this administrator ended the linked-server tour. */
  [UserMetadataKey.FrameleafCloudTour]: {
    seenAt: string;
    ending: 'finished' | 'skipped' | 'opened-settings' | 'setup';
  };
  /** FL-326: when Locked partner copies first reached this account without a PIN, and when it was dismissed. */
  [UserMetadataKey.PartnerLockedNotice]: { flaggedAt: string; dismissedAt: string | null };
}

export type MaybeDehydrated<T> = T | ShallowDehydrateObject<T>;

export type JSONSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object';

export type JSONSchemaProperty = {
  type: JSONSchemaType;
  description?: string;
  default?: any;
  enum?: string[];
  array?: boolean;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
};

export type ClassConstructor<T> = T extends new (...args: infer R) => infer L
  ? new (...args: R) => L
  : new (...args: any[]) => unknown;

export type ClassConstructorsToInstances<T extends readonly ClassConstructor<unknown>[]> = {
  [K in keyof T]: InstanceType<T[K]> | Mocked<InstanceType<T[K]>>;
};
