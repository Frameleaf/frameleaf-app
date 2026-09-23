import { WorkflowTrigger } from '@immich/plugin-sdk';
import z from 'zod';

export enum AuthType {
  Password = 'password',
  OAuth = 'oauth',
}

export enum ImmichCookie {
  AccessToken = 'immich_access_token',
  MaintenanceToken = 'immich_maintenance_token',
  AuthType = 'immich_auth_type',
  IsAuthenticated = 'immich_is_authenticated',
  SharedLinkToken = 'immich_shared_link_token',
  OAuthState = 'immich_oauth_state',
  OAuthCodeVerifier = 'immich_oauth_code_verifier',
}

export enum ImmichHeader {
  ApiKey = 'x-api-key',
  UserToken = 'x-immich-user-token',
  SessionToken = 'x-immich-session-token',
  SharedLinkKey = 'x-immich-share-key',
  SharedLinkSlug = 'x-immich-share-slug',
  Checksum = 'x-immich-checksum',
  CorrelationId = 'X-Correlation-ID',
  HlsInitSegment = 'x-immich-hls-msn',
  HlsPosition = 'x-immich-hls-pos',
  /** The scoped, expiring session credential a render worker was handed at admission (FL-95). */
  RenderWorkerSession = 'x-frameleaf-worker-session',
}

export enum ImmichQuery {
  SharedLinkKey = 'key',
  SharedLinkSlug = 'slug',
  ApiKey = 'apiKey',
  SessionKey = 'sessionKey',
}

export enum AssetType {
  Image = 'IMAGE',
  Video = 'VIDEO',
  Audio = 'AUDIO',
  Other = 'OTHER',
}

export const AssetTypeSchema = z.enum(AssetType).describe('Asset type').meta({ id: 'AssetTypeEnum' });

export enum ChecksumAlgorithm {
  /** sha1 checksum of the whole file contents — legacy, accepted on read but never written for new uploads */
  sha1File = 'sha1',
  /** sha1 checksum of "path:" plus the file path, currently used in external libraries, deprecated */
  sha1Path = 'sha1-path',
  /** sha256 checksum of the whole file contents — default for new server-handled uploads */
  sha256File = 'sha256',
}

export enum AssetFileType {
  /**
   * An full/large-size image extracted/converted from RAW photos
   */
  FullSize = 'fullsize',
  Preview = 'preview',
  Thumbnail = 'thumbnail',
  Sidecar = 'sidecar',
  EncodedVideo = 'encoded_video',
}

export const AssetFileTypeSchema = z.enum(AssetFileType).describe('Type of file').meta({ id: 'AssetFileType' });

export enum AlbumUserRole {
  Editor = 'editor',
  Owner = 'owner',
  Viewer = 'viewer',
}

export const AlbumUserRoleSchema = z.enum(AlbumUserRole).describe('Album user role').meta({ id: 'AlbumUserRole' });

/**
 * What an album row represents. An album holds photos; a collection is a named
 * group of albums, one level deep; a shared space is a top-level library that
 * several people add to. Albums nest only inside collections; collections and
 * spaces never nest.
 */
export enum AlbumKind {
  Album = 'album',
  Collection = 'collection',
  Space = 'space',
}

export const AlbumKindSchema = z
  .enum(AlbumKind)
  .describe('Album kind: album (holds photos), collection (groups albums one level deep) or space (shared, top level)')
  .meta({ id: 'AlbumKind' });

export enum AssetOrder {
  Asc = 'asc',
  Desc = 'desc',
}

export const AssetOrderSchema = z.enum(AssetOrder).describe('Asset sort order').meta({ id: 'AssetOrder' });

export enum AssetOrderBy {
  TakenAt = 'takenAt',
  CreatedAt = 'createdAt',
}

export const AssetOrderBySchema = z.enum(AssetOrderBy).describe('Asset sorting property').meta({ id: 'AssetOrderBy' });

export enum TimeBucketDateType {
  Added = 'added',
  Taken = 'taken',
}

export const TimeBucketDateTypeSchema = z
  .enum(TimeBucketDateType)
  .describe('Date source for timeline bucket grouping')
  .meta({ id: 'TimeBucketDateType' });

export enum ImageEnrichmentFilter {
  Nsfw = 'nsfw',
  NsfwReview = 'nsfw-review',
  NsfwReviewed = 'nsfw-reviewed',
  NsfwOverridden = 'nsfw-overridden',
  ImageDescriptionFailed = 'image-description-failed',
  NsfwDetectionFailed = 'nsfw-detection-failed',
  MissingImageDescription = 'missing-image-description',
  MissingNsfwDetection = 'missing-nsfw-detection',
}

export const ImageEnrichmentFilterSchema = z
  .enum(ImageEnrichmentFilter)
  .describe('Filter by private image enrichment state')
  .meta({ id: 'ImageEnrichmentFilter' });

export enum MachineLearningHardwareAcceleration {
  Auto = 'auto',
  OpenVino = 'openvino',
  Cuda = 'cuda',
}

export const MachineLearningHardwareAccelerationSchema = z
  .enum(MachineLearningHardwareAcceleration)
  .describe('Machine learning hardware acceleration backend')
  .meta({ id: 'MachineLearningHardwareAcceleration' });

export enum MemoryType {
  /** pictures taken on this day X years ago */
  OnThisDay = 'on_this_day',
  /** a multi-day trip or occasion, grouped by the owner's local capture time and place */
  EventStory = 'event_story',
  /** a recap of one calendar year of the owner's library */
  YearInReview = 'year_in_review',
}

export const MemoryTypeSchema = z.enum(MemoryType).describe('Memory type').meta({ id: 'MemoryType' });

/**
 * Lifecycle of a private highlight export (FL-62). `Cancelling` is a request recorded by
 * the owner that the running worker observes between assets; the worker is what moves the
 * run to `Cancelled`, so a cancel is durable across a worker restart.
 */
export enum MemoryExportStatus {
  Pending = 'pending',
  Running = 'running',
  Ready = 'ready',
  Failed = 'failed',
  Cancelling = 'cancelling',
  Cancelled = 'cancelled',
}

export const MemoryExportStatusSchema = z
  .enum(MemoryExportStatus)
  .describe('Memory export status')
  .meta({ id: 'MemoryExportStatus' });

export enum MemoryExportFormat {
  /** a zip of the memory's original files */
  Archive = 'archive',
}

export const MemoryExportFormatSchema = z
  .enum(MemoryExportFormat)
  .describe('Memory export format')
  .meta({ id: 'MemoryExportFormat' });

export enum AssetOrderWithRandom {
  // Include existing values
  Asc = AssetOrder.Asc,
  Desc = AssetOrder.Desc,
  /** Randomly Ordered */
  Random = 'random',
}

export const AssetOrderWithRandomSchema = z
  .enum(AssetOrderWithRandom)
  .describe('Sort order')
  .meta({ id: 'MemorySearchOrder' });

export enum Permission {
  All = 'all',

  ActivityCreate = 'activity.create',
  ActivityRead = 'activity.read',
  ActivityUpdate = 'activity.update',
  ActivityDelete = 'activity.delete',
  ActivityStatistics = 'activity.statistics',

  ApiKeyCreate = 'apiKey.create',
  ApiKeyRead = 'apiKey.read',
  ApiKeyUpdate = 'apiKey.update',
  ApiKeyDelete = 'apiKey.delete',
  ApiKeyRotate = 'apiKey.rotate',

  // ASSET_CREATE = 'asset.create',
  AssetRead = 'asset.read',
  AssetUpdate = 'asset.update',
  AssetDelete = 'asset.delete',
  AssetStatistics = 'asset.statistics',
  AssetShare = 'asset.share',
  AssetView = 'asset.view',
  AssetDownload = 'asset.download',
  AssetUpload = 'asset.upload',
  AssetCopy = 'asset.copy',
  AssetDerive = 'asset.derive',

  AssetFileRead = 'assetFile.read',
  AssetFileDelete = 'assetFile.delete',
  AssetFileDownload = 'assetFile.download',

  AssetEditGet = 'asset.edit.get',
  AssetEditCreate = 'asset.edit.create',
  AssetEditDelete = 'asset.edit.delete',

  AlbumCreate = 'album.create',
  AlbumRead = 'album.read',
  AlbumUpdate = 'album.update',
  AlbumDelete = 'album.delete',
  AlbumStatistics = 'album.statistics',
  AlbumShare = 'album.share',
  AlbumDownload = 'album.download',

  AlbumAssetCreate = 'albumAsset.create',
  AlbumAssetDelete = 'albumAsset.delete',

  AlbumUserCreate = 'albumUser.create',
  AlbumUserUpdate = 'albumUser.update',
  AlbumUserDelete = 'albumUser.delete',

  AuthChangePassword = 'auth.changePassword',

  AuthDeviceDelete = 'authDevice.delete',

  ArchiveRead = 'archive.read',

  BackupList = 'backup.list',
  BackupDownload = 'backup.download',
  BackupUpload = 'backup.upload',
  BackupDelete = 'backup.delete',

  ClusterGroupRead = 'clusterGroup.read',
  ClusterGroupLeave = 'clusterGroup.leave',
  ClusterGroupRequestCreate = 'clusterGroupRequest.create',
  ClusterGroupRequestRead = 'clusterGroupRequest.read',
  ClusterGroupRequestDelete = 'clusterGroupRequest.delete',

  AdminConfigRead = 'adminConfig.read',
  AdminConfigUpdate = 'adminConfig.update',

  UserConfigRead = 'userConfig.read',

  DuplicateRead = 'duplicate.read',
  DuplicateDelete = 'duplicate.delete',

  FaceCreate = 'face.create',
  FaceRead = 'face.read',
  FaceUpdate = 'face.update',
  FaceDelete = 'face.delete',

  FolderRead = 'folder.read',

  JobCreate = 'job.create',
  JobRead = 'job.read',

  LibraryCreate = 'library.create',
  LibraryRead = 'library.read',
  LibraryUpdate = 'library.update',
  LibraryDelete = 'library.delete',
  LibraryStatistics = 'library.statistics',

  TimelineRead = 'timeline.read',
  TimelineDownload = 'timeline.download',

  Maintenance = 'maintenance',

  MapRead = 'map.read',
  MapSearch = 'map.search',

  MemoryCreate = 'memory.create',
  MemoryRead = 'memory.read',
  MemoryUpdate = 'memory.update',
  MemoryDelete = 'memory.delete',
  MemoryStatistics = 'memory.statistics',

  MemoryAssetCreate = 'memoryAsset.create',
  MemoryAssetDelete = 'memoryAsset.delete',

  NotificationCreate = 'notification.create',
  NotificationRead = 'notification.read',
  NotificationUpdate = 'notification.update',
  NotificationDelete = 'notification.delete',

  PartnerCreate = 'partner.create',
  PartnerRead = 'partner.read',
  PartnerUpdate = 'partner.update',
  PartnerDelete = 'partner.delete',

  PersonCreate = 'person.create',
  PersonRead = 'person.read',
  PersonUpdate = 'person.update',
  PersonDelete = 'person.delete',
  PersonStatistics = 'person.statistics',
  PersonMerge = 'person.merge',
  PersonReassign = 'person.reassign',

  PinCodeCreate = 'pinCode.create',
  PinCodeUpdate = 'pinCode.update',
  PinCodeDelete = 'pinCode.delete',

  PluginCreate = 'plugin.create',
  PluginRead = 'plugin.read',
  PluginUpdate = 'plugin.update',
  PluginDelete = 'plugin.delete',

  ServerAbout = 'server.about',
  ServerApkLinks = 'server.apkLinks',
  ServerStorage = 'server.storage',
  ServerStatistics = 'server.statistics',
  ServerVersionCheck = 'server.versionCheck',

  ServerLicenseRead = 'serverLicense.read',
  ServerLicenseUpdate = 'serverLicense.update',
  ServerLicenseDelete = 'serverLicense.delete',

  SessionCreate = 'session.create',
  SessionRead = 'session.read',
  SessionUpdate = 'session.update',
  SessionDelete = 'session.delete',
  SessionLock = 'session.lock',

  SharedLinkCreate = 'sharedLink.create',
  SharedLinkRead = 'sharedLink.read',
  SharedLinkUpdate = 'sharedLink.update',
  SharedLinkDelete = 'sharedLink.delete',

  StackCreate = 'stack.create',
  StackRead = 'stack.read',
  StackUpdate = 'stack.update',
  StackDelete = 'stack.delete',

  SyncStream = 'sync.stream',
  SyncCheckpointRead = 'syncCheckpoint.read',
  SyncCheckpointUpdate = 'syncCheckpoint.update',
  SyncCheckpointDelete = 'syncCheckpoint.delete',

  SystemConfigRead = 'systemConfig.read',
  SystemConfigUpdate = 'systemConfig.update',

  SystemMetadataRead = 'systemMetadata.read',
  SystemMetadataUpdate = 'systemMetadata.update',

  TagCreate = 'tag.create',
  TagRead = 'tag.read',
  TagUpdate = 'tag.update',
  TagDelete = 'tag.delete',
  TagAsset = 'tag.asset',

  UserRead = 'user.read',
  UserUpdate = 'user.update',

  UserLicenseCreate = 'userLicense.create',
  UserLicenseRead = 'userLicense.read',
  UserLicenseUpdate = 'userLicense.update',
  UserLicenseDelete = 'userLicense.delete',

  UserOnboardingRead = 'userOnboarding.read',
  UserOnboardingUpdate = 'userOnboarding.update',
  UserOnboardingDelete = 'userOnboarding.delete',

  UserPreferenceRead = 'userPreference.read',
  UserPreferenceUpdate = 'userPreference.update',

  UserProfileImageCreate = 'userProfileImage.create',
  UserProfileImageRead = 'userProfileImage.read',
  UserProfileImageUpdate = 'userProfileImage.update',
  UserProfileImageDelete = 'userProfileImage.delete',

  QueueRead = 'queue.read',
  QueueUpdate = 'queue.update',

  QueueJobCreate = 'queueJob.create',
  QueueJobRead = 'queueJob.read',
  QueueJobUpdate = 'queueJob.update',
  QueueJobDelete = 'queueJob.delete',

  WorkflowCreate = 'workflow.create',
  WorkflowRead = 'workflow.read',
  WorkflowUpdate = 'workflow.update',
  WorkflowDelete = 'workflow.delete',
  WorkflowLogs = 'workflow.logs',

  AdminUserCreate = 'adminUser.create',
  AdminUserRead = 'adminUser.read',
  AdminUserUpdate = 'adminUser.update',
  AdminUserDelete = 'adminUser.delete',

  AdminSessionRead = 'adminSession.read',

  AdminAuthUnlinkAll = 'adminAuth.unlinkAll',
}

export enum SharedLinkType {
  Album = 'ALBUM',

  /**
   * Individual asset
   * or group of assets that are not in an album
   */
  Individual = 'INDIVIDUAL',
}

export const SharedLinkTypeSchema = z.enum(SharedLinkType).describe('Shared link type').meta({ id: 'SharedLinkType' });

export enum StorageFolder {
  EncodedVideo = 'encoded-video',
  Library = 'library',
  Upload = 'upload',
  Profile = 'profile',
  Thumbnails = 'thumbs',
  Backups = 'backups',
  /** owner-private, expiring artefacts produced by a user-requested export job (FL-62) */
  Exports = 'exports',
}

export const StorageFolderSchema = z.enum(StorageFolder).describe('Storage folder').meta({ id: 'StorageFolder' });

export enum SystemMetadataKey {
  MediaLocation = 'MediaLocation',
  ReverseGeocodingState = 'reverse-geocoding-state',
  FacialRecognitionState = 'facial-recognition-state',
  MemoriesState = 'memories-state',
  AdminOnboarding = 'admin-onboarding',
  MaintenanceMode = 'maintenance-mode',
  SystemConfig = 'system-config',
  SystemFlags = 'system-flags',
  VersionCheckState = 'version-check-state',
  License = 'license',
  PhysicalDeduplicationMigration = 'physical-deduplication-migration',
  RunPodState = 'runpod-state',
  /**
   * References to RunPod templates that the teardown path could not delete
   * (typically because they were already gone from RunPod's side). Tracked so
   * an admin can audit possible orphan HF tokens — see security.md H2.
   */
  RunPodOrphans = 'runpod-orphans',
  IntegrityChecksumCheckpoint = 'integrity-checksum-checkpoint',
  /**
   * FL-34: whether "hide sensitive detections from the library" was on the last time the server
   * started or the setting changed, so detections are locked once when hiding comes on, including
   * through a configuration file the upgrade migration cannot read.
   */
  LockedDetectionsState = 'locked-detections-state',
}

export enum UserMetadataKey {
  Preferences = 'preferences',
  License = 'license',
  Onboarding = 'onboarding',
}

export const UserMetadataKeySchema = z
  .enum(UserMetadataKey)
  .describe('User metadata key')
  .meta({ id: 'UserMetadataKey' });

export enum AssetMetadataKey {
  MobileApp = 'mobile-app',
  MlEnrichment = 'ml-enrichment',
}

export enum UserAvatarColor {
  Primary = 'primary',
  Pink = 'pink',
  Red = 'red',
  Yellow = 'yellow',
  Blue = 'blue',
  Green = 'green',
  Purple = 'purple',
  Orange = 'orange',
  Gray = 'gray',
  Amber = 'amber',
}

export const UserAvatarColorSchema = z
  .enum(UserAvatarColor)
  .describe('User avatar color')
  .meta({ id: 'UserAvatarColor' });

export enum UserStatus {
  Active = 'active',
  Removing = 'removing',
  Deleted = 'deleted',
}

export const UserStatusSchema = z.enum(UserStatus).describe('User status').meta({ id: 'UserStatus' });

export enum AssetStatus {
  Active = 'active',
  Trashed = 'trashed',
  Deleted = 'deleted',
}

export enum SourceType {
  MachineLearning = 'machine-learning',
  Exif = 'exif',
  Manual = 'manual',
}

export const SourceTypeSchema = z.enum(SourceType).describe('Face detection source type').meta({ id: 'SourceType' });

export enum IntegrityReport {
  UntrackedFile = 'untracked_file',
  MissingFile = 'missing_file',
  ChecksumFail = 'checksum_mismatch',
}

export const IntegrityReportSchema = z
  .enum(IntegrityReport)
  .describe('Integrity report type')
  .meta({ id: 'IntegrityReport' });

export enum ManualJobName {
  PersonCleanup = 'person-cleanup',
  TagCleanup = 'tag-cleanup',
  UserCleanup = 'user-cleanup',
  MemoryCleanup = 'memory-cleanup',
  MemoryCreate = 'memory-create',
  BackupDatabase = 'backup-database',
  BestPhotosBackfill = 'best-photos-backfill',
  PhysicalDeduplicationDryRun = 'physical-deduplication-dry-run',
  PhysicalDeduplicationApply = 'physical-deduplication-apply',
  IntegrityMissingFiles = `integrity-missing-files`,
  IntegrityUntrackedFiles = `integrity-untracked-files`,
  IntegrityChecksumFiles = `integrity-checksum-mismatch`,
  IntegrityMissingFilesRefresh = `integrity-missing-files-refresh`,
  IntegrityUntrackedFilesRefresh = `integrity-untracked-files-refresh`,
  IntegrityChecksumFilesRefresh = `integrity-checksum-mismatch-refresh`,
  IntegrityMissingFilesDeleteAll = `integrity-missing-files-delete-all`,
  IntegrityUntrackedFilesDeleteAll = `integrity-untracked-files-delete-all`,
  IntegrityChecksumFilesDeleteAll = `integrity-checksum-mismatch-delete-all`,
}

export const ManualJobNameSchema = z.enum(ManualJobName).describe('Manual job name').meta({ id: 'ManualJobName' });

export enum AssetPathType {
  Original = 'original',
  EncodedVideo = 'encoded_video',
}

export enum PhysicalFileType {
  Original = 'original',
  Thumbnail = 'thumbnail',
  Preview = 'preview',
  FullSize = 'fullsize',
  EncodedVideo = 'encoded_video',
}

export enum PersonPathType {
  Face = 'face',
}

export enum UserPathType {
  Profile = 'profile',
}

export type PathType = AssetFileType | AssetPathType | PersonPathType | UserPathType;

export enum TranscodePolicy {
  All = 'all',
  Optimal = 'optimal',
  Bitrate = 'bitrate',
  Required = 'required',
  Disabled = 'disabled',
}

export const TranscodePolicySchema = z
  .enum(TranscodePolicy)
  .describe('Transcode policy')
  .meta({ id: 'TranscodePolicy' });

export enum TranscodeTarget {
  None = 'NONE',
  Audio = 'AUDIO',
  Video = 'VIDEO',
  All = 'ALL',
}

export enum VideoCodec {
  H264 = 'h264',
  Hevc = 'hevc',
  Vp9 = 'vp9',
  Av1 = 'av1',
}

export const VideoCodecSchema = z.enum(VideoCodec).describe('Target video codec').meta({ id: 'VideoCodec' });

export type VideoSegmentCodec = VideoCodec.Av1 | VideoCodec.Hevc | VideoCodec.H264;

export enum AudioCodec {
  Mp3 = 'mp3',
  Aac = 'aac',
  /** @deprecated Use `Opus` instead */
  Libopus = 'libopus',
  Opus = 'opus',
  PcmS16le = 'pcm_s16le',
}

export const AudioCodecSchema = z.enum(AudioCodec).describe('Target audio codec').meta({ id: 'AudioCodec' });

export enum VideoContainer {
  Mov = 'mov',
  Mp4 = 'mp4',
  Ogg = 'ogg',
  Webm = 'webm',
}

export const VideoContainerSchema = z
  .enum(VideoContainer)
  .describe('Accepted video containers')
  .meta({ id: 'VideoContainer' });

export enum TranscodeHardwareAcceleration {
  Nvenc = 'nvenc',
  Qsv = 'qsv',
  Vaapi = 'vaapi',
  Rkmpp = 'rkmpp',
  Disabled = 'disabled',
}

export const TranscodeHardwareAccelerationSchema = z
  .enum(TranscodeHardwareAcceleration)
  .describe('Transcode hardware acceleration')
  .meta({ id: 'TranscodeHWAccel' });

export enum ToneMapping {
  Hable = 'hable',
  Mobius = 'mobius',
  Reinhard = 'reinhard',
  Disabled = 'disabled',
}

export const ToneMappingSchema = z.enum(ToneMapping).describe('Tone mapping').meta({ id: 'ToneMapping' });

export enum CQMode {
  Auto = 'auto',
  Cqp = 'cqp',
  Icq = 'icq',
}

export const CQModeSchema = z.enum(CQMode).describe('CQ mode').meta({ id: 'CQMode' });

export enum HlsVideoResolution {
  p480 = 480,
  p720 = 720,
  p1080 = 1080,
  p1440 = 1440,
  p2160 = 2160,
}

export const HlsVideoResolutionSchema = z
  .enum(HlsVideoResolution)
  .describe('HLS video resolution')
  .meta({ id: 'HlsVideoResolution', type: 'integer' });

export enum Colorspace {
  Srgb = 'srgb',
  P3 = 'p3',
}

export const ColorspaceSchema = z.enum(Colorspace).describe('Colorspace').meta({ id: 'Colorspace' });

export enum ImageFormat {
  Jpeg = 'jpeg',
  Webp = 'webp',
}

export const ImageFormatSchema = z.enum(ImageFormat).describe('Image format').meta({ id: 'ImageFormat' });

export enum RawExtractedFormat {
  Jpeg = 'jpeg',
  Jxl = 'jxl',
  Tiff = 'tiff',
}

export enum MediaHealthCategory {
  Missing = 'missing',
  Corrupt = 'corrupt',
}

export const MediaHealthCategorySchema = z
  .enum(MediaHealthCategory)
  .describe('Media health category')
  .meta({ id: 'MediaHealthCategory' });

export enum MediaHealthSeverity {
  Info = 'info',
  Warning = 'warning',
  Critical = 'critical',
}

export const MediaHealthSeveritySchema = z
  .enum(MediaHealthSeverity)
  .describe('Media health severity')
  .meta({ id: 'MediaHealthSeverity' });

export enum MediaHealthStatus {
  Found = 'found',
  Missing = 'missing',
  Candidate = 'candidate',
  Relinked = 'relinked',
  Dismissed = 'dismissed',
  Resolved = 'resolved',
  UnsupportedRaw = 'unsupported_raw',
  CorruptSuspect = 'corrupt_suspect',
  CorruptConfirmed = 'corrupt_confirmed',
  TrashQueued = 'trash_queued',
  Trashed = 'trashed',
  DeleteQueued = 'delete_queued',
  Deleted = 'deleted',
}

export const MediaHealthStatusSchema = z
  .enum(MediaHealthStatus)
  .describe('Media health status')
  .meta({ id: 'MediaHealthStatus' });

/**
 * Where a machine-learning workload may run (FL-110). A destination is always named
 * explicitly by the caller; the server never picks one on the caller's behalf and never
 * moves work from one kind to another when the chosen destination is unavailable.
 */
export enum MlDestinationKind {
  /** The deployment's own machine-learning container (the configured ML URLs). */
  Local = 'local',
  /** Another machine on the home network, configured by URL. Media stays on the LAN. */
  Lan = 'lan',
  /** The RunPod pod or serverless endpoint managed by the RunPod service. Media leaves the network. */
  RunPod = 'runpod',
}

export const MlDestinationKindSchema = z
  .enum(MlDestinationKind)
  .describe('Kind of machine-learning destination')
  .meta({ id: 'MlDestinationKind' });

/** Destination kinds whose selection sends media off the operator's network. */
export const CLOUD_ML_DESTINATION_KINDS: ReadonlySet<MlDestinationKind> = new Set([MlDestinationKind.RunPod]);

/**
 * A kind of work a destination can serve. Capabilities (what a destination can run) and
 * workloads (what a caller asks for) are separate on purpose: a reachable ML URL proves
 * nothing about restoration or Studio profiles, so each workload is admitted on its own.
 */
export enum MlWorkload {
  Face = 'face',
  Clip = 'clip',
  Ocr = 'ocr',
  /** Image description, tagging and NSFW classification. */
  Enrichment = 'enrichment',
  RestorationFaithful = 'restoration-faithful',
  RestorationCreative = 'restoration-creative',
  /** Studio AI features (transcription, captioning, speech, music, interpolation). */
  StudioAi = 'studio-ai',
}

export const MlWorkloadSchema = z.enum(MlWorkload).describe('Machine-learning workload').meta({ id: 'MlWorkload' });

/** The workloads the ordinary `/predict` container serves; restoration and Studio need dedicated workers. */
export const LIBRARY_ML_WORKLOADS: readonly MlWorkload[] = [
  MlWorkload.Face,
  MlWorkload.Clip,
  MlWorkload.Ocr,
  MlWorkload.Enrichment,
];

export enum MlDestinationHealth {
  Healthy = 'healthy',
  Unhealthy = 'unhealthy',
  Unknown = 'unknown',
}

export const MlDestinationHealthSchema = z
  .enum(MlDestinationHealth)
  .describe('Last probed health of a machine-learning destination')
  .meta({ id: 'MlDestinationHealth' });

/** Why a selection was refused. Every value is a refusal; there is no "fell back" outcome. */
export enum MlAdmissionRefusal {
  DestinationMissing = 'destination-missing',
  DestinationDisabled = 'destination-disabled',
  WorkloadNotRouted = 'workload-not-routed',
  WorkloadNotAllowed = 'workload-not-allowed',
  WorkloadNotServed = 'workload-not-served',
  ConsentMissing = 'consent-missing',
  BudgetExceeded = 'budget-exceeded',
  EndpointUnresolved = 'endpoint-unresolved',
  DestinationUnhealthy = 'destination-unhealthy',
}

export const MlAdmissionRefusalSchema = z
  .enum(MlAdmissionRefusal)
  .describe('Reason a destination refused a workload')
  .meta({ id: 'MlAdmissionRefusal' });

/**
 * Pet identity model (FL-58).
 *
 * `PetSpecies` is what the owner says the animal is. A detector may guess a species on
 * a `pet_detection` row, but that guess never becomes the identity's species.
 */
export enum PetSpecies {
  Cat = 'cat',
  Dog = 'dog',
  Bird = 'bird',
  Rabbit = 'rabbit',
  Horse = 'horse',
  Reptile = 'reptile',
  Fish = 'fish',
  SmallMammal = 'small_mammal',
  Other = 'other',
}

export const PetSpeciesSchema = z.enum(PetSpecies).describe('Pet species').meta({ id: 'PetSpecies' });

/** Whether the owner said the pet is in an asset, or said it is not. Both are durable. */
export enum PetObservationState {
  Confirmed = 'confirmed',
  Rejected = 'rejected',
}

export const PetObservationStateSchema = z
  .enum(PetObservationState)
  .describe('Pet observation state')
  .meta({ id: 'PetObservationState' });

/** How the durable decision was made. Neither value makes it less durable. */
export enum PetObservationSource {
  /** The owner drew or named it directly. */
  Manual = 'manual',
  /** The owner accepted, reassigned or rejected a recognition proposal. */
  Review = 'review',
}

export const PetObservationSourceSchema = z
  .enum(PetObservationSource)
  .describe('How a pet observation was recorded')
  .meta({ id: 'PetObservationSource' });

/**
 * Durable, user-visible media operations (FL-43, FL-104).
 *
 * One persistent job contract covers every long-running workload a person can see in Activity.
 * The kind selects the workload; the immutable `snapshot` on the row carries whatever that
 * workload needs to reproduce the work exactly.
 */
export enum MediaOperationKind {
  /** A Studio project render to a finished file. */
  StudioExport = 'studio_export',
  /** A short Studio preview render; same graph, bounded range. */
  StudioPreview = 'studio_preview',
  /** A video restoration render. */
  Restoration = 'restoration',
  /** The five-second restoration motion preview a full render must inherit from. */
  RestorationPreview = 'restoration_preview',
  /** A still-image edit recipe render. */
  QuickEdit = 'quick_edit',
  /**
   * A library bulk operation over a frozen set of assets (FL-32). The server applies the action in
   * batches through the same services a single request would use, so it survives the browser.
   */
  Bulk = 'bulk',
  /**
   * A portable Studio project bundle written for download (FL-91): the project document, a
   * manifest with digests, and either references to or copies of the sources it uses.
   */
  StudioBundleExport = 'studio_bundle_export',
  /** A portable Studio project bundle read back into a new project of the importer's (FL-91). */
  StudioBundleImport = 'studio_bundle_import',
}

export const MediaOperationKindSchema = z
  .enum(MediaOperationKind)
  .describe('Media operation kind')
  .meta({ id: 'MediaOperationKind' });

/**
 * The bulk actions the server is willing to run durably (FL-32).
 *
 * Deliberately not the whole selection bar. Anything that only makes sense in the browser tab that
 * asked for it — a download, a shared link the user is about to copy — stays in the browser, and
 * so do moves into and out of the Locked folder, which the person confirms in the unlocked session
 * they are looking at. The worker itself may act on Locked items the owner submitted.
 */
export enum MediaOperationBulkAction {
  Favorite = 'favorite',
  Unfavorite = 'unfavorite',
  Archive = 'archive',
  Unarchive = 'unarchive',
  AddToAlbum = 'add-to-album',
  RemoveFromAlbum = 'remove-from-album',
  Tag = 'tag',
  Untag = 'untag',
  ChangeDate = 'change-date',
  ChangeDescription = 'change-description',
  ChangeLocation = 'change-location',
  MarkSensitive = 'mark-sensitive',
  UnmarkSensitive = 'unmark-sensitive',
  Delete = 'delete',
  DeletePermanently = 'delete-permanently',
  Restore = 'restore',
  Stack = 'stack',
  Unstack = 'unstack',
  RefreshThumbnails = 'refresh-thumbnails',
  RefreshMetadata = 'refresh-metadata',
  RefreshEncoded = 'refresh-encoded',
  RefreshFaces = 'refresh-faces',
}

export const MediaOperationBulkActionSchema = z
  .enum(MediaOperationBulkAction)
  .describe('Bulk action a durable media operation applies')
  .meta({ id: 'MediaOperationBulkAction' });

/** The outcome recorded for one item of a bulk operation. */
export enum MediaOperationItemStatus {
  /** The server applied the action to this item. */
  Ok = 'ok',
  /** Not attempted, or refused before anything changed: no access, or nothing to do. */
  Skipped = 'skipped',
  /** Attempted and rejected. Retryable. */
  Failed = 'failed',
}

export const MediaOperationItemStatusSchema = z
  .enum(MediaOperationItemStatus)
  .describe('Per-item outcome of a bulk media operation')
  .meta({ id: 'MediaOperationItemStatus' });

/**
 * The durable state machine. `cancelling` is a real persisted state: the request is recorded
 * before the worker answers, so a cancel survives a restart and the remote acknowledgement is
 * still expected afterwards.
 */
export enum MediaOperationStatus {
  Queued = 'queued',
  Preparing = 'preparing',
  Rendering = 'rendering',
  Validating = 'validating',
  Completed = 'completed',
  Cancelling = 'cancelling',
  Cancelled = 'cancelled',
  Failed = 'failed',
  /**
   * Held by its owner (FL-104, owner request September 23, 2026). No worker claims a paused job;
   * resuming puts it back in the queue and the next claim carries on from its checkpoints.
   */
  Paused = 'paused',
}

export const MediaOperationStatusSchema = z
  .enum(MediaOperationStatus)
  .describe('Media operation status')
  .meta({ id: 'MediaOperationStatus' });

/**
 * Where the work runs. Always explicit and immutable for the life of a job: losing a local GPU
 * never promotes a job to the cloud, and changing the destination means a new job.
 */
export enum MediaOperationDestination {
  /** This server's own hardware. */
  Local = 'local',
  /** A qualified worker on the home network. */
  Lan = 'lan',
  /** The configured RunPod workload. Chosen by the person, never as a fallback. */
  RunPod = 'runpod',
}

export const MediaOperationDestinationSchema = z
  .enum(MediaOperationDestination)
  .describe('Media operation destination')
  .meta({ id: 'MediaOperationDestination' });

/** The state of one checkpointed chunk of a render. */
export enum MediaOperationCheckpointState {
  /** Claimed or planned, not yet proven. */
  Pending = 'pending',
  /** Rendered and validated; reusable when every digest still matches. */
  Complete = 'complete',
  /** Known not to describe the current inputs; never reusable. */
  Invalid = 'invalid',
}

export const MediaOperationCheckpointStateSchema = z
  .enum(MediaOperationCheckpointState)
  .describe('Media operation checkpoint state')
  .meta({ id: 'MediaOperationCheckpointState' });

/**
 * Revision-bound Studio preview frames (FL-96, `STU-402`).
 *
 * The quality tier is chosen by the client and is part of the store key, so switching quality
 * produces a different frame rather than reusing one rendered at another tier. `draft` exists
 * for scrubbing and is explicitly not a colour authority.
 */
export enum StudioPreviewQuality {
  /** Fast, reduced-precision scrub frame. Never used for inspection or as an export source. */
  Draft = 'draft',
  /** The ordinary paused-playhead frame. */
  Standard = 'standard',
  /** Full-precision inspection frame for scopes and pixel checks. */
  Full = 'full',
}

export const StudioPreviewQualitySchema = z
  .enum(StudioPreviewQuality)
  .describe('Studio preview quality')
  .meta({ id: 'StudioPreviewQuality' });

/**
 * The life of one stored preview frame.
 *
 * `superseded` is a real persisted state rather than a deletion: a frame whose revision has
 * advanced must keep answering "stale" for as long as anyone can still ask for it, because the
 * honest answer to a stale request is a refusal, not a miss.
 */
export enum StudioPreviewStatus {
  /** Recorded, not yet handed to a worker. */
  Pending = 'pending',
  /** A worker holds the render. */
  Rendering = 'rendering',
  /** A validated frame is on disk and may be delivered. */
  Ready = 'ready',
  /** The project revision advanced past this frame. Refused, never served. */
  Superseded = 'superseded',
  /** The render failed; the reason is in the operation. */
  Failed = 'failed',
  /** Retention removed the frame. The row survives so the answer stays "gone", not "missing". */
  Evicted = 'evicted',
}

export const StudioPreviewStatusSchema = z
  .enum(StudioPreviewStatus)
  .describe('Studio preview status')
  .meta({ id: 'StudioPreviewStatus' });

/**
 * Render worker admission (FL-95 `STU-401`).
 *
 * A worker is an identity an administrator enrolled, not a machine that showed up. It is
 * either active or revoked; there is no "pending" because a worker that has not been admitted
 * simply has no session, and an admission that fails is an audit row, not a worker state.
 */
export enum RenderWorkerStatus {
  Active = 'active',
  Revoked = 'revoked',
}

export const RenderWorkerStatusSchema = z
  .enum(RenderWorkerStatus)
  .describe('Render worker status')
  .meta({ id: 'RenderWorkerStatus' });

/** What the audit trail records about a worker. Never a secret, never media. */
export enum RenderWorkerAuditEvent {
  /** An administrator created the identity. */
  Enrolled = 'enrolled',
  /** A worker presented a valid enrolment secret and fresh evidence and received a session. */
  Admitted = 'admitted',
  /** Admission was refused; `reason` says why. */
  Refused = 'refused',
  /** A claim was refused at admission time by a worker, user or hardware limit. */
  ClaimRefused = 'claim_refused',
  /** A running operation was stopped because it exceeded a limit. */
  LimitExceeded = 'limit_exceeded',
  /** An administrator revoked the worker; every session it held is dead. */
  Revoked = 'revoked',
  /** An administrator changed the worker's limits or scopes. */
  Updated = 'updated',
}

export const RenderWorkerAuditEventSchema = z
  .enum(RenderWorkerAuditEvent)
  .describe('Render worker audit event')
  .meta({ id: 'RenderWorkerAuditEvent' });

/**
 * Why a worker was turned away. Stable codes: the admin page turns them into messages, and
 * the same code is written on a refused operation so its owner sees why it is still queued.
 */
export enum RenderWorkerRefusalReason {
  InvalidCredential = 'invalid_credential',
  WorkerRevoked = 'worker_revoked',
  SessionExpired = 'session_expired',
  /** The conformance evidence is older than the worker's configured maximum age. */
  ConformanceStale = 'conformance_stale',
  /** The evidence has been presented before; a replayed report is not fresh evidence. */
  ConformanceReplayed = 'conformance_replayed',
  /** The engine or patch digest the worker reports is not the one it was enrolled with. */
  EngineDigestMismatch = 'engine_digest_mismatch',
  /** A software or fallback renderer was reported where a GPU is required. */
  SoftwareRenderer = 'software_renderer',
  /** The worker's destination is not the destination the operation was submitted to. */
  DestinationMismatch = 'destination_mismatch',
  /** The operation names a worker and this is not it. */
  WorkerMismatch = 'worker_mismatch',
  /** The operation kind is outside the worker's admitted scopes. */
  ScopeExceeded = 'scope_exceeded',
  /** The worker already holds as many operations as it is allowed. */
  WorkerConcurrency = 'worker_concurrency_exceeded',
  /** The operation's owner already has as many operations running as they are allowed. */
  UserConcurrency = 'user_concurrency_exceeded',
  /** The operation needs more GPU memory than the worker was admitted with. */
  GpuMemoryInsufficient = 'gpu_memory_insufficient',
  WallClockExceeded = 'wall_clock_exceeded',
  OutputBytesExceeded = 'output_bytes_exceeded',
  /** The chosen destination reports itself unavailable. */
  DestinationUnavailable = 'destination_unavailable',
  /** FL-90 refused at least one graph resource; a render needs a complete manifest. */
  ManifestIncomplete = 'manifest_incomplete',
}

export const RenderWorkerRefusalReasonSchema = z
  .enum(RenderWorkerRefusalReason)
  .describe('Render worker refusal reason')
  .meta({ id: 'RenderWorkerRefusalReason' });

export enum LogLevel {
  Verbose = 'verbose',
  Debug = 'debug',
  Log = 'log',
  Warn = 'warn',
  Error = 'error',
  Fatal = 'fatal',
}

export const LogLevelSchema = z.enum(LogLevel).describe('Log level').meta({ id: 'LogLevel' });

export enum LogFormat {
  Console = 'console',
  Json = 'json',
}

export const LogFormatSchema = z.enum(LogFormat).describe('Log format').meta({ id: 'LogFormat' });

export enum ApiCustomExtension {
  Permission = 'x-immich-permission',
  AdminOnly = 'x-immich-admin-only',
  History = 'x-immich-history',
  State = 'x-immich-state',
  Required = 'x-immich-required',
}

export enum MetadataKey {
  AuthRoute = 'auth_route',
  ApiKeySecurity = 'api_key',
  EventConfig = 'event_config',
  JobConfig = 'job_config',
}

export enum RouteKey {
  Asset = 'assets',
  User = 'users',
}

export enum CacheControl {
  PrivateWithCache = 'private_with_cache',
  PrivateWithoutCache = 'private_without_cache',
  None = 'none',
}

export enum ImmichEnvironment {
  Development = 'development',
  Testing = 'testing',
  Production = 'production',
}

export const ImmichEnvironmentSchema = z
  .enum(ImmichEnvironment)
  .describe('Immich environment')
  .meta({ id: 'ImmichEnvironment' });

export enum ImmichWorker {
  Api = 'api',
  Maintenance = 'maintenance',
  Microservices = 'microservices',
}

export enum ImmichTelemetry {
  Host = 'host',
  Api = 'api',
  Io = 'io',
  Repo = 'repo',
  Job = 'job',
}

export enum ExifOrientation {
  Horizontal = 1,
  MirrorHorizontal = 2,
  Rotate180 = 3,
  MirrorVertical = 4,
  MirrorHorizontalRotate270CW = 5,
  Rotate90CW = 6,
  MirrorHorizontalRotate90CW = 7,
  Rotate270CW = 8,
}

/** ITU-T H.273 colour primaries codes. */
export enum ColorPrimaries {
  Reserved = 0,
  Bt709 = 1,
  Unknown = 2,
  Bt470M = 4,
  Bt470Bg = 5,
  Smpte170M = 6,
  Smpte240M = 7,
  Film = 8,
  Bt2020 = 9,
  Smpte428 = 10,
  Smpte431 = 11,
  Smpte432 = 12,
  Ebu3213 = 22,
}

/** ITU-T H.273 transfer characteristics codes. */
export enum ColorTransfer {
  Reserved = 0,
  Bt709 = 1,
  Unknown = 2,
  Bt470M = 4,
  Bt470Bg = 5,
  Smpte170M = 6,
  Smpte240M = 7,
  Linear = 8,
  Log100 = 9,
  Log316 = 10,
  Iec6196624 = 11,
  Bt1361E = 12,
  Iec6196621 = 13,
  Bt202010 = 14,
  Bt202012 = 15,
  Smpte2084 = 16,
  Smpte428 = 17,
  AribStdB67 = 18,
}

/** ITU-T H.273 matrix coefficients codes. */
export enum ColorMatrix {
  Gbr = 0,
  Bt709 = 1,
  Unknown = 2,
  Reserved = 3,
  Fcc = 4,
  Bt470Bg = 5,
  Smpte170M = 6,
  Smpte240M = 7,
  Ycgco = 8,
  Bt2020Nc = 9,
  Bt2020C = 10,
  Smpte2085 = 11,
  ChromaDerivedNc = 12,
  ChromaDerivedC = 13,
  Ictcp = 14,
}

/** H.264 `profile_idc` values. */
// H.264 has a few profiles that have the same value but different names, included so lookup by name works
export enum H264Profile {
  ConstrainedBaseline = 66,
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  Baseline = 66,
  Main = 77,
  Extended = 88,
  ConstrainedHigh = 100,
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  ProgressiveHigh = 100,
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  High = 100,
  High10 = 110,
  High422 = 122,
  High444Predictive = 244,
}

/** HEVC `profile_idc` values. */
export enum HevcProfile {
  Main = 1,
  Main10 = 2,
  MainStillPicture = 3,
  Rext = 4,
}

/** AV1 `seq_profile` values. */
export enum Av1Profile {
  Main = 0,
  High = 1,
  Professional = 2,
}

/** MPEG-4 Audio Object Type values for AAC. */
export enum AacProfile {
  Main = 1,
  Lc = 2,
  Ssr = 3,
  Ltp = 4,
  HeAac = 5,
  Ld = 23,
  HeAacv2 = 29,
  Eld = 39,
  XheAac = 42,
}

/** Dolby Vision bitstream profile numbers from the DOVI configuration record. */
export enum DvProfile {
  Dvhe03 = 3,
  Dvhe04 = 4,
  Dvhe05 = 5,
  Dvhe07 = 7,
  Dvhe08 = 8,
  Dvav09 = 9,
  Dav110 = 10,
}

/**
 * Dolby Vision base-layer signal-compatibility ID from the DOVI configuration record.
 * Identifies what the base HEVC/AVC layer renders as on a non-DV decoder.
 */
export enum DvSignalCompatibility {
  None = 0,
  Hdr10 = 1,
  Sdr709 = 2,
  Hlg = 4,
  Sdr2020 = 6,
}

export enum DatabaseExtension {
  Cube = 'cube',
  EarthDistance = 'earthdistance',
  Vector = 'vector',
  VectorChord = 'vchord',
}

export enum BootstrapEventPriority {
  // Database service should be initialized before anything else, most other services need database access
  DatabaseService = -200,
  // Detect and configure the media location before jobs are queued which may use it
  StorageService = -195,
  // Other services may need to queue jobs on bootstrap.
  JobService = -190,
  // Initialize config after other bootstrap services, stop other services from using config on bootstrap
  SystemConfig = 100,
  PluginSync = 190,
  // Load plugins into memory after sync
  PluginLoad = 200,
}

export enum QueueName {
  ThumbnailGeneration = 'thumbnailGeneration',
  MetadataExtraction = 'metadataExtraction',
  VideoConversion = 'videoConversion',
  FaceDetection = 'faceDetection',
  FacialRecognition = 'facialRecognition',
  SmartSearch = 'smartSearch',
  DuplicateDetection = 'duplicateDetection',
  VideoDuplicateDetection = 'videoDuplicateDetection',
  BackgroundTask = 'backgroundTask',
  StorageTemplateMigration = 'storageTemplateMigration',
  Migration = 'migration',
  Search = 'search',
  Sidecar = 'sidecar',
  Library = 'library',
  Notification = 'notifications',
  BackupDatabase = 'backupDatabase',
  Ocr = 'ocr',
  ImageEnrichment = 'imageEnrichment',
  ImageDescription = 'imageDescription',
  NsfwDetection = 'nsfwDetection',
  MediaHealth = 'mediaHealth',
  Workflow = 'workflow',
  IntegrityCheck = 'integrityCheck',
  Editor = 'editor',
}

export const QueueNameSchema = z.enum(QueueName).describe('Queue name').meta({ id: 'QueueName' });

export enum QueueJobStatus {
  Active = 'active',
  Failed = 'failed',
  Complete = 'completed',
  Delayed = 'delayed',
  Waiting = 'waiting',
  Paused = 'paused',
}

export const QueueJobStatusSchema = z.enum(QueueJobStatus).describe('Queue job status').meta({ id: 'QueueJobStatus' });

export enum JobName {
  ICloudSync = 'ICloudSync',
  ForkSchemaBackfill = 'ForkSchemaBackfill',

  AssetDelete = 'AssetDelete',
  AssetDeleteCheck = 'AssetDeleteCheck',
  AssetDetectFacesQueueAll = 'AssetDetectFacesQueueAll',
  AssetDetectFaces = 'AssetDetectFaces',
  AssetDetectDuplicatesQueueAll = 'AssetDetectDuplicatesQueueAll',
  AssetDetectDuplicates = 'AssetDetectDuplicates',
  AssetGenerateVideoDuplicateFramesQueueAll = 'AssetGenerateVideoDuplicateFramesQueueAll',
  AssetGenerateVideoDuplicateFrames = 'AssetGenerateVideoDuplicateFrames',
  AssetEditThumbnailGeneration = 'AssetEditThumbnailGeneration',
  AssetDevelopRender = 'AssetDevelopRender',
  AssetVideoEditGeneration = 'AssetVideoEditGeneration',
  AssetEncodeVideoQueueAll = 'AssetEncodeVideoQueueAll',
  AssetEncodeVideo = 'AssetEncodeVideo',
  AssetEmptyTrash = 'AssetEmptyTrash',
  AssetExtractMetadataQueueAll = 'AssetExtractMetadataQueueAll',
  AssetExtractMetadata = 'AssetExtractMetadata',
  AssetFileMigration = 'AssetFileMigration',
  AssetGenerateThumbnailsQueueAll = 'AssetGenerateThumbnailsQueueAll',
  AssetGenerateThumbnails = 'AssetGenerateThumbnails',
  BestPhotosScoreQueueAll = 'BestPhotosScoreQueueAll',
  BestPhotosScore = 'BestPhotosScore',

  MediaHealthScanMissing = 'MediaHealthScanMissing',
  MediaHealthLocateMissing = 'MediaHealthLocateMissing',
  MediaHealthScanCorrupt = 'MediaHealthScanCorrupt',
  MediaHealthDeleteCorrupt = 'MediaHealthDeleteCorrupt',

  AuditTableCleanup = 'AuditTableCleanup',

  DatabaseBackup = 'DatabaseBackup',

  FacialRecognitionQueueAll = 'FacialRecognitionQueueAll',
  FacialRecognition = 'FacialRecognition',

  FileDelete = 'FileDelete',
  FileMigrationQueueAll = 'FileMigrationQueueAll',

  LibraryDeleteCheck = 'LibraryDeleteCheck',
  LibraryDelete = 'LibraryDelete',
  LibraryRemoveAsset = 'LibraryRemoveAsset',
  LibrarySyncAssetsQueueAll = 'LibraryScanAssetsQueueAll',
  LibrarySyncAssets = 'LibrarySyncAssets',
  LibrarySyncFilesQueueAll = 'LibrarySyncFilesQueueAll',
  LibrarySyncFiles = 'LibrarySyncFiles',
  LibraryScanQueueAll = 'LibraryScanQueueAll',

  HlsSessionCleanup = 'HlsSessionCleanup',

  MemoryCleanup = 'MemoryCleanup',
  MemoryGenerate = 'MemoryGenerate',
  MemoryExport = 'MemoryExport',

  NotificationsCleanup = 'NotificationsCleanup',

  NotifyUserSignup = 'NotifyUserSignup',
  NotifyAlbumInvite = 'NotifyAlbumInvite',
  NotifyAlbumUpdate = 'NotifyAlbumUpdate',

  UserDelete = 'UserDelete',
  UserDeleteCheck = 'UserDeleteCheck',
  UserSyncUsage = 'UserSyncUsage',

  PersonCleanup = 'PersonCleanup',
  PersonFileMigration = 'PersonFileMigration',
  PersonGenerateThumbnail = 'PersonGenerateThumbnail',

  SessionCleanup = 'SessionCleanup',

  SendMail = 'SendMail',

  SidecarQueueAll = 'SidecarQueueAll',
  SidecarCheck = 'SidecarCheck',
  SidecarWrite = 'SidecarWrite',

  SmartSearchQueueAll = 'SmartSearchQueueAll',
  SmartSearch = 'SmartSearch',

  StorageTemplateMigration = 'StorageTemplateMigration',
  StorageTemplateMigrationSingle = 'StorageTemplateMigrationSingle',
  PhysicalDeduplicationMigrationDryRun = 'PhysicalDeduplicationMigrationDryRun',
  PhysicalDeduplicationMigrationApply = 'PhysicalDeduplicationMigrationApply',

  TagCleanup = 'TagCleanup',

  VersionCheck = 'VersionCheck',

  // OCR
  OcrQueueAll = 'OcrQueueAll',
  Ocr = 'Ocr',

  // Image enrichment
  ImageDescriptionQueueAll = 'ImageDescriptionQueueAll',
  ImageDescription = 'ImageDescription',
  NsfwDetectionQueueAll = 'NsfwDetectionQueueAll',
  NsfwDetection = 'NsfwDetection',

  // Smart albums
  SmartAlbumReevaluateAll = 'SmartAlbumReevaluateAll',

  // Workflow
  WorkflowAssetTrigger = 'WorkflowAssetTrigger',

  // Integrity
  IntegrityUntrackedFilesQueueAll = 'IntegrityUntrackedFilesQueueAll',
  IntegrityUntrackedFiles = 'IntegrityUntrackedFiles',
  IntegrityUntrackedFilesRefresh = 'IntegrityUntrackedRefresh',
  IntegrityMissingFilesQueueAll = 'IntegrityMissingFilesQueueAll',
  IntegrityMissingFiles = 'IntegrityMissingFiles',
  IntegrityMissingFilesRefresh = 'IntegrityMissingFilesRefresh',
  IntegrityChecksumFiles = 'IntegrityChecksumFiles',
  IntegrityChecksumFilesRefresh = 'IntegrityChecksumFilesRefresh',
  IntegrityDeleteReportType = 'IntegrityDeleteReportType',
  IntegrityDeleteReports = 'IntegrityDeleteReports',
}

export const JobNameSchema = z.enum(JobName).describe('Job name').meta({ id: 'JobName' });

export enum QueueCommand {
  Start = 'start',
  /** @deprecated Use `updateQueue` instead */
  Pause = 'pause',
  /** @deprecated Use `updateQueue` instead */
  Resume = 'resume',
  /** @deprecated Use `emptyQueue` instead */
  Empty = 'empty',
  /** @deprecated Use `emptyQueue` instead */
  ClearFailed = 'clear-failed',
}

export const QueueCommandSchema = z
  .enum(QueueCommand)
  .describe('Queue command to execute')
  .meta({ id: 'QueueCommand' });

export enum JobStatus {
  Success = 'success',
  Failed = 'failed',
  Skipped = 'skipped',
}

export enum QueueCleanType {
  Failed = 'failed',
}

export enum VectorIndex {
  Clip = 'clip_index',
  Face = 'face_index',
}

export enum DatabaseLock {
  GeodataImport = 100,
  Migrations = 200,
  SystemFileMounts = 300,
  StorageTemplateMigration = 420,
  VersionHistory = 500,
  CLIPDimSize = 512,
  Library = 1337,
  NightlyJobs = 600,
  PluginImport = 666,
  MediaLocation = 700,
  GetSystemConfig = 69,
  BackupDatabase = 42,
  MaintenanceOperation = 621,
  MemoryCreation = 777,
  IntegrityCheck = 67,
  VersionCheck = 800,
  RunPodTransition = 900,
  MlDestinationBootstrap = 910,
  HlsSessionCleanup = 850,
  /** FL-66: an administrator's settings save compares the revision and writes as one step. */
  SystemConfigUpdate = 930,
}

export enum MaintenanceAction {
  Start = 'start',
  End = 'end',
  SelectDatabaseRestore = 'select_database_restore',
  RestoreDatabase = 'restore_database',
}

export const MaintenanceActionSchema = z
  .enum(MaintenanceAction)
  .describe('Maintenance action')
  .meta({ id: 'MaintenanceAction' });

export enum PhysicalDeduplicationDecision {
  Share = 'share',
  Skip = 'skip',
}

export const PhysicalDeduplicationDecisionSchema = z
  .enum(PhysicalDeduplicationDecision)
  .describe('Physical deduplication plan decision for a duplicate copy')
  .meta({ id: 'PhysicalDeduplicationDecision' });

export enum PhysicalDeduplicationSkipReason {
  ExternalLibrary = 'external-library',
  MissingSize = 'missing-size',
  NoRetainedMatch = 'no-retained-match',
  AlreadyShared = 'already-shared',
  RetainedFileMissing = 'retained-file-missing',
}

export const PhysicalDeduplicationSkipReasonSchema = z
  .enum(PhysicalDeduplicationSkipReason)
  .describe('Why a duplicate copy is skipped by the physical deduplication plan')
  .meta({ id: 'PhysicalDeduplicationSkipReason' });

export enum PhysicalDeduplicationPlanMode {
  DryRun = 'dry-run',
  Apply = 'apply',
}

export const PhysicalDeduplicationPlanModeSchema = z
  .enum(PhysicalDeduplicationPlanMode)
  .describe('Whether the physical deduplication plan was a preview or an applied run')
  .meta({ id: 'PhysicalDeduplicationPlanMode' });

export enum ExitCode {
  AppRestart = 7,
}

export enum SyncRequestType {
  AlbumsV1 = 'AlbumsV1',
  AlbumsV2 = 'AlbumsV2',
  AlbumUsersV1 = 'AlbumUsersV1',
  AlbumToAssetsV1 = 'AlbumToAssetsV1',
  /** @deprecated */
  AlbumAssetsV1 = 'AlbumAssetsV1',
  AlbumAssetsV2 = 'AlbumAssetsV2',
  AlbumAssetExifsV1 = 'AlbumAssetExifsV1',
  /** @deprecated */
  AssetsV1 = 'AssetsV1',
  AssetsV2 = 'AssetsV2',
  AssetExifsV1 = 'AssetExifsV1',
  AssetEditsV1 = 'AssetEditsV1',
  AssetMetadataV1 = 'AssetMetadataV1',
  AssetOcrV1 = 'AssetOcrV1',
  AuthUsersV1 = 'AuthUsersV1',
  AuthUsersV2 = 'AuthUsersV2',
  MemoriesV1 = 'MemoriesV1',
  MemoryToAssetsV1 = 'MemoryToAssetsV1',
  PartnersV1 = 'PartnersV1',
  /** @deprecated */
  PartnerAssetsV1 = 'PartnerAssetsV1',
  PartnerAssetsV2 = 'PartnerAssetsV2',
  PartnerAssetExifsV1 = 'PartnerAssetExifsV1',
  PartnerStacksV1 = 'PartnerStacksV1',
  StacksV1 = 'StacksV1',
  UsersV1 = 'UsersV1',
  PeopleV1 = 'PeopleV1',
  /** @deprecated */
  AssetFacesV1 = 'AssetFacesV1',
  /** @deprecated */
  AssetFacesV2 = 'AssetFacesV2',
  AssetFacesV3 = 'AssetFacesV3',
  UserMetadataV1 = 'UserMetadataV1',
}

export const SyncRequestTypeSchema = z
  .enum(SyncRequestType)
  .describe('Sync request type')
  .meta({ id: 'SyncRequestType' });

export enum SyncEntityType {
  AuthUserV1 = 'AuthUserV1',
  AuthUserV2 = 'AuthUserV2',

  UserV1 = 'UserV1',
  UserDeleteV1 = 'UserDeleteV1',

  /** @deprecated */
  AssetV1 = 'AssetV1',
  AssetV2 = 'AssetV2',
  AssetDeleteV1 = 'AssetDeleteV1',
  AssetExifV1 = 'AssetExifV1',
  AssetEditV1 = 'AssetEditV1',
  AssetEditDeleteV1 = 'AssetEditDeleteV1',
  AssetMetadataV1 = 'AssetMetadataV1',
  AssetMetadataDeleteV1 = 'AssetMetadataDeleteV1',
  AssetOcrV1 = 'AssetOcrV1',
  AssetOcrDeleteV1 = 'AssetOcrDeleteV1',

  PartnerV1 = 'PartnerV1',
  PartnerDeleteV1 = 'PartnerDeleteV1',

  /** @deprecated */
  PartnerAssetV1 = 'PartnerAssetV1',
  PartnerAssetV2 = 'PartnerAssetV2',
  /** @deprecated */
  PartnerAssetBackfillV1 = 'PartnerAssetBackfillV1',
  PartnerAssetBackfillV2 = 'PartnerAssetBackfillV2',
  PartnerAssetDeleteV1 = 'PartnerAssetDeleteV1',
  PartnerAssetExifV1 = 'PartnerAssetExifV1',
  PartnerAssetExifBackfillV1 = 'PartnerAssetExifBackfillV1',
  PartnerStackBackfillV1 = 'PartnerStackBackfillV1',
  PartnerStackDeleteV1 = 'PartnerStackDeleteV1',
  PartnerStackV1 = 'PartnerStackV1',

  AlbumV1 = 'AlbumV1',
  AlbumV2 = 'AlbumV2',
  AlbumDeleteV1 = 'AlbumDeleteV1',

  AlbumUserV1 = 'AlbumUserV1',
  AlbumUserBackfillV1 = 'AlbumUserBackfillV1',
  AlbumUserDeleteV1 = 'AlbumUserDeleteV1',

  /** @deprecated */
  AlbumAssetCreateV1 = 'AlbumAssetCreateV1',
  AlbumAssetCreateV2 = 'AlbumAssetCreateV2',
  /** @deprecated */
  AlbumAssetUpdateV1 = 'AlbumAssetUpdateV1',
  AlbumAssetUpdateV2 = 'AlbumAssetUpdateV2',
  /** @deprecated */
  AlbumAssetBackfillV1 = 'AlbumAssetBackfillV1',
  AlbumAssetBackfillV2 = 'AlbumAssetBackfillV2',
  AlbumAssetExifCreateV1 = 'AlbumAssetExifCreateV1',
  AlbumAssetExifUpdateV1 = 'AlbumAssetExifUpdateV1',
  AlbumAssetExifBackfillV1 = 'AlbumAssetExifBackfillV1',

  AlbumToAssetV1 = 'AlbumToAssetV1',
  AlbumToAssetDeleteV1 = 'AlbumToAssetDeleteV1',
  AlbumToAssetBackfillV1 = 'AlbumToAssetBackfillV1',

  MemoryV1 = 'MemoryV1',
  MemoryDeleteV1 = 'MemoryDeleteV1',

  MemoryToAssetV1 = 'MemoryToAssetV1',
  MemoryToAssetDeleteV1 = 'MemoryToAssetDeleteV1',

  StackV1 = 'StackV1',
  StackDeleteV1 = 'StackDeleteV1',

  PersonV1 = 'PersonV1',
  PersonDeleteV1 = 'PersonDeleteV1',

  /** @deprecated */
  AssetFaceV1 = 'AssetFaceV1',
  /** @deprecated */
  AssetFaceV2 = 'AssetFaceV2',
  AssetFaceV3 = 'AssetFaceV3',
  AssetFaceDeleteV1 = 'AssetFaceDeleteV1',

  UserMetadataV1 = 'UserMetadataV1',
  UserMetadataDeleteV1 = 'UserMetadataDeleteV1',

  SyncAckV1 = 'SyncAckV1',
  SyncResetV1 = 'SyncResetV1',
  SyncCompleteV1 = 'SyncCompleteV1',
}

export const SyncEntityTypeSchema = z.enum(SyncEntityType).describe('Sync entity type').meta({ id: 'SyncEntityType' });

export enum NotificationLevel {
  Success = 'success',
  Error = 'error',
  Warning = 'warning',
  Info = 'info',
}

export const NotificationLevelSchema = z
  .enum(NotificationLevel)
  .describe('Notification level')
  .meta({ id: 'NotificationLevel' });

export enum NotificationType {
  JobFailed = 'JobFailed',
  BackupFailed = 'BackupFailed',
  SystemMessage = 'SystemMessage',
  AlbumInvite = 'AlbumInvite',
  AlbumUpdate = 'AlbumUpdate',
  ClusterGroupRequest = 'ClusterGroupRequest',
  SharedSpaceMention = 'SharedSpaceMention',
  SharedSpaceReply = 'SharedSpaceReply',
  Custom = 'Custom',
}

export const NotificationTypeSchema = z
  .enum(NotificationType)
  .describe('Notification type')
  .meta({ id: 'NotificationType' });

/**
 * What a shared space's activity feed records (FL-55). Each value is one durable
 * row in `shared_space_event`, written by the service that made the change and
 * read back only by current members, with anything about media they cannot see
 * filtered out at read time.
 */
export enum SharedSpaceEventType {
  AssetsAdded = 'AssetsAdded',
  AssetsRemoved = 'AssetsRemoved',
  AlbumLinked = 'AlbumLinked',
  AlbumUnlinked = 'AlbumUnlinked',
  PersonLinked = 'PersonLinked',
  PersonUnlinked = 'PersonUnlinked',
  MemberJoined = 'MemberJoined',
  MemberLeft = 'MemberLeft',
  MemberRemoved = 'MemberRemoved',
  MemberRoleChanged = 'MemberRoleChanged',
  Comment = 'Comment',
  /** A reply to a comment (threaded replies); `targetUserId` is the author of the comment it answers. */
  Reply = 'Reply',
  Like = 'Like',
}

export const SharedSpaceEventTypeSchema = z
  .enum(SharedSpaceEventType)
  .describe('Shared space event type')
  .meta({ id: 'SharedSpaceEventType' });

export enum OAuthTokenEndpointAuthMethod {
  ClientSecretPost = 'client_secret_post',
  ClientSecretBasic = 'client_secret_basic',
}

export const OAuthTokenEndpointAuthMethodSchema = z
  .enum(OAuthTokenEndpointAuthMethod)
  .describe('OAuth token endpoint auth method')
  .meta({ id: 'OAuthTokenEndpointAuthMethod' });

export enum AssetVisibility {
  Archive = 'archive',
  Timeline = 'timeline',

  /**
   * Video part of the LivePhotos and MotionPhotos
   */
  Hidden = 'hidden',
  /**
   * Never stored (FL-34). In a request or a response it stands for a locked asset: one with an
   * `asset_lock` record, whatever its stored visibility. See `src/utils/locked.ts`.
   */
  Locked = 'locked',
}

export const AssetVisibilitySchema = z
  .enum(AssetVisibility)
  .describe('Asset visibility')
  .meta({ id: 'AssetVisibility' });

/**
 * Why an asset is locked (FL-34). A lock is metadata: the asset keeps its albums and organisation and
 * is hidden everywhere except its owner's elevated (PIN-unlocked) session.
 */
export enum AssetLockReason {
  /** The owner locked it (Lock, the former Mark Sensitive, or a request for `visibility: locked`). */
  Marked = 'marked',
  /** Sensitive-content detection flagged it; reviewable and reversible in the Locked view. */
  Detected = 'detected',
  /** It was in the upstream Locked folder (`visibility = locked`) when the library was upgraded. */
  ImmichLockedFolder = 'immich-locked-folder',
}

export const AssetLockReasonSchema = z
  .enum(AssetLockReason)
  .describe('Why an asset is locked')
  .meta({ id: 'AssetLockReason' });

export enum ReleaseChannel {
  Stable = 'stable',
  ReleaseCandidate = 'releaseCandidate',
}

export const ReleaseChannelSchema = z.enum(ReleaseChannel).describe('Release channel').meta({ id: 'ReleaseChannel' });

export enum CronJob {
  LibraryScan = 'LibraryScan',
  NightlyJobs = 'NightlyJobs',
  VersionCheck = 'VersionCheck',
}

export enum ConfigVisibility {
  Public = 'Public',
  User = 'User',
  Admin = 'Admin',
}

export enum ApiTag {
  Activities = 'Activities',
  Albums = 'Albums',
  ApiKeys = 'API keys',
  Authentication = 'Authentication',
  AuthenticationAdmin = 'Authentication (admin)',
  Assets = 'Assets',
  AssetFiles = 'Asset files',
  ConfigUser = 'Config (user)',
  ConfigAdmin = 'Config (admin)',
  ConfigPublic = 'Config (public)',
  DatabaseBackups = 'Database Backups (admin)',
  Deprecated = 'Deprecated',
  Download = 'Download',
  Duplicates = 'Duplicates',
  Faces = 'Faces',
  Integrity = 'Integrity (admin)',
  Jobs = 'Jobs',
  Libraries = 'Libraries',
  LivePhoto = 'Live Photo',
  Maintenance = 'Maintenance (admin)',
  Map = 'Map',
  MediaHealth = 'Media Health',
  MediaOperations = 'Media operations',
  RenderWorkers = 'Render workers',
  Memories = 'Memories',
  MlDestinations = 'ML destinations',
  Notifications = 'Notifications',
  NotificationsAdmin = 'Notifications (admin)',
  ClusterGroups = 'Cluster groups',
  Partners = 'Partners',
  People = 'People',
  Pets = 'Pets',
  Plugins = 'Plugins',
  Queues = 'Queues',
  RunPod = 'RunPod (admin)',
  Search = 'Search',
  Server = 'Server',
  Sessions = 'Sessions',
  SharedLinks = 'Shared links',
  SharedSpaces = 'Shared spaces',
  Stacks = 'Stacks',
  StudioPreviews = 'Studio previews',
  StudioProjects = 'Studio projects',
  Sync = 'Sync',
  SystemConfig = 'System config',
  SystemMetadata = 'System metadata',
  Tags = 'Tags',
  Timeline = 'Timeline',
  Trash = 'Trash',
  UsersAdmin = 'Users (admin)',
  Users = 'Users',
  Views = 'Views',
  Workflows = 'Workflows',
}

export const WorkflowTriggerSchema = z
  .enum(WorkflowTrigger)
  .describe('Plugin trigger type')
  .meta({ id: 'WorkflowTrigger' });

export enum WorkflowType {
  AssetV1 = 'AssetV1',
  // AssetPersonV1 = 'AssetPersonV1',
}

export const WorkflowTypeSchema = z.enum(WorkflowType).describe('Workflow type').meta({ id: 'WorkflowType' });

export enum CalendarHeatmapType {
  Upload = 'Upload',
  Taken = 'Taken',
}

export enum WorkflowResult {
  Completed = 'completed',
  Halted = 'halted',
  Error = 'error',
}

export const WorkflowResultSchema = z
  .enum(WorkflowResult)
  .describe('Workflow run result')
  .meta({ id: 'WorkflowResult' });

export enum SearchOrderField {
  FileCreatedAt = 'fileCreatedAt',
  LocalDateTime = 'localDateTime',
  FileSizeInBytes = 'fileSizeInBytes',
  Rating = 'rating',
}

export const SearchOrderFieldSchema = z.enum(SearchOrderField).meta({ id: 'SearchOrderField' });
