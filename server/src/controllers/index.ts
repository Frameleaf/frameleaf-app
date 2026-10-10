import { ActivityController } from 'src/controllers/activity.controller.js';
import { AlbumSourceController } from 'src/controllers/album-source.controller.js';
import { AlbumController } from 'src/controllers/album.controller.js';
import { AnalyticsController } from 'src/controllers/analytics.controller.js';
import { ApiKeyController } from 'src/controllers/api-key.controller.js';
import { AppController } from 'src/controllers/app.controller.js';
import { ArchiveOperationController } from 'src/controllers/archive-operation.controller.js';
import { AssetDevelopController } from 'src/controllers/asset-develop.controller.js';
import { AssetFilesController } from 'src/controllers/asset-file.controller.js';
import { AssetMediaController } from 'src/controllers/asset-media.controller.js';
import { AssetRestorationController } from 'src/controllers/asset-restoration.controller.js';
import { AssetUploadResourceController } from 'src/controllers/asset-upload-resource.controller.js';
import { AssetController } from 'src/controllers/asset.controller.js';
import { AuthAdminController } from 'src/controllers/auth-admin.controller.js';
import { AuthController } from 'src/controllers/auth.controller.js';
import { BackupDeviceAdminController, BackupDeviceController } from 'src/controllers/backup-device.controller.js';
import { BestPhotosController } from 'src/controllers/best-photos.controller.js';
import { BuddyBackupPeerController } from 'src/controllers/buddy-backup-peer.controller.js';
import { BuddyBackupAdminController, BuddyBackupOwnerController } from 'src/controllers/buddy-backup.controller.js';
import { CastController } from 'src/controllers/cast.controller.js';
import { ClassificationController } from 'src/controllers/classification.controller.js';
import { CloudAdminController } from 'src/controllers/cloud-admin.controller.js';
import { CloudBackupAdminController } from 'src/controllers/cloud-backup-admin.controller.js';
import { CloudBackupOwnerController } from 'src/controllers/cloud-backup-owner.controller.js';
import { CloudMlAdminController } from 'src/controllers/cloud-ml-admin.controller.js';
import { CloudMlController } from 'src/controllers/cloud-ml.controller.js';
import { ClusterGroupController } from 'src/controllers/cluster-group.controller.js';
import { ConfigAdminController } from 'src/controllers/config-admin.controller.js';
import { ConfigPublicController } from 'src/controllers/config-public.controller.js';
import { ConfigUserController } from 'src/controllers/config-user.controller.js';
import { DatabaseBackupController } from 'src/controllers/database-backup.controller.js';
import { DocumentController } from 'src/controllers/document.controller.js';
import { DownloadController } from 'src/controllers/download.controller.js';
import { DuplicateReviewController } from 'src/controllers/duplicate-review.controller.js';
import { DuplicateController } from 'src/controllers/duplicate.controller.js';
import { EnrichmentController } from 'src/controllers/enrichment.controller.js';
import { FaceController } from 'src/controllers/face.controller.js';
import { FrameleafAuthController } from 'src/controllers/frameleaf-auth.controller.js';
import { FrameleafLibrarySetupController } from 'src/controllers/frameleaf-library-setup.controller.js';
import { FrameleafServerSetupController } from 'src/controllers/frameleaf-server-setup.controller.js';
import { HardwareCheckController } from 'src/controllers/hardware-check.controller.js';
import { ICloudIdentityController } from 'src/controllers/icloud-identity.controller.js';
import { ICloudSyncController } from 'src/controllers/icloud-sync.controller.js';
import { IntegrityAdminController } from 'src/controllers/integrity-admin.controller.js';
import { ItemShareController } from 'src/controllers/item-share.controller.js';
import { JobController } from 'src/controllers/job.controller.js';
import { LibraryController } from 'src/controllers/library.controller.js';
import { LicenseAdminController, LicenseController } from 'src/controllers/license-admin.controller.js';
import { LivePhotoController } from 'src/controllers/live-photo.controller.js';
import { MaintenanceController } from 'src/controllers/maintenance.controller.js';
import { MapController } from 'src/controllers/map.controller.js';
import { MediaHealthController } from 'src/controllers/media-health.controller.js';
import { MediaOperationController } from 'src/controllers/media-operation.controller.js';
import { MemoryController } from 'src/controllers/memory.controller.js';
import { MlDestinationController } from 'src/controllers/ml-destination.controller.js';
import { NotificationAdminController } from 'src/controllers/notification-admin.controller.js';
import { NotificationController } from 'src/controllers/notification.controller.js';
import { OAuthController } from 'src/controllers/oauth.controller.js';
import { PartnerController } from 'src/controllers/partner.controller.js';
import { PersonController } from 'src/controllers/person.controller.js';
import { PetController } from 'src/controllers/pet.controller.js';
import { PhotoToolsController } from 'src/controllers/photo-tools.controller.js';
import { PhotographyWorkflowController } from 'src/controllers/photography-workflow.controller.js';
import { PhotographyWorkspaceController } from 'src/controllers/photography-workspace.controller.js';
import { PhysicalDeduplicationController } from 'src/controllers/physical-deduplication.controller.js';
import { PhysicalFileTrashController } from 'src/controllers/physical-file-trash.controller.js';
import { PluginController } from 'src/controllers/plugin.controller.js';
import { PreservationController } from 'src/controllers/preservation.controller.js';
import { PushController } from 'src/controllers/push.controller.js';
import { QueueController } from 'src/controllers/queue.controller.js';
import { RenderWorkerAdminController, RenderWorkerController } from 'src/controllers/render-worker.controller.js';
import { SafetyController } from 'src/controllers/safety.controller.js';
import { SearchController } from 'src/controllers/search.controller.js';
import { ServerController } from 'src/controllers/server.controller.js';
import { SessionController } from 'src/controllers/session.controller.js';
import { SharedLinkController } from 'src/controllers/shared-link.controller.js';
import { SharedSpaceController } from 'src/controllers/shared-space.controller.js';
import { StackController } from 'src/controllers/stack.controller.js';
import { StorageMigrationAdminController } from 'src/controllers/storage-migration-admin.controller.js';
import { StudioBundleController } from 'src/controllers/studio-bundle.controller.js';
import { StudioExportController } from 'src/controllers/studio-export.controller.js';
import { StudioMediaController } from 'src/controllers/studio-media.controller.js';
import { StudioPreviewStreamController } from 'src/controllers/studio-preview-stream.controller.js';
import { StudioPreviewController } from 'src/controllers/studio-preview.controller.js';
import { StudioProjectImportController } from 'src/controllers/studio-project-import.controller.js';
import { StudioProjectController } from 'src/controllers/studio-project.controller.js';
import { StudioSourceController } from 'src/controllers/studio-source.controller.js';
import { StudioWorkspaceController } from 'src/controllers/studio-workspace.controller.js';
import { SyncController } from 'src/controllers/sync.controller.js';
import { SystemConfigController } from 'src/controllers/system-config.controller.js';
import { SystemMetadataController } from 'src/controllers/system-metadata.controller.js';
import { TagController } from 'src/controllers/tag.controller.js';
import { TakeoutController } from 'src/controllers/takeout.controller.js';
import { TimelineController } from 'src/controllers/timeline.controller.js';
import { TrashController } from 'src/controllers/trash.controller.js';
import { UserAdminController } from 'src/controllers/user-admin.controller.js';
import { UserController } from 'src/controllers/user.controller.js';
import { VideoStreamController } from 'src/controllers/video-stream.controller.js';
import { ViewController } from 'src/controllers/view.controller.js';
import { WorkerInventoryController } from 'src/controllers/worker-inventory.controller.js';
import { WorkflowController } from 'src/controllers/workflow.controller.js';

export const controllers = [
  FrameleafLibrarySetupController,
  PhotographyWorkspaceController,
  PhotographyWorkflowController,
  AssetUploadResourceController,
  BackupDeviceAdminController,
  BackupDeviceController,
  PushController,
  SafetyController,
  CloudAdminController,
  FrameleafAuthController,
  FrameleafServerSetupController,
  LicenseAdminController,
  LicenseController,
  CloudMlAdminController,
  CloudMlController,
  CloudBackupAdminController,
  BuddyBackupAdminController,
  BuddyBackupOwnerController,
  BuddyBackupPeerController,
  CastController,
  CloudBackupOwnerController,
  HardwareCheckController,
  ICloudSyncController,
  ICloudIdentityController,
  ApiKeyController,
  ActivityController,
  AlbumController,
  AppController,
  ArchiveOperationController,
  AssetController,
  AssetDevelopController,
  AssetFilesController,
  AssetMediaController,
  AssetRestorationController,
  AuthController,
  AuthAdminController,
  AnalyticsController,
  BestPhotosController,
  ClassificationController,
  ClusterGroupController,
  ConfigUserController,
  ConfigAdminController,
  ConfigPublicController,
  DatabaseBackupController,
  DocumentController,
  DownloadController,
  DuplicateController,
  DuplicateReviewController,
  EnrichmentController,
  FaceController,
  IntegrityAdminController,
  JobController,
  LibraryController,
  LivePhotoController,
  MaintenanceController,
  MapController,
  MediaHealthController,
  MediaOperationController,
  PhotoToolsController,
  RenderWorkerAdminController,
  RenderWorkerController,
  MemoryController,
  MlDestinationController,
  WorkerInventoryController,
  NotificationController,
  NotificationAdminController,
  OAuthController,
  PartnerController,
  PersonController,
  PetController,
  PhysicalDeduplicationController,
  PhysicalFileTrashController,
  PluginController,
  PreservationController,
  QueueController,
  SearchController,
  ServerController,
  SessionController,
  SharedLinkController,
  ItemShareController,
  AlbumSourceController,
  SharedSpaceController,
  StackController,
  StorageMigrationAdminController,
  StudioMediaController,
  StudioBundleController,
  StudioExportController,
  StudioPreviewController,
  StudioPreviewStreamController,
  StudioProjectImportController,
  StudioProjectController,
  StudioSourceController,
  StudioWorkspaceController,
  SyncController,
  SystemConfigController,
  SystemMetadataController,
  TagController,
  TakeoutController,
  TimelineController,
  TrashController,
  UserAdminController,
  UserController,
  VideoStreamController,
  ViewController,
  WorkflowController,
];
