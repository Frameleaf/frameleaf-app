import { ActivityService } from 'src/services/activity.service.js';
import { AlbumService } from 'src/services/album.service.js';
import { AnalyticsService } from 'src/services/analytics.service.js';
import { ApiKeyService } from 'src/services/api-key.service.js';
import { ApiService } from 'src/services/api.service.js';
import { ArchiveOperationService } from 'src/services/archive-operation.service.js';
import { AssetDevelopService } from 'src/services/asset-develop.service.js';
import { AssetFileService } from 'src/services/asset-file.service.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { AssetRestorationService } from 'src/services/asset-restoration.service.js';
import { AssetService } from 'src/services/asset.service.js';
import { AuthAdminService } from 'src/services/auth-admin.service.js';
import { AuthService } from 'src/services/auth.service.js';
import { BestPhotosService } from 'src/services/best-photos.service.js';
import { BulkOperationService } from 'src/services/bulk-operation.service.js';
import { ClassificationService } from 'src/services/classification.service.js';
import { CliService } from 'src/services/cli.service.js';
import { CloudMlBatchService } from 'src/services/cloud-ml-batch.service.js';
import { CloudMlService } from 'src/services/cloud-ml.service.js';
import { ClusterGroupService } from 'src/services/cluster-group.service.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import { DatabaseService } from 'src/services/database.service.js';
import { DocumentService } from 'src/services/document.service.js';
import { DownloadService } from 'src/services/download.service.js';
import { DuplicateDecisionService } from 'src/services/duplicate-decision.service.js';
import { DuplicateService } from 'src/services/duplicate.service.js';
import { EnrichmentPlanService } from 'src/services/enrichment-plan.service.js';
import { ForkCutoverVerificationService } from 'src/services/fork-cutover-verification.service.js';
import { ForkHandoffService } from 'src/services/fork-handoff.service.js';
import { ForkSchemaCutoverService } from 'src/services/fork-schema-cutover.service.js';
import { ForkSchemaMigrationService } from 'src/services/fork-schema-migration.service.js';
import { FrameleafAuthService } from 'src/services/frameleaf-auth.service.js';
import { FrameleafCloudService } from 'src/services/frameleaf-cloud.service.js';
import { FrameleafLicenseService } from 'src/services/frameleaf-license.service.js';
import { HardwareCheckService } from 'src/services/hardware-check.service.js';
import { HlsService } from 'src/services/hls.service.js';
import { ICloudAlbumService } from 'src/services/icloud-album.service.js';
import { ICloudMetadataService } from 'src/services/icloud-metadata.service.js';
import { ICloudRelationsService } from 'src/services/icloud-relations.service.js';
import { ICloudStagingService } from 'src/services/icloud-staging.service.js';
import { ICloudSyncService } from 'src/services/icloud-sync.service.js';
import { ImageEnrichmentService } from 'src/services/image-enrichment.service.js';
import { IntegrityService } from 'src/services/integrity.service.js';
import { JobService } from 'src/services/job.service.js';
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
import { MemoryService } from 'src/services/memory.service.js';
import { MetadataService } from 'src/services/metadata.service.js';
import { MlDestinationService } from 'src/services/ml-destination.service.js';
import { NotificationAdminService } from 'src/services/notification-admin.service.js';
import { NotificationService } from 'src/services/notification.service.js';
import { OcrService } from 'src/services/ocr.service.js';
import { PartnerService } from 'src/services/partner.service.js';
import { PersonService } from 'src/services/person.service.js';
import { PetRecognitionService } from 'src/services/pet-recognition.service.js';
import { PetService } from 'src/services/pet.service.js';
import { PhotoToolsService } from 'src/services/photo-tools.service.js';
import { PhysicalDeduplicationPlanService } from 'src/services/physical-deduplication-plan.service.js';
import { PhysicalDeduplicationService } from 'src/services/physical-deduplication.service.js';
import { PluginService } from 'src/services/plugin.service.js';
import { PreservationWorkerService } from 'src/services/preservation-worker.service.js';
import { PreservationService } from 'src/services/preservation.service.js';
import { QueueService } from 'src/services/queue.service.js';
import { RenderWorkerService } from 'src/services/render-worker.service.js';
import { RestorationWorkerService } from 'src/services/restoration-worker.service.js';
import { RunningJobService } from 'src/services/running-job.service.js';
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
import { StudioExportService } from 'src/services/studio-export.service.js';
import { StudioPreviewService } from 'src/services/studio-preview.service.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { StudioResourceService } from 'src/services/studio-resource.service.js';
import { StudioRevocationService } from 'src/services/studio-revocation.service.js';
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
  CloudMlService,
  CloudMlBatchService,
  FrameleafAuthService,
  FrameleafCloudService,
  FrameleafLicenseService,
  HardwareCheckService,
  ICloudMetadataService,
  ICloudRelationsService,
  ICloudAlbumService,
  MediaRecoveryService,
  MediaIntegrityService,
  ICloudStagingService,
  ICloudSyncService,
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
  ForkCutoverVerificationService,
  ForkHandoffService,
  ForkSchemaCutoverService,
  ForkSchemaMigrationService,
  ImageEnrichmentService,
  IntegrityService,
  HlsService,
  JobService,
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
  MemoryService,
  MlDestinationService,
  WorkerInventoryService,
  MetadataService,
  NotificationService,
  NotificationAdminService,
  OcrService,
  ClusterGroupService,
  PartnerService,
  PersonService,
  PetRecognitionService,
  PetService,
  PhysicalDeduplicationPlanService,
  PhysicalDeduplicationService,
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
  SharedSpaceService,
  SmartAlbumService,
  SmartInfoService,
  ZeroShotTaggingService,
  StackService,
  StudioExportService,
  StudioPreviewService,
  StorageService,
  StorageTemplateService,
  StudioBundleService,
  StudioProjectService,
  StudioResourceService,
  StudioRevocationService,
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
