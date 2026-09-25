import { ShallowDehydrateObject } from 'kysely';
import { Mocked } from 'vitest';
import type { BackfillKind } from 'src/repositories/fork-schema.repository.js';
import type { ConfigHistory } from 'src/utils/config-history.js';
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
}

/** Packet-derived video data needed for accurate HLS playlists. */
export interface VideoPacketInfo {
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

/** FL-79: `attempt` is 1 for the one automatic retry a failed collection gets. */
export interface IAnalyticsCollectJob {
  attempt?: number;
}

/** FL-71: a preview may retain originals in an account chosen on the page and review one account's copies. */
export interface IPhysicalDeduplicationDryRunJob extends IBaseJob {
  masterUserId?: string;
  scopeUserId?: string;
}

export interface IForkSchemaBackfillJob {
  kind: BackfillKind;
  batchSize: number;
}

export interface IDelayedJob extends IBaseJob {
  /** The minimum time to wait to execute this job, in milliseconds. */
  delay?: number;
}

export type JobSource = 'upload' | 'sidecar-write' | 'copy' | 'edit';
export interface IPersonJob {
  ownerId: string;
  personGroupId: string;
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
  // Fork schema migration
  | { name: JobName.ForkSchemaBackfill; data: IForkSchemaBackfillJob }

  // Audit
  | { name: JobName.AuditTableCleanup; data?: IBaseJob }

  // Backups
  | { name: JobName.DatabaseBackup; data?: IBaseJob }

  // Transcoding
  | { name: JobName.AssetEncodeVideoQueueAll; data: IBaseJob }
  | { name: JobName.AssetEncodeVideo; data: IEntityJob }
  | { name: JobName.AssetVideoEditGeneration; data: IEntityJob & { versionId?: string } }

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

  // Facial Recognition
  | { name: JobName.AssetDetectFacesQueueAll; data: IBaseJob }
  | { name: JobName.AssetDetectFaces; data: IEntityJob }
  | { name: JobName.FacialRecognitionQueueAll; data: INightlyJob }
  | { name: JobName.FacialRecognition; data: IDeferrableJob }
  | { name: JobName.PersonGenerateThumbnail; data: IPersonJob }
  | { name: JobName.PersonIdentityRefresh; data: IPersonIdentityRefreshJob }

  // Smart Search
  | { name: JobName.SmartSearchQueueAll; data: IBaseJob }
  | { name: JobName.SmartSearch; data: IEntityJob }
  | { name: JobName.AssetEmptyTrash; data?: IBaseJob }

  // Duplicate Detection
  | { name: JobName.AssetDetectDuplicatesQueueAll; data: IBaseJob }
  | { name: JobName.AssetDetectDuplicates; data: IEntityJob }
  | { name: JobName.AssetGenerateVideoDuplicateFramesQueueAll; data: IBaseJob }
  | { name: JobName.AssetGenerateVideoDuplicateFrames; data: IEntityJob }

  // Memories
  | { name: JobName.MemoryCleanup; data?: IBaseJob }
  | { name: JobName.MemoryGenerate; data?: IBaseJob }
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

  // OCR
  | { name: JobName.OcrQueueAll; data: IBaseJob }
  | { name: JobName.Ocr; data: IEntityJob }

  // Image enrichment
  | { name: JobName.ImageDescriptionQueueAll; data: IBaseJob }
  | { name: JobName.ImageDescription; data: IEntityJob }
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

  // Workflow
  | {
      name: JobName.WorkflowAssetTrigger;
      data: {
        workflowId: string;
        assetId: string;
        /** Set on retries: the run they continue and which attempt this is (FL-82). */
        runId?: string;
        attempt?: number;
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

  // Editor
  | { name: JobName.AssetEditThumbnailGeneration; data: IEntityJob }
  | { name: JobName.AssetDevelopRender; data: IEntityJob & IDelayedJob };

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

export type VersionCheckMetadata = { checkedAt: string; releaseVersion: string };
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

export type RunPodPersistedState =
  | { status: 'idle'; instanceTag?: string }
  | {
      status: 'provisioning' | 'starting';
      podId: string;
      podCreatedAt: string;
      gpuTypeId: string;
      imageName: string;
      authToken: string;
      instanceTag: string;
    }
  | {
      status: 'running';
      podId: string;
      podCreatedAt: string;
      gpuTypeId: string;
      imageName: string;
      mlUrl: string;
      authToken: string;
      runningSince: string;
      lastBusyAt: string;
      maxRuntimeHours: number;
      instanceTag: string;
      unhealthySince?: string;
    }
  | {
      status: 'stopping';
      podId: string;
      podCreatedAt?: string;
      gpuTypeId: string;
      imageName: string;
      authToken: string;
      instanceTag: string;
      stopAttempts: number;
      lastStopAttemptAt?: string;
    }
  | {
      status: 'stopped';
      podId: string;
      podCreatedAt: string;
      gpuTypeId: string;
      imageName: string;
      authToken: string;
      stoppedAt: string;
      instanceTag: string;
    }
  | {
      status: 'error';
      podId?: string;
      gpuTypeId?: string;
      imageName?: string;
      message: string;
      errorAt: string;
      instanceTag: string;
    }
  // Serverless variants — runtime is fully managed by RunPod so the lifecycle
  // is much simpler than pod mode: we just create the template + endpoint once
  // and the endpoint scales workers 0→N on demand. No "running"/"stopped"
  // distinction because the endpoint itself is always "there"; only the
  // workers scale.
  | {
      status: 'serverless-provisioning';
      instanceTag: string;
      imageName: string;
      attemptedAt: string;
    }
  | {
      status: 'serverless-ready';
      instanceTag: string;
      templateId: string;
      endpointId: string;
      endpointUrl: string;
      imageName: string;
      gpuTypeIds: string[];
      workersMin: number;
      workersMax: number;
      idleTimeoutSeconds: number;
      createdAt: string;
    };

export interface SystemMetadata extends Record<SystemMetadataKey, Record<string, any>> {
  [SystemMetadataKey.AdminOnboarding]: { isOnboarded: boolean };
  [SystemMetadataKey.FacialRecognitionState]: { lastRun?: string };
  [SystemMetadataKey.License]: { licenseKey: string; activationKey: string; activatedAt: Date };
  [SystemMetadataKey.MaintenanceMode]: MaintenanceModeState;
  [SystemMetadataKey.MediaLocation]: MediaLocation;
  [SystemMetadataKey.PhysicalDeduplicationMigration]: PhysicalDeduplicationMigrationState;
  [SystemMetadataKey.ReverseGeocodingState]: { lastUpdate?: string; lastImportFileName?: string };
  [SystemMetadataKey.SystemConfig]: DeepPartial<SystemConfig>;
  [SystemMetadataKey.SystemFlags]: DeepPartial<SystemFlags>;
  [SystemMetadataKey.VersionCheckState]: VersionCheckMetadata;
  [SystemMetadataKey.MemoriesState]: MemoriesState;
  [SystemMetadataKey.RunPodState]: RunPodPersistedState;
  [SystemMetadataKey.RunPodOrphans]: { orphanTemplateIds: string[] };
  [SystemMetadataKey.IntegrityChecksumCheckpoint]: { date?: string };
  [SystemMetadataKey.SystemConfigHistory]: ConfigHistory;
  [SystemMetadataKey.IntegrityCheckRuns]: IntegrityCheckRuns;
  [SystemMetadataKey.BackupRestoreVerification]: BackupRestoreVerification;
}

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
  [UserMetadataKey.Preferences]: DeepPartial<UserPreferences>;
  [UserMetadataKey.License]: { licenseKey: string; activationKey: string; activatedAt: string };
  [UserMetadataKey.Onboarding]: { isOnboarded: boolean };
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
