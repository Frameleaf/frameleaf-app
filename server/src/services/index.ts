import { ActivityService } from 'src/services/activity.service.js';
import { AlbumSourceService } from 'src/services/album-source.service.js';
import { AlbumService } from 'src/services/album.service.js';
import { AnalyticsService } from 'src/services/analytics.service.js';
import { ApiKeyService } from 'src/services/api-key.service.js';
import { ApiService } from 'src/services/api.service.js';
import { ArchiveOperationService } from 'src/services/archive-operation.service.js';
import { AssetDevelopService } from 'src/services/asset-develop.service.js';
import { AssetFileService } from 'src/services/asset-file.service.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { AssetRestorationService } from 'src/services/asset-restoration.service.js';
import { AssetUploadResourceService } from 'src/services/asset-upload-resource.service.js';
import { AssetService } from 'src/services/asset.service.js';
import { AuthAdminService } from 'src/services/auth-admin.service.js';
import { AuthService } from 'src/services/auth.service.js';
import { BackupDeviceService } from 'src/services/backup-device.service.js';
import { BestPhotosService } from 'src/services/best-photos.service.js';
import { BuddyBackupCaptureService } from 'src/services/buddy-backup-capture.service.js';
import { BuddyBackupPeerService } from 'src/services/buddy-backup-peer.service.js';
import { BuddyBackupRecoveryService } from 'src/services/buddy-backup-recovery.service.js';
import { BuddyBackupRestoreService } from 'src/services/buddy-backup-restore.service.js';
import { BuddyBackupService } from 'src/services/buddy-backup.service.js';
import { BulkOperationService } from 'src/services/bulk-operation.service.js';
import { CastService } from 'src/services/cast.service.js';
import { ClassificationService } from 'src/services/classification.service.js';
import { CliService } from 'src/services/cli.service.js';
import { CloudBackupDetailsService } from 'src/services/cloud-backup-details.service.js';
import { CloudBackupService } from 'src/services/cloud-backup.service.js';
import { CloudMlBatchService } from 'src/services/cloud-ml-batch.service.js';
import { CloudMlJobService } from 'src/services/cloud-ml-job.service.js';
import { CloudMlService } from 'src/services/cloud-ml.service.js';
import { ClusterGroupService } from 'src/services/cluster-group.service.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import { DatabaseService } from 'src/services/database.service.js';
import { DocumentService } from 'src/services/document.service.js';
import { DownloadService } from 'src/services/download.service.js';
import { DuplicateDecisionService } from 'src/services/duplicate-decision.service.js';
import { DuplicateService } from 'src/services/duplicate.service.js';
import { EnrichmentPlanService } from 'src/services/enrichment-plan.service.js';
import { FrameleafAuthService } from 'src/services/frameleaf-auth.service.js';
import { FrameleafCloudTourService } from 'src/services/frameleaf-cloud-tour.service.js';
import { FrameleafCloudService } from 'src/services/frameleaf-cloud.service.js';
import { FrameleafLibrarySetupService } from 'src/services/frameleaf-library-setup.service.js';
import { FrameleafLicenseService } from 'src/services/frameleaf-license.service.js';
import { FrameleafRemoteAccessService } from 'src/services/frameleaf-remote-access.service.js';
import { FrameleafServerSetupService } from 'src/services/frameleaf-server-setup.service.js';
import { HardwareCheckService } from 'src/services/hardware-check.service.js';
import { HlsService } from 'src/services/hls.service.js';
import { ICloudAlbumService } from 'src/services/icloud-album.service.js';
import { ICloudAuditService } from 'src/services/icloud-audit.service.js';
import { ICloudIdentityAdoptionService } from 'src/services/icloud-identity-adoption.service.js';
import { ICloudIdentityService } from 'src/services/icloud-identity.service.js';
import { ICloudMetadataService } from 'src/services/icloud-metadata.service.js';
import { ICloudRelationsService } from 'src/services/icloud-relations.service.js';
import { ICloudScheduledStagingService } from 'src/services/icloud-scheduled-staging.service.js';
import { ICloudScheduledWorkerService } from 'src/services/icloud-scheduled-worker.service.js';
import { ICloudStagingService } from 'src/services/icloud-staging.service.js';
import { ICloudSyncService } from 'src/services/icloud-sync.service.js';
import { ICloudWeeklyService } from 'src/services/icloud-weekly.service.js';
import { ImageEnrichmentService } from 'src/services/image-enrichment.service.js';
import { IntegrityService } from 'src/services/integrity.service.js';
import { ItemShareService } from 'src/services/item-share.service.js';
import { JobService } from 'src/services/job.service.js';
import { LanDiscoveryService } from 'src/services/lan-discovery.service.js';
import { LibraryScanService } from 'src/services/library-scan.service.js';
import { LibraryService } from 'src/services/library.service.js';
import { LivePhotoService } from 'src/services/live-photo.service.js';
import { MaintenanceService } from 'src/services/maintenance.service.js';
import { MapService } from 'src/services/map.service.js';
import { MediaHealthOperationService } from 'src/services/media-health-operation.service.js';
import { MediaHealthService } from 'src/services/media-health.service.js';
import { MediaIntegrityService } from 'src/services/media-integrity.service.js';
import { MediaOperationEventService } from 'src/services/media-operation-event.service.js';
import { MediaOperationSweepService } from 'src/services/media-operation-sweep.service.js';
import { MediaOperationService } from 'src/services/media-operation.service.js';
import { MediaRecoveryService } from 'src/services/media-recovery.service.js';
import { MediaService } from 'src/services/media.service.js';
import { MemoryHighlightService } from 'src/services/memory-highlight.service.js';
import { MemoryService } from 'src/services/memory.service.js';
import { MetadataService } from 'src/services/metadata.service.js';
import { MlDestinationService } from 'src/services/ml-destination.service.js';
import { NotificationAdminService } from 'src/services/notification-admin.service.js';
import { NotificationService } from 'src/services/notification.service.js';
import { OcrService } from 'src/services/ocr.service.js';
import { PartnerCopyService } from 'src/services/partner-copy.service.js';
import { PartnerLockService } from 'src/services/partner-lock.service.js';
import { PartnerLockedNoticeService } from 'src/services/partner-locked-notice.service.js';
import { PartnerPeopleService } from 'src/services/partner-people.service.js';
import { PartnerService } from 'src/services/partner.service.js';
import { PersonService } from 'src/services/person.service.js';
import { PetRecognitionService } from 'src/services/pet-recognition.service.js';
import { PetService } from 'src/services/pet.service.js';
import { PhotoToolsService } from 'src/services/photo-tools.service.js';
import { PhotographyWorkflowService } from 'src/services/photography-workflow.service.js';
import { PhotographyWorkspaceService } from 'src/services/photography-workspace.service.js';
import { PhysicalDeduplicationPlanService } from 'src/services/physical-deduplication-plan.service.js';
import { PhysicalDeduplicationService } from 'src/services/physical-deduplication.service.js';
import { PhysicalFileTrashService } from 'src/services/physical-file-trash.service.js';
import { PinnedCollectionService } from 'src/services/pinned-collection.service.js';
import { PluginService } from 'src/services/plugin.service.js';
import { PreservationWorkerService } from 'src/services/preservation-worker.service.js';
import { PreservationService } from 'src/services/preservation.service.js';
import { PushService } from 'src/services/push.service.js';
import { QueueService } from 'src/services/queue.service.js';
import { RenderWorkerService } from 'src/services/render-worker.service.js';
import { RestorationWorkerService } from 'src/services/restoration-worker.service.js';
import { RunningJobService } from 'src/services/running-job.service.js';
import { SafetyService } from 'src/services/safety.service.js';
import { SearchService } from 'src/services/search.service.js';
import { ServerService } from 'src/services/server.service.js';
import { SessionService } from 'src/services/session.service.js';
import { SharedLinkService } from 'src/services/shared-link.service.js';
import { SharedSpaceService } from 'src/services/shared-space.service.js';
import { SmartAlbumService } from 'src/services/smart-album.service.js';
import { SmartInfoService } from 'src/services/smart-info.service.js';
import { StackService } from 'src/services/stack.service.js';
import { StorageTemplateService } from 'src/services/storage-template.service.js';
import { StorageService } from 'src/services/storage.service.js';
import { StudioBundleService } from 'src/services/studio-bundle.service.js';
import { StudioCatalogService } from 'src/services/studio-catalog.service.js';
import { StudioExportService } from 'src/services/studio-export.service.js';
import { StudioMediaService } from 'src/services/studio-media.service.js';
import { StudioPreviewStreamService } from 'src/services/studio-preview-stream.service.js';
import { StudioPreviewService } from 'src/services/studio-preview.service.js';
import { StudioProjectImportService } from 'src/services/studio-project-import.service.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { StudioResourceService } from 'src/services/studio-resource.service.js';
import { StudioReverseConformCommandService } from 'src/services/studio-reverse-conform-command.service.js';
import { StudioReverseConformService } from 'src/services/studio-reverse-conform.service.js';
import { StudioRevocationService } from 'src/services/studio-revocation.service.js';
import { StudioTranscriptionService } from 'src/services/studio-transcription.service.js';
import { StudioWorkspaceService } from 'src/services/studio-workspace.service.js';
import { SyncService } from 'src/services/sync.service.js';
import { SystemConfigService } from 'src/services/system-config.service.js';
import { SystemMetadataService } from 'src/services/system-metadata.service.js';
import { TagService } from 'src/services/tag.service.js';
import { TakeoutWorkerService } from 'src/services/takeout-worker.service.js';
import { TakeoutService } from 'src/services/takeout.service.js';
import { TimelineService } from 'src/services/timeline.service.js';
import { TranscodingService } from 'src/services/transcoding.service.js';
import { TrashService } from 'src/services/trash.service.js';
import { UserAdminService } from 'src/services/user-admin.service.js';
import { UserService } from 'src/services/user.service.js';
import { VersionService } from 'src/services/version.service.js';
import { VideoMomentIndexService } from 'src/services/video-moment-index.service.js';
import { ViewService } from 'src/services/view.service.js';
import { WorkerInventoryService } from 'src/services/worker-inventory.service.js';
import { WorkflowExecutionService } from 'src/services/workflow-execution.service.js';
import { WorkflowService } from 'src/services/workflow.service.js';
import { ZeroShotTaggingService } from 'src/services/zero-shot-tagging.service.js';

export const services = [
  FrameleafLibrarySetupService,
  ICloudAuditService,
  ICloudScheduledStagingService,
  ICloudScheduledWorkerService,
  ICloudIdentityAdoptionService,
  PhotographyWorkspaceService,
  PhotographyWorkflowService,
  AssetUploadResourceService,
  BackupDeviceService,
  PushService,
  SafetyService,
  CloudMlService,
  CloudBackupDetailsService,
  CloudBackupService,
  BuddyBackupService,
  CastService,
  BuddyBackupPeerService,
  BuddyBackupCaptureService,
  BuddyBackupRestoreService,
  BuddyBackupRecoveryService,
  CloudMlBatchService,
  CloudMlJobService,
  FrameleafAuthService,
  FrameleafServerSetupService,
  FrameleafCloudService,
  FrameleafCloudTourService,
  FrameleafLicenseService,
  FrameleafRemoteAccessService,
  HardwareCheckService,
  ICloudMetadataService,
  ICloudRelationsService,
  ICloudAlbumService,
  MediaRecoveryService,
  MediaIntegrityService,
  ICloudStagingService,
  ICloudSyncService,
  ICloudWeeklyService,
  ICloudIdentityService,
  ApiKeyService,
  ArchiveOperationService,
  ActivityService,
  AlbumService,
  ApiService,
  AssetDevelopService,
  AssetFileService,
  AssetMediaService,
  AssetRestorationService,
  AssetService,
  AuthService,
  AuthAdminService,
  AnalyticsService,
  BestPhotosService,
  ClassificationService,
  BulkOperationService,
  CliService,
  DatabaseBackupService,
  DatabaseService,
  DocumentService,
  DownloadService,
  DuplicateDecisionService,
  DuplicateService,
  EnrichmentPlanService,
  ImageEnrichmentService,
  IntegrityService,
  HlsService,
  JobService,
  LanDiscoveryService,
  LibraryScanService,
  LibraryService,
  LivePhotoService,
  MaintenanceService,
  MapService,
  MediaHealthOperationService,
  MediaHealthService,
  MediaOperationService,
  MediaOperationEventService,
  MediaOperationSweepService,
  PhotoToolsService,
  RenderWorkerService,
  MediaService,
  MemoryHighlightService,
  MemoryService,
  MlDestinationService,
  WorkerInventoryService,
  MetadataService,
  NotificationService,
  NotificationAdminService,
  OcrService,
  ClusterGroupService,
  PartnerLockService,
  PartnerLockedNoticeService,
  PartnerPeopleService,
  PartnerService,
  PartnerCopyService,
  PersonService,
  PinnedCollectionService,
  PetRecognitionService,
  PetService,
  PhysicalDeduplicationPlanService,
  PhysicalDeduplicationService,
  PhysicalFileTrashService,
  PluginService,
  PreservationService,
  PreservationWorkerService,
  QueueService,
  RestorationWorkerService,
  RunningJobService,
  SearchService,
  ServerService,
  SessionService,
  SharedLinkService,
  ItemShareService,
  AlbumSourceService,
  SharedSpaceService,
  SmartAlbumService,
  SmartInfoService,
  ZeroShotTaggingService,
  StackService,
  StudioExportService,
  StudioPreviewService,
  StudioPreviewStreamService,
  StorageService,
  StorageTemplateService,
  StudioMediaService,
  StudioBundleService,
  StudioProjectImportService,
  StudioProjectService,
  StudioReverseConformService,
  StudioReverseConformCommandService,
  StudioTranscriptionService,
  StudioResourceService,
  StudioRevocationService,
  StudioCatalogService,
  StudioWorkspaceService,
  SyncService,
  SystemConfigService,
  SystemMetadataService,
  TagService,
  TakeoutService,
  TakeoutWorkerService,
  TimelineService,
  TranscodingService,
  TrashService,
  UserAdminService,
  UserService,
  VersionService,
  VideoMomentIndexService,
  ViewService,
  WorkflowExecutionService,
  WorkflowService,
];
