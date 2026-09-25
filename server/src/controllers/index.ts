import { ActivityController } from 'src/controllers/activity.controller.js';
import { AlbumController } from 'src/controllers/album.controller.js';
import { AnalyticsController } from 'src/controllers/analytics.controller.js';
import { ApiKeyController } from 'src/controllers/api-key.controller.js';
import { AppController } from 'src/controllers/app.controller.js';
import { ArchiveOperationController } from 'src/controllers/archive-operation.controller.js';
import { AssetDevelopController } from 'src/controllers/asset-develop.controller.js';
import { AssetFilesController } from 'src/controllers/asset-file.controller.js';
import { AssetMediaController } from 'src/controllers/asset-media.controller.js';
import { AssetRestorationController } from 'src/controllers/asset-restoration.controller.js';
import { AssetController } from 'src/controllers/asset.controller.js';
import { AuthAdminController } from 'src/controllers/auth-admin.controller.js';
import { AuthController } from 'src/controllers/auth.controller.js';
import { BestPhotosController } from 'src/controllers/best-photos.controller.js';
import { ClassificationController } from 'src/controllers/classification.controller.js';
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
import { ICloudSyncController } from 'src/controllers/icloud-sync.controller.js';
import { IntegrityAdminController } from 'src/controllers/integrity-admin.controller.js';
import { JobController } from 'src/controllers/job.controller.js';
import { LibraryController } from 'src/controllers/library.controller.js';
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
import { PhysicalDeduplicationController } from 'src/controllers/physical-deduplication.controller.js';
import { PluginController } from 'src/controllers/plugin.controller.js';
import { PreservationController } from 'src/controllers/preservation.controller.js';
import { QueueController } from 'src/controllers/queue.controller.js';
import { RenderWorkerAdminController, RenderWorkerController } from 'src/controllers/render-worker.controller.js';
import { RunPodController } from 'src/controllers/runpod.controller.js';
import { SearchController } from 'src/controllers/search.controller.js';
import { ServerController } from 'src/controllers/server.controller.js';
import { SessionController } from 'src/controllers/session.controller.js';
import { SharedLinkController } from 'src/controllers/shared-link.controller.js';
import { SharedSpaceController } from 'src/controllers/shared-space.controller.js';
import { StackController } from 'src/controllers/stack.controller.js';
import { StudioBundleController } from 'src/controllers/studio-bundle.controller.js';
import { StudioExportController } from 'src/controllers/studio-export.controller.js';
import { StudioPreviewController } from 'src/controllers/studio-preview.controller.js';
import { StudioProjectController } from 'src/controllers/studio-project.controller.js';
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
  ICloudSyncController,
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
  PluginController,
  PreservationController,
  QueueController,
  RunPodController,
  SearchController,
  ServerController,
  SessionController,
  SharedLinkController,
  SharedSpaceController,
  StackController,
  StudioBundleController,
  StudioExportController,
  StudioPreviewController,
  StudioProjectController,
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
