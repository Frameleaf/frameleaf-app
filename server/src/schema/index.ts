import { Database, Extensions, Generated, Int8 } from '@immich/sql-tools';
import {
  album_user_role_enum,
  asset_face_source_type,
  asset_visibility_enum,
  assets_status_enum,
} from 'src/schema/enums.js';
import {
  album_user_after_insert,
  album_user_delete,
  album_user_delete_audit,
  asset_delete_audit,
  asset_face_audit,
  asset_metadata_audit,
  asset_ocr_delete_audit,
  f_concat_ws,
  f_unaccent,
  immich_uuid_v7,
  ll_to_earth_public,
  memory_asset_delete_audit,
  memory_delete_audit,
  partner_delete_audit,
  person_delete_audit,
  person_group_delete_audit,
  stack_delete_audit,
  updated_at,
  user_delete_audit,
  user_metadata_audit,
} from 'src/schema/functions.js';
import { ActivityTable } from 'src/schema/tables/activity.table.js';
import { AdminAuditEventTable } from 'src/schema/tables/admin-audit-event.table.js';
import { AlbumAssetAuditTable } from 'src/schema/tables/album-asset-audit.table.js';
import { AlbumAssetTable } from 'src/schema/tables/album-asset.table.js';
import { AlbumAuditTable } from 'src/schema/tables/album-audit.table.js';
import { AlbumClosureTable } from 'src/schema/tables/album-closure.table.js';
import { AlbumUserAuditTable } from 'src/schema/tables/album-user-audit.table.js';
import { AlbumUserTable } from 'src/schema/tables/album-user.table.js';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { ApiKeyTable } from 'src/schema/tables/api-key.table.js';
import { AssetAuditTable } from 'src/schema/tables/asset-audit.table.js';
import { AssetAudioTable, AssetKeyframeTable, AssetVideoTable } from 'src/schema/tables/asset-av.table.js';
import { AssetBestPhotoScoreTable } from 'src/schema/tables/asset-best-photo-score.table.js';
import { AssetDocumentEditTable } from 'src/schema/tables/asset-document-edit.table.js';
import { AssetEditAuditTable } from 'src/schema/tables/asset-edit-audit.table.js';
import { AssetEditTable } from 'src/schema/tables/asset-edit.table.js';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table.js';
import { AssetFaceAuditTable } from 'src/schema/tables/asset-face-audit.table.js';
import { AssetFaceTable } from 'src/schema/tables/asset-face.table.js';
import { AssetFileTable } from 'src/schema/tables/asset-file.table.js';
import {
  AssetHealthCandidateTable,
  AssetHealthRunTable,
  AssetHealthTable,
} from 'src/schema/tables/asset-health.table.js';
import { AssetJobStatusTable } from 'src/schema/tables/asset-job-status.table.js';
import { AssetLockTable } from 'src/schema/tables/asset-lock.table.js';
import { AssetMetadataAuditTable } from 'src/schema/tables/asset-metadata-audit.table.js';
import { AssetMetadataTable } from 'src/schema/tables/asset-metadata.table.js';
import { AssetOcrAuditTable } from 'src/schema/tables/asset-ocr-audit.table.js';
import { AssetOcrTable } from 'src/schema/tables/asset-ocr.table.js';
import { AssetRestorationTable } from 'src/schema/tables/asset-restoration.table.js';
import { AssetVideoDuplicateFrameTable } from 'src/schema/tables/asset-video-duplicate-frame.table.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { ClassificationMatchTable } from 'src/schema/tables/classification-match.table.js';
import { ClassificationRuleTable } from 'src/schema/tables/classification-rule.table.js';
import { ClusterGroupRequestTable } from 'src/schema/tables/cluster-group-request.table.js';
import { ClusterGroupTable } from 'src/schema/tables/cluster-group.table.js';
import { DuplicateDecisionTable } from 'src/schema/tables/duplicate-decision.table.js';
import { FaceSearchTable } from 'src/schema/tables/face-search.table.js';
import { GeodataPlacesTable } from 'src/schema/tables/geodata-places.table.js';
import { IntegrityReportTable } from 'src/schema/tables/integrity-report.table.js';
import { LibraryTable } from 'src/schema/tables/library.table.js';
import { MediaOperationCheckpointTable, MediaOperationTable } from 'src/schema/tables/media-operation.table.js';
import { MemoryAssetAuditTable } from 'src/schema/tables/memory-asset-audit.table.js';
import { MemoryAssetTable } from 'src/schema/tables/memory-asset.table.js';
import { MemoryAuditTable } from 'src/schema/tables/memory-audit.table.js';
import { MemoryExportTable } from 'src/schema/tables/memory-export.table.js';
import { MemoryTable } from 'src/schema/tables/memory.table.js';
import {
  MlDestinationTable,
  MlWorkloadAccountingTable,
  MlWorkloadRouteTable,
} from 'src/schema/tables/ml-destination.table.js';
import { MoveTable } from 'src/schema/tables/move.table.js';
import { NaturalEarthCountriesTable } from 'src/schema/tables/natural-earth-countries.table.js';
import { NotificationTable } from 'src/schema/tables/notification.table.js';
import { OcrSearchTable } from 'src/schema/tables/ocr-search.table.js';
import { OperationalMetricSampleTable } from 'src/schema/tables/operational-metric-sample.table.js';
import { PartnerAuditTable } from 'src/schema/tables/partner-audit.table.js';
import { PartnerTable } from 'src/schema/tables/partner.table.js';
import { PersonAuditTable } from 'src/schema/tables/person-audit.table.js';
import { PersonGroupAuditTable } from 'src/schema/tables/person-group-audit.table.js';
import { PersonGroupTable } from 'src/schema/tables/person-group.table.js';
import { PersonTable } from 'src/schema/tables/person.table.js';
import { PetCandidateTable, PetDetectionTable, PetObservationTable, PetTable } from 'src/schema/tables/pet.table.js';
import { DevelopExportTable, DevelopPresetTable } from 'src/schema/tables/photo-tools.table.js';
import { PhysicalFileTable } from 'src/schema/tables/physical-file.table.js';
import { PluginMethodTable } from 'src/schema/tables/plugin-method.table.js';
import { PluginTable } from 'src/schema/tables/plugin.table.js';
import {
  PreservationItemTable,
  PreservationPackageTable,
  PreservationRestoreItemTable,
  PreservationRestoreTable,
} from 'src/schema/tables/preservation.table.js';
import {
  RenderWorkerAuditTable,
  RenderWorkerLimitTable,
  RenderWorkerSessionTable,
  RenderWorkerTable,
} from 'src/schema/tables/render-worker.table.js';
import { SessionTable } from 'src/schema/tables/session.table.js';
import { SharedLinkAssetTable } from 'src/schema/tables/shared-link-asset.table.js';
import { SharedLinkTable } from 'src/schema/tables/shared-link.table.js';
import { SharedSpaceAlbumTable } from 'src/schema/tables/shared-space-album.table.js';
import { SharedSpaceCommentThreadTable } from 'src/schema/tables/shared-space-comment-thread.table.js';
import { SharedSpaceEventTable } from 'src/schema/tables/shared-space-event.table.js';
import { SharedSpaceInviteTable } from 'src/schema/tables/shared-space-invite.table.js';
import { SharedSpaceMentionTable } from 'src/schema/tables/shared-space-mention.table.js';
import { SharedSpacePersonTable } from 'src/schema/tables/shared-space-person.table.js';
import { SharedSpaceVisitTable } from 'src/schema/tables/shared-space-visit.table.js';
import { SmartAlbumAssetTable } from 'src/schema/tables/smart-album-asset.table.js';
import { SmartAlbumExclusionTable } from 'src/schema/tables/smart-album-exclusion.table.js';
import { SmartAlbumTable } from 'src/schema/tables/smart-album.table.js';
import { SmartSearchDescriptionTable } from 'src/schema/tables/smart-search-description.table.js';
import { SmartSearchTable } from 'src/schema/tables/smart-search.table.js';
import { StackAuditTable } from 'src/schema/tables/stack-audit.table.js';
import { StackTable } from 'src/schema/tables/stack.table.js';
import {
  StudioExportRemoteReferenceTable,
  StudioExportVersionSourceTable,
  StudioExportVersionTable,
} from 'src/schema/tables/studio-export.table.js';
import { StudioPreviewFrameTable } from 'src/schema/tables/studio-preview.table.js';
import {
  StudioBundleUploadTable,
  StudioProjectCommentTable,
  StudioProjectRevisionTable,
  StudioProjectTable,
} from 'src/schema/tables/studio-project.table.js';
import { SessionSyncCheckpointTable } from 'src/schema/tables/sync-checkpoint.table.js';
import { SystemMetadataTable } from 'src/schema/tables/system-metadata.table.js';
import { TagAssetTable } from 'src/schema/tables/tag-asset.table.js';
import { TagClosureTable } from 'src/schema/tables/tag-closure.table.js';
import { TagTable } from 'src/schema/tables/tag.table.js';
import {
  TakeoutAlbumTable,
  TakeoutFileTable,
  TakeoutImportTable,
  TakeoutItemTable,
  TakeoutPairTable,
  TakeoutSourceTable,
} from 'src/schema/tables/takeout.table.js';
import { UserAuditTable } from 'src/schema/tables/user-audit.table.js';
import { UserMetadataAuditTable } from 'src/schema/tables/user-metadata-audit.table.js';
import { UserMetadataTable } from 'src/schema/tables/user-metadata.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';
import { VersionHistoryTable } from 'src/schema/tables/version-history.table.js';
import {
  VideoMomentFrameEmbeddingTable,
  VideoMomentFrameTable,
  VideoMomentIndexTable,
  VideoMomentTable,
} from 'src/schema/tables/video-moment.table.js';
import {
  VideoStreamSegmentTable,
  VideoStreamSessionTable,
  VideoStreamVariantTable,
} from 'src/schema/tables/video-stream.table.js';
import { WorkflowDefinitionTable } from 'src/schema/tables/workflow-definition.table.js';
import { WorkflowLogDetailTable } from 'src/schema/tables/workflow-log-detail.table.js';
import { WorkflowLogTable } from 'src/schema/tables/workflow-log.table.js';
import { WorkflowRunStepTable } from 'src/schema/tables/workflow-run-step.table.js';
import { WorkflowStepTable } from 'src/schema/tables/workflow-step.table.js';
import { WorkflowTable } from 'src/schema/tables/workflow.table.js';

@Extensions(['uuid-ossp', 'unaccent', 'cube', 'earthdistance', 'pg_trgm', 'plpgsql'])
@Database({ name: 'immich' })
export class ImmichDatabase {
  tables = [
    ActivityTable,
    AdminAuditEventTable,
    AlbumAssetTable,
    AlbumAssetAuditTable,
    AlbumAuditTable,
    AlbumClosureTable,
    AlbumUserAuditTable,
    AlbumUserTable,
    AlbumTable,
    ApiKeyTable,
    AssetAuditTable,
    AssetBestPhotoScoreTable,
    AssetEditTable,
    AssetEditAuditTable,
    AssetFaceTable,
    AssetFaceAuditTable,
    AssetMetadataTable,
    AssetMetadataAuditTable,
    AssetJobStatusTable,
    AssetLockTable,
    AssetDocumentEditTable,
    AssetOcrTable,
    AssetOcrAuditTable,
    AssetRestorationTable,
    AssetTable,
    AssetFileTable,
    AssetHealthRunTable,
    AssetHealthTable,
    AssetHealthCandidateTable,
    AssetExifTable,
    AssetVideoDuplicateFrameTable,
    ClassificationRuleTable,
    ClassificationMatchTable,
    ClusterGroupTable,
    ClusterGroupRequestTable,
    DuplicateDecisionTable,
    FaceSearchTable,
    GeodataPlacesTable,
    IntegrityReportTable,
    LibraryTable,
    MediaOperationTable,
    MediaOperationCheckpointTable,
    RenderWorkerTable,
    RenderWorkerSessionTable,
    RenderWorkerLimitTable,
    RenderWorkerAuditTable,
    MemoryTable,
    MemoryAuditTable,
    MemoryExportTable,
    MemoryAssetTable,
    MemoryAssetAuditTable,
    MlDestinationTable,
    MlWorkloadRouteTable,
    MlWorkloadAccountingTable,
    MoveTable,
    NaturalEarthCountriesTable,
    NotificationTable,
    OcrSearchTable,
    OperationalMetricSampleTable,
    PartnerAuditTable,
    PartnerTable,
    PersonTable,
    PersonAuditTable,
    PhysicalFileTable,
    PersonGroupTable,
    PersonGroupAuditTable,
    PetTable,
    PetObservationTable,
    PetDetectionTable,
    PetCandidateTable,
    PreservationPackageTable,
    PreservationItemTable,
    PreservationRestoreTable,
    PreservationRestoreItemTable,
    SessionTable,
    SharedLinkAssetTable,
    SharedLinkTable,
    SharedSpaceAlbumTable,
    SharedSpaceCommentThreadTable,
    SharedSpaceEventTable,
    SharedSpaceInviteTable,
    SharedSpaceMentionTable,
    SharedSpacePersonTable,
    SharedSpaceVisitTable,
    SmartAlbumTable,
    SmartAlbumAssetTable,
    SmartAlbumExclusionTable,
    SmartSearchTable,
    SmartSearchDescriptionTable,
    StackTable,
    StackAuditTable,
    StudioPreviewFrameTable,
    StudioProjectTable,
    StudioProjectRevisionTable,
    StudioProjectCommentTable,
    StudioBundleUploadTable,
    StudioExportVersionTable,
    StudioExportVersionSourceTable,
    StudioExportRemoteReferenceTable,
    TakeoutImportTable,
    TakeoutSourceTable,
    TakeoutFileTable,
    TakeoutItemTable,
    TakeoutPairTable,
    TakeoutAlbumTable,
    DevelopPresetTable,
    DevelopExportTable,
    SessionSyncCheckpointTable,
    SystemMetadataTable,
    TagTable,
    TagAssetTable,
    TagClosureTable,
    UserAuditTable,
    UserMetadataTable,
    UserMetadataAuditTable,
    UserTable,
    VersionHistoryTable,
    VideoMomentIndexTable,
    VideoMomentFrameTable,
    VideoMomentFrameEmbeddingTable,
    VideoMomentTable,
    VideoStreamSessionTable,
    VideoStreamVariantTable,
    VideoStreamSegmentTable,
    PluginTable,
    PluginMethodTable,
    WorkflowTable,
    WorkflowStepTable,
    WorkflowDefinitionTable,
    WorkflowLogDetailTable,
    WorkflowRunStepTable,
  ];

  functions = [
    immich_uuid_v7,
    updated_at,
    f_concat_ws,
    f_unaccent,
    ll_to_earth_public,
    user_delete_audit,
    partner_delete_audit,
    asset_delete_audit,
    album_user_after_insert,
    album_user_delete_audit,
    memory_delete_audit,
    memory_asset_delete_audit,
    stack_delete_audit,
    person_delete_audit,
    person_group_delete_audit,
    user_metadata_audit,
    asset_metadata_audit,
    asset_face_audit,
    asset_ocr_delete_audit,
    album_user_delete,
  ];

  enum = [album_user_role_enum, assets_status_enum, asset_face_source_type, asset_visibility_enum];
}

export interface Migrations {
  id: Generated<number>;
  name: string;
  timestamp: Int8;
}

export interface DB {
  kysely_migrations: { timestamp: string; name: string };

  activity: ActivityTable;
  admin_audit_event: AdminAuditEventTable;

  album: AlbumTable;
  album_audit: AlbumAuditTable;
  album_asset: AlbumAssetTable;
  album_asset_audit: AlbumAssetAuditTable;
  album_closure: AlbumClosureTable;
  album_user: AlbumUserTable;
  album_user_audit: AlbumUserAuditTable;

  api_key: ApiKeyTable;

  asset: AssetTable;
  asset_audit: AssetAuditTable;
  asset_best_photo_score: AssetBestPhotoScoreTable;
  asset_edit: AssetEditTable;
  asset_edit_audit: AssetEditAuditTable;
  asset_exif: AssetExifTable;
  asset_face: AssetFaceTable;
  asset_face_audit: AssetFaceAuditTable;
  asset_file: AssetFileTable;
  asset_health_run: AssetHealthRunTable;
  asset_health: AssetHealthTable;
  asset_health_candidate: AssetHealthCandidateTable;
  asset_metadata: AssetMetadataTable;
  asset_metadata_audit: AssetMetadataAuditTable;
  asset_job_status: AssetJobStatusTable;
  asset_lock: AssetLockTable;
  asset_document_edit: AssetDocumentEditTable;
  asset_ocr: AssetOcrTable;
  asset_ocr_audit: AssetOcrAuditTable;
  asset_restoration: AssetRestorationTable;
  asset_audio: AssetAudioTable;
  asset_video: AssetVideoTable;
  asset_keyframe: AssetKeyframeTable;
  asset_video_duplicate_frame: AssetVideoDuplicateFrameTable;
  ocr_search: OcrSearchTable;

  duplicate_decision: DuplicateDecisionTable;

  face_search: FaceSearchTable;

  geodata_places: GeodataPlacesTable;

  integrity_report: IntegrityReportTable;

  library: LibraryTable;

  media_operation: MediaOperationTable;
  media_operation_checkpoint: MediaOperationCheckpointTable;

  memory: MemoryTable;
  memory_audit: MemoryAuditTable;
  memory_asset: MemoryAssetTable;
  memory_asset_audit: MemoryAssetAuditTable;
  memory_export: MemoryExportTable;

  migrations: Migrations;

  notification: NotificationTable;

  move_history: MoveTable;

  naturalearth_countries: NaturalEarthCountriesTable;

  ml_destination: MlDestinationTable;
  ml_workload_route: MlWorkloadRouteTable;
  ml_workload_accounting: MlWorkloadAccountingTable;
  operational_metric_sample: OperationalMetricSampleTable;
  partner: PartnerTable;
  partner_audit: PartnerAuditTable;

  person: PersonTable;
  person_audit: PersonAuditTable;
  person_group: PersonGroupTable;
  person_group_audit: PersonGroupAuditTable;

  pet: PetTable;
  pet_observation: PetObservationTable;
  pet_detection: PetDetectionTable;
  pet_candidate: PetCandidateTable;

  classification_match: ClassificationMatchTable;
  classification_rule: ClassificationRuleTable;
  cluster_group: ClusterGroupTable;
  cluster_group_request: ClusterGroupRequestTable;

  physical_file: PhysicalFileTable;

  preservation_package: PreservationPackageTable;
  preservation_item: PreservationItemTable;
  preservation_restore: PreservationRestoreTable;
  preservation_restore_item: PreservationRestoreItemTable;

  render_worker: RenderWorkerTable;
  render_worker_session: RenderWorkerSessionTable;
  render_worker_limit: RenderWorkerLimitTable;
  render_worker_audit: RenderWorkerAuditTable;

  session: SessionTable;
  session_sync_checkpoint: SessionSyncCheckpointTable;

  shared_link: SharedLinkTable;
  shared_link_asset: SharedLinkAssetTable;
  shared_space_album: SharedSpaceAlbumTable;
  shared_space_comment_thread: SharedSpaceCommentThreadTable;
  shared_space_event: SharedSpaceEventTable;
  shared_space_invite: SharedSpaceInviteTable;
  shared_space_mention: SharedSpaceMentionTable;
  shared_space_person: SharedSpacePersonTable;
  shared_space_visit: SharedSpaceVisitTable;

  smart_album: SmartAlbumTable;
  smart_album_asset: SmartAlbumAssetTable;
  smart_album_exclusion: SmartAlbumExclusionTable;

  smart_search: SmartSearchTable;
  smart_search_description: SmartSearchDescriptionTable;

  stack: StackTable;
  stack_audit: StackAuditTable;

  studio_preview_frame: StudioPreviewFrameTable;
  studio_project: StudioProjectTable;
  studio_project_revision: StudioProjectRevisionTable;
  studio_project_comment: StudioProjectCommentTable;
  studio_bundle_upload: StudioBundleUploadTable;
  studio_export_version: StudioExportVersionTable;
  studio_export_version_source: StudioExportVersionSourceTable;
  studio_export_remote_reference: StudioExportRemoteReferenceTable;

  system_metadata: SystemMetadataTable;

  takeout_album: TakeoutAlbumTable;
  takeout_file: TakeoutFileTable;
  takeout_import: TakeoutImportTable;
  takeout_item: TakeoutItemTable;
  takeout_pair: TakeoutPairTable;
  takeout_source: TakeoutSourceTable;

  develop_export: DevelopExportTable;
  develop_preset: DevelopPresetTable;

  tag: TagTable;
  tag_asset: TagAssetTable;
  tag_closure: TagClosureTable;

  user: UserTable;
  user_audit: UserAuditTable;
  user_metadata: UserMetadataTable;
  user_metadata_audit: UserMetadataAuditTable;

  version_history: VersionHistoryTable;

  video_moment_index: VideoMomentIndexTable;
  video_moment_frame: VideoMomentFrameTable;
  video_moment_frame_embedding: VideoMomentFrameEmbeddingTable;
  video_moment: VideoMomentTable;

  video_stream_session: VideoStreamSessionTable;
  video_stream_variant: VideoStreamVariantTable;
  video_stream_segment: VideoStreamSegmentTable;

  plugin: PluginTable;
  plugin_method: PluginMethodTable;

  workflow: WorkflowTable;
  workflow_step: WorkflowStepTable;
  workflow_log: WorkflowLogTable;
  workflow_definition: WorkflowDefinitionTable;
  workflow_log_detail: WorkflowLogDetailTable;
  workflow_run_step: WorkflowRunStepTable;
}
