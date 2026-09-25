import { AccessRepository } from 'src/repositories/access.repository.js';
import { ActivityRepository } from 'src/repositories/activity.repository.js';
import { AdminAuditRepository } from 'src/repositories/admin-audit.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AnalyticsRepository } from 'src/repositories/analytics.repository.js';
import { ApiKeyRepository } from 'src/repositories/api-key.repository.js';
import { AppRepository } from 'src/repositories/app.repository.js';
import { ArchiveOperationRepository } from 'src/repositories/archive-operation.repository.js';
import { AssetDevelopRepository } from 'src/repositories/asset-develop.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetFileRepository } from 'src/repositories/asset-file.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRestorationRepository } from 'src/repositories/asset-restoration.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { BestPhotosRepository } from 'src/repositories/best-photos.repository.js';
import { ClassificationRepository } from 'src/repositories/classification.repository.js';
import { ClusterGroupRepository } from 'src/repositories/cluster-group.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CronRepository } from 'src/repositories/cron.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { DerivativePrivacyRepository } from 'src/repositories/derivative-privacy.repository.js';
import { DocumentRepository } from 'src/repositories/document.repository.js';
import { DownloadRepository } from 'src/repositories/download.repository.js';
import { DuplicateDecisionRepository } from 'src/repositories/duplicate-decision.repository.js';
import { DuplicateRepository } from 'src/repositories/duplicate.repository.js';
import { EmailRepository } from 'src/repositories/email.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { ForkAlbumMetadataRepository } from 'src/repositories/fork-album-metadata.repository.js';
import { ForkConfigRepository } from 'src/repositories/fork-config.repository.js';
import { ForkCutoverVerificationRepository } from 'src/repositories/fork-cutover-verification.repository.js';
import { ForkEnrichmentRepository } from 'src/repositories/fork-enrichment.repository.js';
import { ForkHandoffRepository } from 'src/repositories/fork-handoff.repository.js';
import { ForkPrivacyRepository } from 'src/repositories/fork-privacy.repository.js';
import { ForkSchemaRepository } from 'src/repositories/fork-schema.repository.js';
import { FrameleafAccountRepository } from 'src/repositories/frameleaf-account.repository.js';
import { FrameleafCloudMlRepository } from 'src/repositories/frameleaf-cloud-ml.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { FrameleafConsentRepository } from 'src/repositories/frameleaf-consent.repository.js';
import { FrameleafUserLicenseRepository } from 'src/repositories/frameleaf-user-license.repository.js';
import { HardwareProbeRepository } from 'src/repositories/hardware-probe.repository.js';
import { ICloudAlbumRepository } from 'src/repositories/icloud-album.repository.js';
import { ICloudMetadataRepository } from 'src/repositories/icloud-metadata.repository.js';
import { ICloudRelationsRepository } from 'src/repositories/icloud-relations.repository.js';
import { ICloudSyncRepository } from 'src/repositories/icloud-sync.repository.js';
import { ICloudTransportRepository } from 'src/repositories/icloud-transport.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LivePhotoRepository } from 'src/repositories/live-photo.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { MediaHealthRepository } from 'src/repositories/media-health.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaRecoveryRepository } from 'src/repositories/media-recovery.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { MemoryRepository } from 'src/repositories/memory.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { MoveRepository } from 'src/repositories/move.repository.js';
import { NotificationRepository } from 'src/repositories/notification.repository.js';
import { OAuthRepository } from 'src/repositories/oauth.repository.js';
import { OcrRepository } from 'src/repositories/ocr.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { PetRepository } from 'src/repositories/pet.repository.js';
import { PhotoToolsRepository } from 'src/repositories/photo-tools.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { PluginRepository } from 'src/repositories/plugin.repository.js';
import { PreservationFileRepository } from 'src/repositories/preservation-files.repository.js';
import { PreservationRepository } from 'src/repositories/preservation.repository.js';
import { ProcessRepository } from 'src/repositories/process.repository.js';
import { RenderWorkerRepository } from 'src/repositories/render-worker.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { ServerInfoRepository } from 'src/repositories/server-info.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SharedLinkAssetRepository } from 'src/repositories/shared-link-asset.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { SmartAlbumRepository } from 'src/repositories/smart-album.repository.js';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { StudioExportRepository } from 'src/repositories/studio-export.repository.js';
import { StudioPreviewRepository } from 'src/repositories/studio-preview.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { SyncCheckpointRepository } from 'src/repositories/sync-checkpoint.repository.js';
import { SyncRepository } from 'src/repositories/sync.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { TakeoutStagingRepository } from 'src/repositories/takeout-staging.repository.js';
import { TakeoutRepository } from 'src/repositories/takeout.repository.js';
import { TrashRepository } from 'src/repositories/trash.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { VersionHistoryRepository } from 'src/repositories/version-history.repository.js';
import { VideoMomentRepository } from 'src/repositories/video-moment.repository.js';
import { VideoStreamRepository } from 'src/repositories/video-stream.repository.js';
import { ViewRepository } from 'src/repositories/view-repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { WorkflowRepository } from 'src/repositories/workflow.repository.js';

export const repositories = [
  ICloudMetadataRepository,
  ICloudRelationsRepository,
  ICloudAlbumRepository,
  MediaRecoveryRepository,
  ICloudTransportRepository,
  ICloudSyncRepository,
  AccessRepository,
  ActivityRepository,
  AdminAuditRepository,
  AlbumRepository,
  AnalyticsRepository,
  AlbumUserRepository,
  ApiKeyRepository,
  ArchiveOperationRepository,
  AppRepository,
  BestPhotosRepository,
  AssetRepository,
  AssetDevelopRepository,
  AssetEditRepository,
  AssetFileRepository,
  AssetJobRepository,
  AssetRestorationRepository,
  ConfigRepository,
  CronRepository,
  CryptoRepository,
  DatabaseRepository,
  DocumentRepository,
  DownloadRepository,
  DuplicateDecisionRepository,
  DuplicateRepository,
  EmailRepository,
  EventRepository,
  ForkAlbumMetadataRepository,
  ForkConfigRepository,
  ForkCutoverVerificationRepository,
  ForkEnrichmentRepository,
  ForkHandoffRepository,
  ForkPrivacyRepository,
  ForkSchemaRepository,
  IntegrityRepository,
  JobRepository,
  LibraryRepository,
  LoggingRepository,
  LivePhotoRepository,
  MachineLearningRepository,
  MapRepository,
  MediaHealthRepository,
  MediaOperationRepository,
  RenderWorkerRepository,
  FrameleafCloudRepository,
  FrameleafCloudMlRepository,
  FrameleafConsentRepository,
  FrameleafUserLicenseRepository,
  FrameleafAccountRepository,
  HardwareProbeRepository,
  InstanceIdentityRepository,
  MediaRepository,
  MemoryRepository,
  MetadataRepository,
  MlDestinationRepository,
  MoveRepository,
  NotificationRepository,
  OAuthRepository,
  OcrRepository,
  ClassificationRepository,
  ClusterGroupRepository,
  PartnerRepository,
  PersonRepository,
  PetRepository,
  PhotoToolsRepository,
  PhysicalFileRepository,
  PluginRepository,
  PreservationFileRepository,
  PreservationRepository,
  ProcessRepository,
  SearchRepository,
  ServerInfoRepository,
  SmartAlbumRepository,
  StudioProjectRepository,
  StudioExportRepository,
  DerivativePrivacyRepository,
  SessionRepository,
  SharedLinkRepository,
  SharedLinkAssetRepository,
  StackRepository,
  StudioPreviewRepository,
  StorageRepository,
  SyncRepository,
  SyncCheckpointRepository,
  SystemMetadataRepository,
  TagRepository,
  TakeoutRepository,
  TakeoutStagingRepository,
  TrashRepository,
  UserRepository,
  ViewRepository,
  VersionHistoryRepository,
  VideoMomentRepository,
  VideoStreamRepository,
  WebsocketRepository,
  WorkflowRepository,
];
